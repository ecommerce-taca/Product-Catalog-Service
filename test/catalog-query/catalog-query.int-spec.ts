import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { ProductController } from '../../src/catalog-query/controllers/product.controller';
import { CatalogQueryService } from '../../src/catalog-query/services/catalog-query.service';
import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuDocument, SkuStatus } from '../../src/database/schemas/sku.schema';
import { MediaStatus, ProductMediaDocument } from '../../src/database/schemas/product-media.schema';
import { ShopSnapshotDocument } from '../../src/database/schemas/shop-snapshot.schema';
import {
  InventoryProjectionDocument,
  InventoryStockStatus,
} from '../../src/database/schemas/inventory-projection.schema';
import {
  AttributeDefinitionDocument,
  AttributeScopeType,
  AttributeType,
} from '../../src/database/schemas/attribute-definition.schema';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { INVENTORY_PROJECTION_REPOSITORY_PORT } from '../../src/projections/repositories/inventory-projection.repository.interface';
import { CategoryService } from '../../src/category/services/category.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';

// --- In-Memory Repository Harness for Catalog Query Integration ---

function matchesProductFilter(item: any, filter: any): boolean {
  if (!filter) return true;
  for (const [key, val] of Object.entries(filter)) {
    if (key === '_id') {
      if (typeof val === 'object' && val !== null && '$in' in val) {
        const inList = (val as any).$in.map(String);
        if (!inList.includes(String(item._id))) return false;
      } else {
        if (String(item._id) !== String(val)) return false;
      }
    } else if (key === 'status') {
      if (item.status !== val) return false;
    } else if (key === 'archived_at') {
      if (val === null && item.archived_at !== null && item.archived_at !== undefined) return false;
      if (val !== null && item.archived_at !== val) return false;
    } else if (key === 'shop_id') {
      if (item.shop_id !== val) return false;
    } else if (key === 'price_summary.sale_price') {
      const price = Number(item.price_summary?.sale_price ?? 0);
      const condition = val as any;
      if (condition.$gte !== undefined && price < Number(condition.$gte)) return false;
      if (condition.$lte !== undefined && price > Number(condition.$lte)) return false;
    } else if (key === '$or') {
      const orConditions = val as any[];
      const orMatched = orConditions.some((cond) => matchesProductFilter(item, cond));
      if (!orMatched) return false;
    } else if (key === 'primary_category_id') {
      if (item.primary_category_id !== val) return false;
    }
  }
  return true;
}

class InMemoryProductRepo {
  private products = new Map<string, any>();

  set(doc: any): void {
    this.products.set(doc._id.toString(), { ...doc });
  }

  get(id: string): any {
    return this.products.get(id);
  }

  async findById(id: string): Promise<ProductDocument | null> {
    const p = this.products.get(id);
    return p ? ({ ...p } as unknown as ProductDocument) : null;
  }

  async find(filter: any = {}, options: any = {}): Promise<ProductDocument[]> {
    let result = Array.from(this.products.values()).filter((item) =>
      matchesProductFilter(item, filter),
    );

    if (options.sort) {
      const sortKey = Object.keys(options.sort)[0];
      const sortDir = options.sort[sortKey];
      result.sort((a, b) => {
        let valA: any;
        let valB: any;
        if (sortKey === 'price_summary.sale_price') {
          valA = Number(a.price_summary?.sale_price ?? 0);
          valB = Number(b.price_summary?.sale_price ?? 0);
        } else if (sortKey === 'created_at') {
          valA = new Date(a.created_at).getTime();
          valB = new Date(b.created_at).getTime();
        } else {
          valA = a[sortKey];
          valB = b[sortKey];
        }
        if (valA < valB) return sortDir === 1 ? -1 : 1;
        if (valA > valB) return sortDir === 1 ? 1 : -1;
        return 0;
      });
    }

    if (options.skip !== undefined || options.limit !== undefined) {
      const skip = options.skip || 0;
      const limit = options.limit !== undefined ? options.limit : result.length;
      result = result.slice(skip, skip + limit);
    }

    return result as unknown as ProductDocument[];
  }

  async count(filter: any = {}): Promise<number> {
    const matching = Array.from(this.products.values()).filter((item) =>
      matchesProductFilter(item, filter),
    );
    return matching.length;
  }

  clear(): void {
    this.products.clear();
  }
}

class InMemoryProductCategoryRepo {
  private assignments: any[] = [];

  set(list: any[]): void {
    this.assignments = [...list];
  }

  async find(filter: any = {}): Promise<any[]> {
    return this.assignments.filter((a) => {
      if (filter.category_id && a.category_id !== filter.category_id) return false;
      if (filter.product_id && a.product_id !== filter.product_id) return false;
      return true;
    });
  }

  clear(): void {
    this.assignments = [];
  }
}

class InMemoryShopSnapshotRepo {
  private snapshots = new Map<string, any>();

