import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ClientSession, FilterQuery } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import { CategoryDocument, CategoryStatus } from '../../database/schemas/category.schema';
import { TransactionRunner } from '../../database/transaction.runner';
import { CategoryRepositoryPort } from '../repositories/category.repository.interface';
import { ProductCategoryRepositoryPort } from '../repositories/product-category.repository.interface';
import { CreateCategoryDto } from '../dto/create-category.dto';
import { UpdateCategoryDto } from '../dto/update-category.dto';
import { ArchiveCategoryDto } from '../dto/archive-category.dto';
import { QueryCategoryDto } from '../dto/query-category.dto';
import { CategoryResponseDto, CategoryTreeNodeDto } from '../dto/category-response.dto';
import { CategoryTreeService } from './category-tree.service';

@Injectable()
export class CategoryService {
  constructor(
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepo: CategoryRepositoryPort,
    @Inject('ProductCategoryRepositoryPort')
    private readonly productCategoryRepo: ProductCategoryRepositoryPort,
    private readonly treeService: CategoryTreeService,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * Creates a new category (Root or Child).
   * - Root category (parent_id == null): depth = 1, path = /<id>, tax_rate_bps required.
   * - Child category: verifies parent exists and not ARCHIVED, depth = parent.depth + 1 (<= 5),
   *   path = <parent.path>/<id>, tax_rate_bps optional (inherits from ancestor if null).
   */
  async createCategory(
    dto: CreateCategoryDto,
    session?: ClientSession,
  ): Promise<CategoryResponseDto> {
    // 1. Slug conflict check
    const existingSlug = await this.categoryRepo.findBySlug(dto.slug, session);
    if (existingSlug) {
      throw new HttpException(
        {
          code: 'PRODUCT_SLUG_CONFLICT',
          message: `Slug '${dto.slug}' đã tồn tại trong hệ thống.`,
        },
        HttpStatus.CONFLICT,
      );
    }

    const categoryId = uuidv7();
    let depth = 1;
    let path = `/${categoryId}`;
    const parentId = dto.parent_id ? String(dto.parent_id) : null;

    if (!parentId) {
      // Root category requires tax_rate_bps
      if (dto.tax_rate_bps === undefined || dto.tax_rate_bps === null) {
        throw new HttpException(
          {
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Danh mục gốc (Root) bắt buộc phải cấu hình thuế suất (tax_rate_bps).',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check unique name under root
      const existingName = await this.categoryRepo.findOne(
        { parent_id: null, name: dto.name },
        session,
      );
      if (existingName) {
        throw new HttpException(
          {
            code: 'PRODUCT_CATEGORY_INVALID',
            message: `Tên danh mục '${dto.name}' đã tồn tại ở cấp danh mục gốc.`,
          },
          HttpStatus.BAD_REQUEST,
        );
      }
    } else {
      // Child category
      const parent = await this.categoryRepo.findById(parentId, session);
      if (!parent || parent.status === CategoryStatus.ARCHIVED) {
        throw new HttpException(
          {
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Danh mục cha không tồn tại hoặc đã bị lưu trữ.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check unique name under same parent
      const existingName = await this.categoryRepo.findOne(
        { parent_id: parentId, name: dto.name },
        session,
      );
      if (existingName) {
        throw new HttpException(
          {
            code: 'PRODUCT_CATEGORY_INVALID',
            message: `Tên danh mục '${dto.name}' đã tồn tại dưới cùng danh mục cha.`,
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      depth = parent.depth + 1;
      if (depth > 5) {
        throw new HttpException(
          {
            code: 'CATEGORY_DEPTH_EXCEEDED',
            message: 'Độ sâu cây danh mục không được vượt quá 5 cấp.',
          },
          HttpStatus.CONFLICT,
        );
      }

      path = `${parent.path}/${categoryId}`;
    }

    const created = await this.categoryRepo.create(
      {
        _id: categoryId,
        parent_id: parentId,
        name: dto.name,
        slug: dto.slug,
        path,
        depth,
        status: CategoryStatus.ACTIVE,
        sort_order: dto.sort_order ?? 0,
        tax_rate_bps: dto.tax_rate_bps ?? null,
        version: BigInt(1),
      },
      session,
    );

    return this.formatCategoryResponse(created);
  }

  /**
   * Updates category attributes and handles subtree repositioning atomically.
   * - Enforces OCC version checking (409 on mismatch).
   * - Cycle detection: rejects parent_id if new parent is inside the category's subtree.
   * - Depth check: ensures no descendant exceeds depth 5 after move.
   * - Wraps mutations within a MongoDB transaction.
   */
  async updateCategory(
    id: string,
    dto: UpdateCategoryDto,
    session?: ClientSession,
  ): Promise<CategoryResponseDto> {
    const executeLogic = async (txSession: ClientSession): Promise<CategoryResponseDto> => {
      const category = await this.categoryRepo.findById(id, txSession);
      if (!category) {
        throw new HttpException(
          {
            code: 'PRODUCT_NOT_FOUND',
            message: `Không tìm thấy danh mục với ID '${id}'.`,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      if (category.status === CategoryStatus.ARCHIVED) {
        throw new HttpException(
          {
            code: 'PRODUCT_ARCHIVED',
            message: 'Danh mục đã bị lưu trữ, không thể chỉnh sửa.',
          },
          HttpStatus.CONFLICT,
        );
      }

      // OCC Check
      if (category.version !== BigInt(dto.version)) {
        throw new HttpException(
          {
            code: 'PRODUCT_VERSION_CONFLICT',
            message: 'Danh mục đã được thay đổi. Vui lòng tải lại.',
          },
          HttpStatus.CONFLICT,
        );
      }

      // Slug check if changed
      if (dto.slug && dto.slug !== category.slug) {
        const existingSlug = await this.categoryRepo.findBySlug(dto.slug, txSession);
        if (existingSlug && existingSlug._id !== category._id) {
          throw new HttpException(
            {
              code: 'PRODUCT_SLUG_CONFLICT',
              message: `Slug '${dto.slug}' đã tồn tại trong hệ thống.`,
            },
            HttpStatus.CONFLICT,
          );
        }
      }

      // Effective parent determination
      const effectiveParentId =
        dto.parent_id !== undefined
          ? dto.parent_id
            ? String(dto.parent_id)
            : null
          : category.parent_id;

      // SF-1: Root category tax rate protection
      if (effectiveParentId === null) {
        if (dto.tax_rate_bps === null) {
          throw new BadRequestException({
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Root category must have a non-null tax_rate_bps',
          });
        }
        const effectiveTax =
          dto.tax_rate_bps !== undefined ? dto.tax_rate_bps : category.tax_rate_bps;
        if (effectiveTax === null) {
          throw new BadRequestException({
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Root category must have a non-null tax_rate_bps',
          });
        }
      }

      const isParentChanging = dto.parent_id !== undefined && dto.parent_id !== category.parent_id;
      const targetParentId = effectiveParentId;
      const targetName = dto.name ?? category.name;

      // Sibling name uniqueness check
      if (dto.name !== undefined || isParentChanging) {
        const existingSibling = await this.categoryRepo.findOne(
          {
            parent_id: targetParentId,
            name: targetName,
            _id: { $ne: category._id },
          },
          txSession,
        );
        if (existingSibling) {
          throw new HttpException(
            {
              code: 'PRODUCT_CATEGORY_INVALID',
              message: `Tên danh mục '${targetName}' đã tồn tại dưới cùng danh mục cha.`,
            },
            HttpStatus.BAD_REQUEST,
          );
        }
      }

      let newPath = category.path;
      let newDepth = category.depth;

      if (isParentChanging) {
        if (!targetParentId) {
          // Moving to Root
          newDepth = 1;
          newPath = `/${category._id}`;
        } else {
          // Moving under another parent
          if (targetParentId === category._id) {
            throw new HttpException(
              {
                code: 'CATEGORY_CYCLE_DETECTED',
                message: 'Không thể chọn chính danh mục này làm danh mục cha.',
              },
              HttpStatus.CONFLICT,
            );
          }

          const newParent = await this.categoryRepo.findById(targetParentId, txSession);
          if (!newParent || newParent.status === CategoryStatus.ARCHIVED) {
            throw new HttpException(
              {
                code: 'PRODUCT_CATEGORY_INVALID',
                message: 'Danh mục cha mới không tồn tại hoặc đã bị lưu trữ.',
              },
              HttpStatus.BAD_REQUEST,
            );
          }

          // Cycle detection: newParent cannot be inside category's subtree
          if (newParent.path === category.path || newParent.path.startsWith(`${category.path}/`)) {
            throw new HttpException(
              {
                code: 'CATEGORY_CYCLE_DETECTED',
                message:
                  'Phát hiện chu trình: không thể chuyển danh mục vào làm con của cây con thuộc chính nó.',
              },
              HttpStatus.CONFLICT,
            );
          }

          newDepth = newParent.depth + 1;
          if (newDepth > 5) {
            throw new HttpException(
              {
                code: 'CATEGORY_DEPTH_EXCEEDED',
                message: 'Độ sâu cây danh mục không được vượt quá 5 cấp.',
              },
              HttpStatus.CONFLICT,
            );
          }

          newPath = `${newParent.path}/${category._id}`;
        }

        const depthDelta = newDepth - category.depth;
        const descendants = await this.categoryRepo.findDescendantsByPath(
          `${category.path}/`,
          txSession,
        );

        for (const desc of descendants) {
          if (desc.depth + depthDelta > 5) {
            throw new HttpException(
              {
                code: 'CATEGORY_DEPTH_EXCEEDED',
                message: 'Di chuyển danh mục khiến cây con vượt quá độ sâu tối đa 5 cấp.',
              },
              HttpStatus.CONFLICT,
            );
          }
        }

        if (descendants.length > 0) {
          await this.categoryRepo.updateSubtreePath(
            `${category.path}/`,
            `${newPath}/`,
            depthDelta,
            txSession,
          );
        }
      }

      // Apply updates to the category document
      if (dto.name !== undefined) category.name = dto.name;
      if (dto.slug !== undefined) category.slug = dto.slug;
      if (isParentChanging) {
        category.parent_id = targetParentId;
        category.path = newPath;
        category.depth = newDepth;
      }
      if (dto.status !== undefined) category.status = dto.status;
      if (dto.sort_order !== undefined) category.sort_order = dto.sort_order;
      if (dto.tax_rate_bps !== undefined) category.tax_rate_bps = dto.tax_rate_bps;

      category.version = category.version + BigInt(1);

      const saved = await category.save({ session: txSession });
      return this.formatCategoryResponse(saved);
    };

    if (session) {
      return executeLogic(session);
    }
    return this.transactionRunner.execute(executeLogic);
  }

  /**
   * Soft-archives a category.
   * - Enforces OCC version checking.
   * - Blocks archive if active child categories exist.
   * - Blocks archive if active product references exist.
   * - Wraps checks and status change in a MongoDB transaction.
   */
  async archiveCategory(
    id: string,
    dto: ArchiveCategoryDto,
    session?: ClientSession,
  ): Promise<{ category_id: string; status: string; version: number }> {
    const executeLogic = async (txSession: ClientSession) => {
      const category = await this.categoryRepo.findById(id, txSession);
      if (!category) {
        throw new HttpException(
          {
            code: 'PRODUCT_NOT_FOUND',
            message: `Không tìm thấy danh mục với ID '${id}'.`,
          },
          HttpStatus.NOT_FOUND,
        );
      }

      if (category.version !== BigInt(dto.version)) {
        throw new HttpException(
          {
            code: 'PRODUCT_VERSION_CONFLICT',
            message: 'Danh mục đã được thay đổi. Vui lòng tải lại.',
          },
          HttpStatus.CONFLICT,
        );
      }

      // Check for active child categories
      const activeChildren = await this.categoryRepo.count(
        { parent_id: category._id, status: CategoryStatus.ACTIVE },
        txSession,
      );
      if (activeChildren > 0) {
        throw new HttpException(
          {
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Không thể lưu trữ danh mục khi vẫn còn danh mục con đang hoạt động.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      // Check for assigned products
      const assignedProducts = await this.productCategoryRepo.countByCategoryId(
        category._id,
        txSession,
      );
      if (assignedProducts > 0) {
        throw new HttpException(
          {
            code: 'PRODUCT_CATEGORY_INVALID',
            message: 'Không thể lưu trữ danh mục đang được gán cho sản phẩm.',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      category.status = CategoryStatus.ARCHIVED;
      category.version = category.version + BigInt(1);

      const saved = await category.save({ session: txSession });
      return {
        category_id: saved._id,
        status: saved.status,
        version: Number(saved.version),
      };
    };

    if (session) {
      return executeLogic(session);
    }
    return this.transactionRunner.execute(executeLogic);
  }

  /**
   * Resolves effective VAT rate (tax_rate_bps) by ascending the materialized path.
   * Uses batch fetching to retrieve all ancestors in a single query.
   */
  async resolveEffectiveTaxRate(categoryId: string, session?: ClientSession): Promise<number> {
    const category = await this.categoryRepo.findById(categoryId, session);
    if (!category) {
      throw new HttpException(
        {
          code: 'PRODUCT_NOT_FOUND',
          message: `Không tìm thấy danh mục với ID '${categoryId}'.`,
        },
        HttpStatus.NOT_FOUND,
      );
    }

    if (category.tax_rate_bps !== null && category.tax_rate_bps !== undefined) {
      return category.tax_rate_bps;
    }

    // Climb the materialized path backwards using batch ancestor query
    const segments = category.path.split('/').filter(Boolean);
    const ancestorIds = segments.slice(0, -1);
    if (ancestorIds.length === 0) {
      return 0;
    }

    const ancestors = await this.categoryRepo.find(
      { _id: { $in: ancestorIds } },
      undefined,
      session,
    );
    const ancestorMap = new Map<string, CategoryDocument>();
    for (const ancestor of ancestors) {
      ancestorMap.set(String(ancestor._id), ancestor);
    }

    for (let i = segments.length - 2; i >= 0; i--) {
      const ancestorId = segments[i];
      const ancestor = ancestorMap.get(ancestorId);
      if (ancestor && ancestor.tax_rate_bps !== null && ancestor.tax_rate_bps !== undefined) {
        return ancestor.tax_rate_bps;
      }
    }

    return 0;
  }

  /**
   * Returns active categories structured as a nested tree for Public API.
   */
  async getPublicTree(session?: ClientSession): Promise<CategoryTreeNodeDto[]> {
    const categories = await this.categoryRepo.find(
      { status: CategoryStatus.ACTIVE },
      { sort: { sort_order: 1, created_at: 1 } },
      session,
    );
    return this.treeService.buildTree(categories);
  }

  /**
   * Returns category details and immediate active children for Public API.
   */
  async getPublicCategoryDetail(id: string, session?: ClientSession): Promise<CategoryTreeNodeDto> {
    const category = await this.categoryRepo.findById(id, session);
    if (!category || category.status !== CategoryStatus.ACTIVE) {
      throw new HttpException(
        {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Danh mục không tồn tại hoặc không ở trạng thái hoạt động.',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    const children = await this.categoryRepo.findChildren(
      category._id,
      CategoryStatus.ACTIVE,
      session,
    );

    return {
      category_id: category._id,
      name: category.name,
      slug: category.slug,
      path: category.path,
      depth: category.depth,
      tax_rate_bps: category.tax_rate_bps ?? null,
      children: children.map((c) => ({
        category_id: c._id,
        name: c.name,
        slug: c.slug,
        path: c.path,
        depth: c.depth,
        tax_rate_bps: c.tax_rate_bps ?? null,
        children: [],
      })),
    };
  }

  /**
   * Queries categories with filters and pagination for Admin API.
   */
  async getAdminCategories(
    query: QueryCategoryDto,
    session?: ClientSession,
  ): Promise<{
    items: CategoryResponseDto[];
    pagination: { page: number; size: number; total: number; total_pages: number };
  }> {
    const filter: FilterQuery<CategoryDocument> = {};
    if (query.status) {
      filter.status = query.status;
    }
    if (query.parent_id !== undefined) {
      if (query.parent_id === 'null' || query.parent_id === '') {
        filter.parent_id = null;
      } else {
        filter.parent_id = query.parent_id;
      }
    }

    const page = Math.max(1, query.page || 1);
    const size = Math.min(100, Math.max(1, query.size || 20));

    const { items, total } = await this.categoryRepo.findAllPaginated(filter, page, size, session);

    const totalPages = Math.ceil(total / size) || 1;

    return {
      items: items.map((c) => this.formatCategoryResponse(c)),
      pagination: {
        page,
        size,
        total,
        total_pages: totalPages,
      },
    };
  }

  formatCategoryResponse(cat: CategoryDocument): CategoryResponseDto {
    return {
      category_id: String(cat._id),
      name: cat.name,
      slug: cat.slug,
      parent_id: cat.parent_id ? String(cat.parent_id) : null,
      path: cat.path,
      depth: cat.depth,
      status: cat.status,
      sort_order: cat.sort_order ?? 0,
      tax_rate_bps: cat.tax_rate_bps ?? null,
      version: Number(cat.version),
      created_at: cat.created_at,
      updated_at: cat.updated_at,
    };
  }
}
