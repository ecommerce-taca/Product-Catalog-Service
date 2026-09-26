import { Test, TestingModule } from '@nestjs/testing';
import { PublishPolicyService } from '../../src/publish-policy/services/publish-policy.service';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { CategoryStatus } from '../../src/database/schemas/category.schema';
import { SkuStatus } from '../../src/database/schemas/sku.schema';
import { MediaStatus } from '../../src/database/schemas/product-media.schema';
import { KycStatus, ShopStatus } from '../../src/database/schemas/shop-snapshot.schema';
import { InventoryStockStatus } from '../../src/database/schemas/inventory-projection.schema';
import { AuditAction, AuditTargetType } from '../../src/database/schemas/catalog-audit.schema';
import { AggregateType } from '../../src/database/schemas/outbox-event.schema';
import { CategoryTreeService } from '../../src/category/services/category-tree.service';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { CatalogAuditRepositoryPort } from '../../src/audit/repositories/audit.repository.interface';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { INVENTORY_PROJECTION_REPOSITORY_PORT } from '../../src/projections/repositories/inventory-projection.repository.interface';

/**
 * Unit & Edge Cases Test Suite for Publish Policy Engine & State Transitions [TEST-B07]
 *
 * References:
 * - Test Plan: product-catalog-docs/docs/test/product-catalog.md §3.2 (PC-API-026..032), §4 (PublishPolicy, ProductStateMachine)
 * - LLD: product-catalog-docs/docs/lld/product-catalog.md §3.4-3.5, §5.1, §5.4, §6.1-6.2, §7
 */
