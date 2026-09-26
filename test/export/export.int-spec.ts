import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { SellerExportController } from '../../src/export/controllers/seller-export.controller';
import {
  ExportService,
  PRODUCT_EXPORT_MAX_ROWS,
  PRODUCT_EXPORT_URL_TTL,
} from '../../src/export/services/export.service';
import { ExportFormat } from '../../src/export/dto/export-products.dto';
import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuDocument } from '../../src/database/schemas/sku.schema';
import { CategoryDocument } from '../../src/database/schemas/category.schema';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';

// --- In-Memory Repositories for Export Integration ---

function matchesExportFilter(item: any, filter: any): boolean {
  if (!filter) return true;
  for (const [key, val] of Object.entries(filter)) {
    if (key === 'shop_id') {
      if (item.shop_id !== val) return false;
    } else if (key === 'status') {
      if (item.status !== val) return false;
    } else if (key === '$or') {
      const orConditions = val as any[];
      const matched = orConditions.some((cond) => {
        for (const [field, pattern] of Object.entries(cond)) {
          if (pattern instanceof RegExp) {
            if (pattern.test(item[field])) return true;
          } else if (item[field] === pattern) {
            return true;
          }
        }
        return false;
      });
      if (!matched) return false;
    } else if (key === 'updated_at') {
      const updated = new Date(item.updated_at).getTime();
      const condition = val as any;
      if (condition.$gte && updated < new Date(condition.$gte).getTime()) return false;
      if (condition.$lte && updated > new Date(condition.$lte).getTime()) return false;
    }
  }
  return true;
}

class InMemoryProductRepo {
  private products = new Map<string, any>();
  private forcedCount: number | null = null;

  set(doc: any): void {
    this.products.set(doc._id.toString(), { ...doc });
  }

  setForcedCount(count: number | null): void {
    this.forcedCount = count;
  }

  async count(filter: any = {}): Promise<number> {
    if (this.forcedCount !== null) {
      return this.forcedCount;
    }
    const matching = Array.from(this.products.values()).filter((p) =>
      matchesExportFilter(p, filter),
    );
    return matching.length;
  }

  async find(filter: any = {}, options: any = {}): Promise<ProductDocument[]> {
    let result = Array.from(this.products.values()).filter((p) => matchesExportFilter(p, filter));

    if (options.sort?.updated_at) {
      const dir = options.sort.updated_at;
      result.sort((a, b) => {
        const timeA = new Date(a.updated_at).getTime();
        const timeB = new Date(b.updated_at).getTime();
        return dir === -1 ? timeB - timeA : timeA - timeB;
      });
    }

    if (options.limit !== undefined) {
      result = result.slice(0, options.limit);
    }

    return result as unknown as ProductDocument[];
  }

  clear(): void {
    this.products.clear();
    this.forcedCount = null;
  }
}

class InMemorySkuRepo {
  private skus: any[] = [];

  set(list: any[]): void {
    this.skus = [...list];
  }

  async find(filter: any = {}): Promise<SkuDocument[]> {
    return this.skus.filter((s) => {
      if (filter.product_id?.$in) {
        return filter.product_id.$in.map(String).includes(String(s.product_id));
      }
      if (filter.product_id && s.product_id !== filter.product_id) return false;
      return true;
    }) as unknown as SkuDocument[];
  }

  clear(): void {
    this.skus = [];
  }
}

class InMemoryCategoryRepo {
  private categories = new Map<string, any>();

  set(cat: any): void {
    this.categories.set(cat._id.toString(), { ...cat });
  }

  async find(filter: any = {}): Promise<CategoryDocument[]> {
    const all = Array.from(this.categories.values());
    if (filter._id?.$in) {
      const idSet = new Set(filter._id.$in.map(String));
      return all.filter((c) => idSet.has(String(c._id))) as unknown as CategoryDocument[];
    }
    return all as unknown as CategoryDocument[];
  }

  clear(): void {
    this.categories.clear();
  }
}

/**
 * Integration Test Suite for Seller Product Export API [TEST-B08]
 *
 * References:
 * - Test Plan: product-catalog-docs/docs/test/product-catalog.md §3.2 (PC-API-013b)
 * - API Spec: product-catalog-docs/docs/api/product-catalog.md §3.2
 * - LLD: product-catalog-docs/docs/lld/product-catalog.md §3.7
 */
