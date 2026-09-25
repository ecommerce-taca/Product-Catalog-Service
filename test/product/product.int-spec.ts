import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import mongoose from 'mongoose';
import { ProductService } from '../../src/product/services/product.service';
import { SellerProductController } from '../../src/product/controllers/seller-product.controller';
import { ProductSchema, ProductStatus } from '../../src/database/schemas/product.schema';
import { CategoryStatus } from '../../src/database/schemas/category.schema';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { ActorContext } from '../../src/common/context/actor-context.interface';

jest.mock('sanitize-html', () => {
  return jest.fn().mockImplementation((input: string) => {
    if (!input) return input;
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  });
});

/**
 * Product Core Integration & IDOR Security Test Suite [TEST-B04]
 * References:
 * - product-catalog-docs/docs/test/product-catalog.md §3.2 (PC-API-010..015, PC-API-023..025, PC-SEC-001, PC-SEC-002, PC-SEC-004)
 */
describe('Product Core Integration & IDOR Security Spec [TEST-B04]', () => {
  let service: ProductService;
  let controller: SellerProductController;

  const shopA = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopB = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const userA = '01912f30-7a1b-7c12-9c55-8b1c34a6d003';
  const userB = '01912f30-7a1b-7c12-9c55-8b1c34a6d004';

  const actorA: ActorContext = {
    userId: userA,
    roles: ['SELLER'],
    permissions: [],
    shopScope: shopA,
    isAuthenticated: true,
  };

  const actorB: ActorContext = {
    userId: userB,
    roles: ['SELLER'],
    permissions: [],
    shopScope: shopB,
    isAuthenticated: true,
  };

  const productA_Id = '01912f30-7a1b-7c12-9c55-8b1c34a6d101';
  const productB_Id = '01912f30-7a1b-7c12-9c55-8b1c34a6d102';

  const activeCategoryPrimary = '01912f30-7a1b-7c12-9c55-8b1c34a6d201';
  const activeCategorySecondary1 = '01912f30-7a1b-7c12-9c55-8b1c34a6d202';
  const activeCategorySecondary2 = '01912f30-7a1b-7c12-9c55-8b1c34a6d203';
  const inactiveCategoryId = '01912f30-7a1b-7c12-9c55-8b1c34a6d204';

  // Mock repositories
  const inMemoryProducts = new Map<string, any>();
  const inMemoryCategories = new Map<string, any>();
  const inMemoryAssignments = new Map<string, any[]>();
  const savedOutboxEvents: any[] = [];

  const mockProductRepository = {
    findById: jest.fn().mockImplementation(async (id: string) => {
      const p = inMemoryProducts.get(id);
      return p ? { ...p } : null;
    }),
    findByShopAndSlug: jest.fn().mockImplementation(async (shopId: string, slug: string) => {
      for (const p of inMemoryProducts.values()) {
        if (p.shop_id === shopId && p.slug === slug) {
          return { ...p };
        }
      }
      return null;
    }),
    findByShopAndId: jest.fn().mockImplementation(async (shopId: string, id: string) => {
      const p = inMemoryProducts.get(id);
      if (p && p.shop_id === shopId) {
        return { ...p };
      }
      return null;
    }),
    findSellerProducts: jest.fn().mockImplementation(async (shopId: string, query: any) => {
      const allForShop = Array.from(inMemoryProducts.values()).filter((p) => p.shop_id === shopId);
      let filtered = [...allForShop];

      if (query.status) {
        filtered = filtered.filter((p) => p.status === query.status);
      }

      if (query.q && query.q.trim()) {
        const escaped = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(escaped, 'i');
        filtered = filtered.filter((p) => regex.test(p.title) || regex.test(p.slug));
      }

      const page = query.page && query.page > 0 ? Number(query.page) : 1;
      const size = query.size && query.size > 0 ? Math.min(Number(query.size), 100) : 20;
      const skip = (page - 1) * size;
      const items = filtered.slice(skip, skip + size);

      return { items, total: filtered.length };
    }),
    create: jest.fn().mockImplementation(async (doc: any) => {
      inMemoryProducts.set(doc._id, { ...doc });
      return { ...doc };
    }),
    atomicCasUpdate: jest
      .fn()
      .mockImplementation(
        async (id: string, shopId: string, expectedVersion: number | bigint, updateData: any) => {
          const current = inMemoryProducts.get(id);
          if (
            !current ||
            current.shop_id !== shopId ||
            current.version !== BigInt(expectedVersion)
          ) {
            return null;
          }
          const nextVersion = BigInt(expectedVersion) + BigInt(1);
          const $set = updateData.$set || updateData;
          const updated = {
            ...current,
            ...$set,
            version: nextVersion,
            updated_at: new Date(),
          };
          inMemoryProducts.set(id, updated);
          return { ...updated };
        },
      ),
  };

  const mockProductCategoryRepository = {
    findByProductId: jest.fn().mockImplementation(async (productId: string) => {
      return inMemoryAssignments.get(productId) || [];
    }),
    replaceProductCategories: jest
      .fn()
      .mockImplementation(async (productId: string, items: any[]) => {
        inMemoryAssignments.set(productId, items);
        return items;
      }),
  };

  const mockCategoryRepository = {
    findById: jest.fn().mockImplementation(async (id: string) => {
      const cat = inMemoryCategories.get(id);
      return cat ? { ...cat } : null;
    }),
  };

  const mockAttributeDefinitionRepository = {
    findByScope: jest.fn().mockResolvedValue([]),
  };

  const mockSkuRepository = {
    findByProductId: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockImplementation(async ({ product_id }: { product_id: string }) => {
      return product_id === productA_Id ? 2 : 0;
    }),
  };

  const mockProductMediaRepository = {
    findByProductId: jest.fn().mockResolvedValue([]),
    findActiveByProductId: jest.fn().mockResolvedValue([]),
  };

  const mockOutboxRepository = {
    saveEvent: jest.fn().mockImplementation(async (event: any) => {
      savedOutboxEvents.push(event);
      return event;
    }),
  };

  const mockTransactionRunner = {
    execute: jest
      .fn()
      .mockImplementation(async (cb: (session: unknown) => Promise<unknown>) => cb({})),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    inMemoryProducts.clear();
    inMemoryCategories.clear();
    inMemoryAssignments.clear();
    savedOutboxEvents.length = 0;

    // Seed Categories
    inMemoryCategories.set(activeCategoryPrimary, {
      _id: activeCategoryPrimary,
      name: 'Thời trang nam',
      status: CategoryStatus.ACTIVE,
    });
    inMemoryCategories.set(activeCategorySecondary1, {
      _id: activeCategorySecondary1,
      name: 'Áo khoác nam',
      status: CategoryStatus.ACTIVE,
    });
    inMemoryCategories.set(activeCategorySecondary2, {
      _id: activeCategorySecondary2,
      name: 'Áo gió nam',
      status: CategoryStatus.ACTIVE,
    });
    inMemoryCategories.set(inactiveCategoryId, {
      _id: inactiveCategoryId,
      name: 'Danh mục ẩn',
      status: CategoryStatus.INACTIVE,
    });

    // Seed Product for Shop A
    inMemoryProducts.set(productA_Id, {
      _id: productA_Id,
      shop_id: shopA,
      title: 'Sản phẩm của Shop A',
      slug: 'san-pham-shop-a',
      description: 'Mô tả Shop A',
      brand: 'Brand A',
      status: ProductStatus.DRAFT,
      version: BigInt(1),
      primary_category_id: null,
      price_summary: {
        base_price: BigInt(500000),
        sale_price: BigInt(450000),
        currency: 'VND',
      },
      shop_snapshot: { shop_id: shopA, shop_status: 'ACTIVE', kyc_status: 'APPROVED' },
      rating_summary: null,
      updated_at: new Date('2026-09-24T10:00:00Z'),
    });

    // Seed Product for Shop B
    inMemoryProducts.set(productB_Id, {
      _id: productB_Id,
      shop_id: shopB,
      title: 'Sản phẩm của Shop B',
      slug: 'san-pham-shop-b',
      description: 'Mô tả Shop B',
      brand: 'Brand B',
      status: ProductStatus.DRAFT,
      version: BigInt(1),
      primary_category_id: null,
      price_summary: {
        base_price: BigInt(1000000),
        sale_price: BigInt(950000),
        currency: 'VND',
      },
      shop_snapshot: { shop_id: shopB, shop_status: 'ACTIVE', kyc_status: 'APPROVED' },
      rating_summary: null,
      updated_at: new Date('2026-09-24T10:00:00Z'),
    });

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerProductController],
      providers: [
        ProductService,
        { provide: 'ProductRepositoryPort', useValue: mockProductRepository },
        { provide: 'ProductCategoryRepositoryPort', useValue: mockProductCategoryRepository },
        { provide: 'CategoryRepositoryPort', useValue: mockCategoryRepository },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttributeDefinitionRepository,
        },
        { provide: 'SkuRepositoryPort', useValue: mockSkuRepository },
        { provide: 'ProductMediaRepositoryPort', useValue: mockProductMediaRepository },
        { provide: OutboxRepositoryPort, useValue: mockOutboxRepository },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
      ],
    }).compile();

    service = module.get<ProductService>(ProductService);
    controller = module.get<SellerProductController>(SellerProductController);
  });

  describe('1. SPU Draft Creation & VND Price BSON Long / BigInt SubSchema Validation', () => {
    const TestProductModel =
      mongoose.models.ProductIntegrationTest ||
      mongoose.model('ProductIntegrationTest', ProductSchema);

    it('should validate and instantiate Mongoose document with 64-bit BigInt prices without precision loss', () => {
      // 5 billion VND base_price (> 2^31 - 1 = 2,147,483,647, requires 64-bit BSON Long / BigInt)
      const basePriceBigInt = 5000000000n;
      const salePriceBigInt = 4500000000n;

      const doc = new TestProductModel({
        _id: '01912f30-7a1b-7c12-9c55-8b1c34a6d901',
        shop_id: shopA,
        title: 'Đồng hồ vàng siêu sang',
        slug: 'dong-ho-vang-sieu-sang',
        status: ProductStatus.DRAFT,
        price_summary: {
          base_price: basePriceBigInt,
          sale_price: salePriceBigInt,
          currency: 'VND',
        },
        version: BigInt(1),
      });

      const validationError = doc.validateSync();
      expect(validationError).toBeUndefined();

      expect(typeof doc.price_summary?.base_price).toBe('bigint');
      expect(doc.price_summary?.base_price).toBe(5000000000n);
      expect(typeof doc.price_summary?.sale_price).toBe('bigint');
      expect(doc.price_summary?.sale_price).toBe(4500000000n);
      expect(doc.price_summary?.currency).toBe('VND');
    });

    it('should reject currency other than VND via Mongoose enum validation', () => {
      const doc = new TestProductModel({
        _id: '01912f30-7a1b-7c12-9c55-8b1c34a6d902',
        shop_id: shopA,
        title: 'Sản phẩm giá USD',
        slug: 'san-pham-gia-usd',
        status: ProductStatus.DRAFT,
        price_summary: {
          base_price: 100000n,
          sale_price: 90000n,
          currency: 'USD',
        },
        version: BigInt(1),
      });

      const validationError = doc.validateSync();
      expect(validationError).toBeDefined();
      expect(validationError?.errors['price_summary.currency']).toBeDefined();
    });

    it('should create product draft via ProductService, correctly casting numbers to BigInt', async () => {
      const createDto = {
        title: 'Bộ máy ảnh cơ chuyên nghiệp',
        slug: 'bo-may-anh-co-chuyen-nghiep',
        description: '<p>Mô tả <strong>chính hãng</strong></p>',
        brand: 'Canon',
        price_summary: {
          base_price: 35000000,
          sale_price: 32000000,
          currency: 'VND',
        },
      };

      const result = await service.createProduct(userA, shopA, createDto);

      expect(result).toBeDefined();
      expect(result.status).toBe(ProductStatus.DRAFT);
      expect(result.version).toBe(1);

      const createdInDb = inMemoryProducts.get(result.product_id);
      expect(createdInDb).toBeDefined();
      expect(typeof createdInDb.price_summary.base_price).toBe('bigint');
      expect(createdInDb.price_summary.base_price).toBe(BigInt(35000000));
      expect(typeof createdInDb.price_summary.sale_price).toBe('bigint');
      expect(createdInDb.price_summary.sale_price).toBe(BigInt(32000000));
      expect(createdInDb.price_summary.currency).toBe('VND');

      // Outbox event recording
      expect(savedOutboxEvents).toHaveLength(1);
      expect(savedOutboxEvents[0].event_type).toBe('product.created');
      expect(savedOutboxEvents[0].topic).toBe('product.events.v1');
    });

    it('should allow creating draft product without price_summary (optional before SKUs)', async () => {
      const createDto = {
        title: 'Áo thun chưa định giá',
        slug: 'ao-thun-chua-dinh-gia',
      };

      const result = await service.createProduct(userA, shopA, createDto);
      expect(result.product_id).toBeDefined();

      const created = inMemoryProducts.get(result.product_id);
      expect(created.price_summary).toBeUndefined();
    });
  });

  describe('2. IDOR Security Enforcement (Zero-Trust Multi-Tenancy)', () => {
    it('should throw ForbiddenException (403 PRODUCT_FORBIDDEN) when Seller B tries to read Seller A product', async () => {
      // Seller B requests Product A (owned by Seller A)
      await expect(service.getSellerProductDetail(shopB, productA_Id)).rejects.toThrow(
        ForbiddenException,
      );

      try {
        await service.getSellerProductDetail(shopB, productA_Id);
      } catch (err: any) {
        expect(err.getStatus()).toBe(403);
        expect(err.getResponse()).toEqual({
          code: 'PRODUCT_FORBIDDEN',
          message: 'Bạn không có quyền thao tác trên sản phẩm của shop khác.',
        });
      }
    });

    it('should throw ForbiddenException (403 PRODUCT_FORBIDDEN) when Seller B tries to update Seller A product', async () => {
      const updateDto = {
        version: 1,
        title: 'Hacked Title by Shop B',
      };

      await expect(service.updateProduct(userB, shopB, productA_Id, updateDto)).rejects.toThrow(
        ForbiddenException,
      );

      try {
        await service.updateProduct(userB, shopB, productA_Id, updateDto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(403);
        expect(err.getResponse().code).toBe('PRODUCT_FORBIDDEN');
      }

      // Verify Product A is unchanged
      const productA = inMemoryProducts.get(productA_Id);
      expect(productA.title).toBe('Sản phẩm của Shop A');
      expect(productA.version).toBe(BigInt(1));
    });

    it('should throw ForbiddenException (403 PRODUCT_FORBIDDEN) when Seller B tries to assign categories to Seller A product', async () => {
      const assignDto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
      };

      await expect(service.assignCategories(userB, shopB, productA_Id, assignDto)).rejects.toThrow(
        ForbiddenException,
      );

      try {
        await service.assignCategories(userB, shopB, productA_Id, assignDto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(403);
        expect(err.getResponse().code).toBe('PRODUCT_FORBIDDEN');
      }
    });

    it('should allow legitimate owner actorA and block IDOR attempts from actorB at the Controller layer', async () => {
      // 1. Legitimate owner access
      const detail = await controller.getSellerProductDetail(shopA, productA_Id);
      expect(detail.product_id).toBe(productA_Id);

      const updated = await controller.updateProduct(actorA, shopA, productA_Id, {
        version: 1,
        title: 'Updated by Legitimate Owner',
      });
      expect(updated.title).toBe('Updated by Legitimate Owner');

      // 2. Attacker actorB attempts IDOR
      await expect(controller.getSellerProductDetail(shopB, productA_Id)).rejects.toThrow(
        ForbiddenException,
      );

      await expect(
        controller.updateProduct(actorB, shopB, productA_Id, { version: 2, title: 'Malicious' }),
      ).rejects.toThrow(ForbiddenException);

      await expect(
        controller.assignCategories(actorB, shopB, productA_Id, {
          version: 2,
          primary_category_id: activeCategoryPrimary,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject operations when actorShopId is missing/empty', async () => {
      await expect(service.createProduct(userA, '', { title: 'T', slug: 's' })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.getSellerProducts('', {})).rejects.toThrow(ForbiddenException);
      await expect(service.getSellerProductDetail('', productA_Id)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.updateProduct(userA, '', productA_Id, { version: 1 })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.assignCategories(userA, '', productA_Id, {
          version: 1,
          primary_category_id: activeCategoryPrimary,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('3. Category Assignment Business Constraints & Lifecycle Guards', () => {
    it('should throw BadRequestException (400) if primary_category_id is missing', async () => {
      const dto: any = {
        version: 1,
        secondary_category_ids: [activeCategorySecondary1],
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        BadRequestException,
      );

      try {
        await service.assignCategories(userA, shopA, productA_Id, dto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe('PRODUCT_CATEGORY_INVALID');
        expect(err.getResponse().message).toBe('Primary category là bắt buộc.');
      }
    });

    it('should throw BadRequestException (400) if secondary_category_ids exceeds 2', async () => {
      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
        secondary_category_ids: [
          activeCategorySecondary1,
          activeCategorySecondary2,
          'extra-category-id',
        ],
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        BadRequestException,
      );

      try {
        await service.assignCategories(userA, shopA, productA_Id, dto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe('PRODUCT_CATEGORY_INVALID');
        expect(err.getResponse().message).toBe('Tối đa 2 danh mục phụ (secondary categories).');
      }
    });

    it('should throw BadRequestException (400) if primary and secondary categories duplicate', async () => {
      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
        secondary_category_ids: [activeCategoryPrimary],
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        BadRequestException,
      );

      try {
        await service.assignCategories(userA, shopA, productA_Id, dto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe('PRODUCT_CATEGORY_INVALID');
        expect(err.getResponse().message).toBe(
          'Primary và Secondary category không được trùng nhau.',
        );
      }
    });

    it('should throw BadRequestException (400) if duplicate categories exist within secondary list', async () => {
      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
        secondary_category_ids: [activeCategorySecondary1, activeCategorySecondary1],
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException (400) if a category does not exist', async () => {
      const nonExistentId = '01912f30-7a1b-7c12-9c55-8b1c34a6d999';
      const dto = {
        version: 1,
        primary_category_id: nonExistentId,
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        BadRequestException,
      );

      try {
        await service.assignCategories(userA, shopA, productA_Id, dto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe('PRODUCT_CATEGORY_INVALID');
        expect(err.getResponse().message).toContain('không tồn tại hoặc không ở trạng thái ACTIVE');
      }
    });

    it('should throw BadRequestException (400) if a category is INACTIVE', async () => {
      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
        secondary_category_ids: [inactiveCategoryId],
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        BadRequestException,
      );

      try {
        await service.assignCategories(userA, shopA, productA_Id, dto);
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse().code).toBe('PRODUCT_CATEGORY_INVALID');
        expect(err.getResponse().message).toContain('không tồn tại hoặc không ở trạng thái ACTIVE');
      }
    });

    it('should throw ConflictException (409) if product is ARCHIVED', async () => {
      const archived = inMemoryProducts.get(productA_Id);
      archived.status = ProductStatus.ARCHIVED;

      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ForbiddenException (403) if product is BLOCKED', async () => {
      const blocked = inMemoryProducts.get(productA_Id);
      blocked.status = ProductStatus.BLOCKED;

      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
      };

      await expect(service.assignCategories(userA, shopA, productA_Id, dto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should successfully assign 1 primary and 2 secondary active categories', async () => {
      const dto = {
        version: 1,
        primary_category_id: activeCategoryPrimary,
        secondary_category_ids: [activeCategorySecondary1, activeCategorySecondary2],
      };

      const result = await service.assignCategories(userA, shopA, productA_Id, dto);

      expect(result.product_id).toBe(productA_Id);
      expect(result.primary_category_id).toBe(activeCategoryPrimary);
      expect(result.secondary_category_ids).toEqual([
        activeCategorySecondary1,
        activeCategorySecondary2,
      ]);
      expect(result.version).toBe(BigInt(2));

      // Check DB replacement
      const assignments = inMemoryAssignments.get(productA_Id);
      expect(assignments).toHaveLength(3);
      expect(assignments?.find((a) => a.category_id === activeCategoryPrimary)?.is_primary).toBe(
        true,
      );

      // Check outbox event
      expect(savedOutboxEvents).toHaveLength(1);
      expect(savedOutboxEvents[0].event_type).toBe('product.category_changed');
      expect(savedOutboxEvents[0].topic).toBe('catalog.events.v1');
    });
  });

  describe('4. Filter, Pagination & ReDoS Safety in GET /seller/products', () => {
    beforeEach(() => {
      inMemoryProducts.clear();
      // Seed 25 products for Shop A to test pagination
      for (let i = 1; i <= 25; i++) {
        const id = `01912f30-7a1b-7c12-9c55-8b1c34a6d${String(i).padStart(3, '0')}`;
        inMemoryProducts.set(id, {
          _id: id,
          shop_id: shopA,
          title: `Sản phẩm Shop A số ${i} (Đặc biệt: [ABC] {XYZ} $10)`,
          slug: `san-pham-shop-a-${i}`,
          status: i % 2 === 0 ? ProductStatus.ACTIVE : ProductStatus.DRAFT,
          primary_category_id: null,
          price_summary: null,
          updated_at: new Date(Date.now() - i * 1000),
        });
      }
    });

    it('should filter only products belonging to actorShopId (Shop A never sees Shop B products)', async () => {
      const result = await service.getSellerProducts(shopA, { page: 1, size: 50 });

      expect(result.data.length).toBeGreaterThan(0);
      for (const item of result.data) {
        const raw = inMemoryProducts.get(item.product_id);
        expect(raw.shop_id).toBe(shopA);
        expect(raw.shop_id).not.toBe(shopB);
      }
    });

    it('should correctly paginate results with page and size boundaries', async () => {
      // Page 1 with size 10
      const page1 = await service.getSellerProducts(shopA, { page: 1, size: 10 });
      expect(page1.data).toHaveLength(10);
      expect(page1.meta.page).toBe(1);
      expect(page1.meta.size).toBe(10);
      expect(page1.meta.total).toBe(25);
      expect(page1.meta.total_pages).toBe(3);

      // Page 3 with size 10 (should have 5 items remaining)
      const page3 = await service.getSellerProducts(shopA, { page: 3, size: 10 });
      expect(page3.data).toHaveLength(5);
      expect(page3.meta.page).toBe(3);

      // Size > 100 should be clamped to 100
      const oversized = await service.getSellerProducts(shopA, { page: 1, size: 500 });
      expect(oversized.meta.size).toBe(100);
    });

    it('should safely handle malicious regex patterns (ReDoS safety) without catastrophic backtracking or syntax errors', async () => {
      const maliciousPatterns = [
        '((((((((((a+)+)+)+)+)+)+)+)+)+)$',
        '^(a+)+$',
        '([a-zA-Z0-9]+)*$',
        '\\\\\\\\\\\\',
        '[.*+?^${}()|[\\]\\]',
        '(unclosed parenthesis',
        '***invalid*glob***',
        '+?{',
      ];

      for (const pattern of maliciousPatterns) {
        const startTime = Date.now();

        // Must not throw RegExp syntax error or hang
        const result = await service.getSellerProducts(shopA, { q: pattern });

        const elapsed = Date.now() - startTime;
        expect(elapsed).toBeLessThan(100); // Should resolve in < 100ms
        expect(result).toBeDefined();
        expect(Array.isArray(result.data)).toBe(true);
      }
    });

    it('should search literally for text containing regex special characters', async () => {
      const result = await service.getSellerProducts(shopA, { q: '[ABC]' });
      expect(result.data.length).toBeGreaterThan(0);
      for (const item of result.data) {
        expect(item.title).toContain('[ABC]');
      }
    });
  });
});
