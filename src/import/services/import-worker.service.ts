import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import * as ExcelJS from 'exceljs';
import sanitizeHtml from 'sanitize-html';
import { v7 as uuidv7 } from 'uuid';
import { Readable } from 'stream';

import { ImportErrorDetail, ImportJobStatus } from '../../database/schemas/import-job.schema';
import { ProductPriceSummary, ProductStatus } from '../../database/schemas/product.schema';
import { SkuStatus } from '../../database/schemas/sku.schema';
import { MediaScope, MediaStatus } from '../../database/schemas/product-media.schema';
import { AggregateType } from '../../database/schemas/outbox-event.schema';
import { CategoryStatus } from '../../database/schemas/category.schema';
import { TraceContextStorage } from '../../common/context/trace-context.storage';
import { TransactionRunner } from '../../database/transaction.runner';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';

import { ImportJobRepositoryPort } from '../repositories/import-job.repository.interface';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { CategoryRepositoryPort } from '../../category/repositories/category.repository.interface';
import { ProductCategoryRepositoryPort } from '../../category/repositories/product-category.repository.interface';
import { ProductMediaRepositoryPort } from '../../media/repositories/product-media.repository.interface';
import { OutboxRepositoryPort } from '../../outbox/repositories/outbox.repository.interface';
import { VariantResolver } from '../../sku/services/variant-resolver.service';
import { DownloadedMediaResult, MediaDownloadService } from './media-download.service';
import { ExcelFormulaSanitizer } from '../utils/excel-formula-sanitizer.util';
import { ExcelResultService } from './excel-result.service';

const SYSTEM_ACTOR_ID = '01910000-0000-7000-8000-000000000000';
const GLOBAL_MAX_CONCURRENT_WORKERS = 3;

const STRICT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'ul', 'ol', 'li', 'h3', 'h4', 'a', 'img'],
  allowedAttributes: {
    a: ['href', 'title', 'target'],
    img: ['src', 'alt', 'width', 'height'],
  },
};

export function generateImportSlug(title: string, productId: string): string {
  const normalized = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = normalized.substring(0, 140) || 'product';
  const suffix = productId.replace(/-/g, '').substring(0, 8);
  return `${base}-${suffix}`;
}

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index++;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ParsedSkuRow {
  rowIndex: number;
  productRefId: string;
  sellerSku: string;
  price: number;
  originalPrice?: number | null;
  barcode?: string | null;
  attributes: Record<string, string | number | boolean>;
  variantKey: string;
  rowErrors: ImportErrorDetail[];
}

interface ParsedSpuGroup {
  productRefId: string;
  firstRowIndex: number;
  title: string;
  categoryId: string;
  description: string | null;
  brand: string | null;
  imageUrls: string[];
  skus: ParsedSkuRow[];
  spuErrors: ImportErrorDetail[];
  downloadedMedia: DownloadedMediaResult[];
}

@Injectable()
export class ImportWorkerService {
  private readonly logger = new Logger(ImportWorkerService.name);

  // Global semaphore to enforce max 3 concurrent workers (NFR-IM-03, BR-IM-06)
  private activeWorkers = 0;
  private readonly waitQueue: Array<() => void> = [];

  constructor(
    @Inject('ImportJobRepositoryPort')
    private readonly importJobRepo: ImportJobRepositoryPort,
    @Inject('ProductRepositoryPort')
    private readonly productRepo: ProductRepositoryPort,
    @Inject('SkuRepositoryPort')
    private readonly skuRepo: SkuRepositoryPort,
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepo: CategoryRepositoryPort,
    @Inject('ProductCategoryRepositoryPort')
    private readonly productCategoryRepo: ProductCategoryRepositoryPort,
    @Inject('ProductMediaRepositoryPort')
    private readonly mediaRepo: ProductMediaRepositoryPort,
    private readonly outboxRepo: OutboxRepositoryPort,
    private readonly storageService: S3StorageService,
    private readonly transactionRunner: TransactionRunner,
    private readonly mediaDownloadService: MediaDownloadService,
    @Optional()
    private readonly variantResolver?: VariantResolver,
    @Optional()
    private readonly excelResultService?: ExcelResultService,
  ) {}