  set(snap: any): void {
    this.snapshots.set(snap.shop_id, snap);
  }

  async findByShopId(shopId: string): Promise<ShopSnapshotDocument | null> {
    const s = this.snapshots.get(shopId);
    return s ? ({ ...s } as unknown as ShopSnapshotDocument) : null;
  }

  async findByShopIds(shopIds: string[]): Promise<ShopSnapshotDocument[]> {
    return shopIds.map((id) => this.snapshots.get(id)).filter(Boolean) as ShopSnapshotDocument[];
  }

  clear(): void {
    this.snapshots.clear();
  }
}

class InMemorySkuRepo {
  private skus: any[] = [];

  set(list: any[]): void {
    this.skus = [...list];
  }

  async findByProductId(productId: string): Promise<SkuDocument[]> {
    return this.skus.filter((s) => s.product_id === productId) as unknown as SkuDocument[];
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

class InMemoryMediaRepo {
  private media: any[] = [];

  set(list: any[]): void {
    this.media = [...list];
  }

  async findByProductId(productId: string): Promise<ProductMediaDocument[]> {
    return this.media.filter(
      (m) => m.product_id === productId,
    ) as unknown as ProductMediaDocument[];
  }

  async findByProductIds(productIds: string[]): Promise<ProductMediaDocument[]> {
    const idSet = new Set(productIds.map(String));
    return this.media.filter(
      (m) => idSet.has(String(m.product_id)) && m.status !== MediaStatus.DELETED,
    ) as unknown as ProductMediaDocument[];
  }

  clear(): void {
    this.media = [];
  }
}

class InMemoryInventoryProjectionRepo {
  private projections: any[] = [];

  set(list: any[]): void {
    this.projections = [...list];
  }

  async findByProductId(productId: string): Promise<InventoryProjectionDocument[]> {
    return this.projections.filter(
      (p) => p.product_id === productId,
    ) as unknown as InventoryProjectionDocument[];
  }

  async findByProductIds(productIds: string[]): Promise<InventoryProjectionDocument[]> {
    const idSet = new Set(productIds.map(String));
    return this.projections.filter((p) =>
      idSet.has(String(p.product_id)),
    ) as unknown as InventoryProjectionDocument[];
  }

  async findBySkuId(skuId: string): Promise<InventoryProjectionDocument | null> {
    const p = this.projections.find((item) => item.sku_id === skuId);
    return p ? (p as unknown as InventoryProjectionDocument) : null;
  }

  clear(): void {
    this.projections = [];
  }
}

class InMemoryAttributeDefinitionRepo {
  private definitions: any[] = [];

  set(list: any[]): void {
    this.definitions = [...list];
  }

  async findByScope(scope: string, scopeId?: string): Promise<AttributeDefinitionDocument[]> {
    return this.definitions.filter((d) => {
      if (d.scope !== scope) return false;
      if (scopeId && d.scope_id && d.scope_id !== scopeId) return false;
      return true;
    }) as unknown as AttributeDefinitionDocument[];
  }

  clear(): void {
    this.definitions = [];
  }
}

/**
 * Integration Test Suite for Public Catalog Read APIs, Hydration & Search Integration [TEST-B08]
 *
 * References:
 * - Test Plan: product-catalog-docs/docs/test/product-catalog.md §3.1 (PC-API-001..006, PC-API-009, 009b, 009c)
 * - LLD: product-catalog-docs/docs/lld/product-catalog.md §3.7 (Public Read & Batch Hydration)
 * - API Spec: product-catalog-docs/docs/api/product-catalog.md §3.1
 */
describe('Catalog Query & Batch Hydration Integration Spec [TEST-B08]', () => {
  let app: INestApplication;

  const inMemoryProductRepo = new InMemoryProductRepo();
  const inMemoryProductCategoryRepo = new InMemoryProductCategoryRepo();
  const inMemoryShopSnapshotRepo = new InMemoryShopSnapshotRepo();
  const inMemorySkuRepo = new InMemorySkuRepo();
  const inMemoryMediaRepo = new InMemoryMediaRepo();
  const inMemoryInventoryProjectionRepo = new InMemoryInventoryProjectionRepo();
  const inMemoryAttributeDefinitionRepo = new InMemoryAttributeDefinitionRepo();

  const mockCategoryService = {
    resolveEffectiveTaxRate: jest.fn(),
  };

  const mockS3StorageService = {
    getPublicUrl: jest.fn((key: string) => `https://cdn.taca.test/${key}`),
  };

  // Test Fixtures
  const shopA = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopB = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const shopSuspended = '01912f30-7a1b-7c12-9c55-8b1c34a6d099';

  const categoryElectronics = '01912f20-7a1b-7c12-9c55-8b1c34a6d101';
  const categoryFashion = '01912f20-7a1b-7c12-9c55-8b1c34a6d102';
  const categoryChild = '01912f20-7a1b-7c12-9c55-8b1c34a6d103';

  const activeProduct1 = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d001',
    shop_id: shopA,
    title: 'Bàn phím cơ không dây Taca Mech Pro',
    slug: 'ban-phim-co-khong-day-taca-mech-pro',
    description: 'Bàn phím cơ Bluetooth 5.0 3 modes, switch hot-swap gõ cực êm.',
    brand: 'Taca Gaming',
    status: ProductStatus.ACTIVE,
    primary_category_id: categoryElectronics,
    price_summary: {
      base_price: BigInt(1500000),
      sale_price: BigInt(1250000),
      currency: 'VND',
    },
    rating_summary: {
      avg: 4.8,
      count: 42,
    },
    archived_at: null,
    created_at: new Date('2026-09-01T10:00:00Z'),
    updated_at: new Date('2026-09-01T10:00:00Z'),
    version: 3n,
  };

  const activeProduct2 = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d002',
    shop_id: shopA,
    title: 'Chuột công thái học Taca Master Mouse',
    slug: 'chuot-cong-thai-hoc-taca-master-mouse',
    description: 'Chuột không dây công thái học giảm đau cổ tay chuyên văn phòng.',
    brand: 'Taca Office',
    status: ProductStatus.ACTIVE,
    primary_category_id: categoryElectronics,
    price_summary: {
      base_price: BigInt(800000),
      sale_price: BigInt(650000),
      currency: 'VND',
    },
    rating_summary: {
      avg: 4.6,
      count: 18,
    },
    archived_at: null,
    created_at: new Date('2026-09-05T10:00:00Z'),
    updated_at: new Date('2026-09-05T10:00:00Z'),
    version: 2n,
  };

  const activeProduct3 = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d003',
    shop_id: shopB,
    title: 'Áo thun cotton thoáng khí Taca Casual',
    slug: 'ao-thun-cotton-thoang-khi-taca-casual',
    description: 'Chất liệu 100% Cotton Compact định lượng 250gsm siêu mềm.',
    brand: 'Taca Fashion',
    status: ProductStatus.ACTIVE,
    primary_category_id: categoryFashion,
    price_summary: {
      base_price: BigInt(350000),
      sale_price: BigInt(299000),
      currency: 'VND',
    },
    rating_summary: {
      avg: 4.9,
      count: 120,
    },
    archived_at: null,
    created_at: new Date('2026-09-10T10:00:00Z'),
    updated_at: new Date('2026-09-10T10:00:00Z'),
    version: 1n,
  };

