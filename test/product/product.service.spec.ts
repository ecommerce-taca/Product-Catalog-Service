import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

jest.mock('sanitize-html', () => {
  return jest.fn().mockImplementation((input: string) => {
    if (!input) return input;
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  });
});

import { ProductService } from '../../src/product/services/product.service';
import { ProductStatus } from '../../src/database/schemas/product.schema';
import { CategoryStatus } from '../../src/database/schemas/category.schema';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('ProductService', () => {
  let service: ProductService;

  const mockProductRepository = {
    findById: jest.fn(),
    findByShopAndSlug: jest.fn(),
    findByShopAndId: jest.fn(),
    findSellerProducts: jest.fn(),
    atomicCasUpdate: jest.fn(),
    create: jest.fn(),
  };

  const mockProductCategoryRepository = {
    findByProductId: jest.fn(),
    replaceProductCategories: jest.fn(),
  };

  const mockCategoryRepository = {
    findById: jest.fn(),
  };

  const mockAttributeDefinitionRepository = {
    findByScope: jest.fn(),
  };

  const mockSkuRepository = {
    findByProductId: jest.fn(),
    count: jest.fn(),
  };

  const mockOutboxRepository = {
    saveEvent: jest.fn(),
  };

  const mockMediaRepository = {
    findByProductId: jest.fn().mockResolvedValue([]),
    findActiveByProductId: jest.fn().mockResolvedValue([]),
  };

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation((cb: (session: unknown) => Promise<unknown>) => cb({})),
  };

  const actorUserId = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const actorShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const otherShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d999';

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductService,
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
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttributeDefinitionRepository,
        },
        {
          provide: 'SkuRepositoryPort',
          useValue: mockSkuRepository,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: mockOutboxRepository,
        },
        {
          provide: 'ProductMediaRepositoryPort',
          useValue: mockMediaRepository,
        },
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
      ],
    }).compile();

    service = module.get<ProductService>(ProductService);
  });

  describe('createProduct', () => {
    it('should create a draft product and record outbox event', async () => {
      mockProductRepository.findByShopAndSlug.mockResolvedValue(null);
      mockProductRepository.create.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(1),
      });

      const dto = {
        title: 'Áo khoác cotton cao cấp',
        slug: 'ao-khoac-cotton-cao-cap',
        description: '<p>Mô tả <strong>sản phẩm</strong> an toàn</p>',
        brand: 'Taca Brand',
        price_summary: {
          base_price: 300000,
          sale_price: 250000,
          currency: 'VND',
        },
      };

      const result = await service.createProduct(actorUserId, actorShopId, dto);

      expect(result).toBeDefined();
      expect(result.shop_id).toBe(actorShopId);
      expect(result.status).toBe(ProductStatus.DRAFT);
      expect(result.version).toBe(1);
      expect(mockProductRepository.create).toHaveBeenCalled();
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.created',
          topic: 'product.events.v1',
          aggregate_type: 'PRODUCT',
        }),
        expect.anything(),
      );
    });

    it('should sanitize dangerous HTML tags in description', async () => {
      mockProductRepository.findByShopAndSlug.mockResolvedValue(null);
      mockProductRepository.create.mockResolvedValue({ _id: 'prod-01' });

      const dto = {
        title: 'Áo thun',
        slug: 'ao-thun',
        description: '<p>Nội dung</p><script>alert("xss")</script><iframe src="evil.com"></iframe>',
      };

      await service.createProduct(actorUserId, actorShopId, dto);

      expect(mockProductRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: '<p>Nội dung</p>',
        }),
        expect.anything(),
      );
    });

    it('should throw ConflictException (409) if slug already exists in shop', async () => {
      mockProductRepository.findByShopAndSlug.mockResolvedValue({
        _id: 'existing-id',
        slug: 'ao-khoac',
      });

      const dto = {
        title: 'Áo khoác',
        slug: 'ao-khoac',
      };

      await expect(service.createProduct(actorUserId, actorShopId, dto)).rejects.toThrow(
        ConflictException,
      );
      expect(mockProductRepository.create).not.toHaveBeenCalled();
    });

    it('should throw ForbiddenException (403) if actorShopId is missing', async () => {
      const dto = { title: 'Áo', slug: 'ao' };
      await expect(service.createProduct(actorUserId, '', dto)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getSellerProducts', () => {
    it('should return paginated list of products with sku counts', async () => {
      const mockItems = [
        {
          _id: 'prod-01',
          title: 'Áo khoác',
          slug: 'ao-khoac',
          status: ProductStatus.DRAFT,
          primary_category_id: null,
          price_summary: null,
          updated_at: new Date(),
        },
      ];
      mockProductRepository.findSellerProducts.mockResolvedValue({
        items: mockItems,
        total: 1,
      });
      mockSkuRepository.count.mockResolvedValue(2);

      const result = await service.getSellerProducts(actorShopId, { page: 1, size: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].product_id).toBe('prod-01');
      expect(result.data[0].sku_count).toBe(2);
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
    });
  });

  describe('getSellerProductDetail', () => {
    it('should throw NotFoundException (404) if product does not exist', async () => {
      mockProductRepository.findById.mockResolvedValue(null);

      await expect(service.getSellerProductDetail(actorShopId, 'non-existing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException (403) for IDOR attack (different shop_id)', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: otherShopId,
      });

      await expect(service.getSellerProductDetail(actorShopId, 'prod-01')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should hydrate product with definitions, skus, and categories', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.ACTIVE,
        version: BigInt(2),
        title: 'Áo khoác',
        slug: 'ao-khoac',
        description: 'Mô tả',
        brand: 'Taca',
        price_summary: { base_price: BigInt(200000), sale_price: BigInt(180000), currency: 'VND' },
        shop_snapshot: { shop_id: actorShopId, shop_status: 'ACTIVE', kyc_status: 'APPROVED' },
        block_reason: null,
      });

      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([
        {
          key: 'color',
          label: 'Màu',
          type: 'ENUM',
          is_variant_dimension: true,
          allowed_values: ['red', 'blue'],
        },
      ]);

      mockSkuRepository.findByProductId.mockResolvedValue([
        {
          _id: 'sku-01',
          seller_sku: 'AK-RED',
          attributes: { color: 'red' },
          price_override: null,
          status: 'ACTIVE',
        },
      ]);

      mockProductCategoryRepository.findByProductId.mockResolvedValue([
        { category_id: 'cat-01', is_primary: true },
        { category_id: 'cat-02', is_primary: false },
      ]);

      mockMediaRepository.findActiveByProductId.mockResolvedValue([
        {
          _id: 'media-01',
          object_key: 'products/shop-1/product-1/media-01.jpg',
          status: 'READY',
          is_cover: true,
        },
      ]);

      const result = await service.getSellerProductDetail(actorShopId, 'prod-01');

      expect(result.product_id).toBe('prod-01');
      expect(result.attribute_definitions).toHaveLength(1);
      expect(result.skus).toHaveLength(1);
      expect(result.categories.primary_category_id).toBe('cat-01');
      expect(result.categories.secondary_category_ids).toEqual(['cat-02']);
      expect(result.media).toHaveLength(1);
      expect(result.media[0]).toEqual({
        media_id: 'media-01',
        url: 'products/shop-1/product-1/media-01.jpg',
        status: 'READY',
        is_cover: true,
      });
    });
  });

  describe('updateProduct', () => {
    it('should throw ConflictException (409) if product is ARCHIVED', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.ARCHIVED,
      });

      await expect(
        service.updateProduct(actorUserId, actorShopId, 'prod-01', {
          version: 1,
          title: 'Tên mới',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw ForbiddenException (403) if product is BLOCKED', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.BLOCKED,
      });

      await expect(
        service.updateProduct(actorUserId, actorShopId, 'prod-01', {
          version: 1,
          title: 'Tên mới',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ConflictException (409) on optimistic lock mismatch (CAS failure)', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(2),
      });

      mockProductRepository.atomicCasUpdate.mockResolvedValue(null);

      await expect(
        service.updateProduct(actorUserId, actorShopId, 'prod-01', {
          version: 1,
          title: 'Tên mới',
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('should apply price_summary in PATCH when product has NO SKUs', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(1),
        slug: 'ao-khoac',
      });
      mockSkuRepository.findByProductId.mockResolvedValue([]);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(2),
        title: 'Áo khoác mới',
        slug: 'ao-khoac',
        price_summary: { base_price: BigInt(200000), sale_price: BigInt(180000), currency: 'VND' },
        updated_at: new Date(),
      });

      const result = await service.updateProduct(actorUserId, actorShopId, 'prod-01', {
        version: 1,
        title: 'Áo khoác mới',
        price_summary: { base_price: 200000, sale_price: 180000, currency: 'VND' },
      });

      expect(result.version).toEqual(BigInt(2));
      expect(mockProductRepository.atomicCasUpdate).toHaveBeenCalledWith(
        'prod-01',
        actorShopId,
        1,
        expect.objectContaining({
          price_summary: expect.any(Object),
        }),
        expect.anything(),
      );
    });

    it('should ignore price_summary in PATCH when product HAS SKUs', async () => {
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(1),
        slug: 'ao-khoac',
      });
      mockSkuRepository.findByProductId.mockResolvedValue([{ _id: 'sku-01' }]);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(2),
        title: 'Áo khoác mới',
        slug: 'ao-khoac',
        updated_at: new Date(),
      });

      await service.updateProduct(actorUserId, actorShopId, 'prod-01', {
        version: 1,
        title: 'Áo khoác mới',
        price_summary: { base_price: 200000, sale_price: 180000, currency: 'VND' },
      });

      expect(mockProductRepository.atomicCasUpdate).toHaveBeenCalledWith(
        'prod-01',
        actorShopId,
        1,
        expect.not.objectContaining({
          price_summary: expect.anything(),
        }),
        expect.anything(),
      );
    });

    it('should record outbox event product.updated with full payload including changes and updated fields', async () => {
      mockProductRepository.findByShopAndSlug.mockResolvedValue(null);
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(1),
        slug: 'ao-khoac',
      });
      mockSkuRepository.findByProductId.mockResolvedValue([]);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(2),
        title: 'Áo khoác mới',
        slug: 'ao-khoac-moi',
        price_summary: { base_price: BigInt(200000), sale_price: BigInt(180000), currency: 'VND' },
        updated_at: new Date(),
      });

      await service.updateProduct(actorUserId, actorShopId, 'prod-01', {
        version: 1,
        title: 'Áo khoác mới',
        slug: 'ao-khoac-moi',
      });

      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.updated',
          topic: 'product.events.v1',
          aggregate_type: 'PRODUCT',
          payload: expect.objectContaining({
            product_id: 'prod-01',
            shop_id: actorShopId,
            version: BigInt(2),
            status: ProductStatus.DRAFT,
            changes: ['title', 'slug'],
            title: 'Áo khoác mới',
            slug: 'ao-khoac-moi',
          }),
        }),
        expect.anything(),
      );
    });
  });

  describe('assignCategories', () => {
    const primaryCatId = '01912f30-7a1b-7c12-9c55-8b1c34a6d101';
    const secondaryCatId = '01912f30-7a1b-7c12-9c55-8b1c34a6d102';

    it('should successfully assign primary and secondary categories', async () => {
      mockCategoryRepository.findById.mockImplementation((id: string) => {
        return Promise.resolve({ _id: id, status: CategoryStatus.ACTIVE });
      });

      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(1),
      });

      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        _id: 'prod-01',
        version: BigInt(2),
      });

      const dto = {
        version: 1,
        primary_category_id: primaryCatId,
        secondary_category_ids: [secondaryCatId],
      };

      const result = await service.assignCategories(actorUserId, actorShopId, 'prod-01', dto);

      expect(result.primary_category_id).toBe(primaryCatId);
      expect(result.secondary_category_ids).toEqual([secondaryCatId]);
      expect(mockProductCategoryRepository.replaceProductCategories).toHaveBeenCalledWith(
        'prod-01',
        [
          { category_id: primaryCatId, is_primary: true, assigned_by: actorUserId },
          { category_id: secondaryCatId, is_primary: false, assigned_by: actorUserId },
        ],
        expect.anything(),
      );
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.category_changed',
          topic: 'catalog.events.v1',
        }),
        expect.anything(),
      );
    });

    it('should fallback assigned_by to valid UUIDv7 SYSTEM_ACTOR_ID when actorUserId is undefined', async () => {
      mockCategoryRepository.findById.mockResolvedValue({
        _id: primaryCatId,
        status: CategoryStatus.ACTIVE,
      });
      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(1),
      });
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        _id: 'prod-01',
        version: BigInt(2),
      });

      const dto = {
        version: 1,
        primary_category_id: primaryCatId,
      };

      await service.assignCategories(undefined, actorShopId, 'prod-01', dto);

      expect(mockProductCategoryRepository.replaceProductCategories).toHaveBeenCalledWith(
        'prod-01',
        [
          {
            category_id: primaryCatId,
            is_primary: true,
            assigned_by: '01910000-0000-7000-8000-000000000000',
          },
        ],
        expect.anything(),
      );
    });

    it('should throw BadRequestException (400) when primary and secondary categories duplicate', async () => {
      const dto = {
        version: 1,
        primary_category_id: primaryCatId,
        secondary_category_ids: [primaryCatId],
      };

      await expect(
        service.assignCategories(actorUserId, actorShopId, 'prod-01', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException (400) if category does not exist or is inactive', async () => {
      mockCategoryRepository.findById.mockResolvedValue({
        _id: primaryCatId,
        status: CategoryStatus.INACTIVE,
      });

      const dto = {
        version: 1,
        primary_category_id: primaryCatId,
        secondary_category_ids: [],
      };

      await expect(
        service.assignCategories(actorUserId, actorShopId, 'prod-01', dto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException (409) if version conflict occurs during assignment', async () => {
      mockCategoryRepository.findById.mockResolvedValue({
        _id: primaryCatId,
        status: CategoryStatus.ACTIVE,
      });

      mockProductRepository.findById.mockResolvedValue({
        _id: 'prod-01',
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: BigInt(2),
      });

      mockProductRepository.atomicCasUpdate.mockResolvedValue(null);

      const dto = {
        version: 1,
        primary_category_id: primaryCatId,
      };

      await expect(
        service.assignCategories(actorUserId, actorShopId, 'prod-01', dto),
      ).rejects.toThrow(ConflictException);
    });
  });
});
