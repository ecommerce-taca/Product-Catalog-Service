import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as crypto from 'crypto';
import sanitizeHtml from 'sanitize-html';
import { v7 as uuidv7 } from 'uuid';

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

export function generateProductCode(): string {
  const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `PRD-${randomHex}`;
}

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
  sheetName?: string;
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
  sheetName?: string;
  assignedProductId?: string;
  title: string;
  categoryId: string;
  description: string | null;
  brand: string | null;
  imageUrls: string[];
  skus: ParsedSkuRow[];
  spuErrors: ImportErrorDetail[];
  downloadedMedia: DownloadedMediaResult[];
  isExistingSpu?: boolean;
  existingProduct?: any;
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

    let heartbeatTimer: NodeJS.Timeout | null = null;
    heartbeatTimer = setInterval(async () => {
      try {
        await this.importJobRepo.updateHeartbeat(jobId, 120_000);
      } catch (hbErr: unknown) {
        this.logger.warn(`Heartbeat update failed for job ${jobId}: ${hbErr}`);
      }
    }, 30_000);
    if (heartbeatTimer.unref) {
      heartbeatTimer.unref();
    }

    try {
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
            error_code: 'PRODUCT_IMPORT_FILE_CORRUPT',
            error_message: `Định dạng tệp Excel không hợp lệ hoặc bị hỏng: ${msg}`,
          },
        ];
        await job.save();
        return;
      }

      const IGNORE_SHEET_REGEX = /hướng dẫn|ví dụ|guide|example/i;
      const dataSheets = (workbook.worksheets || []).filter(
        (ws) => !IGNORE_SHEET_REGEX.test(ws.name),
      );

      if (dataSheets.length === 0) {
        job.status = ImportJobStatus.FAILED;
        job.completed_at = new Date();
        job.locked_until = null;
        job.error_count = 1;
        job.error_summary = [
          {
            row_index: 0,
            product_ref_id: 'SYSTEM',
            error_code: 'PRODUCT_IMPORT_FILE_CORRUPT',
            error_message: 'Tệp Excel không chứa sheet dữ liệu.',
          },
        ];
        await job.save();
        return;
      }

      // Read all non-empty data rows across all valid data sheets
      const rawRows: Array<any> = [];
      for (const ws of dataSheets) {
        const headerRow = ws.getRow(1);
        const colMap = this.mapHeaderColumns(headerRow);
        const sheetRows = this.extractDataRows(ws, colMap);
        rawRows.push(...sheetRows);
      }

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
            sheetName: r.sheetName,
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
            sheet_name: r.sheetName,
            product_ref_id: spu.productRefId,
            seller_sku: undefined,
            error_code: 'PRODUCT_INVALID_INPUT',
            error_message: 'Mã seller_sku không được để trống.',
          });
        } else if (r.sellerSku.length > 64) {
          rowErrors.push({
            row_index: r.rowIndex,
            sheet_name: r.sheetName,
            product_ref_id: spu.productRefId,
            seller_sku: r.sellerSku,
            error_code: 'PRODUCT_INVALID_INPUT',
            error_message: 'Mã seller_sku tối đa 64 ký tự.',
          });
        } else if (duplicateSellerSkusInFile.has(r.sellerSku.toLowerCase())) {
          rowErrors.push({
            row_index: r.rowIndex,
            sheet_name: r.sheetName,
            product_ref_id: spu.productRefId,
            seller_sku: r.sellerSku,
            error_code: 'PRODUCT_SKU_DUPLICATE',
            error_message: `Mã seller_sku '${r.sellerSku}' bị trùng lặp trong tệp.`,
          });
        }

        // Validate price (must be integer VND, 1.000 to 999.999.999.999)
        if (
          r.price === null ||
          r.price === undefined ||
          isNaN(r.price) ||
          !Number.isInteger(r.price) ||
          r.price < 1000 ||
          r.price > 999_999_999_999
        ) {
          rowErrors.push({
            row_index: r.rowIndex,
            sheet_name: r.sheetName,
            product_ref_id: spu.productRefId,
            seller_sku: r.sellerSku || undefined,
            error_code: 'PRODUCT_PRICE_INVALID',
            error_message: 'Giá bán phải là số nguyên dương từ 1.000 đến 999.999.999.999 VND.',
          });
        }

        // Validate original_price
        if (r.originalPrice !== null && r.originalPrice !== undefined && !isNaN(r.originalPrice)) {
          if (r.originalPrice < 0 || !Number.isInteger(r.originalPrice)) {
            rowErrors.push({
              row_index: r.rowIndex,
              sheet_name: r.sheetName,
              product_ref_id: spu.productRefId,
              seller_sku: r.sellerSku || undefined,
              error_code: 'PRODUCT_PRICE_INVALID',
              error_message: 'Giá niêm yết gốc phải là số nguyên dương.',
            });
          } else if (r.price && r.originalPrice < r.price) {
            rowErrors.push({
              row_index: r.rowIndex,
              sheet_name: r.sheetName,
              product_ref_id: spu.productRefId,
              seller_sku: r.sellerSku || undefined,
              error_code: 'PRODUCT_PRICE_INVALID',
              error_message: 'Giá niêm yết gốc phải lớn hơn hoặc bằng giá bán.',
            });
          }
        }

        // Compute canonical variant key
        const variantKey = this.computeCanonicalVariantKey(r.attributes);

        spu.skus.push({
          rowIndex: r.rowIndex,
          sheetName: r.sheetName,
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

      // Check for existing SPU if productRefId is a valid UUID or business code
      for (const spu of spuMap.values()) {
        const refId = spu.productRefId?.trim();
        if (refId) {
          try {
            let existingProduct: any = null;
            existingProduct = await this.productRepo.findByIdOrCode(job.shop_id, refId);

            if (existingProduct && existingProduct.shop_id === job.shop_id) {
              spu.isExistingSpu = true;
              spu.existingProduct = existingProduct;
              spu.assignedProductId = existingProduct._id;

              // Check existing product status (SF-1 / SF-EDGE-01)
              if (
                existingProduct.status === ProductStatus.BLOCKED ||
                existingProduct.status === ProductStatus.ARCHIVED
              ) {
                spu.spuErrors.push({
                  row_index: spu.firstRowIndex,
                  sheet_name: spu.sheetName,
                  product_ref_id: spu.productRefId,
                  error_code: 'PRODUCT_SPU_STATUS_INVALID',
                  error_message: `Không thể bổ sung biến thể vào sản phẩm đang ở trạng thái ${existingProduct.status}.`,
                });
              }

              if ((!spu.title || !spu.title.trim()) && existingProduct.title) {
                spu.title = existingProduct.title;
              }
              if (
                (!spu.categoryId || !spu.categoryId.trim()) &&
                existingProduct.primary_category_id
              ) {
                spu.categoryId = existingProduct.primary_category_id;
              }
              if ((!spu.description || !spu.description.trim()) && existingProduct.description) {
                spu.description = existingProduct.description;
              }
              if ((!spu.brand || !spu.brand.trim()) && existingProduct.brand) {
                spu.brand = existingProduct.brand;
              }
            }
          } catch (err: unknown) {
            this.logger.warn(`Failed to check existing SPU for ${spu.productRefId}: ${err}`);
          }
        }
        if (!spu.assignedProductId) {
          spu.assignedProductId = uuidv7();
        }
      }

      // SPU-level validation and in-SPU duplicate variant detection (AC-IM-10, B-LR-01)
      for (const spu of spuMap.values()) {
        if (!spu.title || spu.title.trim().length < 10 || spu.title.trim().length > 200) {
          spu.spuErrors.push({
            row_index: spu.firstRowIndex,
            sheet_name: spu.sheetName,
            product_ref_id: spu.productRefId,
            error_code: 'PRODUCT_INVALID_INPUT',
            error_message: 'Tiêu đề sản phẩm bắt buộc từ 10 đến 200 ký tự.',
          });
        }

        if (!spu.categoryId || !spu.categoryId.trim()) {
          spu.spuErrors.push({
            row_index: spu.firstRowIndex,
            sheet_name: spu.sheetName,
            product_ref_id: spu.productRefId,
            error_code: 'PRODUCT_CATEGORY_INVALID',
            error_message: 'Mã danh mục không được để trống.',
          });
        }

        // Detect duplicate variant keys within same SPU (B-LR-01)
        const seenVariantKeys = new Set<string>();
        for (const sku of spu.skus) {
          if (sku.variantKey !== undefined && seenVariantKeys.has(sku.variantKey)) {
            sku.rowErrors.push({
              row_index: sku.rowIndex,
              sheet_name: sku.sheetName,
              product_ref_id: spu.productRefId,
              seller_sku: sku.sellerSku || undefined,
              error_code: 'PRODUCT_SKU_DUPLICATE_VARIANT',
              error_message: 'Trùng lặp tổ hợp thuộc tính biến thể trong cùng sản phẩm.',
            });
          }
          if (sku.variantKey !== undefined) {
            seenVariantKeys.add(sku.variantKey);
          }
        }
      }

      // -------------------------------------------------------------------------
      // STAGE 2: Batch DB Pre-Check & Parallel Media Probe (~500ms, 0 transaction)
      // -------------------------------------------------------------------------

      // 2.1 Batch check category validity (UUIDv7 or category_code)
      const candidateCategoryIds = new Set<string>();
      for (const spu of spuMap.values()) {
        if (spu.categoryId) {
          candidateCategoryIds.add(spu.categoryId.trim());
        }
      }

      const validCategoryMap = new Map<string, { valid: boolean; categoryId: string }>();
      for (const rawCatId of candidateCategoryIds) {
        let cat: any = null;
        try {
          cat = await this.categoryRepo.findByIdOrCode(rawCatId);
        } catch (err: unknown) {
          this.logger.warn(`Failed to resolve category for '${rawCatId}': ${err}`);
        }

        if (cat && cat.status === CategoryStatus.ACTIVE) {
          validCategoryMap.set(rawCatId, { valid: true, categoryId: cat._id });
        } else {
          validCategoryMap.set(rawCatId, { valid: false, categoryId: rawCatId });
        }
      }

      for (const spu of spuMap.values()) {
        if (spu.categoryId) {
          const catInfo = validCategoryMap.get(spu.categoryId.trim());
          if (!catInfo || !catInfo.valid) {
            spu.spuErrors.push({
              row_index: spu.firstRowIndex,
              sheet_name: spu.sheetName,
              product_ref_id: spu.productRefId,
              error_code: 'PRODUCT_CATEGORY_INVALID',
              error_message: `Danh mục '${spu.categoryId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
            });
          } else {
            spu.categoryId = catInfo.categoryId;
          }
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
        const existingDbSkus = await this.skuRepo.findBySellerSkus(
          job.shop_id,
          candidateSellerSkus,
        );
        const existingSellerSkuSet = new Set(existingDbSkus.map((s) => s.seller_sku.toLowerCase()));

        for (const spu of spuMap.values()) {
          for (const sku of spu.skus) {
            if (sku.sellerSku && existingSellerSkuSet.has(sku.sellerSku.toLowerCase())) {
              sku.rowErrors.push({
                row_index: sku.rowIndex,
                sheet_name: sku.sheetName,
                product_ref_id: spu.productRefId,
                seller_sku: sku.sellerSku,
                error_code: 'PRODUCT_SKU_DUPLICATE',
                error_message: `Mã seller_sku '${sku.sellerSku}' đã tồn tại trong gian hàng.`,
              });
            }
          }
        }
      }

      // 2.3 Check existing variants in DB for existing SPUs (SF-EDGE-01)
      for (const spu of spuMap.values()) {
        if (spu.isExistingSpu && spu.existingProduct) {
          try {
            const existingSkus = await this.skuRepo.findByProductId(spu.existingProduct._id);
            const dbVariantKeys = new Set(existingSkus.map((s) => s.variant_key ?? ''));

            for (const sku of spu.skus) {
              if (sku.variantKey !== undefined && dbVariantKeys.has(sku.variantKey)) {
                sku.rowErrors.push({
                  row_index: sku.rowIndex,
                  sheet_name: sku.sheetName,
                  product_ref_id: spu.productRefId,
                  seller_sku: sku.sellerSku || undefined,
                  error_code: 'PRODUCT_SKU_DUPLICATE_VARIANT',
                  error_message: 'Trùng lặp tổ hợp thuộc tính biến thể đã tồn tại trong sản phẩm.',
                });
              }
            }
          } catch (err: unknown) {
            this.logger.warn(
              `Failed to check existing SKU variants for product ${spu.existingProduct._id}: ${err}`,
            );
          }
        }
      }

      // 2.4 Media Probe Parallel (concurrency 5, timeout 3s, anti-SSRF)
      // Only probe media for SPUs that currently have zero fatal errors
      const mediaWarningDetails: ImportErrorDetail[] = [];
      const uploadedS3Keys: string[] = [];

      const spusToProbeMedia = Array.from(spuMap.values()).filter((spu) => {
        const hasSpuError = spu.spuErrors.length > 0;
        const hasSkuError = spu.skus.some((s) => s.rowErrors.length > 0);
        return !hasSpuError && !hasSkuError && spu.imageUrls.length > 0;
      });

      for (const spu of spusToProbeMedia) {
        const assignedProductId =
          spu.assignedProductId ||
          (spu.isExistingSpu ? spu.existingProduct?._id || spu.productRefId : uuidv7());
        spu.assignedProductId = assignedProductId;

        await runWithConcurrency(spu.imageUrls.slice(0, 5), 5, async (url) => {
          try {
            const downloaded = await this.mediaDownloadService.downloadAndUploadImage(
              url,
              assignedProductId,
            );
            spu.downloadedMedia.push(downloaded);
            if (downloaded.objectKey) {
              uploadedS3Keys.push(downloaded.objectKey);
            }
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
              sheet_name: spu.sheetName,
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
          // Replicate PRODUCT_SPU_REJECTED for any child SKU that doesn't have an error (B-UX-01)
          for (const sku of spu.skus) {
            if (sku.rowErrors.length === 0) {
              sku.rowErrors.push({
                row_index: sku.rowIndex,
                sheet_name: sku.sheetName,
                product_ref_id: spu.productRefId,
                seller_sku: sku.sellerSku || undefined,
                error_code: 'PRODUCT_SPU_REJECTED',
                error_message:
                  'Sản phẩm (SPU) bị từ chối do có lỗi; biến thể này không được khởi tạo.',
              });
            }
          }
          // Entire SPU fails
          errorDetails.push(...spuErrors);
          errorDetails.push(...spu.skus.flatMap((s) => s.rowErrors));
        } else {
          validSpus.push(spu);
        }
      }

      if (validSpus.length > 0) {
        // SF-01: Ensure job has not been reclaimed or aborted while waiting for Stage 2 downloads
        const currentJobDoc = await this.importJobRepo.findById(jobId);
        if (
          currentJobDoc &&
          (currentJobDoc.status === ImportJobStatus.FAILED ||
            currentJobDoc.status === ImportJobStatus.COMPLETED)
        ) {
          this.logger.warn(
            `Job ${jobId} was reclaimed/aborted (current status: ${currentJobDoc.status}). Skipping Stage 3 transaction.`,
          );
          if (uploadedS3Keys.length > 0) {
            try {
              await this.storageService.deleteObjects(uploadedS3Keys);
            } catch (delErr: unknown) {
              this.logger.warn(`Failed to cleanup uploaded S3 objects on zombie abort: ${delErr}`);
            }
          }
          return;
        }

        try {
          await this.transactionRunner.execute(async (session) => {
            for (const spu of validSpus) {
              if (spu.isExistingSpu) {
                // SF-02: TOCTOU check for existing SPU status within session
                const freshSpu = await this.productRepo.findByIdOrCode(
                  job.shop_id,
                  spu.assignedProductId || spu.productRefId,
                  session,
                );
                if (!freshSpu) {
                  throw new Error(
                    `Sản phẩm '${spu.productRefId}' không còn tồn tại trong hệ thống, không thể bổ sung biến thể.`,
                  );
                }
                if (
                  freshSpu.status === ProductStatus.BLOCKED ||
                  freshSpu.status === ProductStatus.ARCHIVED
                ) {
                  throw new Error(
                    `Sản phẩm '${spu.productRefId}' đã chuyển sang trạng thái ${freshSpu.status}, không thể bổ sung biến thể.`,
                  );
                }
              }
              const productId =
                spu.assignedProductId || (spu.isExistingSpu ? spu.productRefId : uuidv7());
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

              if (!spu.isExistingSpu) {
                // 1. Insert product (100% DRAFT - BR-IM-03, AC-IM-15)
                const productCode = generateProductCode();
                await this.productRepo.create(
                  {
                    _id: productId,
                    product_code: productCode,
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

                // 2. Insert primary product category (SPU Category binding - PCAT-IMP-07)
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
              }

              // 3. Insert SKUs (status: ACTIVE) and collect sku.created CDC events
              const pendingSkuEvents: any[] = [];
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

                // Defer Outbox event for SKU until after product.created
                pendingSkuEvents.push({
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
                });
              }

              // 4. Insert Media
              let shouldSetCover = true;
              if (spu.isExistingSpu) {
                const existingMedia =
                  typeof this.mediaRepo.findByProductId === 'function'
                    ? await this.mediaRepo.findByProductId(productId, session)
                    : [];
                const hasReadyCover = existingMedia?.some(
                  (m) => m.is_cover === true && m.status === MediaStatus.READY,
                );
                if (hasReadyCover) {
                  shouldSetCover = false;
                }
              }

              let isFirst = shouldSetCover;
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

              // 5. Update price_summary for existing SPU if new SKU has lower price
              // BLOCKER-03: Use atomic MongoDB query filter to prevent Lost Update Race Condition
              if (spu.isExistingSpu && spu.existingProduct) {
                const newMinPrice = BigInt(minPrice);
                await this.productRepo.update(
                  {
                    _id: productId,
                    $or: [
                      { 'price_summary.base_price': { $gt: newMinPrice } },
                      { 'price_summary.base_price': null },
                    ],
                  },
                  {
                    $set: {
                      'price_summary.base_price': newMinPrice,
                      'price_summary.sale_price': newMinPrice,
                    },
                  },
                  session,
                );
              }

              // 6. Outbox events: SPU (product.created) FIRST, then child SKUs (sku.created)
              if (!spu.isExistingSpu) {
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

              for (const skuEvent of pendingSkuEvents) {
                await this.outboxRepo.saveEvent(skuEvent, session);
              }
            }
          });
        } catch (err: unknown) {
          // B-ARCH-01: Clean up uploaded S3 objects if Stage 3 transaction rolls back
          if (uploadedS3Keys.length > 0) {
            try {
              await this.storageService.deleteObjects(uploadedS3Keys);
            } catch (delErr: unknown) {
              this.logger.warn(`Failed to cleanup uploaded S3 objects on rollback: ${delErr}`);
            }
          }

          const errorMsg = (err as Error)?.message || String(err);
          this.logger.error(
            `Stage 3 transaction failed for import job ${jobId}: ${errorMsg}`,
            (err as Error)?.stack,
          );
          job.status = ImportJobStatus.FAILED;
          job.locked_until = null;
          job.completed_at = new Date();
          job.error_count = rawRows.length || 1;
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
        sheet_name: err.sheet_name,
        product_ref_id: ExcelFormulaSanitizer.sanitize(err.product_ref_id),
        seller_sku: err.seller_sku ? ExcelFormulaSanitizer.sanitize(err.seller_sku) : undefined,
        error_code: err.error_code,
        error_message: ExcelFormulaSanitizer.sanitize(err.error_message),
      }));

      combinedErrorSummary.sort((a, b) => {
        if (a.sheet_name && b.sheet_name && a.sheet_name !== b.sheet_name) {
          return a.sheet_name.localeCompare(b.sheet_name);
        }
        return a.row_index - b.row_index;
      });

      // Total failed SKU rows
      const failedSkuRowsCount =
        rawRows.length - validSpus.reduce((acc, spu) => acc + spu.skus.length, 0);

      // SF-01: Ensure we do not overwrite a job that was reclaimed by timeout or aborted
      const latestJob = await this.importJobRepo.findById(jobId);
      if (
        latestJob &&
        (latestJob.status === ImportJobStatus.FAILED ||
          latestJob.status === ImportJobStatus.COMPLETED)
      ) {
        this.logger.warn(
          `Job ${jobId} was reclaimed/aborted (current status: ${latestJob.status}). Skipping COMPLETED finalization.`,
        );
        return;
      }

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

      // SF-3: Use atomic conditional update to ensure job is still in PROCESSING status before committing COMPLETED
      const updatedJob = await this.importJobRepo.update(
        { _id: jobId, status: ImportJobStatus.PROCESSING },
        {
          $set: {
            status: ImportJobStatus.COMPLETED,
            total_rows: rawRows.length,
            processed_rows: rawRows.length,
            success_count: validSpus.length,
            error_count: failedSkuRowsCount,
            error_summary: combinedErrorSummary,
            result_file_url: job.result_file_url,
            completed_at: job.completed_at,
            locked_until: null,
          },
        },
      );
      if (!updatedJob) {
        this.logger.warn(
          `Job ${jobId} was modified/reclaimed before completion finalization. Skipping COMPLETED commit.`,
        );
        return;
      }

      if (typeof job.save === 'function') {
        await job.save();
      }

      this.logger.log(
        `Job ${jobId} finished: success=${validSpus.length} SPUs, failed_rows=${failedSkuRowsCount}/${rawRows.length}`,
      );
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  }

  private async downloadBufferFromStorage(fileUrl: string): Promise<Buffer> {
    return this.storageService.downloadBuffer(fileUrl);
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
    sheetName: string;
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

      // Extract friendly [UUID/Code] from categoryId and productRefId (match last bracket group)
      let trimmedCatId = categoryId.trim();
      const catMatch = trimmedCatId.match(/\[([A-Za-z0-9_-]+)\](?=[^\]]*$)/);
      if (catMatch) {
        trimmedCatId = catMatch[1];
      }

      let trimmedProductRefId = productRefId.trim();
      const refMatch = trimmedProductRefId.match(/\[([A-Za-z0-9_-]+)\](?=[^\]]*$)/);
      if (refMatch) {
        trimmedProductRefId = refMatch[1];
      }

      rawRows.push({
        rowIndex: rowNumber,
        sheetName: worksheet.name,
        productRefId: trimmedProductRefId,
        title: title.trim(),
        categoryId: trimmedCatId,
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