  const draftProduct = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d004',
    shop_id: shopA,
    title: 'Sản phẩm bản nháp chưa công bố',
    slug: 'san-pham-ban-nhap-chua-cong-bo',
    status: ProductStatus.DRAFT,
    primary_category_id: categoryElectronics,
    price_summary: { base_price: BigInt(500000), sale_price: BigInt(500000), currency: 'VND' },
    archived_at: null,
    created_at: new Date('2026-09-15T10:00:00Z'),
    updated_at: new Date('2026-09-15T10:00:00Z'),
  };

  const blockedProduct = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d005',
    shop_id: shopA,
    title: 'Sản phẩm vi phạm bị khóa kiểm duyệt',
    slug: 'san-pham-vi-pham-bi-khoa-kiem-duyet',
    status: ProductStatus.BLOCKED,
    primary_category_id: categoryElectronics,
    price_summary: { base_price: BigInt(500000), sale_price: BigInt(500000), currency: 'VND' },
    archived_at: null,
    created_at: new Date('2026-09-16T10:00:00Z'),
    updated_at: new Date('2026-09-16T10:00:00Z'),
  };

  const archivedProduct = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d006',
    shop_id: shopA,
    title: 'Sản phẩm đã lưu trữ ngừng kinh doanh',
    slug: 'san-pham-da-luu-tru-ngung-kinh-doanh',
    status: ProductStatus.ARCHIVED,
    primary_category_id: categoryElectronics,
    price_summary: { base_price: BigInt(500000), sale_price: BigInt(500000), currency: 'VND' },
    archived_at: new Date('2026-09-20T10:00:00Z'),
    created_at: new Date('2026-09-02T10:00:00Z'),
    updated_at: new Date('2026-09-20T10:00:00Z'),
  };

  const productShopSuspended = {
    _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d007',
    shop_id: shopSuspended,
    title: 'Sản phẩm của shop bị đình chỉ',
    slug: 'san-pham-cua-shop-bi-dinh-chi',
    status: ProductStatus.ACTIVE,
    primary_category_id: categoryFashion,
    price_summary: { base_price: BigInt(400000), sale_price: BigInt(400000), currency: 'VND' },
    archived_at: null,
    created_at: new Date('2026-09-12T10:00:00Z'),
    updated_at: new Date('2026-09-12T10:00:00Z'),
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ProductController],
      providers: [
        CatalogQueryService,
        { provide: 'ProductRepositoryPort', useValue: inMemoryProductRepo },
        { provide: SHOP_SNAPSHOT_REPOSITORY_PORT, useValue: inMemoryShopSnapshotRepo },
        { provide: 'ProductCategoryRepositoryPort', useValue: inMemoryProductCategoryRepo },
        { provide: 'SkuRepositoryPort', useValue: inMemorySkuRepo },
        { provide: 'ProductMediaRepositoryPort', useValue: inMemoryMediaRepo },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: inMemoryInventoryProjectionRepo,
        },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: inMemoryAttributeDefinitionRepo,
        },
        { provide: CategoryService, useValue: mockCategoryService },
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
    inMemoryProductCategoryRepo.clear();
    inMemoryShopSnapshotRepo.clear();
    inMemorySkuRepo.clear();
    inMemoryMediaRepo.clear();
    inMemoryInventoryProjectionRepo.clear();
    inMemoryAttributeDefinitionRepo.clear();
    jest.clearAllMocks();

    // Default Seed Data
    inMemoryProductRepo.set(activeProduct1);
    inMemoryProductRepo.set(activeProduct2);
    inMemoryProductRepo.set(activeProduct3);
    inMemoryProductRepo.set(draftProduct);
    inMemoryProductRepo.set(blockedProduct);
    inMemoryProductRepo.set(archivedProduct);
    inMemoryProductRepo.set(productShopSuspended);

    inMemoryShopSnapshotRepo.set({
      shop_id: shopA,
      name: 'Taca Tech Official Store',
      slug: 'taca-tech-official',
      logo_url: 'https://cdn.taca.test/logos/shop-a.png',
      shop_status: 'ACTIVE',
    });

    inMemoryShopSnapshotRepo.set({
      shop_id: shopB,
      name: 'Taca Fashion House',
      slug: 'taca-fashion-house',
      logo_url: 'https://cdn.taca.test/logos/shop-b.png',
      shop_status: 'ACTIVE',
    });

    inMemoryShopSnapshotRepo.set({
      shop_id: shopSuspended,
      name: 'Suspended Fake Store',
      slug: 'suspended-fake-store',
      logo_url: null,
      shop_status: 'SUSPENDED',
    });

    mockCategoryService.resolveEffectiveTaxRate.mockImplementation(async (catId: string) => {
      if (catId === categoryElectronics) return 1000; // 10%
      if (catId === categoryFashion) return 800; // 8%
      if (catId === categoryChild) return 1000; // Inherited 10%
      return 0;
    });

    // Seed Media for Product 1 (Cover + Gallery)
    inMemoryMediaRepo.set([
      {
        _id: 'media-01',
        product_id: activeProduct1._id,
        object_key: 'products/media-01.webp',
        content_type: 'image/webp',
        is_cover: true,
        sort_order: 0,
        status: MediaStatus.READY,
        created_at: new Date('2026-09-01T10:00:00Z'),
      },
      {
        _id: 'media-02',
        product_id: activeProduct1._id,
        object_key: 'products/media-02.webp',
        content_type: 'image/webp',
        is_cover: false,
        sort_order: 1,
        status: MediaStatus.READY,
        created_at: new Date('2026-09-01T10:05:00Z'),
      },
    ]);

    // Seed SKUs for Product 1
    inMemorySkuRepo.set([
      {
        _id: 'sku-01',
        product_id: activeProduct1._id,
        seller_sku: 'MECH-PRO-RED',
        attributes: { switch_type: 'Red Linear', color: 'Midnight Black' },
        price_override: null,
        status: SkuStatus.ACTIVE,
      },
      {
        _id: 'sku-02',
        product_id: activeProduct1._id,
        seller_sku: 'MECH-PRO-BLUE',
        attributes: { switch_type: 'Blue Clicky', color: 'Glacier White' },
        price_override: BigInt(1350000),
        status: SkuStatus.ACTIVE,
      },
    ]);

    // Seed Inventory Projections for Product 1
    inMemoryInventoryProjectionRepo.set([
      {
        sku_id: 'sku-01',
        product_id: activeProduct1._id,
        stock_status: InventoryStockStatus.IN_STOCK,
        available_qty_snapshot: BigInt(25),
        as_of: new Date(),
      },
      {
        sku_id: 'sku-02',
        product_id: activeProduct1._id,
        stock_status: InventoryStockStatus.LOW_STOCK,
        available_qty_snapshot: BigInt(3),
        as_of: new Date(),
      },
    ]);

    // Seed Attribute Definitions for Product 1
    inMemoryAttributeDefinitionRepo.set([
      {
        key: 'switch_type',
        label: 'Loại Switch',
        type: AttributeType.ENUM,
        allowed_values: ['Red Linear', 'Blue Clicky', 'Brown Tactile'],
        scope: AttributeScopeType.PRODUCT,
        scope_id: activeProduct1._id,
      },
      {
        key: 'color',
        label: 'Màu sắc',
        type: AttributeType.STRING,
        allowed_values: [],
        scope: AttributeScopeType.PRODUCT,
        scope_id: activeProduct1._id,
      },
    ]);
  });

  // =========================================================================
  // PC-API-001: Public Catalog Listing Default
  // =========================================================================
  describe('[PC-API-001] GET /products - Public Listing Defaults', () => {
    it('should return HTTP 200 with active products only, default pagination page=1, size=20, and full card fields', async () => {
      const res = await request(app.getHttpServer()).get('/products').expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body).toHaveProperty('meta');

      const items = res.body.data;
      expect(Array.isArray(items)).toBe(true);

      // Must only contain ACTIVE products (P1, P2, P3, and suspended shop's product is also in repo, but P4 DRAFT, P5 BLOCKED, P6 ARCHIVED must NOT exist)
      const ids = items.map((p: any) => p.product_id);
      expect(ids).toContain(activeProduct1._id);
      expect(ids).toContain(activeProduct2._id);
      expect(ids).toContain(activeProduct3._id);
      expect(ids).not.toContain(draftProduct._id);
      expect(ids).not.toContain(blockedProduct._id);
      expect(ids).not.toContain(archivedProduct._id);

      // Verify meta pagination
      expect(res.body.meta.page).toBe(1);
      expect(res.body.meta.size).toBe(20);
      expect(res.body.meta.total).toBe(4); // 4 active products
      expect(res.body.meta.total_pages).toBe(1);

      // Verify full card schema on activeProduct1
      const card = items.find((p: any) => p.product_id === activeProduct1._id);
      expect(card).toBeDefined();
      expect(card.title).toBe(activeProduct1.title);
      expect(card.slug).toBe(activeProduct1.slug);
      expect(card.primary_category_id).toBe(categoryElectronics);
      expect(card.tax_rate_bps).toBe(1000);

      // Shop snapshot hydration
      expect(card.shop).toEqual({
        shop_id: shopA,
        name: 'Taca Tech Official Store',
        slug: 'taca-tech-official',
        logo_url: 'https://cdn.taca.test/logos/shop-a.png',
      });

      // Price object
      expect(card.price).toEqual({
        base_price: 1500000,
        sale_price: 1250000,
        currency: 'VND',
      });

      // Cover media
      expect(card.cover_media).toEqual({
        media_id: 'media-01',
        url: 'https://cdn.taca.test/products/media-01.webp',
        content_type: 'image/webp',
      });

      // Rating summary
      expect(card.rating_summary).toEqual({
        avg: 4.8,
        count: 42,
      });

      // Stock display snapshot
      expect(card.stock_display).toHaveProperty('status');
      expect(card.stock_display).toHaveProperty('as_of');
      expect(['IN_STOCK', 'LOW_STOCK']).toContain(card.stock_display.status);
    });
  });

  // =========================================================================
  // PC-API-002: Validation Input Edge Cases
  // =========================================================================
  describe('[PC-API-002] GET /products - Validation Input Edge Cases', () => {
    it('should reject size > 100 with 400 PRODUCT_INVALID_INPUT', async () => {
      const res = await request(app.getHttpServer()).get('/products?size=101').expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
    });

    it('should reject size <= 0 with 400 PRODUCT_INVALID_INPUT', async () => {
      const res1 = await request(app.getHttpServer()).get('/products?size=0').expect(400);
      expect(res1.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      const res2 = await request(app.getHttpServer()).get('/products?size=-5').expect(400);
      expect(res2.body.error.code).toBe('PRODUCT_INVALID_INPUT');
    });

    it('should reject page <= 0 with 400 PRODUCT_INVALID_INPUT', async () => {
      const res1 = await request(app.getHttpServer()).get('/products?page=0').expect(400);
      expect(res1.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      const res2 = await request(app.getHttpServer()).get('/products?page=-1').expect(400);
      expect(res2.body.error.code).toBe('PRODUCT_INVALID_INPUT');
    });

    it('should reject negative min_price or max_price with 400 PRODUCT_INVALID_INPUT', async () => {
      const res1 = await request(app.getHttpServer()).get('/products?min_price=-1000').expect(400);
      expect(res1.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      const res2 = await request(app.getHttpServer()).get('/products?max_price=-500').expect(400);
      expect(res2.body.error.code).toBe('PRODUCT_INVALID_INPUT');
    });

    it('should reject min_price > max_price with 400 PRODUCT_INVALID_INPUT', async () => {
      const res = await request(app.getHttpServer())
        .get('/products?min_price=1000000&max_price=500000')
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
      expect(res.body.error.message).toContain('min_price không được lớn hơn max_price');
    });

    it('should reject decimal numbers for page, size, min_price with 400 PRODUCT_INVALID_INPUT', async () => {
      const resPage = await request(app.getHttpServer()).get('/products?page=1.5').expect(400);
      expect(resPage.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      const resSize = await request(app.getHttpServer()).get('/products?size=10.5').expect(400);
      expect(resSize.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      const resPrice = await request(app.getHttpServer())
        .get('/products?min_price=100.5')
        .expect(400);
      expect(resPrice.body.error.code).toBe('PRODUCT_INVALID_INPUT');
    });
  });

  // =========================================================================
  // PC-API-003: Filtering & Sorting
  // =========================================================================
  describe('[PC-API-003] GET /products - Filtering & Sorting', () => {
    it('should filter products by primary category_id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products?category_id=${categoryFashion}`)
        .expect(200);

      expect(res.body.data.length).toBeGreaterThan(0);
      for (const item of res.body.data) {
        expect(item.primary_category_id).toBe(categoryFashion);
      }
    });

    it('should filter products by secondary category assignments in product_categories', async () => {
      inMemoryProductCategoryRepo.set([
        { product_id: activeProduct1._id, category_id: categoryFashion },
      ]);

      const res = await request(app.getHttpServer())
        .get(`/products?category_id=${categoryFashion}`)
        .expect(200);

      const ids = res.body.data.map((p: any) => p.product_id);
      expect(ids).toContain(activeProduct1._id);
      expect(ids).toContain(activeProduct3._id);
    });

    it('should filter products by shop_id', async () => {
      const res = await request(app.getHttpServer()).get(`/products?shop_id=${shopB}`).expect(200);

      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].product_id).toBe(activeProduct3._id);
      expect(res.body.data[0].shop.shop_id).toBe(shopB);
    });

    it('should filter products by price range [min_price, max_price]', async () => {
      const res = await request(app.getHttpServer())
        .get('/products?min_price=500000&max_price=1000000')
        .expect(200);

      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].product_id).toBe(activeProduct2._id);
      expect(res.body.data[0].price.sale_price).toBe(650000);
    });

    it('should sort products by price ascending (price_asc)', async () => {
      const res = await request(app.getHttpServer()).get('/products?sort=price_asc').expect(200);

      const prices = res.body.data.map((p: any) => p.price.sale_price);
      for (let i = 0; i < prices.length - 1; i++) {
        expect(prices[i]).toBeLessThanOrEqual(prices[i + 1]);
      }
    });

    it('should sort products by price descending (price_desc)', async () => {
      const res = await request(app.getHttpServer()).get('/products?sort=price_desc').expect(200);

      const prices = res.body.data.map((p: any) => p.price.sale_price);
      for (let i = 0; i < prices.length - 1; i++) {
        expect(prices[i]).toBeGreaterThanOrEqual(prices[i + 1]);
      }
    });

    it('should sort products by newest (created_at descending)', async () => {
      const res = await request(app.getHttpServer()).get('/products?sort=newest').expect(200);

      const ids = res.body.data.map((p: any) => p.product_id);
      // P3 created Sep 10, P2 created Sep 5, P1 created Sep 1
      const idxP3 = ids.indexOf(activeProduct3._id);
      const idxP2 = ids.indexOf(activeProduct2._id);
      const idxP1 = ids.indexOf(activeProduct1._id);
      expect(idxP3).toBeLessThan(idxP2);
      expect(idxP2).toBeLessThan(idxP1);
    });
  });

  // =========================================================================
  // PC-API-004: Product Detail Page (PDP)
  // =========================================================================
  describe('[PC-API-004] GET /products/:productId - Full PDP Details', () => {
    it('should return HTTP 200 with complete PDP response', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products/${activeProduct1._id}`)
        .expect(200);

      const pdp = res.body.data;
      expect(pdp.product_id).toBe(activeProduct1._id);
      expect(pdp.status).toBe(ProductStatus.ACTIVE);
      expect(pdp.title).toBe(activeProduct1.title);
      expect(pdp.slug).toBe(activeProduct1.slug);
      expect(pdp.description).toBe(activeProduct1.description);
      expect(pdp.brand).toBe(activeProduct1.brand);
      expect(pdp.primary_category_id).toBe(categoryElectronics);
      expect(pdp.tax_rate_bps).toBe(1000);

      // Shop snapshot
      expect(pdp.shop).toEqual({
        shop_id: shopA,
        name: 'Taca Tech Official Store',
        slug: 'taca-tech-official',
        logo_url: 'https://cdn.taca.test/logos/shop-a.png',
      });

      // Price
      expect(pdp.price).toEqual({
        base_price: 1500000,
        sale_price: 1250000,
        currency: 'VND',
      });

      // Attributes with dynamic definitions
      expect(pdp.attributes).toHaveLength(2);
      const switchAttr = pdp.attributes.find((a: any) => a.key === 'switch_type');
      expect(switchAttr).toBeDefined();
      expect(switchAttr.type).toBe('ENUM');
      expect(switchAttr.values).toEqual(['Red Linear', 'Blue Clicky', 'Brown Tactile']);

      const colorAttr = pdp.attributes.find((a: any) => a.key === 'color');
      expect(colorAttr).toBeDefined();
      expect(colorAttr.values).toEqual(expect.arrayContaining(['Midnight Black', 'Glacier White']));

      // Active SKUs with projections and overrides
      expect(pdp.skus).toHaveLength(2);
      const sku1 = pdp.skus.find((s: any) => s.seller_sku === 'MECH-PRO-RED');
      expect(sku1).toBeDefined();
      expect(sku1.price.sale_price).toBe(1250000); // Product fallback
      expect(sku1.stock_display.status).toBe('IN_STOCK');
      expect(sku1.stock_display.available_qty_snapshot).toBe(25);

      const sku2 = pdp.skus.find((s: any) => s.seller_sku === 'MECH-PRO-BLUE');
      expect(sku2).toBeDefined();
      expect(sku2.price.sale_price).toBe(1350000); // Price override
      expect(sku2.stock_display.status).toBe('LOW_STOCK');
      expect(sku2.stock_display.available_qty_snapshot).toBe(3);

      // Media ready, cover first
      expect(pdp.media).toHaveLength(2);
      expect(pdp.media[0].is_cover).toBe(true);
      expect(pdp.media[0].media_id).toBe('media-01');
      expect(pdp.media[1].is_cover).toBe(false);
      expect(pdp.media[1].media_id).toBe('media-02');
    });

    it('should reflect STALE stock_display status on SKU when as_of is older than 60s (SF-02)', async () => {
      inMemoryInventoryProjectionRepo.set([
        {
          _id: '01912f80-0000-7000-8000-000000000099',
          sku_id: 'sku-01',
          product_id: activeProduct1._id,
          available_qty_snapshot: BigInt(10),
          stock_status: InventoryStockStatus.IN_STOCK,
          as_of: new Date(Date.now() - 70000), // 70s ago (> 60s)
        },
      ]);

      const res = await request(app.getHttpServer())
        .get(`/products/${activeProduct1._id}`)
        .expect(200);

      const sku = res.body.data.skus.find((s: any) => s.sku_id === 'sku-01');
      expect(sku).toBeDefined();
      expect(sku.stock_display.status).toBe('STALE');
    });
  });

  // =========================================================================
  // PC-API-005: Security Policy & Zero Leak on Inactive / Nonexistent
  // =========================================================================
  describe('[PC-API-005] GET /products/:productId - No Existence Leak for Non-Public', () => {
    it('should return 404 PRODUCT_NOT_FOUND for DRAFT product', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products/${draftProduct._id}`)
        .expect(404);

      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
      expect(res.body.error.message).toBe('Không tìm thấy sản phẩm.');
    });

    it('should return 404 PRODUCT_NOT_FOUND for BLOCKED product', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products/${blockedProduct._id}`)
        .expect(404);

      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
      expect(res.body.error.message).toBe('Không tìm thấy sản phẩm.');
    });

    it('should return 404 PRODUCT_NOT_FOUND for ARCHIVED product', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products/${archivedProduct._id}`)
        .expect(404);

      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
      expect(res.body.error.message).toBe('Không tìm thấy sản phẩm.');
    });

    it('should return 404 PRODUCT_NOT_FOUND for nonexistent UUID', async () => {
      const res = await request(app.getHttpServer())
        .get('/products/01912f99-9999-7999-9999-999999999999')
        .expect(404);

      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
      expect(res.body.error.message).toBe('Không tìm thấy sản phẩm.');
    });
  });

  // =========================================================================
  // PC-API-006: Stock Projection Display Status Lifecycle
  // =========================================================================
  describe('[PC-API-006] Stock Projection Display Metadata Handling', () => {
    it('should return UNKNOWN when product has no inventory projections', async () => {
      // Product 2 has no inventory projection records seeded
      const res = await request(app.getHttpServer()).get('/products').expect(200);

      const card2 = res.body.data.find((p: any) => p.product_id === activeProduct2._id);
      expect(card2.stock_display.status).toBe('UNKNOWN');
      expect(card2.stock_display.as_of).toBeNull();
    });

    it('should return OUT_OF_STOCK when all projections have quantity 0 or status OUT_OF_STOCK', async () => {
      inMemoryInventoryProjectionRepo.set([
        {
          sku_id: 'sku-01',
          product_id: activeProduct1._id,
          stock_status: InventoryStockStatus.OUT_OF_STOCK,
          available_qty_snapshot: BigInt(0),
          as_of: new Date(),
        },
      ]);

      const res = await request(app.getHttpServer()).get('/products').expect(200);

      const card1 = res.body.data.find((p: any) => p.product_id === activeProduct1._id);
      expect(card1.stock_display.status).toBe('OUT_OF_STOCK');
    });

    it('should return STALE when as_of is older than 60 seconds or status is STALE', async () => {
      const staleDate = new Date(Date.now() - 120000); // 2 minutes ago
      inMemoryInventoryProjectionRepo.set([
        {
          sku_id: 'sku-01',
          product_id: activeProduct1._id,
          stock_status: InventoryStockStatus.IN_STOCK,
          available_qty_snapshot: BigInt(50),
          as_of: staleDate,
        },
      ]);

      const res = await request(app.getHttpServer()).get('/products').expect(200);

      const card1 = res.body.data.find((p: any) => p.product_id === activeProduct1._id);
      expect(card1.stock_display.status).toBe('STALE');
    });
  });

  // =========================================================================
  // PC-API-009: Shop Products & Suspended Policy
  // =========================================================================
  describe('[PC-API-009] GET /shops/:shopId/products - Shop Scoped Query & Suspended Policy', () => {
    it('should return products for active shop', async () => {
      const res = await request(app.getHttpServer()).get(`/shops/${shopA}/products`).expect(200);

      expect(res.body.data.length).toBe(2);
      for (const p of res.body.data) {
        expect(p.shop.shop_id).toBe(shopA);
      }
    });

    it('should throw 403 PRODUCT_SHOP_SUSPENDED when shop is SUSPENDED', async () => {
      const res = await request(app.getHttpServer())
        .get(`/shops/${shopSuspended}/products`)
        .expect(403);

      expect(res.body.error.code).toBe('PRODUCT_SHOP_SUSPENDED');
      expect(res.body.error.message).toContain('Cửa hàng đang bị tạm ngưng');
    });
  });

  // =========================================================================
  // PC-API-009b: Batch Hydration (Cart / Favorites)
  // =========================================================================
  describe('[PC-API-009b] GET /products?product_ids= - Batch Hydration', () => {
    it('should hydrate active products and preserve client request order', async () => {
      const requestedIds = [activeProduct3._id, activeProduct1._id];
      const res = await request(app.getHttpServer())
        .get(`/products?product_ids=${requestedIds.join(',')}`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[0].product_id).toBe(activeProduct3._id);
      expect(res.body.data[1].product_id).toBe(activeProduct1._id);
    });

    it('should gracefully omit non-existent, DRAFT, BLOCKED, ARCHIVED IDs without errors', async () => {
      const mixedIds = [
        '01912f99-nonexistent-1',
        activeProduct2._id,
        draftProduct._id,
        blockedProduct._id,
        activeProduct1._id,
        archivedProduct._id,
      ];

      const res = await request(app.getHttpServer())
        .get(`/products?product_ids=${mixedIds.join(',')}`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
      const returnedIds = res.body.data.map((p: any) => p.product_id);
      expect(returnedIds).toEqual([activeProduct2._id, activeProduct1._id]);
    });

    it('should reject batch request when product_ids count exceeds 100 with 400 PRODUCT_INVALID_INPUT', async () => {
      const excessIds = Array.from({ length: 101 }, (_, i) => `01912f99-uuid-${i + 1}`).join(',');

      const res = await request(app.getHttpServer())
        .get(`/products?product_ids=${excessIds}`)
        .expect(400);

      expect(res.body.error.code).toBe('PRODUCT_INVALID_INPUT');
      expect(res.body.error.message).toContain('Số lượng product_ids tối đa là 100');
    });

    it('should return empty list when product_ids is empty', async () => {
      const res = await request(app.getHttpServer()).get('/products?product_ids=').expect(200);

      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it('should ignore secondary filters (shop_id, category_id, price range) when product_ids is passed (SG-01)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/products?product_ids=${activeProduct1._id}&shop_id=${shopB}&min_price=9999999`)
        .expect(200);

      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].product_id).toBe(activeProduct1._id);
    });
  });

  // =========================================================================
  // PC-API-009c: Inherited Tax Rate Resolution
  // =========================================================================
  describe('[PC-API-009c] Tax Rate Resolution Inheritance', () => {
    it('should inherit tax_rate_bps from root category when child category is null', async () => {
      const productWithChildCat = {
        _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d099',
        shop_id: shopA,
        title: 'Bàn phím cơ Mini 60% Taca Compact',
        slug: 'ban-phim-co-mini-60-taca-compact',
        description: 'Bàn phím cơ nhỏ gọn 61 phím.',
        brand: 'Taca Gaming',
        status: ProductStatus.ACTIVE,
        primary_category_id: categoryChild, // Node con, tax_rate_bps null -> thừa kế 1000 bps từ Electronics
        price_summary: { base_price: BigInt(1000000), sale_price: BigInt(900000), currency: 'VND' },
        archived_at: null,
        created_at: new Date('2026-09-20T10:00:00Z'),
        updated_at: new Date('2026-09-20T10:00:00Z'),
      };
      inMemoryProductRepo.set(productWithChildCat);

      const res = await request(app.getHttpServer())
        .get(`/products/${productWithChildCat._id}`)
        .expect(200);

      expect(res.body.data.tax_rate_bps).toBe(1000);
      expect(mockCategoryService.resolveEffectiveTaxRate).toHaveBeenCalledWith(categoryChild);
    });
  });
});
