import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { SellerPublishController } from '../../src/publish-policy/controllers/seller-publish.controller';
import { PublishPolicyService } from '../../src/publish-policy/services/publish-policy.service';
import { CategoryTreeService } from '../../src/category/services/category-tree.service';
import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { CategoryDocument, CategoryStatus } from '../../src/database/schemas/category.schema';
import { SkuDocument, SkuStatus } from '../../src/database/schemas/sku.schema';
import { MediaStatus, ProductMediaDocument } from '../../src/database/schemas/product-media.schema';
import {
  KycStatus,
  ShopSnapshotDocument,
  ShopStatus,
} from '../../src/database/schemas/shop-snapshot.schema';
import {
  InventoryProjectionDocument,
  InventoryStockStatus,
} from '../../src/database/schemas/inventory-projection.schema';
import { AuditAction, AuditTargetType } from '../../src/database/schemas/catalog-audit.schema';
import { AggregateType } from '../../src/database/schemas/outbox-event.schema';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { CatalogAuditRepositoryPort } from '../../src/audit/repositories/audit.repository.interface';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { INVENTORY_PROJECTION_REPOSITORY_PORT } from '../../src/projections/repositories/inventory-projection.repository.interface';

// --- In-Memory Repositories for Integration Test Double Harness ---

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

  async atomicCasUpdate(
    id: string,
    shopId: string,
    expectedVersion: number,
    updateFields: any,
    _session: any,
  ): Promise<ProductDocument | null> {
    const existing = this.products.get(id);
    if (!existing) return null;
    if (existing.shop_id !== shopId) return null;
    if (Number(existing.version) !== Number(expectedVersion)) return null;

    const nextVer = BigInt(existing.version) + 1n;
    const updated = {
      ...existing,
      ...updateFields,
      version: nextVer,
      updated_at: new Date(),
    };
    this.products.set(id, updated);
    return { ...updated } as unknown as ProductDocument;
  }

  clear(): void {
    this.products.clear();
  }
}

class InMemoryProductCategoryRepo {
  private assignments = new Map<string, any[]>();

  setForProduct(productId: string, assigns: any[]): void {
    this.assignments.set(productId, assigns);
  }

  async findByProductId(productId: string): Promise<any[]> {
    return this.assignments.get(productId) || [];
  }

  clear(): void {
    this.assignments.clear();
  }
}

class InMemoryCategoryRepo {
  private categories = new Map<string, any>();

  set(cat: any): void {
    this.categories.set(cat._id.toString(), cat);
  }

  async findById(id: string): Promise<CategoryDocument | null> {
    const c = this.categories.get(id);
    return c ? ({ ...c } as unknown as CategoryDocument) : null;
  }

  clear(): void {
    this.categories.clear();
  }
}

class InMemorySkuRepo {
  private skus = new Map<string, any[]>();

  setForProduct(productId: string, skuList: any[]): void {
    this.skus.set(productId, skuList);
  }

  async findByProductId(productId: string): Promise<SkuDocument[]> {
    return (this.skus.get(productId) || []) as unknown as SkuDocument[];
  }

  clear(): void {
    this.skus.clear();
  }
}

class InMemoryMediaRepo {
  private media = new Map<string, any[]>();

  setForProduct(productId: string, mediaList: any[]): void {
    this.media.set(productId, mediaList);
  }

  async findByProductId(productId: string): Promise<ProductMediaDocument[]> {
    return (this.media.get(productId) || []) as unknown as ProductMediaDocument[];
  }

  async findActiveByProductId(productId: string): Promise<ProductMediaDocument[]> {
    return (this.media.get(productId) || []).filter(
      (m) => m.status !== MediaStatus.DELETED,
    ) as unknown as ProductMediaDocument[];
  }

  clear(): void {
    this.media.clear();
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

  clear(): void {
    this.snapshots.clear();
  }
}

class InMemoryInventoryProjectionRepo {
  private projections = new Map<string, any[]>();