describe('Seller Product Export Integration Spec [TEST-B08]', () => {
  let app: INestApplication;

  const inMemoryProductRepo = new InMemoryProductRepo();
  const inMemorySkuRepo = new InMemorySkuRepo();
  const inMemoryCategoryRepo = new InMemoryCategoryRepo();

  const uploadedBuffers: { key: string; buffer: Buffer; contentType?: string }[] = [];
  const presignedCalls: { key: string; ttl?: number }[] = [];

  const mockS3StorageService = {
    uploadBuffer: jest
      .fn()
      .mockImplementation(async (key: string, buffer: Buffer, contentType?: string) => {
        uploadedBuffers.push({ key, buffer, contentType });
      }),
    generatePresignedDownloadUrl: jest
      .fn()
      .mockImplementation(async (key: string, ttl: number = PRODUCT_EXPORT_URL_TTL) => {
        presignedCalls.push({ key, ttl });
        const expiresAt = new Date(Date.now() + ttl * 1000);
        return {
          downloadUrl: `https://storage.taca.test/${key}?signed=true&expires=${expiresAt.getTime()}`,
          expiresAt,
        };
      }),
  };

  // Test Fixtures
  const shopA = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopB = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';

  const userSellerA = '01912f30-7a1b-7c12-9c55-8b1c34a6d101';
  const userStaffA = '01912f30-7a1b-7c12-9c55-8b1c34a6d102';
  const userBuyer = '01912f30-7a1b-7c12-9c55-8b1c34a6d103';

  const catFashion = '01912f20-7a1b-7c12-9c55-8b1c34a6d201';
  const catTech = '01912f20-7a1b-7c12-9c55-8b1c34a6d202';

  const sellerAHeaders = {
    'x-user-id': userSellerA,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'PRODUCT_READ,PRODUCT_EXPORT',
    'x-user-shop-scope': shopA,
  };

  const staffAHeaders = {
    'x-user-id': userStaffA,
    'x-user-roles': 'SELLER_STAFF',
    'x-user-permissions': 'PRODUCT_READ,PRODUCT_EXPORT',
    'x-user-shop-scope': shopA,
  };

  const buyerHeaders = {
    'x-user-id': userBuyer,
    'x-user-roles': 'BUYER',
    'x-user-permissions': '',
  };

  const productA1 = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d001',
    shop_id: shopA,
    title: 'Áo thun phong cách "Oversize" cổ tròn, màu đen',
    slug: 'ao-thun-phong-cach-oversize-co-tron-mau-den',
    status: ProductStatus.ACTIVE,
    primary_category_id: catFashion,
    price_summary: {
      base_price: BigInt(300000),
      sale_price: BigInt(250000),
      currency: 'VND',
    },
    updated_at: new Date('2026-09-20T12:00:00Z'),
  };

  const productA2 = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d002',
    shop_id: shopA,
    title: 'Quần jeans baggy nam',
    slug: 'quan-jeans-baggy-nam',
    status: ProductStatus.DRAFT,
    primary_category_id: catFashion,
    price_summary: {
      base_price: BigInt(500000),
      sale_price: BigInt(450000),
      currency: 'VND',
    },
    updated_at: new Date('2026-09-18T10:00:00Z'),
  };

  const productB1 = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d003',
    shop_id: shopB,
    title: 'Tai nghe Bluetooth chống ồn Taca Sound',
    slug: 'tai-nghe-bluetooth-chong-on-taca-sound',
    status: ProductStatus.ACTIVE,
    primary_category_id: catTech,
    price_summary: {
      base_price: BigInt(1200000),
      sale_price: BigInt(990000),
      currency: 'VND',
    },
    updated_at: new Date('2026-09-22T08:00:00Z'),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SellerExportController],
      providers: [
        ExportService,
        { provide: 'ProductRepositoryPort', useValue: inMemoryProductRepo },
        { provide: 'SkuRepositoryPort', useValue: inMemorySkuRepo },
        { provide: 'CategoryRepositoryPort', useValue: inMemoryCategoryRepo },
        { provide: S3StorageService, useValue: mockS3StorageService },
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new ActorContextGuard(reflector));
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(reflector));
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    inMemoryProductRepo.clear();
    inMemorySkuRepo.clear();
    inMemoryCategoryRepo.clear();
    uploadedBuffers.length = 0;
    presignedCalls.length = 0;
    jest.clearAllMocks();

    // Default Seed
    inMemoryProductRepo.set(productA1);
    inMemoryProductRepo.set(productA2);
    inMemoryProductRepo.set(productB1);

    inMemoryCategoryRepo.set({
      _id: catFashion,
      name: 'Thời trang nam',
      slug: 'thoi-trang-nam',
    });

    inMemoryCategoryRepo.set({
      _id: catTech,
      name: 'Thiết bị âm thanh',
      slug: 'thiet-bi-am-thanh',
    });

    inMemorySkuRepo.set([
      { _id: 'sku-01', product_id: productA1._id, seller_sku: 'TSHIRT-BLK-M' },
      { _id: 'sku-02', product_id: productA1._id, seller_sku: 'TSHIRT-BLK-L' },
      { _id: 'sku-03', product_id: productA1._id, seller_sku: 'TSHIRT-BLK-XL' },
      { _id: 'sku-04', product_id: productA2._id, seller_sku: 'JEANS-BAGGY-30' },
      { _id: 'sku-05', product_id: productB1._id, seller_sku: 'HEADPHONE-BT-01' },
    ]);
  });

  // =========================================================================
  // 1. Authentication & RBAC Gate
  // =========================================================================
  describe('Authentication & Authorization RBAC Gates', () => {
    it('should reject unauthenticated anonymous request with 401 UNAUTHORIZED', async () => {
      const res = await request(app.getHttpServer()).get('/seller/products/export').expect(401);

      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.message).toBe('Yêu cầu xác thực tài khoản.');
    });

    it('should reject non-seller BUYER request with 403 PRODUCT_FORBIDDEN', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(buyerHeaders)
        .expect(403);

      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });

    it('should reject SELLER request when x-user-shop-scope is missing with 403 PRODUCT_FORBIDDEN', async () => {
      const headersWithoutShop = {
        'x-user-id': userSellerA,
        'x-user-roles': 'SELLER',
        'x-user-permissions': 'PRODUCT_READ',
      };

      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(headersWithoutShop)
        .expect(403);

      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
      expect(res.body.error.message).toContain('Yêu cầu phạm vi cửa hàng');
    });

    it('should allow SELLER with valid shop scope to export products with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(sellerAHeaders)
        .expect(200);

      expect(res.body.data).toHaveProperty('export_url');
      expect(res.body.data.row_count).toBe(2);
    });

    it('should allow SELLER_STAFF with valid shop scope to export products with 200 OK', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(staffAHeaders)
        .expect(200);

      expect(res.body.data).toHaveProperty('export_url');
      expect(res.body.data.row_count).toBe(2);
    });
  });

  // =========================================================================
  // 2. Multi-tenant Shop Scope Isolation
  // =========================================================================
  describe('Multi-tenant Shop Scope Isolation', () => {
    it('should only export products belonging to seller shop scope and never leak other shop products', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(sellerAHeaders)
        .expect(200);

      // Verify row count matches only Shop A products (2 products)
      expect(res.body.data.row_count).toBe(2);

      // Verify uploaded CSV buffer content
      expect(uploadedBuffers).toHaveLength(1);
      const csvStr = uploadedBuffers[0].buffer.toString('utf-8');

      expect(csvStr).toContain(productA1._id);
      expect(csvStr).toContain(productA2._id);
      expect(csvStr).not.toContain(productB1._id);
      expect(csvStr).not.toContain('Tai nghe Bluetooth');
    });
  });

  // =========================================================================
  // 3. Filters & Validations (status, q, updated_from, updated_to)
  // =========================================================================
  describe('Filters & Input Validations', () => {
    it('should filter export by product status', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export?status=ACTIVE')
        .set(sellerAHeaders)
        .expect(200);

      expect(res.body.data.row_count).toBe(1);
      const csvStr = uploadedBuffers[0].buffer.toString('utf-8');
      expect(csvStr).toContain(productA1._id);
      expect(csvStr).not.toContain(productA2._id);
    });

    it('should filter export by search keyword q (title or slug substring)', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export?q=baggy')
        .set(sellerAHeaders)
        .expect(200);

      expect(res.body.data.row_count).toBe(1);
      const csvStr = uploadedBuffers[0].buffer.toString('utf-8');
      expect(csvStr).toContain(productA2._id);
      expect(csvStr).toContain('Quần jeans baggy nam');
      expect(csvStr).not.toContain(productA1._id);
    });

    it('should filter export by date range [updated_from, updated_to]', async () => {
      const res = await request(app.getHttpServer())
        .get(
          '/seller/products/export?updated_from=2026-09-19T00:00:00Z&updated_to=2026-09-21T00:00:00Z',
        )
        .set(sellerAHeaders)
        .expect(200);

      expect(res.body.data.row_count).toBe(1);
      const csvStr = uploadedBuffers[0].buffer.toString('utf-8');
      expect(csvStr).toContain(productA1._id);
      expect(csvStr).not.toContain(productA2._id);
    });

    it('should reject invalid updated_from date with 400 PRODUCT_INVALID_INPUT', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export?updated_from=invalid-date')
        .set(sellerAHeaders)
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
      const errorStr = JSON.stringify(res.body.error);
      expect(errorStr).toMatch(/updated_from/);
    });

    it('should reject invalid updated_to date with 400 PRODUCT_INVALID_INPUT', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export?updated_to=not-a-date')
        .set(sellerAHeaders)
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
      const errorStr = JSON.stringify(res.body.error);
      expect(errorStr).toMatch(/updated_to/);
    });

    it('should reject updated_from > updated_to with 400 PRODUCT_INVALID_INPUT', async () => {
      const res = await request(app.getHttpServer())
        .get(
          '/seller/products/export?updated_from=2026-09-25T00:00:00Z&updated_to=2026-09-20T00:00:00Z',
        )
        .set(sellerAHeaders)
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
      expect(res.body.error.message).toContain('updated_from không được lớn hơn updated_to');
    });
  });

  // =========================================================================
  // 4. Row Limit Protection (PRODUCT_EXPORT_MAX_ROWS = 10,000)
  // =========================================================================
  describe('Row Limit Protection', () => {
    it('should reject export with 400 PRODUCT_EXPORT_TOO_LARGE when matching count exceeds 10,000 rows', async () => {
      inMemoryProductRepo.setForcedCount(PRODUCT_EXPORT_MAX_ROWS + 1); // 10001

      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(sellerAHeaders)
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_EXPORT_TOO_LARGE');
      expect(res.body.error.message).toContain('Kết quả xuất file quá lớn');
      expect(uploadedBuffers).toHaveLength(0);
    });
  });

  // =========================================================================
  // 5. CSV File Structure, Column Headers & Escaping
  // =========================================================================
  describe('CSV Formatting & Structure Standards', () => {
    it('should format CSV with UTF-8 BOM, exact standard columns and properly escaped content', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export?format=csv')
        .set(sellerAHeaders)
        .expect(200);

      expect(res.body.data.format).toBe(ExportFormat.CSV);
      expect(uploadedBuffers).toHaveLength(1);

      const { buffer, contentType, key } = uploadedBuffers[0];
      expect(contentType).toBe('text/csv; charset=utf-8');
      expect(key).toMatch(new RegExp(`^exports/products-shop-${shopA}-\\d{14}\\.csv$`));

      const content = buffer.toString('utf-8');

      // UTF-8 BOM check
      expect(content.startsWith('\uFEFF')).toBe(true);

      const lines = content.replace('\uFEFF', '').split('\n');
      expect(lines.length).toBe(3); // 1 header + 2 product rows

      // Exact Header from API Spec §3.2
      const expectedHeader =
        'product_id,title,slug,status,primary_category,base_price,sale_price,sku_count,updated_at';
      expect(lines[0]).toBe(expectedHeader);

      // Verify row 1 (Product A1) escaping of title with quotes and comma
      // Title: Áo thun phong cách "Oversize" cổ tròn, màu đen -> escaped with double quotes
      expect(content).toContain('"Áo thun phong cách ""Oversize"" cổ tròn, màu đen"');

      // Verify primary category resolution: 'Thời trang nam'
      expect(content).toContain('Thời trang nam');

      // Verify base_price (300000), sale_price (250000)
      expect(content).toContain('300000,250000');

      // Verify SKU count for Product A1 (has 3 skus)
      expect(content).toContain(',3,2026-09-20T12:00:00.000Z');

      // Verify SKU count for Product A2 (has 1 sku)
      expect(content).toContain(',1,2026-09-18T10:00:00.000Z');
    });
  });

  // =========================================================================
  // 6. Presigned Download URL Generation
  // =========================================================================
  describe('S3 Presigned Download URL Generation', () => {
    it('should generate presigned download URL valid for 30 minutes (1800s) with default CSV format', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export')
        .set(sellerAHeaders)
        .expect(200);

      const data = res.body.data;
      expect(data).toHaveProperty('export_url');
      expect(data).toHaveProperty('format', 'csv');
      expect(data).toHaveProperty('row_count', 2);
      expect(data).toHaveProperty('generated_at');
      expect(data).toHaveProperty('expires_at');

      // Verify S3 storage service called with correct TTL and .csv key
      expect(mockS3StorageService.generatePresignedDownloadUrl).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^exports/products-shop-${shopA}-\\d{14}\\.csv$`)),
        PRODUCT_EXPORT_URL_TTL,
      );

      // Verify expires_at is approximately 30 minutes in the future
      const generatedAt = new Date(data.generated_at).getTime();
      const expiresAt = new Date(data.expires_at).getTime();
      const diffSeconds = Math.round((expiresAt - generatedAt) / 1000);
      expect(diffSeconds).toBeCloseTo(1800, -1); // Within +-5 seconds
    });

    it('should reject export with 400 PRODUCT_INVALID_INPUT when format is xlsx (unsupported in v1)', async () => {
      const res = await request(app.getHttpServer())
        .get('/seller/products/export?format=xlsx')
        .set(sellerAHeaders)
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
      expect(res.body.error.message).toContain('Định dạng xuất không được hỗ trợ');
    });
  });
});
