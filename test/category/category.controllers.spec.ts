import { Test, TestingModule } from '@nestjs/testing';
import { CategoryController } from '../../src/category/controllers/category.controller';
import { AdminCategoryController } from '../../src/category/controllers/admin-category.controller';
import { CategoryService } from '../../src/category/services/category.service';
import { CreateCategoryDto } from '../../src/category/dto/create-category.dto';
import { UpdateCategoryDto } from '../../src/category/dto/update-category.dto';
import { ArchiveCategoryDto } from '../../src/category/dto/archive-category.dto';
import { QueryCategoryDto } from '../../src/category/dto/query-category.dto';

describe('Category Controllers', () => {
  let categoryController: CategoryController;
  let adminCategoryController: AdminCategoryController;
  let mockCategoryService: Partial<Record<keyof CategoryService, jest.Mock>>;

  beforeEach(async () => {
    mockCategoryService = {
      getPublicTree: jest.fn().mockResolvedValue([
        {
          category_id: 'cat-1',
          name: 'Điện tử',
          slug: 'dien-tu',
          path: '/cat-1',
          depth: 1,
          tax_rate_bps: 1000,
          children: [],
        },
      ]),
      getPublicCategoryDetail: jest.fn().mockResolvedValue({
        category_id: 'cat-1',
        name: 'Điện tử',
        slug: 'dien-tu',
        path: '/cat-1',
        depth: 1,
        tax_rate_bps: 1000,
        children: [],
      }),
      getAdminCategories: jest.fn().mockResolvedValue({
        items: [
          {
            category_id: 'cat-1',
            name: 'Điện tử',
            slug: 'dien-tu',
            parent_id: null,
            path: '/cat-1',
            depth: 1,
            status: 'ACTIVE',
            tax_rate_bps: 1000,
            version: 1,
          },
        ],
        pagination: { page: 1, size: 20, total: 1, total_pages: 1 },
      }),
      createCategory: jest.fn().mockResolvedValue({
        category_id: 'cat-1',
        name: 'Điện tử',
        slug: 'dien-tu',
        parent_id: null,
        path: '/cat-1',
        depth: 1,
        status: 'ACTIVE',
        tax_rate_bps: 1000,
        version: 1,
      }),
      updateCategory: jest.fn().mockResolvedValue({
        category_id: 'cat-1',
        name: 'Điện tử gia dụng',
        slug: 'dien-tu-gia-dung',
        parent_id: null,
        path: '/cat-1',
        depth: 1,
        status: 'ACTIVE',
        tax_rate_bps: 1000,
        version: 2,
      }),
      archiveCategory: jest.fn().mockResolvedValue({
        category_id: 'cat-1',
        status: 'ARCHIVED',
        version: 3,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoryController, AdminCategoryController],
      providers: [
        {
          provide: CategoryService,
          useValue: mockCategoryService,
        },
      ],
    }).compile();

    categoryController = module.get<CategoryController>(CategoryController);
    adminCategoryController = module.get<AdminCategoryController>(AdminCategoryController);
  });

  describe('CategoryController (Public)', () => {
    it('should return public category tree', async () => {
      const result = await categoryController.getCategories();
      expect(result).toHaveLength(1);
      expect(result[0].category_id).toBe('cat-1');
      expect(mockCategoryService.getPublicTree).toHaveBeenCalledTimes(1);
    });

    it('should return public category detail with immediate children', async () => {
      const result = await categoryController.getCategoryById('cat-1');
      expect(result.category_id).toBe('cat-1');
      expect(mockCategoryService.getPublicCategoryDetail).toHaveBeenCalledWith('cat-1');
    });
  });

  describe('AdminCategoryController', () => {
    it('should list categories with pagination metadata', async () => {
      const query: QueryCategoryDto = { page: 1, size: 20 };
      const result = await adminCategoryController.getCategories(query);
      expect(result.data).toHaveLength(1);
      expect(result.meta).toEqual({ page: 1, size: 20, total: 1, total_pages: 1 });
      expect(mockCategoryService.getAdminCategories).toHaveBeenCalledWith(query);
    });

    it('should create category', async () => {
      const dto: CreateCategoryDto = {
        name: 'Điện tử',
        slug: 'dien-tu',
        tax_rate_bps: 1000,
      };
      const result = await adminCategoryController.createCategory(dto);
      expect(result.category_id).toBe('cat-1');
      expect(mockCategoryService.createCategory).toHaveBeenCalledWith(dto);
    });

    it('should update category', async () => {
      const dto: UpdateCategoryDto = {
        version: 1,
        name: 'Điện tử gia dụng',
      };
      const result = await adminCategoryController.updateCategory('cat-1', dto);
      expect(result.name).toBe('Điện tử gia dụng');
      expect(result.version).toBe(2);
      expect(mockCategoryService.updateCategory).toHaveBeenCalledWith('cat-1', dto);
    });

    it('should archive category', async () => {
      const dto: ArchiveCategoryDto = {
        version: 2,
        reason: 'Thay đổi taxonomy',
      };
      const result = await adminCategoryController.archiveCategory('cat-1', dto);
      expect(result.status).toBe('ARCHIVED');
      expect(result.version).toBe(3);
      expect(mockCategoryService.archiveCategory).toHaveBeenCalledWith('cat-1', dto);
    });
  });
});
