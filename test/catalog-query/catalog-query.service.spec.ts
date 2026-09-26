import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CatalogQueryService } from '../../src/catalog-query/services/catalog-query.service';
import { ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuStatus } from '../../src/database/schemas/sku.schema';
import { MediaStatus } from '../../src/database/schemas/product-media.schema';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { INVENTORY_PROJECTION_REPOSITORY_PORT } from '../../src/projections/repositories/inventory-projection.repository.interface';
import { CategoryService } from '../../src/category/services/category.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { ProductSortOption } from '../../src/catalog-query/dto/query-products.dto';

describe('CatalogQueryService', () => {
  let service: CatalogQueryService;

  const mockProductRepository = {
    find: jest.fn(),
    findById: jest.fn(),
    count: jest.fn(),
  };

  const mockShopSnapshotRepository = {
    findByShopId: jest.fn(),
    findByShopIds: jest.fn(),
  };

  const mockCategoryRepository = {
    findById: jest.fn(),
    find: jest.fn(),
  };

  const mockProductCategoryRepository = {
    find: jest.fn(),
  };

  const mockSkuRepository = {
    findByProductId: jest.fn(),
  };

  const mockMediaRepository = {
    findByProductId: jest.fn(),
    findByProductIds: jest.fn(),
  };

  const mockInventoryProjectionRepository = {
    findByProductId: jest.fn(),
    findByProductIds: jest.fn(),
    findBySkuId: jest.fn(),
  };

  const mockAttributeDefinitionRepository = {
    findByScope: jest.fn(),
  };

  const mockCategoryService = {
    resolveEffectiveTaxRate: jest.fn(),
  };

  const mockS3StorageService = {
    getPublicUrl: jest.fn((key: string) => `https://cdn.example.com/${key}`),
  };

  const sampleProduct = {
    _id: 'prod-01',
    shop_id: 'shop-01',
    title: 'Áo khoác cotton',
    slug: 'ao-khoac-cotton',
    description: 'Mô tả chi tiết',
    brand: 'Taca Brand',
    status: ProductStatus.ACTIVE,
    primary_category_id: 'cat-01',
    price_summary: {
      base_price: BigInt(299000),
      sale_price: BigInt(249000),
      currency: 'VND',
    },
    rating_summary: {
      avg: 4.5,
      count: 128,
    },
    archived_at: null,
    created_at: new Date('2026-08-30T09:00:00Z'),
    updated_at: new Date('2026-08-30T09:00:00Z'),
  };

  const sampleShop = {
    shop_id: 'shop-01',
    name: 'Taca Shop',
    slug: 'taca-shop',
    logo_url: 'https://cdn.example.com/logo.png',
    shop_status: 'ACTIVE',
  };

  const sampleMedia = [
    {
      _id: 'media-01',
      product_id: 'prod-01',
      object_key: 'prod-01/cover.webp',
      content_type: 'image/webp',
      is_cover: true,
      status: MediaStatus.READY,
      sort_order: 0,
      created_at: new Date('2026-08-30T09:00:00Z'),
    },
    {
      _id: 'media-02',
      product_id: 'prod-01',
      object_key: 'prod-01/gallery.webp',
      content_type: 'image/webp',
      is_cover: false,
      status: MediaStatus.READY,
      sort_order: 1,
      created_at: new Date('2026-08-30T09:01:00Z'),
    },
  ];

  const sampleSku = {
    _id: 'sku-01',
    product_id: 'prod-01',
    seller_sku: 'COTTON-L',
    attributes: { material: 'cotton', size: 'L' },
    price_override: null,
    status: SkuStatus.ACTIVE,
  };

  const sampleProjection = {
    sku_id: 'sku-01',
    product_id: 'prod-01',
    stock_status: 'IN_STOCK',
    available_qty_snapshot: BigInt(10),
    as_of: new Date(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CatalogQueryService,
        { provide: 'ProductRepositoryPort', useValue: mockProductRepository },
        { provide: SHOP_SNAPSHOT_REPOSITORY_PORT, useValue: mockShopSnapshotRepository },
        { provide: 'CategoryRepositoryPort', useValue: mockCategoryRepository },
        { provide: 'ProductCategoryRepositoryPort', useValue: mockProductCategoryRepository },
        { provide: 'SkuRepositoryPort', useValue: mockSkuRepository },
        { provide: 'ProductMediaRepositoryPort', useValue: mockMediaRepository },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: mockInventoryProjectionRepository,
        },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttributeDefinitionRepository,
        },
        { provide: CategoryService, useValue: mockCategoryService },
        { provide: S3StorageService, useValue: mockS3StorageService },
      ],
    }).compile();

    service = module.get<CatalogQueryService>(CatalogQueryService);

    mockShopSnapshotRepository.findByShopIds.mockImplementation(async (ids: string[]) => {
      const list = await Promise.all(ids.map((id) => mockShopSnapshotRepository.findByShopId(id)));
      return list.filter(Boolean);
    });
    mockMediaRepository.findByProductIds.mockImplementation(async (ids: string[]) => {
      const list = await Promise.all(ids.map((id) => mockMediaRepository.findByProductId(id)));
      return list.flat().filter(Boolean);
    });
    mockInventoryProjectionRepository.findByProductIds.mockImplementation(async (ids: string[]) => {
      const list = await Promise.all(
        ids.map((id) => mockInventoryProjectionRepository.findByProductId(id)),
      );
      return list.flat().filter(Boolean);
    });
  });

  describe('listProducts', () => {
    it('should query active products with default pagination and hydrate data', async () => {
      mockProductRepository.find.mockResolvedValue([sampleProduct]);
      mockProductRepository.count.mockResolvedValue(1);
      mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
      mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(1000);
      mockMediaRepository.findByProductId.mockResolvedValue(sampleMedia);
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([sampleProjection]);

      const result = await service.listProducts({});

      expect(result.data).toHaveLength(1);
      const card = result.data[0];
      expect(card.product_id).toBe('prod-01');
      expect(card.shop.name).toBe('Taca Shop');
      expect(card.tax_rate_bps).toBe(1000);
      expect(card.price.base_price).toBe(299000);
      expect(card.price.sale_price).toBe(249000);
      expect(card.cover_media?.media_id).toBe('media-01');
      expect(card.rating_summary.avg).toBe(4.5);
      expect(card.stock_display.status).toBe('IN_STOCK');
      expect(result.meta.page).toBe(1);
      expect(result.meta.size).toBe(20);
      expect(result.meta.total).toBe(1);
      expect(result.meta.total_pages).toBe(1);

      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: ProductStatus.ACTIVE, archived_at: null }),
        expect.objectContaining({ readPreference: 'primaryPreferred', skip: 0, limit: 20 }),
      );
    });

    it('should filter by shop_id and category_id', async () => {
      mockProductCategoryRepository.find.mockResolvedValue([{ product_id: 'prod-01' }]);
      mockProductRepository.find.mockResolvedValue([sampleProduct]);
      mockProductRepository.count.mockResolvedValue(1);
      mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
      mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(1000);
      mockMediaRepository.findByProductId.mockResolvedValue(sampleMedia);
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([sampleProjection]);

      await service.listProducts({
        shop_id: 'shop-01',
        category_id: 'cat-01',
      });

      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          shop_id: 'shop-01',
          $or: [{ primary_category_id: 'cat-01' }, { _id: { $in: ['prod-01'] } }],
        }),
        expect.any(Object),
      );
    });

    it('should filter by min_price and max_price', async () => {
      mockProductRepository.find.mockResolvedValue([]);
      mockProductRepository.count.mockResolvedValue(0);

      await service.listProducts({
        min_price: 100000,
        max_price: 300000,
      });

      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({
          'price_summary.sale_price': {
            $gte: BigInt(100000),
            $lte: BigInt(300000),
          },
        }),
        expect.any(Object),
      );
    });

    it('should apply sort options correctly', async () => {
      mockProductRepository.find.mockResolvedValue([]);
      mockProductRepository.count.mockResolvedValue(0);

      await service.listProducts({ sort: ProductSortOption.PRICE_ASC });
      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ sort: { 'price_summary.sale_price': 1 } }),
      );

      await service.listProducts({ sort: ProductSortOption.PRICE_DESC });
      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ sort: { 'price_summary.sale_price': -1 } }),
      );

      await service.listProducts({ sort: ProductSortOption.NEWEST });
      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ sort: { created_at: -1 } }),
      );
    });

    describe('batch hydration via product_ids (PC-API-009b)', () => {
      it('should hydrate requested product_ids, gracefully omit missing/inactive, and preserve order', async () => {
        const prodA = { ...sampleProduct, _id: 'id-a', title: 'Product A' };
        const prodC = { ...sampleProduct, _id: 'id-c', title: 'Product C' };

        // MongoDB returns in arbitrary order
        mockProductRepository.find.mockResolvedValue([prodC, prodA]);
        mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
        mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(null);
        mockMediaRepository.findByProductId.mockResolvedValue([]);
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([]);

        // id-b does not exist
        const result = await service.listProducts({
          product_ids: 'id-a, id-b, id-c',
        });

        expect(result.data).toHaveLength(2);
        // Preserves order of id-a before id-c
        expect(result.data[0].product_id).toBe('id-a');
        expect(result.data[1].product_id).toBe('id-c');
        expect(result.meta.total).toBe(2);
      });

      it('should return empty list when product_ids is empty', async () => {
        const result = await service.listProducts({
          product_ids: '   ',
        });

        expect(result.data).toHaveLength(0);
        expect(result.meta.total).toBe(0);
        expect(mockProductRepository.find).not.toHaveBeenCalled();
      });

      it('should throw 400 PRODUCT_INVALID_INPUT when product_ids > 100', async () => {
        const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`).join(',');
        await expect(service.listProducts({ product_ids: ids })).rejects.toThrow(
          BadRequestException,
        );
      });

      it('should ignore secondary filters (shop_id, category_id, min_price, max_price) when product_ids is passed (SG-01)', async () => {
        mockProductRepository.find.mockResolvedValue([sampleProduct]);

        await service.listProducts({
          product_ids: 'prod-01',
          shop_id: 'other-shop',
          category_id: 'other-cat',
          min_price: 100000,
          max_price: 500000,
        });

        expect(mockProductRepository.find).toHaveBeenCalledWith(
          {
            _id: { $in: ['prod-01'] },
            status: ProductStatus.ACTIVE,
            archived_at: null,
          },
          expect.objectContaining({ readPreference: 'primaryPreferred' }),
        );
        expect(mockProductCategoryRepository.find).not.toHaveBeenCalled();
      });

      it('should batch hydrate products using findByShopIds and findByProductIds to prevent N+1 queries (SF-03)', async () => {
        const prod1 = {
          ...sampleProduct,
          _id: 'prod-01',
          shop_id: 'shop-01',
          primary_category_id: 'cat-01',
        };
        const prod2 = {
          ...sampleProduct,
          _id: 'prod-02',
          shop_id: 'shop-02',
          primary_category_id: 'cat-01',
        };
        const prod3 = {
          ...sampleProduct,
          _id: 'prod-03',
          shop_id: 'shop-01',
          primary_category_id: 'cat-02',
        };

        mockProductRepository.find.mockResolvedValue([prod1, prod2, prod3]);
        mockShopSnapshotRepository.findByShopIds.mockResolvedValue([
          { ...sampleShop, shop_id: 'shop-01' },
          { ...sampleShop, shop_id: 'shop-02' },
        ]);
        mockMediaRepository.findByProductIds.mockResolvedValue([]);
        mockInventoryProjectionRepository.findByProductIds.mockResolvedValue([]);
        mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(1000);

        const result = await service.listProducts({
          product_ids: 'prod-01, prod-02, prod-03',
        });

        expect(result.data).toHaveLength(3);
        // Exactly 1 batch query for shop snapshots
        expect(mockShopSnapshotRepository.findByShopIds).toHaveBeenCalledTimes(1);
        expect(mockShopSnapshotRepository.findByShopIds).toHaveBeenCalledWith([
          'shop-01',
          'shop-02',
        ]);
        // Exactly 1 batch query for media
        expect(mockMediaRepository.findByProductIds).toHaveBeenCalledTimes(1);
        expect(mockMediaRepository.findByProductIds).toHaveBeenCalledWith([
          'prod-01',
          'prod-02',
          'prod-03',
        ]);
        // Exactly 1 batch query for inventory projections
        expect(mockInventoryProjectionRepository.findByProductIds).toHaveBeenCalledTimes(1);
        expect(mockInventoryProjectionRepository.findByProductIds).toHaveBeenCalledWith([
          'prod-01',
          'prod-02',
          'prod-03',
        ]);
        // Exactly 2 tax rate lookups for 2 unique categories ('cat-01', 'cat-02') instead of 3
        expect(mockCategoryService.resolveEffectiveTaxRate).toHaveBeenCalledTimes(2);
      });
    });

    describe('validation constraints (PC-API-002)', () => {
      it('should throw 400 when page < 1', async () => {
        await expect(service.listProducts({ page: 0 })).rejects.toThrow(BadRequestException);
      });

      it('should throw 400 when size > 100', async () => {
        await expect(service.listProducts({ size: 101 })).rejects.toThrow(BadRequestException);
      });

      it('should throw 400 when size < 1', async () => {
        await expect(service.listProducts({ size: 0 })).rejects.toThrow(BadRequestException);
      });

      it('should throw 400 when min_price < 0', async () => {
        await expect(service.listProducts({ min_price: -10 })).rejects.toThrow(BadRequestException);
      });

      it('should throw 400 when max_price < 0', async () => {
        await expect(service.listProducts({ max_price: -10 })).rejects.toThrow(BadRequestException);
      });

      it('should throw 400 when min_price > max_price', async () => {
        await expect(service.listProducts({ min_price: 500, max_price: 100 })).rejects.toThrow(
          BadRequestException,
        );
      });
    });

    describe('stock aggregation display', () => {
      it('should display UNKNOWN when no projections exist', async () => {
        mockProductRepository.find.mockResolvedValue([sampleProduct]);
        mockProductRepository.count.mockResolvedValue(1);
        mockShopSnapshotRepository.findByShopId.mockResolvedValue(null);
        mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(null);
        mockMediaRepository.findByProductId.mockResolvedValue([]);
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([]);

        const result = await service.listProducts({});
        expect(result.data[0].stock_display.status).toBe('UNKNOWN');
      });

      it('should display OUT_OF_STOCK when available quantity is 0', async () => {
        mockProductRepository.find.mockResolvedValue([sampleProduct]);
        mockProductRepository.count.mockResolvedValue(1);
        mockShopSnapshotRepository.findByShopId.mockResolvedValue(null);
        mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(null);
        mockMediaRepository.findByProductId.mockResolvedValue([]);
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
          { ...sampleProjection, available_qty_snapshot: BigInt(0), stock_status: 'OUT_OF_STOCK' },
        ]);

        const result = await service.listProducts({});
        expect(result.data[0].stock_display.status).toBe('OUT_OF_STOCK');
      });

      it('should display LOW_STOCK when total available <= 5', async () => {
        mockProductRepository.find.mockResolvedValue([sampleProduct]);
        mockProductRepository.count.mockResolvedValue(1);
        mockShopSnapshotRepository.findByShopId.mockResolvedValue(null);
        mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(null);
        mockMediaRepository.findByProductId.mockResolvedValue([]);
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
          { ...sampleProjection, available_qty_snapshot: BigInt(3), stock_status: 'LOW_STOCK' },
        ]);

        const result = await service.listProducts({});
        expect(result.data[0].stock_display.status).toBe('LOW_STOCK');
      });

      it('should display STALE when projection is older than 60 seconds', async () => {
        mockProductRepository.find.mockResolvedValue([sampleProduct]);
        mockProductRepository.count.mockResolvedValue(1);
        mockShopSnapshotRepository.findByShopId.mockResolvedValue(null);
        mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(null);
        mockMediaRepository.findByProductId.mockResolvedValue([]);
        mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
          {
            ...sampleProjection,
            as_of: new Date(Date.now() - 120000), // 2 minutes ago
          },
        ]);

        const result = await service.listProducts({});
        expect(result.data[0].stock_display.status).toBe('STALE');
      });
    });
  });

  describe('getProductDetail (PC-API-004, PC-API-005)', () => {
    it('should return complete PDP detail for active product', async () => {
      mockProductRepository.findById.mockResolvedValue(sampleProduct);
      mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
      mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(1000);
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([
        {
          key: 'material',
          label: 'Chất liệu',
          type: 'ENUM',
          allowed_values: ['cotton', 'polyester'],
        },
      ]);
      mockMediaRepository.findByProductId.mockResolvedValue(sampleMedia);
      mockSkuRepository.findByProductId.mockResolvedValue([sampleSku]);
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([sampleProjection]);

      const result = await service.getProductDetail('prod-01');

      expect(result.product_id).toBe('prod-01');
      expect(result.status).toBe('ACTIVE');
      expect(result.title).toBe('Áo khoác cotton');
      expect(result.tax_rate_bps).toBe(1000);
      expect(result.shop.shop_id).toBe('shop-01');
      expect(result.attributes).toHaveLength(1);
      expect(result.attributes[0].key).toBe('material');
      expect(result.skus).toHaveLength(1);
      expect(result.skus[0].sku_id).toBe('sku-01');
      expect(result.skus[0].stock_display.available_qty_snapshot).toBe(10);
      expect(result.media).toHaveLength(2);
      expect(result.media[0].is_cover).toBe(true);
    });

    it('should throw 404 PRODUCT_NOT_FOUND when product does not exist', async () => {
      mockProductRepository.findById.mockResolvedValue(null);

      await expect(service.getProductDetail('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 PRODUCT_NOT_FOUND when product status is DRAFT (PC-API-005)', async () => {
      mockProductRepository.findById.mockResolvedValue({
        ...sampleProduct,
        status: ProductStatus.DRAFT,
      });

      await expect(service.getProductDetail('prod-01')).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 PRODUCT_NOT_FOUND when product is BLOCKED', async () => {
      mockProductRepository.findById.mockResolvedValue({
        ...sampleProduct,
        status: ProductStatus.BLOCKED,
      });

      await expect(service.getProductDetail('prod-01')).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 PRODUCT_NOT_FOUND when product is ARCHIVED', async () => {
      mockProductRepository.findById.mockResolvedValue({
        ...sampleProduct,
        status: ProductStatus.ARCHIVED,
        archived_at: new Date(),
      });

      await expect(service.getProductDetail('prod-01')).rejects.toThrow(NotFoundException);
    });

    it('should mark SKU stock_display status as STALE when projection is older than 60s (SF-02)', async () => {
      mockProductRepository.findById.mockResolvedValue(sampleProduct);
      mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
      mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(1000);
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([]);
      mockMediaRepository.findByProductId.mockResolvedValue([]);
      mockSkuRepository.findByProductId.mockResolvedValue([sampleSku]);
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
        {
          ...sampleProjection,
          stock_status: 'IN_STOCK',
          as_of: new Date(Date.now() - 65000), // 65 seconds ago (> 60s)
        },
      ]);

      const result = await service.getProductDetail('prod-01');

      expect(result.skus[0].stock_display.status).toBe('STALE');
    });

    it('should mark SKU stock_display status as STALE when projection stock_status is STALE (SF-02)', async () => {
      mockProductRepository.findById.mockResolvedValue(sampleProduct);
      mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
      mockCategoryService.resolveEffectiveTaxRate.mockResolvedValue(1000);
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([]);
      mockMediaRepository.findByProductId.mockResolvedValue([]);
      mockSkuRepository.findByProductId.mockResolvedValue([sampleSku]);
      mockInventoryProjectionRepository.findByProductId.mockResolvedValue([
        {
          ...sampleProjection,
          stock_status: 'STALE',
          as_of: new Date(),
        },
      ]);

      const result = await service.getProductDetail('prod-01');

      expect(result.skus[0].stock_display.status).toBe('STALE');
    });
  });

  describe('listShopProducts (PC-API-009)', () => {
    it('should throw 403 PRODUCT_SHOP_SUSPENDED when shop is SUSPENDED', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        ...sampleShop,
        shop_status: 'SUSPENDED',
      });

      await expect(service.listShopProducts('shop-01', {})).rejects.toThrow(ForbiddenException);
    });

    it('should call listProducts with shop_id when shop is ACTIVE', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue(sampleShop);
      mockProductRepository.find.mockResolvedValue([]);
      mockProductRepository.count.mockResolvedValue(0);

      const result = await service.listShopProducts('shop-01', {});
      expect(result.data).toEqual([]);
      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ shop_id: 'shop-01' }),
        expect.any(Object),
      );
    });
  });
});