  /**
   * Returns current count of running workers for monitoring and tests.
   */
  getActiveWorkersCount(): number {
    return this.activeWorkers;
  }

  /**
   * Main entry point to process an import job by jobId.
   * Acquires global worker semaphore slot (limit 3), performs 3-stage pipeline,
   * handles partial success, and releases semaphore.
   */
  async processJob(jobId: string): Promise<void> {
    await this.acquireSlot();
    try {
      await this.executeJob(jobId);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Critical error executing import job ${jobId}: ${errorMsg}`,
        (err as Error)?.stack,
      );
    } finally {
      this.releaseSlot();
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.activeWorkers < GLOBAL_MAX_CONCURRENT_WORKERS) {
      this.activeWorkers++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.activeWorkers++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.activeWorkers--;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next?.();
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = await this.importJobRepo.findById(jobId);
    if (!job) {
      this.logger.warn(`Job ${jobId} not found`);
      return;
    }

    if (job.status !== ImportJobStatus.PENDING) {
      this.logger.warn(`Job ${jobId} status is ${job.status}, expected PENDING. Skipping.`);
      return;
    }

    // Heartbeat Lease (2 minutes)
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + 120_000);
    job.status = ImportJobStatus.PROCESSING;
    job.started_at = now;
    job.locked_until = lockedUntil;
    await job.save();

    // 1. Download file buffer from S3 storage
    let fileBuffer: Buffer;
    try {
      fileBuffer = await this.downloadBufferFromStorage(job.file_url);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to download file from S3 for job ${jobId}: ${msg}`);
      job.status = ImportJobStatus.FAILED;
      job.completed_at = new Date();
      job.locked_until = null;
      job.error_count = 1;
      job.error_summary = [
        {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_FILE_CORRUPT',
          error_message: `Không thể đọc tệp từ bộ lưu trữ: ${msg}`,
        },
      ];
      await job.save();
      return;
    }

    // -------------------------------------------------------------------------
    // STAGE 1: In-memory Pre-validation (~30ms, 0 DB connection)
    // -------------------------------------------------------------------------
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(fileBuffer as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = ImportJobStatus.FAILED;
      job.completed_at = new Date();
      job.locked_until = null;
      job.error_count = 1;
      job.error_summary = [
        {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_INVALID_FORMAT',
          error_message: `Định dạng tệp Excel không hợp lệ hoặc bị hỏng: ${msg}`,
        },
      ];
      await job.save();
      return;
    }

    const worksheet = workbook.getWorksheet(1);
    if (!worksheet) {
      job.status = ImportJobStatus.FAILED;
      job.completed_at = new Date();
      job.locked_until = null;
      job.error_count = 1;
      job.error_summary = [
        {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_INVALID_FORMAT',
          error_message: 'Tệp Excel không chứa sheet dữ liệu.',
        },
      ];
      await job.save();
      return;
    }

    // Map column headers from Row 1
    const headerRow = worksheet.getRow(1);
    const colMap = this.mapHeaderColumns(headerRow);

    // Read all non-empty data rows from Row 2
    const rawRows = this.extractDataRows(worksheet, colMap);

    if (rawRows.length === 0) {
      job.status = ImportJobStatus.FAILED;
      job.completed_at = new Date();
      job.locked_until = null;
      job.total_rows = 0;
      job.processed_rows = 0;
      job.error_count = 1;
      job.error_summary = [
        {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_EMPTY_FILE',
          error_message: 'Tệp Excel không chứa bất kỳ dòng dữ liệu nào.',
        },
      ];
      await job.save();
      return;
    }

    // Limit check 1: Max 200 SKU rows (AC-IM-09, BR-IM-02)
    if (rawRows.length > 200) {
      job.status = ImportJobStatus.FAILED;
      job.completed_at = new Date();
      job.locked_until = null;
      job.total_rows = rawRows.length;
      job.processed_rows = 0;
      job.error_count = rawRows.length;
      job.error_summary = [
        {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_TOO_MANY_ROWS',
          error_message: `Số lượng dòng trong file (${rawRows.length}) vượt quá giới hạn tối đa cho phép (200 dòng SKU / 100 SPUs).`,
        },
      ];
      await job.save();
      return;
    }

