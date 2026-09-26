import { BadRequestException } from '@nestjs/common';
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

describe('PublishPolicyService', () => {
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
        {
          provide: 'ProductRepositoryPort',
          useValue: mockProductRepository,
        },
        {
          provide: 'ProductCategoryRepositoryPort',
          useValue: mockProductCategoryRepository,
        },
        {
          provide: 'CategoryRepositoryPort',
          useValue: mockCategoryRepository,
        },
        {
          provide: CategoryTreeService,
          useValue: mockCategoryTreeService,
        },
        {
          provide: 'SkuRepositoryPort',
          useValue: mockSkuRepository,
        },
        {
          provide: 'ProductMediaRepositoryPort',
          useValue: mockMediaRepository,
        },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttributeDefinitionRepository,
        },
        {
          provide: SHOP_SNAPSHOT_REPOSITORY_PORT,
          useValue: mockShopSnapshotRepository,
        },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: mockInventoryProjectionRepository,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: mockOutboxRepository,
        },
        {
          provide: CatalogAuditRepositoryPort,
          useValue: mockCatalogAuditRepository,
        },
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
      ],
    }).compile();

    service = module.get<PublishPolicyService>(PublishPolicyService);
  });

  const createValidProductDoc = (overrides = {}): ProductDocument =>
    ({
      _id: productId,
      shop_id: shopScope,
      title: 'Áo khoác cotton cao cấp',
      slug: 'ao-khoac-cotton-cao-cap',
      description: 'Mô tả chi tiết sản phẩm hợp lệ',
      brand: 'Taca Brand',
      status: ProductStatus.DRAFT,
      primary_category_id: categoryId,
      price_summary: {
        base_price: BigInt(300000),
        sale_price: BigInt(250000),
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
      name: 'Thời trang nam',
      slug: 'thoi-trang-nam',
      status: CategoryStatus.ACTIVE,
      path: `/${categoryId}`,
      depth: 1,
      tax_rate_bps: 1000,
    });
    mockSkuRepository.findByProductId.mockResolvedValue([
      {
        _id: skuId,
        seller_sku: 'SKU-001',
        variant_key: 'size=L|color=black',
        price_override: BigInt(250000),
        status: SkuStatus.ACTIVE,
      },
    ]);
    mockMediaRepository.findByProductId.mockResolvedValue([
      {
        _id: mediaId,
        is_cover: true,
        status: MediaStatus.READY,
        object_key: 'products/shop/img.jpg',
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
        available_qty_snapshot: BigInt(10),
        stock_status: InventoryStockStatus.IN_STOCK,
        as_of: new Date('2026-09-26T10:00:00Z'),
      },
    ]);
  };

  describe('validatePublishReadiness', () => {
    it('should throw PRODUCT_TITLE_REQUIRED if title is missing or whitespace', async () => {
      const product = createValidProductDoc({ title: '   ' });
      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_TITLE_REQUIRED' },
      });
    });

    it('should throw PRODUCT_TITLE_REQUIRED if title exceeds 200 characters', async () => {
      const product = createValidProductDoc({ title: 'A'.repeat(201) });
      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_TITLE_REQUIRED' },
      });
    });

    it('should throw PRODUCT_DESCRIPTION_INVALID if description is missing or empty', async () => {
      const product = createValidProductDoc({ description: '' });
      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_DESCRIPTION_INVALID' },
      });
    });

    it('should throw PRODUCT_CATEGORY_REQUIRED if product has no primary category assignment', async () => {
      const product = createValidProductDoc({ primary_category_id: null });
      mockProductCategoryRepository.findByProductId.mockResolvedValue([]);
      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_CATEGORY_REQUIRED' },
      });
    });

    it('should throw PRODUCT_CATEGORY_INVALID if primary category is not ACTIVE', async () => {
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

    it('should throw PRODUCT_SKU_REQUIRED if product has no active SKUs', async () => {
      const product = createValidProductDoc();
      mockProductCategoryRepository.findByProductId.mockResolvedValue([
        { category_id: categoryId, is_primary: true },
      ]);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: categoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findByProductId.mockResolvedValue([
        { _id: skuId, status: SkuStatus.DRAFT },
      ]);

      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_SKU_REQUIRED' },
      });
    });

    it('should throw PRODUCT_PRICE_INVALID if active SKU has zero or negative price', async () => {
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

    it('should throw PRODUCT_MEDIA_REQUIRED if product has no READY cover image', async () => {
      const product = createValidProductDoc();
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
          price_override: BigInt(100000),
          status: SkuStatus.ACTIVE,
        },
      ]);
      mockMediaRepository.findByProductId.mockResolvedValue([
        { _id: mediaId, is_cover: true, status: MediaStatus.UPLOADING },
      ]);

      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_MEDIA_REQUIRED' },
      });
    });

    it('should throw PRODUCT_MEDIA_REQUIRED if product has more than 1 READY cover image', async () => {
      const product = createValidProductDoc();
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
          price_override: BigInt(100000),
          status: SkuStatus.ACTIVE,
        },
      ]);
      mockMediaRepository.findByProductId.mockResolvedValue([
        { _id: 'm1', is_cover: true, status: MediaStatus.READY },
        { _id: 'm2', is_cover: true, status: MediaStatus.READY },
      ]);

      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_MEDIA_REQUIRED' },
      });
    });

    it('should throw PRODUCT_SKU_DUPLICATE if active SKUs have duplicate variant_key', async () => {
      const product = createValidProductDoc();
      mockProductCategoryRepository.findByProductId.mockResolvedValue([
        { category_id: categoryId, is_primary: true },
      ]);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: categoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findByProductId.mockResolvedValue([
        {
          _id: 's1',
          seller_sku: 'SKU-01',
          variant_key: 'size=M',
          price_override: BigInt(100000),
          status: SkuStatus.ACTIVE,
        },
        {
          _id: 's2',
          seller_sku: 'SKU-02',
          variant_key: 'size=M',
          price_override: BigInt(100000),
          status: SkuStatus.ACTIVE,
        },
      ]);
      mockMediaRepository.findByProductId.mockResolvedValue([
        { _id: mediaId, is_cover: true, status: MediaStatus.READY },
      ]);

      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_SKU_DUPLICATE' },
      });
    });

    it('should throw PRODUCT_SKU_DUPLICATE if active SKUs have duplicate empty string variant_key', async () => {
      const product = createValidProductDoc();
      mockProductCategoryRepository.findByProductId.mockResolvedValue([
        { category_id: categoryId, is_primary: true },
      ]);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: categoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findByProductId.mockResolvedValue([
        {
          _id: 's1',
          seller_sku: 'SKU-01',
          variant_key: '',
          price_override: BigInt(100000),
          status: SkuStatus.ACTIVE,
        },
        {
          _id: 's2',
          seller_sku: 'SKU-02',
          variant_key: '',
          price_override: BigInt(100000),
          status: SkuStatus.ACTIVE,
        },
      ]);
      mockMediaRepository.findByProductId.mockResolvedValue([
        { _id: mediaId, is_cover: true, status: MediaStatus.READY },
      ]);

      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_SKU_DUPLICATE' },
      });
    });

    it('should throw PRODUCT_KYC_REQUIRED if shop KYC is not APPROVED', async () => {
      const product = createValidProductDoc();
      setupValidReadinessFixtures();
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: shopScope,
        shop_status: ShopStatus.ACTIVE,
        kyc_status: KycStatus.NEEDS_INFO,
      });

      await expect(service.validatePublishReadiness(product, shopScope)).rejects.toMatchObject({
        response: { code: 'PRODUCT_KYC_REQUIRED' },
      });
    });

    it('should throw PRODUCT_SHOP_SUSPENDED if shop is SUSPENDED', async () => {
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

    it('should NOT block publish if stock = 0; should return OUT_OF_STOCK', async () => {
      const product = createValidProductDoc();
      setupValidReadinessFixtures();
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
        {
          sku_id: skuId,
          available_qty_snapshot: BigInt(0),
          stock_status: InventoryStockStatus.OUT_OF_STOCK,
          as_of: new Date('2026-09-26T10:00:00Z'),
        },
      ]);

      const result = await service.validatePublishReadiness(product, shopScope);
      expect(result.stockStatus).toBe(InventoryStockStatus.OUT_OF_STOCK);
    });

    it('should return LOW_STOCK when totalAvailable is <= LOW_STOCK_THRESHOLD (e.g. 3)', async () => {
      const product = createValidProductDoc();
      setupValidReadinessFixtures();
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
        {
          sku_id: skuId,
          available_qty_snapshot: BigInt(3),
          stock_status: InventoryStockStatus.LOW_STOCK,
          as_of: new Date('2026-09-26T10:00:00Z'),
        },
      ]);

      const result = await service.validatePublishReadiness(product, shopScope);
      expect(result.stockStatus).toBe(InventoryStockStatus.LOW_STOCK);
    });

    it('should return IN_STOCK when totalAvailable > 5 even if first SKU in projections has 0 quantity', async () => {
      const product = createValidProductDoc();
      setupValidReadinessFixtures();
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
        {
          sku_id: 's1',
          available_qty_snapshot: BigInt(0),
          stock_status: InventoryStockStatus.OUT_OF_STOCK,
          as_of: new Date('2026-09-26T10:00:00Z'),
        },
        {
          sku_id: 's2',
          available_qty_snapshot: BigInt(8),
          stock_status: InventoryStockStatus.IN_STOCK,
          as_of: new Date('2026-09-26T10:05:00Z'),
        },
      ]);

      const result = await service.validatePublishReadiness(product, shopScope);
      expect(result.stockStatus).toBe(InventoryStockStatus.IN_STOCK);
      expect(result.stockAsOf).toEqual(new Date('2026-09-26T10:05:00Z'));
    });

    it('should return UNKNOWN stock status when no inventory projection exists', async () => {
      const product = createValidProductDoc();
      setupValidReadinessFixtures();
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([]);

      const result = await service.validatePublishReadiness(product, shopScope);
      expect(result.stockStatus).toBe(InventoryStockStatus.UNKNOWN);
      expect(result.stockAsOf).toBeNull();
    });
  });

  describe('publish', () => {
    it('should throw PRODUCT_NOT_FOUND when product does not exist', async () => {
      mockProductRepository.findById.mockResolvedValue(null);
      await expect(
        service.publish(actorUserId, shopScope, 'non-existent', { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_NOT_FOUND' },
      });
    });

    it('should throw PRODUCT_FORBIDDEN on IDOR violation (different shop)', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ shop_id: 'other-shop' }),
      );
      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_FORBIDDEN' },
      });
    });

    it('should throw PRODUCT_BLOCKED when product is BLOCKED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.BLOCKED }),
      );
      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_BLOCKED' },
      });
    });

    it('should throw PRODUCT_ARCHIVED when product is ARCHIVED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.ARCHIVED }),
      );
      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_ARCHIVED' },
      });
    });

    it('should throw PRODUCT_STATE_INVALID when product is already ACTIVE', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.ACTIVE }),
      );
      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_STATE_INVALID' },
      });
    });

    it('should throw PRODUCT_VERSION_CONFLICT when expected version mismatches', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ version: BigInt(2) }),
      );
      await expect(
        service.publish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should successfully publish product, emit outbox event, and record audit', async () => {
      const product = createValidProductDoc({ version: BigInt(1) });
      mockProductRepository.findById.mockResolvedValue(product);
      setupValidReadinessFixtures();

      const updatedProduct = {
        ...product,
        status: ProductStatus.ACTIVE,
        version: BigInt(2),
      };
      mockProductRepository.atomicCasUpdate.mockResolvedValue(updatedProduct);

      const response = await service.publish(actorUserId, shopScope, productId, { version: 1 });

      expect(response).toMatchObject({
        product_id: productId,
        status: ProductStatus.ACTIVE,
        version: 2,
        stock_display: {
          status: InventoryStockStatus.IN_STOCK,
        },
      });

      // Verify CAS update
      expect(mockProductRepository.atomicCasUpdate).toHaveBeenCalledWith(
        productId,
        shopScope,
        1,
        expect.objectContaining({
          status: ProductStatus.ACTIVE,
        }),
        expect.anything(),
      );

      // Verify Outbox event
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.published',
          topic: 'product.events.v1',
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          version: BigInt(2),
          payload: expect.objectContaining({
            product_id: productId,
            shop_id: shopScope,
            visibility_status: 'PUBLISHED',
          }),
        }),
        expect.anything(),
      );

      // Verify Audit record
      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PUBLISH,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          shop_id: shopScope,
        }),
        expect.anything(),
      );
    });
  });

  describe('unpublish', () => {
    it('should successfully unpublish ACTIVE product to INACTIVE', async () => {
      const product = createValidProductDoc({
        status: ProductStatus.ACTIVE,
        version: BigInt(3),
      });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.INACTIVE,
        version: BigInt(4),
      });

      const response = await service.unpublish(actorUserId, shopScope, productId, {
        version: 3,
        reason: 'Tạm dừng bảo trì',
      });

      expect(response).toEqual({
        product_id: productId,
        status: ProductStatus.INACTIVE,
        version: 4,
      });

      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.unpublished',
          topic: 'product.events.v1',
          payload: expect.objectContaining({
            product_id: productId,
            reason: 'Tạm dừng bảo trì',
            version: 4,
          }),
        }),
        expect.anything(),
      );

      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UNPUBLISH,
          reason: 'Tạm dừng bảo trì',
        }),
        expect.anything(),
      );
    });

    it('should throw PRODUCT_STATE_INVALID when product is DRAFT', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.DRAFT }),
      );
      await expect(
        service.unpublish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_STATE_INVALID' },
      });
    });

    it('should throw PRODUCT_BLOCKED when product is BLOCKED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.BLOCKED }),
      );
      await expect(
        service.unpublish(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_BLOCKED' },
      });
    });

    it('should throw PRODUCT_VERSION_CONFLICT on version mismatch', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.ACTIVE, version: BigInt(5) }),
      );
      await expect(
        service.unpublish(actorUserId, shopScope, productId, { version: 4 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });
  });

  describe('archive', () => {
    it('should successfully archive a DRAFT or INACTIVE or ACTIVE product', async () => {
      const product = createValidProductDoc({
        status: ProductStatus.INACTIVE,
        version: BigInt(2),
      });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.ARCHIVED,
        version: BigInt(3),
      });

      const response = await service.archive(actorUserId, shopScope, productId, {
        version: 2,
        reason: 'Ngừng kinh doanh vĩnh viễn',
      });

      expect(response).toEqual({
        product_id: productId,
        status: ProductStatus.ARCHIVED,
        version: 3,
      });

      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.archived',
          topic: 'product.events.v1',
          payload: expect.objectContaining({
            product_id: productId,
            reason: 'Ngừng kinh doanh vĩnh viễn',
            version: 3,
          }),
        }),
        expect.anything(),
      );

      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ARCHIVE,
          reason: 'Ngừng kinh doanh vĩnh viễn',
        }),
        expect.anything(),
      );
    });

    it('should throw PRODUCT_STATE_INVALID when product is already ARCHIVED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.ARCHIVED }),
      );
      await expect(
        service.archive(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_STATE_INVALID' },
      });
    });

    it('should throw PRODUCT_BLOCKED when product is BLOCKED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createValidProductDoc({ status: ProductStatus.BLOCKED }),
      );
      await expect(
        service.archive(actorUserId, shopScope, productId, { version: 1 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_BLOCKED' },
      });
    });
  });
});