  setForProduct(productId: string, list: any[]): void {
    this.projections.set(productId, list);
  }

  async findByProductId(productId: string): Promise<InventoryProjectionDocument[]> {
    return (this.projections.get(productId) || []) as unknown as InventoryProjectionDocument[];
  }

  clear(): void {
    this.projections.clear();
  }
}

/**
 * Integration Test Suite for Publish Policy Engine & State Transitions [TEST-B07]
 *
 * References:
 * - Test Plan: product-catalog-docs/docs/test/product-catalog.md §3.2 (PC-API-026..032, PC-SEC-001, PC-SEC-004)
 * - LLD: product-catalog-docs/docs/lld/product-catalog.md §3.4-3.5, §5.1, §5.4, §6.1-6.2, §7
 * - API Spec: product-catalog-docs/docs/api/product-catalog.md §3.2
 */
describe('Publish Policy Engine & State Machine Integration Spec [TEST-B07]', () => {
  let app: INestApplication;

  const inMemoryProductRepo = new InMemoryProductRepo();
  const inMemoryProductCategoryRepo = new InMemoryProductCategoryRepo();
  const inMemoryCategoryRepo = new InMemoryCategoryRepo();
  const inMemorySkuRepo = new InMemorySkuRepo();
  const inMemoryMediaRepo = new InMemoryMediaRepo();
  const inMemoryShopSnapshotRepo = new InMemoryShopSnapshotRepo();
  const inMemoryInventoryProjectionRepo = new InMemoryInventoryProjectionRepo();

  const savedOutboxEvents: any[] = [];
  const savedAudits: any[] = [];

  const mockOutboxRepo: OutboxRepositoryPort = {
    saveEvent: jest.fn().mockImplementation(async (event: any) => {
      savedOutboxEvents.push(event);
      return event;
    }),
  } as any;

  const mockCatalogAuditRepo: Partial<CatalogAuditRepositoryPort> = {
    record: jest.fn().mockImplementation(async (audit: any) => {
      savedAudits.push(audit);
      return audit;
    }),
  };

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation(async (cb: (session: any) => Promise<any>) => cb({})),
  };

  const mockCategoryTreeService = {
    resolveEffectiveTaxRateFromList: jest.fn().mockReturnValue(1000),
  };

  const mockAttributeDefinitionRepo = {
    findByScope: jest.fn().mockResolvedValue([]),
  };

  // Test Fixtures
  const shopA = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopB = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const userA = '01912f30-7a1b-7c12-9c55-8b1c34a6d003';
  const productId = '01912f31-7a1b-7c12-9c55-8b1c34a6d004';
  const categoryId = '01912f20-7a1b-7c12-9c55-8b1c34a6d005';
  const skuId = '01912f33-7a1b-7c12-9c55-8b1c34a6d006';
  const mediaId = '01912f32-7a1b-7c12-9c55-8b1c34a6d007';

  const sellerHeaders = {
    'x-user-id': userA,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'PRODUCT_WRITE,PRODUCT_PUBLISH',
    'x-user-shop-scope': shopA,
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SellerPublishController],
      providers: [
        PublishPolicyService,
        { provide: 'ProductRepositoryPort', useValue: inMemoryProductRepo },
        { provide: 'ProductCategoryRepositoryPort', useValue: inMemoryProductCategoryRepo },
        { provide: 'CategoryRepositoryPort', useValue: inMemoryCategoryRepo },
        { provide: CategoryTreeService, useValue: mockCategoryTreeService },
        { provide: 'SkuRepositoryPort', useValue: inMemorySkuRepo },
        { provide: 'ProductMediaRepositoryPort', useValue: inMemoryMediaRepo },
        { provide: 'AttributeDefinitionRepositoryPort', useValue: mockAttributeDefinitionRepo },
        { provide: SHOP_SNAPSHOT_REPOSITORY_PORT, useValue: inMemoryShopSnapshotRepo },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: inMemoryInventoryProjectionRepo,
        },
        { provide: OutboxRepositoryPort, useValue: mockOutboxRepo },
        { provide: CatalogAuditRepositoryPort, useValue: mockCatalogAuditRepo },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new ActorContextGuard(reflector));
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(reflector));
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const setupReadyProduct = (status = ProductStatus.DRAFT, version = 1n) => {
    inMemoryProductRepo.set({
      _id: productId,
      shop_id: shopA,
      title: 'Bàn phím cơ không dây Taca Mech',
      slug: 'ban-phim-co-khong-day-taca-mech',
      description: 'Bàn phím cơ layout 75%, kết nối Bluetooth 5.1 và 2.4GHz.',
      brand: 'Taca Mech',
      status,
      primary_category_id: categoryId,
      price_summary: {
        base_price: 1500000n,
        sale_price: 1290000n,
        currency: 'VND',
      },
      version,
      published_at: status === ProductStatus.ACTIVE ? new Date('2026-09-01T00:00:00Z') : null,
      unpublished_at: status === ProductStatus.INACTIVE ? new Date('2026-09-02T00:00:00Z') : null,
      archived_at: null,
      block_reason: null,
    });

    inMemoryProductCategoryRepo.setForProduct(productId, [
      { category_id: categoryId, is_primary: true },
    ]);

    inMemoryCategoryRepo.set({
      _id: categoryId,
      name: 'Phụ kiện máy tính',
      slug: 'phu-kien-may-tinh',
      status: CategoryStatus.ACTIVE,
      path: `/${categoryId}`,
      depth: 1,
      tax_rate_bps: 1000,
    });

    inMemorySkuRepo.setForProduct(productId, [
      {
        _id: skuId,
        product_id: productId,
        seller_sku: 'MECH-75-RED',
        variant_key: 'switch=red|color=white',
        price_override: 1290000n,
        status: SkuStatus.ACTIVE,
      },
    ]);

    inMemoryMediaRepo.setForProduct(productId, [
      {
        _id: mediaId,
        product_id: productId,
        is_cover: true,
        status: MediaStatus.READY,
        object_key: 'products/shop/cover.jpg',
      },
    ]);

    inMemoryShopSnapshotRepo.set({
      shop_id: shopA,
      name: 'Taca Official Store',
      shop_status: ShopStatus.ACTIVE,
      kyc_status: KycStatus.APPROVED,
    });

    inMemoryInventoryProjectionRepo.setForProduct(productId, [
      {
        sku_id: skuId,
        available_qty_snapshot: 100n,
        stock_status: InventoryStockStatus.IN_STOCK,
        as_of: new Date('2026-09-26T10:00:00Z'),
      },
    ]);
  };

  beforeEach(() => {
    inMemoryProductRepo.clear();
    inMemoryProductCategoryRepo.clear();
    inMemoryCategoryRepo.clear();
    inMemorySkuRepo.clear();
    inMemoryMediaRepo.clear();
    inMemoryShopSnapshotRepo.clear();
    inMemoryInventoryProjectionRepo.clear();
    savedOutboxEvents.length = 0;
    savedAudits.length = 0;
    jest.clearAllMocks();
  });

  // =========================================================================
  // PC-API-026..030: POST /seller/products/{productId}/publish
  // =========================================================================
  describe('POST /seller/products/{productId}/publish', () => {
    it('PC-API-026: Should successfully publish DRAFT product when all readiness checks and KYC APPROVED pass', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: {
          product_id: productId,
          status: 'ACTIVE',
          version: 2,
          stock_display: {
            status: 'IN_STOCK',
          },
        },
      });
      expect(res.body.data.published_at).toBeDefined();

      // Check DB CAS update
      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.ACTIVE);
      expect(dbProduct.version).toBe(2n);

      // Check Outbox event (LLD §6.1, §6.2)
      expect(savedOutboxEvents.length).toBe(1);
      const outbox = savedOutboxEvents[0];
      expect(outbox.event_type).toBe('product.published');
      expect(outbox.topic).toBe('product.events.v1');
      expect(outbox.aggregate_id).toBe(productId);
      expect(outbox.aggregate_type).toBe(AggregateType.PRODUCT);
      expect(outbox.version).toBe(2n);
      expect(outbox.actor_user_id).toBe(userA);
      expect(outbox.payload).toMatchObject({
        product_id: productId,
        shop_id: shopA,
        title: 'Bàn phím cơ không dây Taca Mech',
        slug: 'ban-phim-co-khong-day-taca-mech',
        visibility_status: 'PUBLISHED',
        primary_category_id: categoryId,
        tax_rate_bps: 1000,
        active_sku_ids: [skuId],
        version: 2,
      });

      // Check Audit record
      expect(savedAudits.length).toBe(1);
      const audit = savedAudits[0];
      expect(audit.action).toBe(AuditAction.PUBLISH);
      expect(audit.target_type).toBe(AuditTargetType.PRODUCT);
      expect(audit.target_id).toBe(productId);
      expect(audit.actor_user_id).toBe(userA);
      expect(audit.shop_id).toBe(shopA);
      expect(audit.metadata).toMatchObject({
        previous_status: ProductStatus.DRAFT,
        new_status: ProductStatus.ACTIVE,
        version: 2,
      });
    });

    it('PC-API-026b: Should successfully resume/publish INACTIVE product back to ACTIVE', async () => {
      setupReadyProduct(ProductStatus.INACTIVE, 4n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 4 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.version).toBe(5);

      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.ACTIVE);
      expect(dbProduct.version).toBe(5n);
    });

    it.each([KycStatus.PENDING, KycStatus.NEEDS_INFO, KycStatus.REJECTED, KycStatus.EXPIRED])(
      'PC-API-027: Should return 403 PRODUCT_KYC_REQUIRED when shop KYC status is %s',
      async (kycStatus) => {
        setupReadyProduct(ProductStatus.DRAFT, 1n);
        inMemoryShopSnapshotRepo.set({
          shop_id: shopA,
          shop_status: ShopStatus.ACTIVE,
          kyc_status: kycStatus,
        });

        const res = await request(app.getHttpServer())
          .post(`/seller/products/${productId}/publish`)
          .set(sellerHeaders)
          .send({ version: 1 });

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('PRODUCT_KYC_REQUIRED');

        // Product in DB must remain DRAFT, version 1
        const dbProduct = inMemoryProductRepo.get(productId);
        expect(dbProduct.status).toBe(ProductStatus.DRAFT);
        expect(dbProduct.version).toBe(1n);
        expect(savedOutboxEvents.length).toBe(0);
        expect(savedAudits.length).toBe(0);
      },
    );

    it('PC-API-027b: Should return 403 PRODUCT_KYC_REQUIRED when shop snapshot does not exist', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryShopSnapshotRepo.clear();

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_KYC_REQUIRED');
    });

    it('PC-API-028: Should return 403 PRODUCT_SHOP_SUSPENDED when shop status is SUSPENDED', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryShopSnapshotRepo.set({
        shop_id: shopA,
        shop_status: ShopStatus.SUSPENDED,
        kyc_status: KycStatus.APPROVED,
      });

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_SHOP_SUSPENDED');
      expect(inMemoryProductRepo.get(productId).status).toBe(ProductStatus.DRAFT);
    });

    it('PC-API-029a: Should return 400 PRODUCT_TITLE_REQUIRED when title is missing or whitespace', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      const prod = inMemoryProductRepo.get(productId);
      prod.title = '   ';
      inMemoryProductRepo.set(prod);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_TITLE_REQUIRED');
    });

    it('PC-API-029b: Should return 400 PRODUCT_DESCRIPTION_INVALID when description is empty', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      const prod = inMemoryProductRepo.get(productId);
      prod.description = '';
      inMemoryProductRepo.set(prod);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_DESCRIPTION_INVALID');
    });

    it('PC-API-029c: Should return 400 PRODUCT_CATEGORY_REQUIRED when no primary category is assigned', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryProductCategoryRepo.setForProduct(productId, []);
      const prod = inMemoryProductRepo.get(productId);
      prod.primary_category_id = null;
      inMemoryProductRepo.set(prod);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_CATEGORY_REQUIRED');
    });

    it('PC-API-029d: Should return 400 PRODUCT_CATEGORY_INVALID when primary category is INACTIVE', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryCategoryRepo.set({
        _id: categoryId,
        status: CategoryStatus.INACTIVE,
      });

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_CATEGORY_INVALID');
    });

    it('PC-API-029e: Should return 400 PRODUCT_SKU_REQUIRED when product has no active SKUs', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemorySkuRepo.setForProduct(productId, [{ _id: skuId, status: SkuStatus.DRAFT }]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_SKU_REQUIRED');
    });

    it('PC-API-029f: Should return 400 PRODUCT_PRICE_INVALID when SKU price is zero or negative', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemorySkuRepo.setForProduct(productId, [
        { _id: skuId, seller_sku: 'SKU-0', price_override: 0n, status: SkuStatus.ACTIVE },
      ]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_PRICE_INVALID');
    });

    it('PC-API-029g: Should return 400 PRODUCT_PRICE_INVALID when SKU price exceeds 999,999,999,999 VND', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemorySkuRepo.setForProduct(productId, [
        {
          _id: skuId,
          seller_sku: 'SKU-MAX',
          price_override: 1000000000000n,
          status: SkuStatus.ACTIVE,
        },
      ]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_PRICE_INVALID');
    });

    it('PC-API-029h: Should return 400 PRODUCT_MEDIA_REQUIRED when cover image is missing or not in READY status', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryMediaRepo.setForProduct(productId, [
        { _id: mediaId, is_cover: true, status: MediaStatus.UPLOADING },
      ]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_REQUIRED');
    });

    it('PC-API-029i: Should return 400 PRODUCT_MEDIA_REQUIRED when product has multiple cover images READY', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryMediaRepo.setForProduct(productId, [
        { _id: 'm1', is_cover: true, status: MediaStatus.READY },
        { _id: 'm2', is_cover: true, status: MediaStatus.READY },
      ]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_REQUIRED');
    });

    it('PC-API-029j: Should return 409 PRODUCT_SKU_DUPLICATE when multiple active SKUs share identical variant_key', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemorySkuRepo.setForProduct(productId, [
        {
          _id: 's1',
          seller_sku: 'S1',
          variant_key: 'sw=blue',
          price_override: 500000n,
          status: SkuStatus.ACTIVE,
        },
        {
          _id: 's2',
          seller_sku: 'S2',
          variant_key: 'sw=blue',
          price_override: 500000n,
          status: SkuStatus.ACTIVE,
        },
      ]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_SKU_DUPLICATE');
    });

    it('PC-API-030: Should publish successfully with OUT_OF_STOCK display when inventory quantity is 0 (Does NOT block publish!)', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);
      inMemoryInventoryProjectionRepo.setForProduct(productId, [
        {
          sku_id: skuId,
          available_qty_snapshot: 0n,
          stock_status: InventoryStockStatus.OUT_OF_STOCK,
          as_of: new Date('2026-09-26T10:00:00Z'),
        },
      ]);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('ACTIVE');
      expect(res.body.data.stock_display).toEqual({
        status: 'OUT_OF_STOCK',
        as_of: '2026-09-26T10:00:00.000Z',
      });
      expect(inMemoryProductRepo.get(productId).status).toBe(ProductStatus.ACTIVE);
    });

    it('OCC Invariant: Should return 409 PRODUCT_VERSION_CONFLICT when payload version does not match DB', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 3n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 2 }); // Stale version

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_VERSION_CONFLICT');
    });

    it('IDOR Defense: Should return 403 PRODUCT_FORBIDDEN when seller tries to publish product of another shop', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);

      const crossShopHeaders = {
        ...sellerHeaders,
        'x-user-shop-scope': shopB, // Belongs to Shop B, product belongs to Shop A
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(crossShopHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
      expect(inMemoryProductRepo.get(productId).status).toBe(ProductStatus.DRAFT);
    });

    it('State Machine: Should return 409 PRODUCT_STATE_INVALID when product is already ACTIVE', async () => {
      setupReadyProduct(ProductStatus.ACTIVE, 2n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 2 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_STATE_INVALID');
    });

    it('State Machine: Should return 403 PRODUCT_BLOCKED when product is BLOCKED by admin', async () => {
      setupReadyProduct(ProductStatus.BLOCKED, 2n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 2 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_BLOCKED');
    });

    it('State Machine: Should return 409 PRODUCT_ARCHIVED when product is ARCHIVED', async () => {
      setupReadyProduct(ProductStatus.ARCHIVED, 2n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/publish`)
        .set(sellerHeaders)
        .send({ version: 2 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_ARCHIVED');
    });
  });

  // =========================================================================
  // PC-API-031..032: POST /seller/products/{productId}/unpublish
  // =========================================================================
  describe('POST /seller/products/{productId}/unpublish', () => {
    it('PC-API-031: Should successfully unpublish ACTIVE product to INACTIVE with version increment and outbox event', async () => {
      setupReadyProduct(ProductStatus.ACTIVE, 2n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/unpublish`)
        .set(sellerHeaders)
        .send({ version: 2, reason: 'Tạm hết linh kiện' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: {
          product_id: productId,
          status: 'INACTIVE',
          version: 3,
        },
      });

      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.INACTIVE);
      expect(dbProduct.version).toBe(3n);
      expect(dbProduct.unpublished_at).toBeDefined();

      // Ensure SKUs and Media were NOT deleted
      const skus = await inMemorySkuRepo.findByProductId(productId);
      expect(skus.length).toBe(1);
      const media = await inMemoryMediaRepo.findByProductId(productId);
      expect(media.length).toBe(1);

      // Verify Outbox event
      expect(savedOutboxEvents.length).toBe(1);
      const outbox = savedOutboxEvents[0];
      expect(outbox.event_type).toBe('product.unpublished');
      expect(outbox.topic).toBe('product.events.v1');
      expect(outbox.version).toBe(3n);
      expect(outbox.payload).toMatchObject({
        product_id: productId,
        reason: 'Tạm hết linh kiện',
        version: 3,
      });

      // Verify Audit record
      expect(savedAudits.length).toBe(1);
      const audit = savedAudits[0];
      expect(audit.action).toBe(AuditAction.UNPUBLISH);
      expect(audit.reason).toBe('Tạm hết linh kiện');
      expect(audit.metadata).toMatchObject({
        previous_status: ProductStatus.ACTIVE,
        new_status: ProductStatus.INACTIVE,
        version: 3,
      });
    });

    it('PC-API-032: Should return 409 PRODUCT_STATE_INVALID when product is in DRAFT status', async () => {
      setupReadyProduct(ProductStatus.DRAFT, 1n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/unpublish`)
        .set(sellerHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_STATE_INVALID');
      expect(inMemoryProductRepo.get(productId).status).toBe(ProductStatus.DRAFT);
    });

    it('PC-API-032b: Should return 403 PRODUCT_BLOCKED when product is BLOCKED', async () => {
      setupReadyProduct(ProductStatus.BLOCKED, 3n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/unpublish`)
        .set(sellerHeaders)
        .send({ version: 3 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_BLOCKED');
    });

    it('PC-API-032c: Should return 409 PRODUCT_ARCHIVED when product is ARCHIVED', async () => {
      setupReadyProduct(ProductStatus.ARCHIVED, 3n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/unpublish`)
        .set(sellerHeaders)
        .send({ version: 3 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_ARCHIVED');
    });

    it('OCC Invariant: Should return 409 PRODUCT_VERSION_CONFLICT on version mismatch during unpublish', async () => {
      setupReadyProduct(ProductStatus.ACTIVE, 5n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/unpublish`)
        .set(sellerHeaders)
        .send({ version: 4 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_VERSION_CONFLICT');
    });

    it('IDOR Defense: Should return 403 PRODUCT_FORBIDDEN on cross-tenant unpublish attempt', async () => {
      setupReadyProduct(ProductStatus.ACTIVE, 2n);

      const crossHeaders = {
        ...sellerHeaders,
        'x-user-shop-scope': shopB,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/unpublish`)
        .set(crossHeaders)
        .send({ version: 2 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });
  });

  // =========================================================================
  // Archive Lifecycle: POST /seller/products/{productId}/archive
  // =========================================================================
  describe('POST /seller/products/{productId}/archive', () => {
    it.each([
      [ProductStatus.DRAFT, 1n, 2],
      [ProductStatus.INACTIVE, 3n, 4],
      [ProductStatus.ACTIVE, 5n, 6],
    ])(
      'Should successfully archive %s product to ARCHIVED status',
      async (initStatus, initVer, expectedNextVer) => {
        setupReadyProduct(initStatus, initVer);

        const res = await request(app.getHttpServer())
          .post(`/seller/products/${productId}/archive`)
          .set(sellerHeaders)
          .send({ version: Number(initVer), reason: 'Dừng kinh doanh vĩnh viễn' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          data: {
            product_id: productId,
            status: 'ARCHIVED',
            version: expectedNextVer,
          },
        });

        const dbProduct = inMemoryProductRepo.get(productId);
        expect(dbProduct.status).toBe(ProductStatus.ARCHIVED);
        expect(dbProduct.version).toBe(BigInt(expectedNextVer));
        expect(dbProduct.archived_at).toBeDefined();

        // Check Outbox event
        expect(savedOutboxEvents.length).toBe(1);
        expect(savedOutboxEvents[0]).toMatchObject({
          event_type: 'product.archived',
          topic: 'product.events.v1',
          version: BigInt(expectedNextVer),
          payload: {
            product_id: productId,
            reason: 'Dừng kinh doanh vĩnh viễn',
            version: expectedNextVer,
          },
        });

        // Check Audit
        expect(savedAudits.length).toBe(1);
        expect(savedAudits[0]).toMatchObject({
          action: AuditAction.ARCHIVE,
          reason: 'Dừng kinh doanh vĩnh viễn',
          metadata: {
            previous_status: initStatus,
            new_status: ProductStatus.ARCHIVED,
            version: expectedNextVer,
          },
        });
      },
    );

    it('Should return 409 PRODUCT_STATE_INVALID when product is already ARCHIVED', async () => {
      setupReadyProduct(ProductStatus.ARCHIVED, 8n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/archive`)
        .set(sellerHeaders)
        .send({ version: 8 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_STATE_INVALID');
    });

    it('Should return 403 PRODUCT_BLOCKED when seller attempts to archive BLOCKED product', async () => {
      setupReadyProduct(ProductStatus.BLOCKED, 5n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/archive`)
        .set(sellerHeaders)
        .send({ version: 5 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_BLOCKED');
    });

    it('OCC Invariant: Should return 409 PRODUCT_VERSION_CONFLICT when version is mismatched on archive', async () => {
      setupReadyProduct(ProductStatus.ACTIVE, 6n);

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/archive`)
        .set(sellerHeaders)
        .send({ version: 5 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_VERSION_CONFLICT');
    });

    it('IDOR Defense: Should return 403 PRODUCT_FORBIDDEN on cross-tenant archive attempt', async () => {
      setupReadyProduct(ProductStatus.INACTIVE, 2n);

      const crossHeaders = {
        ...sellerHeaders,
        'x-user-shop-scope': shopB,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/archive`)
        .set(crossHeaders)
        .send({ version: 2 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });
  });
});