    // In-file duplicate seller_sku detection across all rows
    const seenSellerSkusInFile = new Map<string, number>();
    const duplicateSellerSkusInFile = new Set<string>();

    for (const r of rawRows) {
      if (r.sellerSku) {
        const normSku = r.sellerSku.toLowerCase();
        if (seenSellerSkusInFile.has(normSku)) {
          duplicateSellerSkusInFile.add(normSku);
        } else {
          seenSellerSkusInFile.set(normSku, r.rowIndex);
        }
      }
    }

    // Group rows by product_ref_id
    const spuMap = new Map<string, ParsedSpuGroup>();

    for (const r of rawRows) {
      const refKey = (r.productRefId || `ROW_${r.rowIndex}`).trim().toUpperCase();

      if (!spuMap.has(refKey)) {
        spuMap.set(refKey, {
          productRefId: r.productRefId || refKey,
          firstRowIndex: r.rowIndex,
          title: r.title,
          categoryId: r.categoryId,
          description: r.description,
          brand: r.brand,
          imageUrls: r.imageUrls,
          skus: [],
          spuErrors: [],
          downloadedMedia: [],
        });
      }

      const spu = spuMap.get(refKey)!;

      // Inherit SPU metadata if subsequent row left them blank
      if (!spu.title && r.title) spu.title = r.title;
      if (!spu.categoryId && r.categoryId) spu.categoryId = r.categoryId;
      if (!spu.description && r.description) spu.description = r.description;
      if (!spu.brand && r.brand) spu.brand = r.brand;
      if (spu.imageUrls.length === 0 && r.imageUrls.length > 0) spu.imageUrls = r.imageUrls;

      const rowErrors: ImportErrorDetail[] = [];

      // Validate seller_sku in file
      if (!r.sellerSku) {
        rowErrors.push({
          row_index: r.rowIndex,
          product_ref_id: spu.productRefId,
          seller_sku: undefined,
          error_code: 'PRODUCT_INVALID_INPUT',
          error_message: 'Mã seller_sku không được để trống.',
        });
      } else if (r.sellerSku.length > 64) {
        rowErrors.push({
          row_index: r.rowIndex,
          product_ref_id: spu.productRefId,
          seller_sku: r.sellerSku,
          error_code: 'PRODUCT_INVALID_INPUT',
          error_message: 'Mã seller_sku tối đa 64 ký tự.',
        });
      } else if (duplicateSellerSkusInFile.has(r.sellerSku.toLowerCase())) {
        rowErrors.push({
          row_index: r.rowIndex,
          product_ref_id: spu.productRefId,
          seller_sku: r.sellerSku,
          error_code: 'PRODUCT_SKU_DUPLICATE',
          error_message: `Mã seller_sku '${r.sellerSku}' bị trùng lặp trong tệp.`,
        });
      }

      // Validate price
      if (
        r.price === null ||
        r.price === undefined ||
        isNaN(r.price) ||
        r.price < 1000 ||
        r.price > 999_999_999_999
      ) {
        rowErrors.push({
          row_index: r.rowIndex,
          product_ref_id: spu.productRefId,
          seller_sku: r.sellerSku || undefined,
          error_code: 'PRODUCT_INVALID_PRICE',
          error_message: 'Giá bán phải là số nguyên dương từ 1.000 đến 999.999.999.999 VND.',
        });
      }

      // Validate original_price
      if (r.originalPrice !== null && r.originalPrice !== undefined && !isNaN(r.originalPrice)) {
        if (r.originalPrice < 0) {
          rowErrors.push({
            row_index: r.rowIndex,
            product_ref_id: spu.productRefId,
            seller_sku: r.sellerSku || undefined,
            error_code: 'PRODUCT_INVALID_PRICE',
            error_message: 'Giá niêm yết gốc phải là số dương.',
          });
        } else if (r.price && r.originalPrice < r.price) {
          rowErrors.push({
            row_index: r.rowIndex,
            product_ref_id: spu.productRefId,
            seller_sku: r.sellerSku || undefined,
            error_code: 'PRODUCT_INVALID_PRICE',
            error_message: 'Giá niêm yết gốc phải lớn hơn hoặc bằng giá bán.',
          });
        }
      }

      // Compute canonical variant key
      const variantKey = this.computeCanonicalVariantKey(r.attributes);

      spu.skus.push({
        rowIndex: r.rowIndex,
        productRefId: spu.productRefId,
        sellerSku: r.sellerSku,
        price: r.price,
        originalPrice: r.originalPrice,
        barcode: r.barcode,
        attributes: r.attributes,
        variantKey,
        rowErrors,
      });
    }

