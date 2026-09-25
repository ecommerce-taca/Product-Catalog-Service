import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ClientSession } from 'mongoose';
import { CategoryService } from '../../src/category/services/category.service';
import { CategoryTreeService } from '../../src/category/services/category-tree.service';
import { CategoryRepositoryPort } from '../../src/category/repositories/category.repository.interface';
import { ProductCategoryRepositoryPort } from '../../src/category/repositories/product-category.repository.interface';
import { CategoryDocument, CategoryStatus } from '../../src/database/schemas/category.schema';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('CategoryService', () => {
  let service: CategoryService;
  let mockCategoryRepo: jest.Mocked<CategoryRepositoryPort>;
  let mockProductCategoryRepo: jest.Mocked<ProductCategoryRepositoryPort>;
  let mockTransactionRunner: jest.Mocked<TransactionRunner>;
  let mockSession: ClientSession;

  const createMockCategory = (overrides?: Partial<CategoryDocument>): CategoryDocument => {
    return {
      _id: '01912f20-7a1b-7c12-9c55-8b1c34a6d921',
      parent_id: null,
      name: 'Điện tử',
      slug: 'dien-tu',
      path: '/01912f20-7a1b-7c12-9c55-8b1c34a6d921',
      depth: 1,
      status: CategoryStatus.ACTIVE,
      sort_order: 0,
      tax_rate_bps: 1000,
      version: BigInt(1),
      save: jest.fn().mockImplementation(function (this: CategoryDocument) {
        return Promise.resolve(this);
      }),
      ...overrides,
    } as unknown as CategoryDocument;
  };

  beforeEach(async () => {
    mockSession = { id: 'mock-session-id' } as unknown as ClientSession;
    mockTransactionRunner = {
      execute: jest
        .fn()
        .mockImplementation(async (cb: (session: ClientSession) => Promise<unknown>) => {
          return cb(mockSession);
        }),
    } as unknown as jest.Mocked<TransactionRunner>;

    mockCategoryRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      findBySlug: jest.fn(),
      findChildren: jest.fn(),
      findDescendantsByPath: jest.fn(),
      updateSubtreePath: jest.fn(),
      findAllPaginated: jest.fn(),
    };

    mockProductCategoryRepo = {
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      countByCategoryId: jest.fn(),
      findByProductId: jest.fn(),
      deleteByProductId: jest.fn(),
      replaceProductCategories: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoryService,
        CategoryTreeService,
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
        {
          provide: 'CategoryRepositoryPort',
          useValue: mockCategoryRepo,
        },
        {
          provide: 'ProductCategoryRepositoryPort',
          useValue: mockProductCategoryRepo,
        },
      ],
    }).compile();

    service = module.get<CategoryService>(CategoryService);
  });

  describe('createCategory', () => {
    it('should create a root category successfully with depth = 1, tax_rate_bps non-null, version = 1', async () => {
      mockCategoryRepo.findBySlug.mockResolvedValue(null);
      mockCategoryRepo.findOne.mockResolvedValue(null);
      mockCategoryRepo.create.mockImplementation((doc) =>
        Promise.resolve(createMockCategory(doc as Partial<CategoryDocument>)),
      );

      const result = await service.createCategory({
        name: 'Điện tử',
        slug: 'dien-tu',
        tax_rate_bps: 1000,
        sort_order: 5,
      });

      expect(mockCategoryRepo.findBySlug).toHaveBeenCalledWith('dien-tu', undefined);
      expect(mockCategoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Điện tử',
          slug: 'dien-tu',
          depth: 1,
          status: CategoryStatus.ACTIVE,
          tax_rate_bps: 1000,
          sort_order: 5,
          version: BigInt(1),
        }),
        undefined,
      );
      expect(result.depth).toBe(1);
      expect(result.tax_rate_bps).toBe(1000);
      expect(result.version).toBe(1);
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID if root category has no tax_rate_bps', async () => {
      mockCategoryRepo.findBySlug.mockResolvedValue(null);

      await expect(
        service.createCategory({
          name: 'Root without tax',
          slug: 'root-no-tax',
          tax_rate_bps: null,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
          }),
        }),
      );
    });

    it('should throw 409 PRODUCT_SLUG_CONFLICT if slug already exists', async () => {
      mockCategoryRepo.findBySlug.mockResolvedValue(createMockCategory());

      await expect(
        service.createCategory({
          name: 'Điện tử',
          slug: 'dien-tu',
          tax_rate_bps: 1000,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'PRODUCT_SLUG_CONFLICT',
          }),
        }),
      );
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID if sibling with same name exists under root', async () => {
      mockCategoryRepo.findBySlug.mockResolvedValue(null);
      mockCategoryRepo.findOne.mockResolvedValue(createMockCategory({ name: 'Điện tử' }));

      await expect(
        service.createCategory({
          name: 'Điện tử',
          slug: 'dien-tu-moi',
          tax_rate_bps: 1000,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
          }),
        }),
      );
    });

    it('should create a child category with depth = parent.depth + 1 and path = parent.path/id', async () => {
      const parent = createMockCategory({
        _id: '01912f20-parent-uuid',
        depth: 2,
        path: '/01912f20-root/01912f20-parent-uuid',
      });

      mockCategoryRepo.findBySlug.mockResolvedValue(null);
      mockCategoryRepo.findById.mockResolvedValue(parent);
      mockCategoryRepo.findOne.mockResolvedValue(null);
      mockCategoryRepo.create.mockImplementation((doc) =>
        Promise.resolve(createMockCategory(doc as Partial<CategoryDocument>)),
      );

      const result = await service.createCategory({
        name: 'Điện thoại thông minh',
        slug: 'dien-thoai-thong-minh',
        parent_id: '01912f20-parent-uuid',
        tax_rate_bps: null,
      });

      expect(mockCategoryRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          parent_id: '01912f20-parent-uuid',
          depth: 3,
          path: expect.stringMatching(/^\/01912f20-root\/01912f20-parent-uuid\/[0-9a-f-]{36}$/),
          tax_rate_bps: null,
        }),
        undefined,
      );
      expect(result.depth).toBe(3);
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID if parent category is ARCHIVED', async () => {
      const parent = createMockCategory({
        status: CategoryStatus.ARCHIVED,
      });
      mockCategoryRepo.findBySlug.mockResolvedValue(null);
      mockCategoryRepo.findById.mockResolvedValue(parent);

      await expect(
        service.createCategory({
          name: 'Con của archived',
          slug: 'con-archived',
          parent_id: parent._id,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
          }),
        }),
      );
    });

    it('should throw 409 CATEGORY_DEPTH_EXCEEDED when child depth exceeds 5', async () => {
      const parent = createMockCategory({
        depth: 5,
        path: '/r/c1/c2/c3/c4',
      });
      mockCategoryRepo.findBySlug.mockResolvedValue(null);
      mockCategoryRepo.findById.mockResolvedValue(parent);
      mockCategoryRepo.findOne.mockResolvedValue(null);

      await expect(
        service.createCategory({
          name: 'Cấp 6',
          slug: 'cap-6',
          parent_id: parent._id,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'CATEGORY_DEPTH_EXCEEDED',
          }),
        }),
      );
    });
  });

  describe('updateCategory', () => {
    it('should update name and increment OCC version', async () => {
      const existing = createMockCategory({
        version: BigInt(2),
        name: 'Tên cũ',
      });
      mockCategoryRepo.findById.mockResolvedValue(existing);
      mockCategoryRepo.findOne.mockResolvedValue(null);

      const result = await service.updateCategory(existing._id, {
        version: 2,
        name: 'Tên mới',
      });

      expect(existing.name).toBe('Tên mới');
      expect(existing.version).toBe(BigInt(3));
      expect(result.version).toBe(3);
      expect(existing.save).toHaveBeenCalled();
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT on OCC version mismatch', async () => {
      const existing = createMockCategory({
        version: BigInt(5),
      });
      mockCategoryRepo.findById.mockResolvedValue(existing);

      await expect(
        service.updateCategory(existing._id, {
          version: 4,
          name: 'Tên mới',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'PRODUCT_VERSION_CONFLICT',
          }),
        }),
      );
    });

    it('should detect cycle when parent_id is set to self', async () => {
      const existing = createMockCategory({
        _id: '01912f20-self',
        version: BigInt(1),
      });
      mockCategoryRepo.findById.mockResolvedValue(existing);

      await expect(
        service.updateCategory('01912f20-self', {
          version: 1,
          parent_id: '01912f20-self',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'CATEGORY_CYCLE_DETECTED',
          }),
        }),
      );
    });

    it('should detect cycle when new parent is inside category subtree', async () => {
      const existing = createMockCategory({
        _id: 'cat-a',
        path: '/cat-a',
        depth: 1,
        version: BigInt(1),
      });
      const descendant = createMockCategory({
        _id: 'cat-c',
        path: '/cat-a/cat-b/cat-c',
        depth: 3,
      });

      mockCategoryRepo.findById.mockImplementation((id: string) => {
        if (id === 'cat-a') return Promise.resolve(existing);
        if (id === 'cat-c') return Promise.resolve(descendant);
        return Promise.resolve(null);
      });

      await expect(
        service.updateCategory('cat-a', {
          version: 1,
          parent_id: 'cat-c',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'CATEGORY_CYCLE_DETECTED',
          }),
        }),
      );
    });

    it('should update subtree paths and depths atomically when moving parent', async () => {
      const targetCategory = createMockCategory({
        _id: 'cat-sub',
        parent_id: 'cat-root1',
        path: '/cat-root1/cat-sub',
        depth: 2,
        version: BigInt(1),
      });

      const newParent = createMockCategory({
        _id: 'cat-root2',
        parent_id: null,
        path: '/cat-root2',
        depth: 1,
      });

      const childOfTarget = createMockCategory({
        _id: 'cat-child',
        parent_id: 'cat-sub',
        path: '/cat-root1/cat-sub/cat-child',
        depth: 3,
      });

      mockCategoryRepo.findById.mockImplementation((id: string) => {
        if (id === 'cat-sub') return Promise.resolve(targetCategory);
        if (id === 'cat-root2') return Promise.resolve(newParent);
        return Promise.resolve(null);
      });
      mockCategoryRepo.findOne.mockResolvedValue(null);
      mockCategoryRepo.findDescendantsByPath.mockResolvedValue([childOfTarget]);
      mockCategoryRepo.updateSubtreePath.mockResolvedValue(1);

      await service.updateCategory('cat-sub', {
        version: 1,
        parent_id: 'cat-root2',
      });

      expect(targetCategory.path).toBe('/cat-root2/cat-sub');
      expect(targetCategory.depth).toBe(2);
      expect(mockCategoryRepo.updateSubtreePath).toHaveBeenCalledWith(
        '/cat-root1/cat-sub/',
        '/cat-root2/cat-sub/',
        0, // depthDelta = 2 - 2 = 0
        mockSession,
      );
    });

    it('should execute inside transactionRunner.execute', async () => {
      const existing = createMockCategory({
        version: BigInt(1),
        name: 'Gốc',
      });
      mockCategoryRepo.findById.mockResolvedValue(existing);
      mockCategoryRepo.findOne.mockResolvedValue(null);

      await service.updateCategory(existing._id, {
        version: 1,
        name: 'Gốc mới',
      });

      expect(mockTransactionRunner.execute).toHaveBeenCalled();
      expect(existing.save).toHaveBeenCalledWith({ session: mockSession });
    });

    it('should throw 400 BadRequestException when updating root category with tax_rate_bps: null (SF-1)', async () => {
      const existing = createMockCategory({
        parent_id: null,
        version: BigInt(1),
        tax_rate_bps: 1000,
      });
      mockCategoryRepo.findById.mockResolvedValue(existing);

      await expect(
        service.updateCategory(existing._id, {
          version: 1,
          tax_rate_bps: null,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Root category must have a non-null tax_rate_bps',
          }),
        }),
      );
    });

    it('should throw 400 BadRequestException when moving child to root without tax_rate_bps (SF-1)', async () => {
      const existingChild = createMockCategory({
        _id: 'child-1',
        parent_id: 'parent-1',
        version: BigInt(1),
        tax_rate_bps: null,
      });
      mockCategoryRepo.findById.mockResolvedValue(existingChild);

      await expect(
        service.updateCategory(existingChild._id, {
          version: 1,
          parent_id: null,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Root category must have a non-null tax_rate_bps',
          }),
        }),
      );
    });

    it('should throw 409 CATEGORY_DEPTH_EXCEEDED if moving category causes descendants to exceed depth 5', async () => {
      const targetCategory = createMockCategory({
        _id: 'cat-sub',
        parent_id: 'cat-root1',
        path: '/cat-root1/cat-sub',
        depth: 2,
        version: BigInt(1),
      });

      const newParent = createMockCategory({
        _id: 'cat-deep-parent',
        parent_id: 'p3',
        path: '/r/p1/p2/p3/cat-deep-parent',
        depth: 4,
      });

      const descendant = createMockCategory({
        _id: 'deep-child',
        path: '/cat-root1/cat-sub/c1/deep-child',
        depth: 4, // relative difference +2 from targetCategory
      });

      mockCategoryRepo.findById.mockImplementation((id: string) => {
        if (id === 'cat-sub') return Promise.resolve(targetCategory);
        if (id === 'cat-deep-parent') return Promise.resolve(newParent);
        return Promise.resolve(null);
      });
      mockCategoryRepo.findOne.mockResolvedValue(null);
      mockCategoryRepo.findDescendantsByPath.mockResolvedValue([descendant]);

      // targetCategory newDepth = 4 + 1 = 5. depthDelta = 5 - 2 = 3.
      // descendant new depth = 4 + 3 = 7 > 5!
      await expect(
        service.updateCategory('cat-sub', {
          version: 1,
          parent_id: 'cat-deep-parent',
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'CATEGORY_DEPTH_EXCEEDED',
          }),
        }),
      );
    });
  });

  describe('archiveCategory', () => {
    it('should archive successfully if version matches, no active children and no assigned products', async () => {
      const category = createMockCategory({
        version: BigInt(2),
        status: CategoryStatus.ACTIVE,
      });

      mockCategoryRepo.findById.mockResolvedValue(category);
      mockCategoryRepo.count.mockResolvedValue(0);
      mockProductCategoryRepo.countByCategoryId.mockResolvedValue(0);

      const result = await service.archiveCategory(category._id, {
        version: 2,
        reason: 'Taxonomy thay đổi',
      });

      expect(category.status).toBe(CategoryStatus.ARCHIVED);
      expect(category.version).toBe(BigInt(3));
      expect(result.status).toBe(CategoryStatus.ARCHIVED);
      expect(result.version).toBe(3);
    });

    it('should throw 409 PRODUCT_VERSION_CONFLICT on version mismatch', async () => {
      const category = createMockCategory({
        version: BigInt(3),
      });
      mockCategoryRepo.findById.mockResolvedValue(category);

      await expect(
        service.archiveCategory(category._id, {
          version: 2,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.CONFLICT,
          response: expect.objectContaining({
            code: 'PRODUCT_VERSION_CONFLICT',
          }),
        }),
      );
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID if active child categories exist', async () => {
      const category = createMockCategory({
        version: BigInt(1),
      });
      mockCategoryRepo.findById.mockResolvedValue(category);
      mockCategoryRepo.count.mockResolvedValue(2); // 2 active children

      await expect(
        service.archiveCategory(category._id, {
          version: 1,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
          }),
        }),
      );
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID if products are assigned to category', async () => {
      const category = createMockCategory({
        version: BigInt(1),
      });
      mockCategoryRepo.findById.mockResolvedValue(category);
      mockCategoryRepo.count.mockResolvedValue(0);
      mockProductCategoryRepo.countByCategoryId.mockResolvedValue(5); // 5 products

      await expect(
        service.archiveCategory(category._id, {
          version: 1,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.BAD_REQUEST,
          response: expect.objectContaining({
            code: 'PRODUCT_CATEGORY_INVALID',
          }),
        }),
      );
    });

    it('should execute inside transactionRunner.execute and pass session to queries', async () => {
      const category = createMockCategory({
        version: BigInt(2),
        status: CategoryStatus.ACTIVE,
      });

      mockCategoryRepo.findById.mockResolvedValue(category);
      mockCategoryRepo.count.mockResolvedValue(0);
      mockProductCategoryRepo.countByCategoryId.mockResolvedValue(0);

      await service.archiveCategory(category._id, {
        version: 2,
      });

      expect(mockTransactionRunner.execute).toHaveBeenCalled();
      expect(mockCategoryRepo.count).toHaveBeenCalledWith(
        { parent_id: category._id, status: CategoryStatus.ACTIVE },
        mockSession,
      );
      expect(mockProductCategoryRepo.countByCategoryId).toHaveBeenCalledWith(
        category._id,
        mockSession,
      );
      expect(category.save).toHaveBeenCalledWith({ session: mockSession });
    });
  });

  describe('resolveEffectiveTaxRate', () => {
    it('should return own tax_rate_bps if non-null', async () => {
      const category = createMockCategory({
        tax_rate_bps: 800,
      });
      mockCategoryRepo.findById.mockResolvedValue(category);

      const rate = await service.resolveEffectiveTaxRate(category._id);
      expect(rate).toBe(800);
    });

    it('should inherit tax_rate_bps from nearest ancestor when own is null', async () => {
      const child = createMockCategory({
        _id: 'child-uuid',
        parent_id: 'parent-uuid',
        path: '/root-uuid/parent-uuid/child-uuid',
        tax_rate_bps: null,
      });

      const parent = createMockCategory({
        _id: 'parent-uuid',
        parent_id: 'root-uuid',
        path: '/root-uuid/parent-uuid',
        tax_rate_bps: 1200,
      });

      const root = createMockCategory({
        _id: 'root-uuid',
        parent_id: null,
        path: '/root-uuid',
        tax_rate_bps: 1000,
      });

      mockCategoryRepo.findById.mockResolvedValue(child);
      mockCategoryRepo.find.mockResolvedValue([root, parent]);

      const rate = await service.resolveEffectiveTaxRate('child-uuid');
      expect(rate).toBe(1200);
      expect(mockCategoryRepo.find).toHaveBeenCalledWith(
        { _id: { $in: ['root-uuid', 'parent-uuid'] } },
        undefined,
        undefined,
      );
    });

    it('should batch fetch all ancestors in a single query and traverse in memory (S-2)', async () => {
      const child = createMockCategory({
        _id: 'child-uuid',
        parent_id: 'parent-uuid',
        path: '/root-uuid/parent-uuid/child-uuid',
        tax_rate_bps: null,
      });

      const parent = createMockCategory({
        _id: 'parent-uuid',
        parent_id: 'root-uuid',
        path: '/root-uuid/parent-uuid',
        tax_rate_bps: null,
      });

      const root = createMockCategory({
        _id: 'root-uuid',
        parent_id: null,
        path: '/root-uuid',
        tax_rate_bps: 1000,
      });

      mockCategoryRepo.findById.mockResolvedValue(child);
      mockCategoryRepo.find.mockResolvedValue([root, parent]);

      const rate = await service.resolveEffectiveTaxRate('child-uuid');
      expect(rate).toBe(1000);
      // findById should only be called once for the target category, not iteratively for ancestors
      expect(mockCategoryRepo.findById).toHaveBeenCalledTimes(1);
      expect(mockCategoryRepo.findById).toHaveBeenCalledWith('child-uuid', undefined);
      // find should be called once with $in for all ancestor IDs
      expect(mockCategoryRepo.find).toHaveBeenCalledTimes(1);
      expect(mockCategoryRepo.find).toHaveBeenCalledWith(
        { _id: { $in: ['root-uuid', 'parent-uuid'] } },
        undefined,
        undefined,
      );
    });
  });

  describe('Public Endpoints Service Methods', () => {
    it('getPublicCategoryDetail should return category and active children', async () => {
      const category = createMockCategory({
        _id: 'cat-1',
        status: CategoryStatus.ACTIVE,
      });
      const child = createMockCategory({
        _id: 'child-1',
        name: 'Child 1',
        parent_id: 'cat-1',
        status: CategoryStatus.ACTIVE,
      });

      mockCategoryRepo.findById.mockResolvedValue(category);
      mockCategoryRepo.findChildren.mockResolvedValue([child]);

      const result = await service.getPublicCategoryDetail('cat-1');
      expect(result.category_id).toBe('cat-1');
      expect(result.children).toHaveLength(1);
      expect(result.children[0].category_id).toBe('child-1');
    });

    it('getPublicCategoryDetail should throw 404 PRODUCT_NOT_FOUND if category is ARCHIVED', async () => {
      const category = createMockCategory({
        _id: 'cat-archived',
        status: CategoryStatus.ARCHIVED,
      });
      mockCategoryRepo.findById.mockResolvedValue(category);

      await expect(service.getPublicCategoryDetail('cat-archived')).rejects.toThrow(
        expect.objectContaining({
          status: HttpStatus.NOT_FOUND,
          response: expect.objectContaining({
            code: 'PRODUCT_NOT_FOUND',
          }),
        }),
      );
    });
  });
});
