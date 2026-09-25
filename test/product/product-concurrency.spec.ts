import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ProductService } from '../../src/product/services/product.service';
import { SellerProductController } from '../../src/product/controllers/seller-product.controller';
import { ProductStatus } from '../../src/database/schemas/product.schema';
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
 * Product Concurrency & Optimistic Concurrency Control (OCC) Test Suite [TEST-B04]
 * References:
 * - product-catalog-docs/docs/test/product-catalog.md §3.2 (PC-API-017, PC-API-023)
 * - cecilia-review recommendation REV-B04-C: Concurrency CAS test with PRODUCT_VERSION_CONFLICT
 */
describe('Product Concurrency OCC Spec [TEST-B04]', () => {
  let service: ProductService;
  let controller: SellerProductController;

  const actorShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const actorUserId = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const productId = '01912f30-7a1b-7c12-9c55-8b1c34a6d111';

  const actor: ActorContext = {
    userId: actorUserId,
    roles: ['SELLER'],
    permissions: [],
    shopScope: actorShopId,
    isAuthenticated: true,
  };

  // Shared in-memory product state simulating datastore
  let sharedProductState: {
    _id: string;
    shop_id: string;
    title: string;
    slug: string;
    description: string | null;
    brand: string | null;
    status: ProductStatus;
    version: bigint;
    primary_category_id: string | null;
    price_summary: any;
    shop_snapshot: any;
    rating_summary: any;
    updated_at: Date;
  };

  const savedOutboxEvents: any[] = [];
  const savedCategoryAssignments: any[] = [];

  const mockProductRepository = {
    findById: jest.fn().mockImplementation(async (id: string) => {
      // Simulate non-blocking async DB read
      await new Promise((r) => setImmediate(r));
      if (sharedProductState._id === id) {
        return { ...sharedProductState };
      }
      return null;
    }),

    findByShopAndSlug: jest.fn().mockImplementation(async (shopId: string, slug: string) => {
      await new Promise((r) => setImmediate(r));
      if (sharedProductState.shop_id === shopId && sharedProductState.slug === slug) {
        return { ...sharedProductState };
      }
      return null;
    }),

    atomicCasUpdate: jest
      .fn()
      .mockImplementation(
        async (
          id: string,
          shopId: string,
          expectedVersion: number | bigint,
          updateData: Record<string, any>,
        ) => {
          // Simulate microtask interleaving
          await new Promise((r) => setImmediate(r));

          // Atomic CAS evaluation
          if (
            sharedProductState._id === id &&
            sharedProductState.shop_id === shopId &&
            sharedProductState.version === BigInt(expectedVersion)
          ) {
            const nextVersion = BigInt(expectedVersion) + BigInt(1);
            const $set = updateData.$set || updateData;
            sharedProductState = {
              ...sharedProductState,
              ...$set,
              version: nextVersion,
              updated_at: new Date(),
            };
            return { ...sharedProductState };
          }

          // Version conflict: current version in DB does not match expectedVersion
          return null;
        },
      ),
  };

  const mockProductCategoryRepository = {
    findByProductId: jest.fn().mockImplementation(async (id: string) => {
      return savedCategoryAssignments.filter((a) => a.product_id === id);
    }),
    replaceProductCategories: jest.fn().mockImplementation(async (id: string, items: any[]) => {
      savedCategoryAssignments.length = 0;
      for (const item of items) {
        savedCategoryAssignments.push({ ...item, product_id: id });
      }
      return savedCategoryAssignments;
    }),
  };

  const mockCategoryRepository = {
    findById: jest.fn().mockImplementation(async (id: string) => {
      return { _id: id, status: CategoryStatus.ACTIVE, name: 'Active Category' };
    }),
  };

  const mockAttributeDefinitionRepository = {
    findByScope: jest.fn().mockResolvedValue([]),
  };

  const mockSkuRepository = {
    findByProductId: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
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
    savedOutboxEvents.length = 0;
    savedCategoryAssignments.length = 0;

    // Reset base product state to version 1
    sharedProductState = {
      _id: productId,
      shop_id: actorShopId,
      title: 'Original Title',
      slug: 'original-title',
      description: 'Original description',
      brand: 'Taca',
      status: ProductStatus.DRAFT,
      version: BigInt(1),
      primary_category_id: null,
      price_summary: {
        base_price: BigInt(200000),
        sale_price: BigInt(180000),
        currency: 'VND',
      },
      shop_snapshot: null,
      rating_summary: null,
      updated_at: new Date('2026-09-24T00:00:00Z'),
    };

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
        { provide: OutboxRepositoryPort, useValue: mockOutboxRepository },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
      ],
    }).compile();

    service = module.get<ProductService>(ProductService);
    controller = module.get<SellerProductController>(SellerProductController);
  });

  describe('Optimistic Concurrency Control (OCC) - Simultaneous PATCH Updates', () => {
    it('should allow exactly 1 update to succeed and reject the other with PRODUCT_VERSION_CONFLICT (409)', async () => {
      // Simulate two concurrent requests arriving with the same initial version (version = 1)
      const req1 = service.updateProduct(actorUserId, actorShopId, productId, {
        version: 1,
        title: 'Title Updated by Request A',
      });

      const req2 = service.updateProduct(actorUserId, actorShopId, productId, {
        version: 1,
        title: 'Title Updated by Request B',
      });

      const results = await Promise.allSettled([req1, req2]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // 1. Exactly 1 request succeeds
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0].value.version).toBe(BigInt(2));
      expect(fulfilled[0].value.product_id).toBe(productId);

      // 2. Exactly 1 request fails with ConflictException (409)
      expect(rejected).toHaveLength(1);
      const error = rejected[0].reason;
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toEqual({
        code: 'PRODUCT_VERSION_CONFLICT',
        message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
      });

      // 3. Document state integrity: version incremented exactly once (1 -> 2)
      expect(sharedProductState.version).toBe(BigInt(2));
      // The final title is whichever request won the CAS race
      expect(['Title Updated by Request A', 'Title Updated by Request B']).toContain(
        sharedProductState.title,
      );

      // 4. Outbox events: exactly 1 event recorded, no orphan event from failed request
      expect(savedOutboxEvents).toHaveLength(1);
      expect(savedOutboxEvents[0].event_type).toBe('product.updated');
      expect(savedOutboxEvents[0].version).toBe(BigInt(2));
    });

    it('should handle multi-party race condition (5 concurrent requests on version 1)', async () => {
      // 5 concurrent requests attempting to update the product at version 1
      const requests = Array.from({ length: 5 }, (_, i) =>
        service.updateProduct(actorUserId, actorShopId, productId, {
          version: 1,
          title: `Concurrent Title Update #${i + 1}`,
        }),
      );

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // Exactly 1 must succeed
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0].value.version).toBe(BigInt(2));

      // Remaining 4 must fail with 409 PRODUCT_VERSION_CONFLICT
      expect(rejected).toHaveLength(4);
      for (const rej of rejected) {
        expect(rej.reason).toBeInstanceOf(ConflictException);
        expect(rej.reason.getStatus()).toBe(409);
        expect(rej.reason.getResponse()).toEqual({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // Final version in database is 2 (no lost updates or duplicate increments)
      expect(sharedProductState.version).toBe(BigInt(2));
      expect(savedOutboxEvents).toHaveLength(1);
    });

    it('should allow retry after conflict resolution when refreshing to the latest version', async () => {
      // Step 1: Request 1 updates version 1 -> 2
      const firstUpdate = await service.updateProduct(actorUserId, actorShopId, productId, {
        version: 1,
        title: 'Title by Tab 1',
      });
      expect(firstUpdate.version).toBe(BigInt(2));

      // Step 2: Tab 2 tries with stale version 1 -> fails with 409
      await expect(
        service.updateProduct(actorUserId, actorShopId, productId, {
          version: 1,
          title: 'Stale Title by Tab 2',
        }),
      ).rejects.toThrow(ConflictException);

      // Step 3: Tab 2 reads updated version from database
      const refreshedProduct = await mockProductRepository.findById(productId);
      expect(refreshedProduct?.version).toBe(BigInt(2));

      // Step 4: Tab 2 retries with latest version 2 -> succeeds, incrementing to version 3
      const retryUpdate = await service.updateProduct(actorUserId, actorShopId, productId, {
        version: Number(refreshedProduct?.version),
        title: 'Fresh Title by Tab 2 after conflict resolution',
      });

      expect(retryUpdate.version).toBe(BigInt(3));
      expect(sharedProductState.title).toBe('Fresh Title by Tab 2 after conflict resolution');
      expect(sharedProductState.version).toBe(BigInt(3));
      expect(savedOutboxEvents).toHaveLength(2);
    });
  });

  describe('Optimistic Concurrency Control (OCC) - Simultaneous Category Assignment', () => {
    const primaryCat1 = '01912f30-7a1b-7c12-9c55-8b1c34a6d201';
    const primaryCat2 = '01912f30-7a1b-7c12-9c55-8b1c34a6d202';
    const secondaryCat = '01912f30-7a1b-7c12-9c55-8b1c34a6d203';

    it('should serialize concurrent assignCategories calls: 1 succeeds and 1 fails with 409', async () => {
      const assign1 = service.assignCategories(actorUserId, actorShopId, productId, {
        version: 1,
        primary_category_id: primaryCat1,
        secondary_category_ids: [secondaryCat],
      });

      const assign2 = service.assignCategories(actorUserId, actorShopId, productId, {
        version: 1,
        primary_category_id: primaryCat2,
        secondary_category_ids: [],
      });

      const results = await Promise.allSettled([assign1, assign2]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      // Exactly 1 succeeds
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0].value.version).toBe(BigInt(2));

      // Exactly 1 fails with 409 PRODUCT_VERSION_CONFLICT
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(rejected[0].reason.getResponse()).toEqual({
        code: 'PRODUCT_VERSION_CONFLICT',
        message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
      });

      // Exactly 1 outbox event for category change
      expect(savedOutboxEvents).toHaveLength(1);
      expect(savedOutboxEvents[0].event_type).toBe('product.category_changed');

      // Category replacement was committed exactly once
      expect(mockProductCategoryRepository.replaceProductCategories).toHaveBeenCalledTimes(1);
    });
  });

  describe('Cross-Operation Concurrency: Concurrent updateProduct and assignCategories', () => {
    const primaryCat = '01912f30-7a1b-7c12-9c55-8b1c34a6d201';

    it('should enforce OCC between different mutation types targeting the same version', async () => {
      const patchReq = service.updateProduct(actorUserId, actorShopId, productId, {
        version: 1,
        title: 'New Title from Patch',
      });

      const putCategoryReq = service.assignCategories(actorUserId, actorShopId, productId, {
        version: 1,
        primary_category_id: primaryCat,
      });

      const results = await Promise.allSettled([patchReq, putCategoryReq]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(rejected[0].reason.getResponse().code).toBe('PRODUCT_VERSION_CONFLICT');

      expect(sharedProductState.version).toBe(BigInt(2));
      expect(savedOutboxEvents).toHaveLength(1);
    });
  });

  describe('Controller Layer Concurrency Simulation', () => {
    it('should bubble up ConflictException (409) through controller layer when concurrent calls occur', async () => {
      const callA = controller.updateProduct(actor, actorShopId, productId, {
        version: 1,
        title: 'Controller Title A',
      });

      const callB = controller.updateProduct(actor, actorShopId, productId, {
        version: 1,
        title: 'Controller Title B',
      });

      const results = await Promise.allSettled([callA, callB]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled',
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);
      expect(rejected[0].reason.getResponse().code).toBe('PRODUCT_VERSION_CONFLICT');
    });
  });
});