    // Limit check 2: Max 100 SPUs (BR-IM-02)
    if (spuMap.size > 100) {
      job.status = ImportJobStatus.FAILED;
      job.completed_at = new Date();
      job.locked_until = null;
      job.total_rows = rawRows.length;
      job.processed_rows = 0;
      job.error_count = rawRows.length;
      job.error_summary = [
        {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_TOO_MANY_SPUS',
          error_message: `Số lượng SPU trong file (${spuMap.size}) vượt quá giới hạn tối đa 100 SPUs.`,
        },
      ];
      await job.save();
      return;
    }

    // SPU-level validation and in-SPU duplicate variant detection (AC-IM-10)
    for (const spu of spuMap.values()) {
      if (!spu.title || spu.title.trim().length < 10 || spu.title.trim().length > 255) {
        spu.spuErrors.push({
          row_index: spu.firstRowIndex,
          product_ref_id: spu.productRefId,
          error_code: 'PRODUCT_INVALID_INPUT',
          error_message: 'Tiêu đề sản phẩm bắt buộc từ 10 đến 255 ký tự.',
        });
      }

      if (!spu.categoryId || !spu.categoryId.trim()) {
        spu.spuErrors.push({
          row_index: spu.firstRowIndex,
          product_ref_id: spu.productRefId,
          error_code: 'PRODUCT_CATEGORY_INVALID',
          error_message: 'Mã danh mục không được để trống.',
        });
      }

      // Detect duplicate variant keys within same SPU
      const seenVariantKeys = new Set<string>();
      for (const sku of spu.skus) {
        if (sku.variantKey && seenVariantKeys.has(sku.variantKey)) {
          sku.rowErrors.push({
            row_index: sku.rowIndex,
            product_ref_id: spu.productRefId,
            seller_sku: sku.sellerSku || undefined,
            error_code: 'PRODUCT_SKU_DUPLICATE_VARIANT',
            error_message: 'Trùng lặp tổ hợp thuộc tính biến thể trong cùng sản phẩm.',
          });
        }
        if (sku.variantKey) {
          seenVariantKeys.add(sku.variantKey);
        }
      }
    }

    // -------------------------------------------------------------------------
    // STAGE 2: Batch DB Pre-Check & Parallel Media Probe (~500ms, 0 transaction)
    // -------------------------------------------------------------------------

    // 2.1 Batch check category validity
    const candidateCategoryIds = new Set<string>();
    for (const spu of spuMap.values()) {
      if (spu.categoryId) {
        candidateCategoryIds.add(spu.categoryId.trim());
      }
    }

    const validCategoryMap = new Map<string, boolean>();
    for (const catId of candidateCategoryIds) {
      const cat = await this.categoryRepo.findById(catId);
      validCategoryMap.set(catId, !!cat && cat.status === CategoryStatus.ACTIVE);
    }

