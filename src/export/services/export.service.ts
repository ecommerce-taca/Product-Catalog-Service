import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { FilterQuery } from 'mongoose';
import { ProductDocument } from '../../database/schemas/product.schema';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { CategoryRepositoryPort } from '../../category/repositories/category.repository.interface';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { ExportFormat, ExportProductsDto } from '../dto/export-products.dto';
import { ExportResponseDto } from '../dto/export-response.dto';

export const PRODUCT_EXPORT_MAX_ROWS = 10000;
export const PRODUCT_EXPORT_URL_TTL = 1800; // 30 minutes in seconds

@Injectable()
export class ExportService {
  constructor(
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
    @Inject('SkuRepositoryPort')
    private readonly skuRepository: SkuRepositoryPort,
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepository: CategoryRepositoryPort,
    private readonly s3StorageService: S3StorageService,
  ) {}

  /**
   * Exports products for a specific shop to a file (CSV/XLSX buffer uploaded to S3)
   * and returns a presigned download URL valid for 30 minutes.
   * Throws 400 PRODUCT_EXPORT_TOO_LARGE if matching count exceeds 10,000 rows.
   */
  async exportProducts(shopId: string, query: ExportProductsDto): Promise<ExportResponseDto> {
    const filter: FilterQuery<ProductDocument> = {
      shop_id: shopId,
    };

    if (query.status) {
      filter.status = query.status;
    }

    if (query.q && query.q.trim()) {
      const escaped = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ title: new RegExp(escaped, 'i') }, { slug: new RegExp(escaped, 'i') }];
    }

    const from = query.updated_from ? new Date(query.updated_from) : undefined;
    const to = query.updated_to ? new Date(query.updated_to) : undefined;

    if (from && isNaN(from.getTime())) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'updated_from không hợp lệ.',
      });
    }

    if (to && isNaN(to.getTime())) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'updated_to không hợp lệ.',
      });
    }

    if (from && to && from > to) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'updated_from không được lớn hơn updated_to.',
      });
    }

    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter.$gte = from;
      if (to) dateFilter.$lte = to;
      filter.updated_at = dateFilter;
    }

    const count = await this.productRepository.count(filter);

    if (count > PRODUCT_EXPORT_MAX_ROWS) {
      throw new BadRequestException({
        code: 'PRODUCT_EXPORT_TOO_LARGE',
        message: 'Kết quả xuất file quá lớn, vui lòng lọc hẹp hơn.',
      });
    }

    const products = await this.productRepository.find(filter, {
      sort: { updated_at: -1 },
      limit: PRODUCT_EXPORT_MAX_ROWS,
    });

    const productIds = products.map((p) => String(p._id));
    const categoryIds = Array.from(
      new Set(products.map((p) => p.primary_category_id).filter(Boolean)),
    ) as string[];

    const [skus, categories] = await Promise.all([
      productIds.length > 0 ? this.skuRepository.find({ product_id: { $in: productIds } }) : [],
      categoryIds.length > 0 ? this.categoryRepository.find({ _id: { $in: categoryIds } }) : [],
    ]);

    const skuCountMap = new Map<string, number>();
    for (const sku of skus) {
      const pid = String(sku.product_id);
      skuCountMap.set(pid, (skuCountMap.get(pid) || 0) + 1);
    }

    const categoryNameMap = new Map<string, string>();
    for (const cat of categories) {
      categoryNameMap.set(String(cat._id), cat.name);
    }

    // Format columns according to API Spec §3.2:
    // product_id, title, slug, status, primary_category, base_price, sale_price, sku_count, updated_at
    const header =
      'product_id,title,slug,status,primary_category,base_price,sale_price,sku_count,updated_at';
    const rows = products.map((p) => {
      const pid = String(p._id);
      const title = this.escapeCsv(p.title);
      const slug = this.escapeCsv(p.slug);
      const status = p.status;
      const primaryCat = this.escapeCsv(
        p.primary_category_id
          ? categoryNameMap.get(p.primary_category_id) || p.primary_category_id
          : '',
      );
      const basePrice = p.price_summary?.base_price ? Number(p.price_summary.base_price) : 0;
      const salePrice = p.price_summary?.sale_price ? Number(p.price_summary.sale_price) : 0;
      const skuCount = skuCountMap.get(pid) || 0;
      const updatedAt = p.updated_at ? new Date(p.updated_at).toISOString() : '';
      return `${pid},${title},${slug},${status},${primaryCat},${basePrice},${salePrice},${skuCount},${updatedAt}`;
    });

    const csvContent = '\uFEFF' + [header, ...rows].join('\n');
    const buffer = Buffer.from(csvContent, 'utf-8');

    const format = query.format || ExportFormat.CSV;
    if (format !== ExportFormat.CSV) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'Định dạng xuất không được hỗ trợ. Hiện chỉ hỗ trợ csv.',
      });
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[-:T.]/g, '')
      .slice(0, 14);
    const objectKey = `exports/products-shop-${shopId}-${timestamp}.csv`;
    const contentType = 'text/csv; charset=utf-8';

    await this.s3StorageService.uploadBuffer(objectKey, buffer, contentType);

    const { downloadUrl, expiresAt } = await this.s3StorageService.generatePresignedDownloadUrl(
      objectKey,
      PRODUCT_EXPORT_URL_TTL,
    );

    return {
      export_url: downloadUrl,
      format,
      row_count: products.length,
      generated_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
    };
  }

  private escapeCsv(val: unknown): string {
    if (val === null || val === undefined) return '';
    let str = String(val);
    if (/^[=+\-@]/.test(str)) {
      str = `'${str}`;
    }
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}