describe('Publish Policy Engine & State Machine Unit/Edge Spec [TEST-B07]', () => {
  let service: PublishPolicyService;

  const mockProductRepository = {
    findById: jest.fn(),
    atomicCasUpdate: jest.fn(),
  };

  const mockProductCategoryRepository = {
    findByProductId: jest.fn(),
  };

  const mockCategoryRepository = {
    findById: jest.fn(),
  };

  const mockCategoryTreeService = {
    resolveEffectiveTaxRateFromList: jest.fn().mockReturnValue(1000),
  };

  const mockSkuRepository = {
    findByProductId: jest.fn(),
  };

  const mockMediaRepository = {
    findByProductId: jest.fn(),
    findActiveByProductId: jest.fn(),
  };

  const mockAttributeDefinitionRepository = {
    findByScope: jest.fn().mockResolvedValue([]),
  };

  const mockShopSnapshotRepository = {
    findByShopId: jest.fn(),
  };

  const mockInventoryProjectionRepository = {
    findByProductId: jest.fn(),
  };

  const mockOutboxRepository = {
    saveEvent: jest.fn(),
  };

  const mockCatalogAuditRepository = {
    record: jest.fn(),
  };

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation((cb: (session: unknown) => Promise<unknown>) => cb({})),
  };

  const actorUserId = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopScope = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const productId = '01912f31-7a1b-7c12-9c55-8b1c34a6d003';
  const categoryId = '01912f20-7a1b-7c12-9c55-8b1c34a6d004';
  const skuId = '01912f33-7a1b-7c12-9c55-8b1c34a6d005';
  const mediaId = '01912f32-7a1b-7c12-9c55-8b1c34a6d006';

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMediaRepository.findActiveByProductId.mockImplementation((id: string) =>
      mockMediaRepository.findByProductId(id),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PublishPolicyService,
        { provide: 'ProductRepositoryPort', useValue: mockProductRepository },
        { provide: 'ProductCategoryRepositoryPort', useValue: mockProductCategoryRepository },
        { provide: 'CategoryRepositoryPort', useValue: mockCategoryRepository },
        { provide: CategoryTreeService, useValue: mockCategoryTreeService },
        { provide: 'SkuRepositoryPort', useValue: mockSkuRepository },
        { provide: 'ProductMediaRepositoryPort', useValue: mockMediaRepository },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttributeDefinitionRepository,
        },
        { provide: SHOP_SNAPSHOT_REPOSITORY_PORT, useValue: mockShopSnapshotRepository },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: mockInventoryProjectionRepository,
        },
        { provide: OutboxRepositoryPort, useValue: mockOutboxRepository },
        { provide: CatalogAuditRepositoryPort, useValue: mockCatalogAuditRepository },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
      ],
    }).compile();

    service = module.get<PublishPolicyService>(PublishPolicyService);
  });

  const createValidProductDoc = (overrides = {}): ProductDocument =>
    ({
      _id: productId,
      shop_id: shopScope,
      title: 'Tai nghe Bluetooth không dây Taca Pro',
      slug: 'tai-nghe-bluetooth-khong-day-taca-pro',
      description: 'Mô tả chi tiết âm thanh vòm, chống ồn chủ động ANC.',
      brand: 'Taca Sound',
      status: ProductStatus.DRAFT,
      primary_category_id: categoryId,
      price_summary: {
        base_price: BigInt(500000),
        sale_price: BigInt(450000),
        currency: 'VND',
      },
      version: BigInt(1),
      ...overrides,
    }) as unknown as ProductDocument;

  const setupValidReadinessFixtures = () => {
    mockProductCategoryRepository.findByProductId.mockResolvedValue([
      { category_id: categoryId, is_primary: true },
    ]);
    mockCategoryRepository.findById.mockResolvedValue({
      _id: categoryId,
      name: 'Thiết bị âm thanh',
      slug: 'thiet-bi-am-thanh',
      status: CategoryStatus.ACTIVE,
      path: `/${categoryId}`,
      depth: 1,
      tax_rate_bps: 1000,
    });
    mockSkuRepository.findByProductId.mockResolvedValue([
      {
        _id: skuId,
        seller_sku: 'TACA-PRO-BLK',
        variant_key: 'color=black',
        price_override: BigInt(450000),
        status: SkuStatus.ACTIVE,
      },
    ]);
    mockMediaRepository.findByProductId.mockResolvedValue([
      {
        _id: mediaId,
        is_cover: true,
        status: MediaStatus.READY,
        object_key: 'products/shop/cover.webp',
      },
    ]);
    mockShopSnapshotRepository.findByShopId.mockResolvedValue({
      shop_id: shopScope,
      shop_status: ShopStatus.ACTIVE,
      kyc_status: KycStatus.APPROVED,
    });
    mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
      {
        sku_id: skuId,
        available_qty_snapshot: BigInt(50),
        stock_status: InventoryStockStatus.IN_STOCK,
        as_of: new Date('2026-09-26T10:00:00Z'),
      },
    ]);
  };

  // =========================================================================
  // 1. Publish Readiness Policy Checks & Boundaries (PC-API-026..030)
  // =========================================================================
  describe('Publish Readiness Policy Validation (PC-API-026..030)', () => {
    describe('Title Validation', () => {
      it('should reject when title is null or undefined', async () => {
        const product = createValidProductDoc({ title: null });
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_TITLE_REQUIRED' },
        });
      });

      it('should reject when title is whitespace only', async () => {
        const product = createValidProductDoc({ title: '    \t\n   ' });
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_TITLE_REQUIRED' },
        });
      });

      it('should accept when title has exactly 200 characters', async () => {
        const product = createValidProductDoc({ title: 'A'.repeat(200) });
        setupValidReadinessFixtures();
        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.primaryCategory).toBeDefined();
      });

      it('should reject when title exceeds 200 characters (201 chars)', async () => {
        const product = createValidProductDoc({ title: 'A'.repeat(201) });
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_TITLE_REQUIRED' },
        });
      });
    });

    describe('Description Validation', () => {
      it('should reject when description is null or empty', async () => {
        const product = createValidProductDoc({ description: '' });
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_DESCRIPTION_INVALID' },
        });
      });

      it('should reject when description is whitespace only', async () => {
        const product = createValidProductDoc({ description: '   ' });
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_DESCRIPTION_INVALID' },
        });
      });

      it('should accept when description has exactly 100,000 characters', async () => {
        const product = createValidProductDoc({ description: 'A'.repeat(100000) });
        setupValidReadinessFixtures();
        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.primaryCategory).toBeDefined();
      });

      it('should reject when description exceeds 100,000 characters', async () => {
        const product = createValidProductDoc({ description: 'A'.repeat(100001) });
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_DESCRIPTION_INVALID' },
        });
      });
    });

    describe('Primary Category & Tax Rate Inheritance', () => {
      it('should reject when product has no primary category assigned', async () => {
        const product = createValidProductDoc({ primary_category_id: null });
        mockProductCategoryRepository.findByProductId.mockResolvedValue([]);
        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_CATEGORY_REQUIRED' },
        });
      });

      it('should reject when primary category does not exist in repository', async () => {
        const product = createValidProductDoc();
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue(null);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_CATEGORY_INVALID' },
        });
      });

      it('should reject when primary category status is INACTIVE', async () => {
        const product = createValidProductDoc();
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.INACTIVE,
        });

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_CATEGORY_INVALID' },
        });
      });

      it('should reject when primary category status is ARCHIVED', async () => {
        const product = createValidProductDoc();
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ARCHIVED,
        });

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_CATEGORY_INVALID' },
        });
      });

      it('should correctly build category_path and resolve effective tax_rate_bps', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();

        const rootCat = {
          _id: 'cat-root',
          name: 'Điện tử',
          slug: 'dien-tu',
          path: '/cat-root',
          tax_rate_bps: 1000,
        };
        const leafCat = {
          _id: categoryId,
          name: 'Thiết bị âm thanh',
          slug: 'am-thanh',
          path: '/cat-root/' + categoryId,
          tax_rate_bps: null,
          status: CategoryStatus.ACTIVE,
        };

        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockImplementation((id: string) => {
          if (id === 'cat-root') return Promise.resolve(rootCat);
          if (id === categoryId) return Promise.resolve(leafCat);
          return Promise.resolve(null);
        });
        mockCategoryTreeService.resolveEffectiveTaxRateFromList.mockReturnValue(1000);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.categoryPath).toEqual(['Điện tử', 'Thiết bị âm thanh']);
        expect(res.taxRateBps).toBe(1000);
      });
    });

    describe('SKU Active & Price Range Boundaries (PC-SEC-004)', () => {
      it('should reject when product has zero SKUs', async () => {
        const product = createValidProductDoc();
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ACTIVE,
        });
        mockSkuRepository.findByProductId.mockResolvedValue([]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_SKU_REQUIRED' },
        });
      });

      it('should reject when product has only DRAFT or INACTIVE SKUs', async () => {
        const product = createValidProductDoc();
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ACTIVE,
        });
        mockSkuRepository.findByProductId.mockResolvedValue([
          { _id: 's1', status: SkuStatus.DRAFT },
          { _id: 's2', status: SkuStatus.INACTIVE },
          { _id: 's3', status: SkuStatus.ARCHIVED },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_SKU_REQUIRED' },
        });
      });

      it('should reject when active SKU price is 0', async () => {
        const product = createValidProductDoc({ price_summary: null });
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ACTIVE,
        });
        mockSkuRepository.findByProductId.mockResolvedValue([
          { _id: skuId, seller_sku: 'SKU-01', price_override: BigInt(0), status: SkuStatus.ACTIVE },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_PRICE_INVALID' },
        });
      });

      it('should reject when active SKU price is negative', async () => {
        const product = createValidProductDoc({ price_summary: null });
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ACTIVE,
        });
        mockSkuRepository.findByProductId.mockResolvedValue([
          {
            _id: skuId,
            seller_sku: 'SKU-01',
            price_override: BigInt(-5000),
            status: SkuStatus.ACTIVE,
          },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_PRICE_INVALID' },
        });
      });

      it('should reject when active SKU price exceeds 999,999,999,999 VND', async () => {
        const product = createValidProductDoc({ price_summary: null });
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ACTIVE,
        });
        mockSkuRepository.findByProductId.mockResolvedValue([
          {
            _id: skuId,
            seller_sku: 'SKU-01',
            price_override: BigInt('1000000000000'),
            status: SkuStatus.ACTIVE,
          },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_PRICE_INVALID' },
        });
      });

      it('should fallback to product.price_summary.sale_price when price_override is null', async () => {
        const product = createValidProductDoc({
          price_summary: {
            base_price: BigInt(300000),
            sale_price: BigInt(250000),
            currency: 'VND',
          },
        });
        setupValidReadinessFixtures();
        mockSkuRepository.findByProductId.mockResolvedValue([
          {
            _id: skuId,
            seller_sku: 'SKU-01',
            price_override: null,
            status: SkuStatus.ACTIVE,
            variant_key: 'k=v',
          },
        ]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.activeSkus.length).toBe(1);
      });

      it('should reject when both price_override and product.price_summary are null', async () => {
        const product = createValidProductDoc({ price_summary: null });
        mockProductCategoryRepository.findByProductId.mockResolvedValue([
          { category_id: categoryId, is_primary: true },
        ]);
        mockCategoryRepository.findById.mockResolvedValue({
          _id: categoryId,
          status: CategoryStatus.ACTIVE,
        });
        mockSkuRepository.findByProductId.mockResolvedValue([
          { _id: skuId, seller_sku: 'SKU-01', price_override: null, status: SkuStatus.ACTIVE },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_PRICE_INVALID' },
        });
      });
    });

    describe('Cover Media Validation', () => {
      it('should reject when there is no cover media', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockMediaRepository.findByProductId.mockResolvedValue([
          { _id: 'm1', is_cover: false, status: MediaStatus.READY },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_MEDIA_REQUIRED' },
        });
      });

      it.each([
        MediaStatus.UPLOADING,
        MediaStatus.SCANNING,
        MediaStatus.REJECTED,
        MediaStatus.DELETED,
      ])('should reject when cover media is in %s status', async (nonReadyStatus) => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockMediaRepository.findByProductId.mockResolvedValue([
          { _id: 'm1', is_cover: true, status: nonReadyStatus },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_MEDIA_REQUIRED' },
        });
      });

      it('should reject when there are 2 cover media both in READY status', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockMediaRepository.findByProductId.mockResolvedValue([
          { _id: 'm1', is_cover: true, status: MediaStatus.READY },
          { _id: 'm2', is_cover: true, status: MediaStatus.READY },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_MEDIA_REQUIRED' },
        });
      });

      it('should accept when there is exactly 1 READY cover media plus other non-cover READY media', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockMediaRepository.findByProductId.mockResolvedValue([
          { _id: 'm1', is_cover: true, status: MediaStatus.READY },
          { _id: 'm2', is_cover: false, status: MediaStatus.READY },
          { _id: 'm3', is_cover: false, status: MediaStatus.READY },
        ]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.primaryCategory).toBeDefined();
      });
    });

    describe('Variant Key Duplicate Detection', () => {
      it('should reject when two active SKUs share the exact same variant_key', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockSkuRepository.findByProductId.mockResolvedValue([
          {
            _id: 's1',
            seller_sku: 'SKU-01',
            variant_key: 'color=red|size=M',
            status: SkuStatus.ACTIVE,
            price_override: 100000n,
          },
          {
            _id: 's2',
            seller_sku: 'SKU-02',
            variant_key: 'color=red|size=M',
            status: SkuStatus.ACTIVE,
            price_override: 100000n,
          },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_SKU_DUPLICATE' },
        });
      });

      it('should reject when two active SKUs share duplicate empty string variant_key', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockSkuRepository.findByProductId.mockResolvedValue([
          {
            _id: 's1',
            seller_sku: 'SKU-01',
            variant_key: '',
            status: SkuStatus.ACTIVE,
            price_override: 100000n,
          },
          {
            _id: 's2',
            seller_sku: 'SKU-02',
            variant_key: '',
            status: SkuStatus.ACTIVE,
            price_override: 100000n,
          },
        ]);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_SKU_DUPLICATE' },
        });
      });

      it('should not conflict if duplicate variant_key belongs to an INACTIVE SKU', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockSkuRepository.findByProductId.mockResolvedValue([
          {
            _id: 's1',
            seller_sku: 'SKU-01',
            variant_key: 'color=red|size=M',
            status: SkuStatus.ACTIVE,
            price_override: 100000n,
          },
          {
            _id: 's2',
            seller_sku: 'SKU-02',
            variant_key: 'color=red|size=M',
            status: SkuStatus.INACTIVE,
            price_override: 100000n,
          },
        ]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.activeSkus.length).toBe(1);
      });
    });

    describe('KYC Gate & Shop Suspension (PC-API-027, PC-API-028)', () => {
      it('should reject when shop snapshot is missing from projection repository', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockShopSnapshotRepository.findByShopId.mockResolvedValue(null);

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_KYC_REQUIRED' },
        });
      });

      it.each([KycStatus.PENDING, KycStatus.NEEDS_INFO, KycStatus.REJECTED, KycStatus.EXPIRED])(
        'should reject when shop KYC status is %s',
        async (status) => {
          const product = createValidProductDoc();
          setupValidReadinessFixtures();
          mockShopSnapshotRepository.findByShopId.mockResolvedValue({
            shop_id: shopScope,
            shop_status: ShopStatus.ACTIVE,
            kyc_status: status,
          });

          await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
            response: { code: 'PRODUCT_KYC_REQUIRED' },
          });
        },
      );

      it('should reject when shop status is SUSPENDED even if KYC is APPROVED', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockShopSnapshotRepository.findByShopId.mockResolvedValue({
          shop_id: shopScope,
          shop_status: ShopStatus.SUSPENDED,
          kyc_status: KycStatus.APPROVED,
        });

        await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
          response: { code: 'PRODUCT_SHOP_SUSPENDED' },
        });
      });
    });

    describe('Inventory Stock Projection & Zero Stock Non-blocking (PC-API-030)', () => {
      it('should allow publish when stock projection quantity is 0 and mark OUT_OF_STOCK', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
          {
            sku_id: skuId,
            available_qty_snapshot: 0n,
            stock_status: InventoryStockStatus.OUT_OF_STOCK,
            as_of: new Date('2026-09-26T10:00:00Z'),
          },
        ]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.stockStatus).toBe(InventoryStockStatus.OUT_OF_STOCK);
        expect(res.stockAsOf).toEqual(new Date('2026-09-26T10:00:00Z'));
      });

      it('should mark LOW_STOCK when total available quantity is <= LOW_STOCK_THRESHOLD', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
          {
            sku_id: skuId,
            available_qty_snapshot: 4n,
            stock_status: InventoryStockStatus.LOW_STOCK,
            as_of: new Date('2026-09-26T10:00:00Z'),
          },
        ]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.stockStatus).toBe(InventoryStockStatus.LOW_STOCK);
        expect(res.stockAsOf).toEqual(new Date('2026-09-26T10:00:00Z'));
      });

      it('should mark IN_STOCK when total available quantity is > 5 even if first SKU is 0', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
          {
            sku_id: 's1',
            available_qty_snapshot: 0n,
            stock_status: InventoryStockStatus.OUT_OF_STOCK,
            as_of: new Date('2026-09-26T10:00:00Z'),
          },
          {
            sku_id: 's2',
            available_qty_snapshot: 10n,
            stock_status: InventoryStockStatus.IN_STOCK,
            as_of: new Date('2026-09-26T10:05:00Z'),
          },
        ]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.stockStatus).toBe(InventoryStockStatus.IN_STOCK);
        expect(res.stockAsOf).toEqual(new Date('2026-09-26T10:05:00Z'));
      });

      it('should return UNKNOWN when no inventory projections exist', async () => {
        const product = createValidProductDoc();
        setupValidReadinessFixtures();
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([]);

        const res = await service.validatePublishReadiness(product, shopScope);
        expect(res.stockStatus).toBe(InventoryStockStatus.UNKNOWN);
        expect(res.stockAsOf).toBeNull();
      });
    });
  });

  // =========================================================================
  // 2. Product State Machine & Lifecycle Transitions (LLD §5.1, PC-API-026..032)
  // =========================================================================
  describe('Product State Machine Transitions (LLD §5.1)', () => {
    describe('Publish Transitions', () => {
      it('should allow DRAFT -> ACTIVE transition', async () => {
        const product = createValidProductDoc({ status: ProductStatus.DRAFT, version: 1n });
        mockProductRepository.findById.mockResolvedValue(product);
        setupValidReadinessFixtures();
        mockProductRepository.atomicCasUpdate.mockResolvedValue({
          ...product,
          status: ProductStatus.ACTIVE,
          version: 2n,
        });

        const res = await service.publish(actorUserId, shopScope, productId, { version: 1 });
        expect(res.status).toBe(ProductStatus.ACTIVE);
        expect(res.version).toBe(2);
      });

      it('should allow INACTIVE -> ACTIVE transition (resume)', async () => {
        const product = createValidProductDoc({ status: ProductStatus.INACTIVE, version: 3n });
        mockProductRepository.findById.mockResolvedValue(product);
        setupValidReadinessFixtures();
        mockProductRepository.atomicCasUpdate.mockResolvedValue({
          ...product,
          status: ProductStatus.ACTIVE,
          version: 4n,
        });

        const res = await service.publish(actorUserId, shopScope, productId, { version: 3 });
        expect(res.status).toBe(ProductStatus.ACTIVE);
        expect(res.version).toBe(4);
      });

      it('should reject ACTIVE -> ACTIVE transition with 409 PRODUCT_STATE_INVALID', async () => {
        const product = createValidProductDoc({ status: ProductStatus.ACTIVE, version: 2n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.publish(actorUserId, shopScope, productId, { version: 2 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_STATE_INVALID' },
        });
      });

      it('should reject BLOCKED -> ACTIVE transition with 403 PRODUCT_BLOCKED', async () => {
        const product = createValidProductDoc({ status: ProductStatus.BLOCKED, version: 2n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.publish(actorUserId, shopScope, productId, { version: 2 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_BLOCKED' },
        });
      });

      it('should reject ARCHIVED -> ACTIVE transition with 409 PRODUCT_ARCHIVED', async () => {
        const product = createValidProductDoc({ status: ProductStatus.ARCHIVED, version: 2n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.publish(actorUserId, shopScope, productId, { version: 2 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_ARCHIVED' },
        });
      });
    });

    describe('Unpublish Transitions', () => {
      it('should allow ACTIVE -> INACTIVE transition', async () => {
        const product = createValidProductDoc({ status: ProductStatus.ACTIVE, version: 5n });
        mockProductRepository.findById.mockResolvedValue(product);
        mockProductRepository.atomicCasUpdate.mockResolvedValue({
          ...product,
          status: ProductStatus.INACTIVE,
          version: 6n,
        });

        const res = await service.unpublish(actorUserId, shopScope, productId, {
          version: 5,
          reason: 'Tạm ẩn bán',
        });
        expect(res.status).toBe(ProductStatus.INACTIVE);
        expect(res.version).toBe(6);
      });

      it('should reject DRAFT -> INACTIVE transition with 409 PRODUCT_STATE_INVALID', async () => {
        const product = createValidProductDoc({ status: ProductStatus.DRAFT, version: 1n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.unpublish(actorUserId, shopScope, productId, { version: 1 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_STATE_INVALID' },
        });
      });

      it('should reject INACTIVE -> INACTIVE transition with 409 PRODUCT_STATE_INVALID', async () => {
        const product = createValidProductDoc({ status: ProductStatus.INACTIVE, version: 4n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.unpublish(actorUserId, shopScope, productId, { version: 4 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_STATE_INVALID' },
        });
      });

      it('should reject BLOCKED -> INACTIVE transition via seller unpublish with 403 PRODUCT_BLOCKED', async () => {
        const product = createValidProductDoc({ status: ProductStatus.BLOCKED, version: 3n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.unpublish(actorUserId, shopScope, productId, { version: 3 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_BLOCKED' },
        });
      });

      it('should reject ARCHIVED -> INACTIVE transition with 409 PRODUCT_ARCHIVED', async () => {
        const product = createValidProductDoc({ status: ProductStatus.ARCHIVED, version: 3n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.unpublish(actorUserId, shopScope, productId, { version: 3 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_ARCHIVED' },
        });
      });
    });

    describe('Archive Transitions', () => {
      it.each([ProductStatus.DRAFT, ProductStatus.INACTIVE, ProductStatus.ACTIVE])(
        'should allow %s -> ARCHIVED transition',
        async (initialStatus) => {
          const product = createValidProductDoc({ status: initialStatus, version: 3n });
          mockProductRepository.findById.mockResolvedValue(product);
          mockProductRepository.atomicCasUpdate.mockResolvedValue({
            ...product,
            status: ProductStatus.ARCHIVED,
            version: 4n,
          });

          const res = await service.archive(actorUserId, shopScope, productId, {
            version: 3,
            reason: 'Ngừng kinh doanh',
          });
          expect(res.status).toBe(ProductStatus.ARCHIVED);
          expect(res.version).toBe(4);
        },
      );

      it('should reject ARCHIVED -> ARCHIVED transition with 409 PRODUCT_STATE_INVALID', async () => {
        const product = createValidProductDoc({ status: ProductStatus.ARCHIVED, version: 5n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.archive(actorUserId, shopScope, productId, { version: 5 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_STATE_INVALID' },
        });
      });

      it('should reject BLOCKED -> ARCHIVED transition via seller archive with 403 PRODUCT_BLOCKED', async () => {
        const product = createValidProductDoc({ status: ProductStatus.BLOCKED, version: 5n });
        mockProductRepository.findById.mockResolvedValue(product);

        await expect(
          service.archive(actorUserId, shopScope, productId, { version: 5 }),
        ).rejects.toMatchObject({
          response: { code: 'PRODUCT_BLOCKED' },
        });
      });
    });
  });

  // =========================================================================
  // 3. Optimistic Concurrency Control (OCC) & Cas Failures
  // =========================================================================
  describe('Optimistic Concurrency Control (OCC) Invariants', () => {
    it('should throw 409 PRODUCT_VERSION_CONFLICT when input version does not match DB version on publish', async () => {
      const product = createValidProductDoc({ version: 2n });
      mockProductRepository.findById.mockResolvedValue(product);

      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT when concurrent CAS update returns null on publish', async () => {
      const product = createValidProductDoc({ version: 1n });
      mockProductRepository.findById.mockResolvedValue(product);
      setupValidReadinessFixtures();
      mockProductRepository.atomicCasUpdate.mockResolvedValue(null);

      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT when input version does not match DB version on unpublish', async () => {
      const product = createValidProductDoc({ status: ProductStatus.ACTIVE, version: 5n });
      mockProductRepository.findById.mockResolvedValue(product);

      await expect(
        service.unpublish(actorUserId, shopScope, productId, { version: 4 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT when concurrent CAS update returns null on unpublish', async () => {
      const product = createValidProductDoc({ status: ProductStatus.ACTIVE, version: 5n });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue(null);

      await expect(
        service.unpublish(actorUserId, shopScope, productId, { version: 5 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT when input version does not match DB version on archive', async () => {
      const product = createValidProductDoc({ version: 7n });
      mockProductRepository.findById.mockResolvedValue(product);

      await expect(
        service.archive(actorUserId, shopScope, productId, { version: 6 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT when concurrent CAS update returns null on archive', async () => {
      const product = createValidProductDoc({ version: 7n });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue(null);

      await expect(
        service.archive(actorUserId, shopScope, productId, { version: 7 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });
  });

  // =========================================================================
  // 4. Zero-Trust IDOR Defense (PC-SEC-001)
  // =========================================================================
  describe('Zero-Trust IDOR Defense (PC-SEC-001)', () => {
    it('should reject publish when actor shopScope does not match product shop_id', async () => {
      const product = createValidProductDoc({ shop_id: 'shop-alpha' });
      mockProductRepository.findById.mockResolvedValue(product);

      await expect(
        service.publish(actorUserId, 'shop-beta', productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_FORBIDDEN' },
      });
    });

    it('should reject unpublish when actor shopScope does not match product shop_id', async () => {
      const product = createValidProductDoc({
        shop_id: 'shop-alpha',
        status: ProductStatus.ACTIVE,
      });
      mockProductRepository.findById.mockResolvedValue(product);

      await expect(
        service.unpublish(actorUserId, 'shop-beta', productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_FORBIDDEN' },
      });
    });

    it('should reject archive when actor shopScope does not match product shop_id', async () => {
      const product = createValidProductDoc({ shop_id: 'shop-alpha' });
      mockProductRepository.findById.mockResolvedValue(product);

      await expect(
        service.archive(actorUserId, 'shop-beta', productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_FORBIDDEN' },
      });
    });

    it('should reject when shopScope is empty or undefined', async () => {
      await expect(
        service.publish(actorUserId, '', productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_FORBIDDEN' },
      });
    });
  });

  // =========================================================================
  // 5. Outbox Event & Audit Trail Verification (LLD §6.1, §6.2)
  // =========================================================================
  describe('Outbox Events & Audit Logging (LLD §6.1-6.2)', () => {
    it('should generate complete product.published outbox event and PUBLISH audit', async () => {
      const product = createValidProductDoc({ version: 1n });
      mockProductRepository.findById.mockResolvedValue(product);
      setupValidReadinessFixtures();
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.ACTIVE,
        version: 2n,
      });

      await service.publish(actorUserId, shopScope, productId, { version: 1 });

      // Outbox assertion
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.published',
          topic: 'product.events.v1',
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          version: 2n,
          payload: expect.objectContaining({
            product_id: productId,
            shop_id: shopScope,
            title: product.title,
            slug: product.slug,
            visibility_status: 'PUBLISHED',
            primary_category_id: categoryId,
            tax_rate_bps: 1000,
            active_sku_ids: [skuId],
            version: 2,
          }),
        }),
        expect.anything(),
      );

      // Audit assertion
      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PUBLISH,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          actor_user_id: actorUserId,
          shop_id: shopScope,
          metadata: expect.objectContaining({
            previous_status: ProductStatus.DRAFT,
            new_status: ProductStatus.ACTIVE,
            version: 2,
          }),
        }),
        expect.anything(),
      );
    });

    it('should generate product.unpublished outbox event and UNPUBLISH audit', async () => {
      const product = createValidProductDoc({ status: ProductStatus.ACTIVE, version: 2n });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.INACTIVE,
        version: 3n,
      });

      await service.unpublish(actorUserId, shopScope, productId, {
        version: 2,
        reason: 'Bảo trì hệ thống',
      });

      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.unpublished',
          topic: 'product.events.v1',
          aggregate_id: productId,
          version: 3n,
          payload: expect.objectContaining({
            product_id: productId,
            reason: 'Bảo trì hệ thống',
            version: 3,
          }),
        }),
        expect.anything(),
      );

      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UNPUBLISH,
          reason: 'Bảo trì hệ thống',
          target_id: productId,
        }),
        expect.anything(),
      );
    });

    it('should generate product.archived outbox event and ARCHIVE audit', async () => {
      const product = createValidProductDoc({ status: ProductStatus.INACTIVE, version: 4n });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.ARCHIVED,
        version: 5n,
      });

      await service.archive(actorUserId, shopScope, productId, {
        version: 4,
        reason: 'Ngừng kinh doanh',
      });

      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.archived',
          topic: 'product.events.v1',
          aggregate_id: productId,
          version: 5n,
          payload: expect.objectContaining({
            product_id: productId,
            reason: 'Ngừng kinh doanh',
            version: 5,
          }),
        }),
        expect.anything(),
      );

      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ARCHIVE,
          reason: 'Ngừng kinh doanh',
          target_id: productId,
        }),
        expect.anything(),
      );
    });
  });
});