    for (const spu of spuMap.values()) {
      if (spu.categoryId && !validCategoryMap.get(spu.categoryId.trim())) {
        spu.spuErrors.push({
          row_index: spu.firstRowIndex,
          product_ref_id: spu.productRefId,
          error_code: 'PRODUCT_CATEGORY_INVALID',
          error_message: `Danh mục '${spu.categoryId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
        });
      }
    }

    // 2.2 1 query duy nhất ($in) vào collection skus kiểm tra tồn tại seller_sku trong shop
    const candidateSellerSkus: string[] = [];
    for (const spu of spuMap.values()) {
      for (const sku of spu.skus) {
        if (sku.sellerSku) {
          candidateSellerSkus.push(sku.sellerSku);
        }
      }
    }

    if (candidateSellerSkus.length > 0) {
      const existingDbSkus = await this.skuRepo.findBySellerSkus(job.shop_id, candidateSellerSkus);
      const existingSellerSkuSet = new Set(existingDbSkus.map((s) => s.seller_sku.toLowerCase()));

      for (const spu of spuMap.values()) {
        for (const sku of spu.skus) {
          if (sku.sellerSku && existingSellerSkuSet.has(sku.sellerSku.toLowerCase())) {
            sku.rowErrors.push({
              row_index: sku.rowIndex,
              product_ref_id: spu.productRefId,
              seller_sku: sku.sellerSku,
              error_code: 'PRODUCT_SKU_DUPLICATE',
              error_message: `Mã seller_sku '${sku.sellerSku}' đã tồn tại trong gian hàng.`,
            });
          }
        }
      }
    }

    // 2.3 Media Probe Parallel (concurrency 5, timeout 3s, anti-SSRF)
    // Only probe media for SPUs that currently have zero fatal errors
    const mediaWarningDetails: ImportErrorDetail[] = [];

    const spusToProbeMedia = Array.from(spuMap.values()).filter((spu) => {
      const hasSpuError = spu.spuErrors.length > 0;
      const hasSkuError = spu.skus.some((s) => s.rowErrors.length > 0);
      return !hasSpuError && !hasSkuError && spu.imageUrls.length > 0;
    });

    for (const spu of spusToProbeMedia) {
      const tempProductId = uuidv7();

      await runWithConcurrency(spu.imageUrls.slice(0, 5), 5, async (url) => {
        try {
          const downloaded = await this.mediaDownloadService.downloadAndUploadImage(
            url,
            tempProductId,
          );
          spu.downloadedMedia.push(downloaded);
        } catch (err: unknown) {
          const errObj = err as Error & { code?: string };
          const errorCode =
            errObj.code === 'MEDIA_INVALID_URL_BLOCKED'
              ? 'MEDIA_INVALID_URL_BLOCKED'
              : 'WARNING: MEDIA_DOWNLOAD_FAILED';
          const errorMsg =
            errObj.code === 'MEDIA_INVALID_URL_BLOCKED'
              ? 'URL không an toàn hoặc trỏ về địa chỉ nội bộ'
              : `Không thể tải ảnh từ URL: ${url} (${errObj.message || 'Error'})`;

          // Fault-tolerance (AC-IM-12): Record warning, DO NOT fail SPU!
          mediaWarningDetails.push({
            row_index: spu.firstRowIndex,
            product_ref_id: spu.productRefId,
            error_code: errorCode,
            error_message: errorMsg,
          });
        }
      });
    }

    // -------------------------------------------------------------------------
    // STAGE 3: Single Atomic Batch Transaction (~50-80ms)
    // -------------------------------------------------------------------------
    const validSpus: ParsedSpuGroup[] = [];
    const errorDetails: ImportErrorDetail[] = [];

    for (const spu of spuMap.values()) {
      const spuErrors = spu.spuErrors;
      const skuErrors = spu.skus.flatMap((s) => s.rowErrors);

      if (spuErrors.length > 0 || skuErrors.length > 0) {
        // Entire SPU fails
        errorDetails.push(...spuErrors);
        errorDetails.push(...skuErrors);
      } else {
        validSpus.push(spu);
      }
    }

    if (validSpus.length > 0) {
      try {
        await this.transactionRunner.execute(async (session) => {
          for (const spu of validSpus) {
            const productId = uuidv7();
            const cleanTitle = spu.title.trim();
            const slug = generateImportSlug(cleanTitle, productId);
            const sanitizedDesc = spu.description
              ? sanitizeHtml(spu.description, STRICT_SANITIZE_OPTIONS)
              : null;

            // Compute price summary
            const minPrice = Math.min(...spu.skus.map((s) => s.price));
            const priceSummary: ProductPriceSummary = {
              base_price: BigInt(minPrice),
              sale_price: BigInt(minPrice),
              currency: 'VND',
            };

            // 1. Insert product (100% DRAFT - BR-IM-03, AC-IM-15)
            await this.productRepo.create(
              {
                _id: productId,
                shop_id: job.shop_id,
                title: cleanTitle,
                slug,
                description: sanitizedDesc,
                brand: spu.brand || null,
                price_summary: priceSummary,
                status: ProductStatus.DRAFT,
                primary_category_id: spu.categoryId,
                shop_snapshot: null,
                rating_summary: null,
                published_at: null,
                unpublished_at: null,
                archived_at: null,
                blocked_at: null,
                block_reason: null,
                version: BigInt(1),
              },
              session,
            );

            // 2. Insert SKUs (status: ACTIVE)
            for (const sku of spu.skus) {
              const skuId = uuidv7();
              await this.skuRepo.create(
                {
                  _id: skuId,
                  product_id: productId,
                  shop_id: job.shop_id,
                  seller_sku: sku.sellerSku,
                  attributes: sku.attributes,
                  variant_key: sku.variantKey,
                  price_override: BigInt(sku.price),
                  status: SkuStatus.ACTIVE,
                  media_ids: [],
                  version: BigInt(1),
                },
                session,
              );

              // Outbox event for SKU
              await this.outboxRepo.saveEvent(
                {
                  _id: uuidv7(),
                  event_id: uuidv7(),
                  aggregate_type: AggregateType.SKU,
                  aggregate_id: skuId,
                  event_type: 'sku.created',
                  schema_version: 1,
                  payload: {
                    sku_id: skuId,
                    product_id: productId,
                    shop_id: job.shop_id,
                    seller_sku: sku.sellerSku,
                    variant_key: sku.variantKey,
                    status: SkuStatus.ACTIVE,
                  },
                  topic: 'sku.events.v1',
                  version: BigInt(1),
                  actor_user_id: job.actor_user_id || null,
                  traceparent: TraceContextStorage.getTraceparent() || null,
                },
                session,
              );
            }

            // 3. Insert primary product category
            await this.productCategoryRepo.create(
              {
                _id: uuidv7(),
                product_id: productId,
                category_id: spu.categoryId,
                is_primary: true,
                assigned_at: new Date(),
                assigned_by: job.actor_user_id || SYSTEM_ACTOR_ID,
              },
              session,
            );

            // 4. Insert downloaded media records (if any)
            let isFirst = true;
            for (const media of spu.downloadedMedia) {
              await this.mediaRepo.create(
                {
                  _id: media.mediaId,
                  product_id: productId,
                  sku_id: null,
                  scope: MediaScope.SPU,
                  object_key: media.objectKey,
                  content_type: media.contentType,
                  size_bytes: media.sizeBytes,
                  sha256: media.sha256,
                  sort_order: 0,
                  is_cover: isFirst,
                  status: MediaStatus.READY,
                  uploaded_by: job.actor_user_id || SYSTEM_ACTOR_ID,
                },
                session,
              );
              isFirst = false;
            }

            // 5. Outbox event for Product (product.created CDC)
            await this.outboxRepo.saveEvent(
              {
                _id: uuidv7(),
                event_id: uuidv7(),
                aggregate_type: AggregateType.PRODUCT,
                aggregate_id: productId,
                event_type: 'product.created',
                schema_version: 1,
                payload: {
                  product_id: productId,
                  shop_id: job.shop_id,
                  slug,
                  title: cleanTitle,
                  status: ProductStatus.DRAFT,
                  version: 1,
                },
                topic: 'product.events.v1',
                version: BigInt(1),
                actor_user_id: job.actor_user_id || null,
                traceparent: TraceContextStorage.getTraceparent() || null,
              },
              session,
            );
          }
        });
      } catch (err: unknown) {
        const errorMsg = (err as Error)?.message || String(err);
        this.logger.error(
          `Stage 3 transaction failed for import job ${jobId}: ${errorMsg}`,
          (err as Error)?.stack,
        );
        job.status = ImportJobStatus.FAILED;
        job.locked_until = null;
        job.completed_at = new Date();
        if (!job.error_summary) {
          job.error_summary = [];
        }
        job.error_summary.push({
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'DATABASE_TRANSACTION_FAILED',
          error_message:
            'Không thể ghi nhận sản phẩm vào cơ sở dữ liệu: ' +
            ((err as Error)?.message || String(err)),
        });
        await job.save();
        return;
      }
    }

    // Combine error details and media warnings (sanitized against Formula Injection CWE-1236)
    const combinedErrorSummary = [...errorDetails, ...mediaWarningDetails].map((err) => ({
      row_index: err.row_index,
      product_ref_id: ExcelFormulaSanitizer.sanitize(err.product_ref_id),
      seller_sku: err.seller_sku ? ExcelFormulaSanitizer.sanitize(err.seller_sku) : undefined,
      error_code: err.error_code,
      error_message: ExcelFormulaSanitizer.sanitize(err.error_message),
    }));

    combinedErrorSummary.sort((a, b) => a.row_index - b.row_index);

    // Total failed SKU rows
    const failedSkuRowsCount =
      rawRows.length - validSpus.reduce((acc, spu) => acc + spu.skus.length, 0);

    job.status = ImportJobStatus.COMPLETED;
    job.total_rows = rawRows.length;
    job.processed_rows = rawRows.length;
    job.success_count = validSpus.length;
    job.error_count = failedSkuRowsCount;
    job.error_summary = combinedErrorSummary;
    job.completed_at = new Date();
    job.locked_until = null;

    if (failedSkuRowsCount > 0 && this.excelResultService) {
      try {
        const uploadResult = await this.excelResultService.generateAndUploadResultFile(job);
        job.result_file_url = uploadResult.s3Key;
      } catch (err: unknown) {
        this.logger.error(
          `Failed to generate/upload error result file for job ${jobId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await job.save();

    this.logger.log(
      `Job ${jobId} finished: success=${validSpus.length} SPUs, failed_rows=${failedSkuRowsCount}/${rawRows.length}`,
    );
  }

  private async downloadBufferFromStorage(fileUrl: string): Promise<Buffer> {
    const cleanKey = fileUrl.replace(/^\//, '');
    const command = new GetObjectCommand({
      Bucket: this.storageService.bucket,
      Key: cleanKey,
    });
    const response = await this.storageService.s3Client.send(command);
    const stream = response.Body as Readable;

    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  private mapHeaderColumns(headerRow: ExcelJS.Row): Map<string, number> {
    const colMap = new Map<string, number>();

    headerRow.eachCell((cell, colNumber) => {
      const headerText = this.getCellValueAsString(cell).trim();
      const lower = headerText.toLowerCase();

      if (lower.includes('tham chiếu') || lower === 'product_ref_id') {
        colMap.set('product_ref_id', colNumber);
      } else if (lower.includes('tên sản phẩm') || lower === 'title') {
        colMap.set('title', colNumber);
      } else if (lower.includes('mã danh mục') || lower === 'category_id') {
        colMap.set('category_id', colNumber);
      } else if (lower.includes('mô tả') || lower === 'description') {
        colMap.set('description', colNumber);
      } else if (lower.includes('thương hiệu') || lower === 'brand') {
        colMap.set('brand', colNumber);
      } else if (lower.includes('url ảnh') || lower === 'image_urls') {
        colMap.set('image_urls', colNumber);
      } else if (lower.includes('mã sku') || lower === 'seller_sku') {
        colMap.set('seller_sku', colNumber);
      } else if (
        lower.includes('niêm yết') ||
        lower.includes('gốc') ||
        lower === 'original_price'
      ) {
        colMap.set('original_price', colNumber);
      } else if (lower.includes('giá bán') || lower === 'price') {
        colMap.set('price', colNumber);
      } else if (lower.includes('mã vạch') || lower === 'barcode') {
        colMap.set('barcode', colNumber);
      } else if (headerText.length > 0) {
        // Dynamic attribute
        colMap.set(`attr_${headerText}`, colNumber);
      }
    });

    return colMap;
  }

  private extractDataRows(
    worksheet: ExcelJS.Worksheet,
    colMap: Map<string, number>,
  ): Array<{
    rowIndex: number;
    productRefId: string;
    title: string;
    categoryId: string;
    description: string;
    brand: string;
    imageUrls: string[];
    sellerSku: string;
    price: number;
    originalPrice?: number | null;
    barcode?: string | null;
    attributes: Record<string, string | number | boolean>;
  }> {
    const rawRows: Array<any> = [];

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // Skip header

      const productRefId = this.getColValue(row, colMap, 'product_ref_id');
      const title = this.getColValue(row, colMap, 'title');
      const categoryId = this.getColValue(row, colMap, 'category_id');
      const description = this.getColValue(row, colMap, 'description');
      const brand = this.getColValue(row, colMap, 'brand');
      const imageUrlsRaw = this.getColValue(row, colMap, 'image_urls');
      const sellerSku = this.getColValue(row, colMap, 'seller_sku');
      const priceRaw = this.getColValue(row, colMap, 'price');
      const originalPriceRaw = this.getColValue(row, colMap, 'original_price');
      const barcode = this.getColValue(row, colMap, 'barcode');

      // Check if entire row is empty
      if (!productRefId && !title && !sellerSku && !priceRaw) {
        return;
      }

      const imageUrls = imageUrlsRaw
        ? imageUrlsRaw
            .split(/[\r\n,]+/)
            .map((u) => u.trim())
            .filter((u) => u.length > 0)
        : [];

      const price = priceRaw ? parseFloat(priceRaw.replace(/[^\d.-]/g, '')) : NaN;
      const originalPrice = originalPriceRaw
        ? parseFloat(originalPriceRaw.replace(/[^\d.-]/g, ''))
        : null;

      // Extract dynamic attributes
      const attributes: Record<string, string | number | boolean> = {};
      for (const [key, colIdx] of colMap.entries()) {
        if (key.startsWith('attr_')) {
          const attrName = key.replace('attr_', '');
          const val = this.getCellValueAsString(row.getCell(colIdx)).trim();
          if (val) {
            attributes[attrName] = val;
          }
        }
      }

      rawRows.push({
        rowIndex: rowNumber,
        productRefId: productRefId.trim(),
        title: title.trim(),
        categoryId: categoryId.trim(),
        description: description.trim(),
        brand: brand.trim(),
        imageUrls,
        sellerSku: sellerSku.trim(),
        price,
        originalPrice: isNaN(originalPrice as number) ? null : originalPrice,
        barcode: barcode.trim() || null,
        attributes,
      });
    });

    return rawRows;
  }

  private getColValue(row: ExcelJS.Row, colMap: Map<string, number>, key: string): string {
    const colIdx = colMap.get(key);
    if (!colIdx) return '';
    return this.getCellValueAsString(row.getCell(colIdx));
  }

  private getCellValueAsString(cell: ExcelJS.Cell): string {
    if (cell.value === null || cell.value === undefined) return '';
    if (typeof cell.value === 'object') {
      if ('richText' in cell.value && Array.isArray((cell.value as any).richText)) {
        return (cell.value as any).richText.map((t: any) => t.text).join('');
      }
      if ('text' in cell.value) {
        return String((cell.value as any).text);
      }
      if ('result' in cell.value) {
        return String((cell.value as any).result);
      }
    }
    return String(cell.value);
  }

  private computeCanonicalVariantKey(
    attributes: Record<string, string | number | boolean>,
  ): string {
    if (this.variantResolver && Object.keys(attributes).length > 0) {
      try {
        const dummyDefs = Object.keys(attributes).map((k) => ({
          key: k,
          type: 'STRING',
          is_variant_dimension: true,
        }));
        const res = this.variantResolver.validateAndCanonicalize(attributes, dummyDefs);
        return res.variantKey;
      } catch {
        // Fallback to manual sorted serialization
      }
    }
    const keys = Object.keys(attributes).sort();
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}=${String(attributes[k]).trim()}`).join('|');
  }
}
