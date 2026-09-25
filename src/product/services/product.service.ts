import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
  Optional,
} from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';
import { v7 as uuidv7 } from 'uuid';
import { ProductPriceSummary, ProductStatus } from '../../database/schemas/product.schema';
import { AttributeScopeType } from '../../database/schemas/attribute-definition.schema';
import { CategoryStatus } from '../../database/schemas/category.schema';
import { AggregateType } from '../../database/schemas/outbox-event.schema';
import { TransactionRunner } from '../../database/transaction.runner';
import { TraceContextStorage } from '../../common/context/trace-context.storage';
import { ProductRepositoryPort } from '../repositories/product.repository.interface';
import { ProductCategoryRepositoryPort } from '../../category/repositories/product-category.repository.interface';
import { CategoryRepositoryPort } from '../../category/repositories/category.repository.interface';
import { AttributeDefinitionRepositoryPort } from '../../attribute/repositories/attribute-definition.repository.interface';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { OutboxRepositoryPort } from '../../outbox/repositories/outbox.repository.interface';
import { ProductMediaRepositoryPort } from '../../media/repositories/product-media.repository.interface';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { QueryProductDto } from '../dto/query-product.dto';
import { AssignCategoriesDto } from '../dto/assign-categories.dto';
import {
  AssignCategoriesResponseDto,
  CreateProductResponseDto,
  PaginatedSellerProductsDto,
  UpdateProductResponseDto,
} from '../dto/product-response.dto';
import { SellerProductDetailDto } from '../dto/seller-product-detail.dto';

const SYSTEM_ACTOR_ID = '01910000-0000-7000-8000-000000000000';

const STRICT_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'ul', 'ol', 'li', 'h3', 'h4', 'a', 'img'],
  allowedAttributes: {
    a: ['href', 'title', 'target'],
    img: ['src', 'alt', 'width', 'height'],
  },
};

@Injectable()
export class ProductService {
  constructor(
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
    @Inject('ProductCategoryRepositoryPort')
    private readonly productCategoryRepository: ProductCategoryRepositoryPort,
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepository: CategoryRepositoryPort,
    @Inject('AttributeDefinitionRepositoryPort')
    private readonly attributeDefinitionRepository: AttributeDefinitionRepositoryPort,
    @Inject('SkuRepositoryPort')
    private readonly skuRepository: SkuRepositoryPort,
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly transactionRunner: TransactionRunner,
    @Inject(forwardRef(() => 'ProductMediaRepositoryPort'))
    private readonly mediaRepository: ProductMediaRepositoryPort,
    @Optional()
    private readonly storageService?: S3StorageService,
  ) {}

  /**
   * Creates a draft product for the seller shop.
   * Enforces slug uniqueness within shop, HTML sanitization, and outbox event recording.
   */
  async createProduct(
    actorUserId: string | undefined,
    actorShopId: string,
    dto: CreateProductDto,
  ): Promise<CreateProductResponseDto> {
    if (!actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    // 1. Sanitize rich-text description
    let sanitizedDescription: string | null = null;
    if (dto.description !== undefined && dto.description !== null) {
      sanitizedDescription = sanitizeHtml(dto.description, STRICT_SANITIZE_OPTIONS);
    }

    // 2. Slug conflict check within the shop
    const existingSlug = await this.productRepository.findByShopAndSlug(actorShopId, dto.slug);
    if (existingSlug) {
      throw new ConflictException({
        code: 'PRODUCT_SLUG_CONFLICT',
        message: `Slug '${dto.slug}' đã tồn tại trong gian hàng của bạn.`,
      });
    }

    const priceSummary: ProductPriceSummary | undefined = dto.price_summary
      ? {
          base_price: BigInt(dto.price_summary.base_price),
          sale_price: BigInt(dto.price_summary.sale_price),
          currency: dto.price_summary.currency || 'VND',
        }
      : undefined;

    const productId = uuidv7();

    // 3. Bounded MongoDB transaction
    return this.transactionRunner.execute(async (session) => {
      await this.productRepository.create(
        {
          _id: productId,
          shop_id: actorShopId,
          title: dto.title,
          slug: dto.slug,
          description: sanitizedDescription,
          brand: dto.brand ?? null,
          price_summary: priceSummary,
          status: ProductStatus.DRAFT,
          primary_category_id: null,
          shop_snapshot: null,
          rating_summary: null,
          published_at: null,
          unpublished_at: null,
          archived_at: null,
          blocked_at: null,
          block_reason: null,
          version: BigInt(1),
        },
        session,
      );

      // Record outbox event for CDC
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.created',
          schema_version: 1,
          payload: {
            product_id: productId,
            shop_id: actorShopId,
            slug: dto.slug,
            title: dto.title,
            status: ProductStatus.DRAFT,
            version: 1,
          },
          occurred_at: new Date(),
          topic: 'product.events.v1',
          version: BigInt(1),
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      return {
        product_id: productId,
        shop_id: actorShopId,
        status: ProductStatus.DRAFT,
        version: 1,
      };
    });
  }

  /**
   * Retrieves paginated seller products filtered by actor shop scope.
   */
  async getSellerProducts(
    actorShopId: string,
    query: QueryProductDto,
  ): Promise<PaginatedSellerProductsDto> {
    if (!actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    const { items, total } = await this.productRepository.findSellerProducts(actorShopId, query);

    const skuCounts = await Promise.all(
      items.map((p) => this.skuRepository.count({ product_id: p._id })),
    );

    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const size = query.size && query.size > 0 ? Math.min(Number(query.size), 100) : 20;

    const data = items.map((p, idx) => ({
      product_id: p._id,
      title: p.title,
      slug: p.slug,
      status: p.status,
      primary_category_id: p.primary_category_id || null,
      price_summary: p.price_summary ?? null,
      sku_count: skuCounts[idx] || 0,
      cover_media: null,
      updated_at: p.updated_at,
    }));

    return {
      data,
      meta: {
        page,
        size,
        total,
        total_pages: Math.ceil(total / size) || 1,
      },
    };
  }

  /**
   * Retrieves full product detail for the seller editor, hydrated with definitions, SKUs, and categories.
   */
  async getSellerProductDetail(
    actorShopId: string,
    productId: string,
  ): Promise<SellerProductDetailDto> {
    if (!actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    // Zero-Trust IDOR check
    if (product.shop_id !== actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác trên sản phẩm của shop khác.',
      });
    }

    const [definitions, skus, categoryAssignments, mediaItems] = await Promise.all([
      this.attributeDefinitionRepository.findByScope(AttributeScopeType.PRODUCT, productId),
      this.skuRepository.findByProductId(productId),
      this.productCategoryRepository.findByProductId(productId),
      this.mediaRepository.findActiveByProductId
        ? this.mediaRepository.findActiveByProductId(productId)
        : this.mediaRepository.findByProductId(productId),
    ]);

    const primaryAssignment = categoryAssignments.find((a) => a.is_primary);
    const secondaryAssignments = categoryAssignments
      .filter((a) => !a.is_primary)
      .map((a) => a.category_id);

    const shopSnapshot = product.shop_snapshot as Record<string, unknown> | null;
    const shopProjection = shopSnapshot
      ? {
          shop_id: (shopSnapshot.shop_id as string) || product.shop_id,
          status: (shopSnapshot.shop_status as string) || 'ACTIVE',
          kyc_status: (shopSnapshot.kyc_status as string) || 'APPROVED',
        }
      : {
          shop_id: product.shop_id,
          status: 'ACTIVE',
          kyc_status: 'APPROVED',
        };

    return {
      product_id: product._id,
      status: product.status,
      version: product.version,
      title: product.title,
      slug: product.slug,
      description: product.description,
      brand: product.brand,
      price_summary: product.price_summary ?? null,
      attribute_definitions: definitions.map((d) => ({
        key: d.key,
        label: d.label,
        type: d.type,
        is_variant_dimension: d.is_variant_dimension,
        allowed_values: d.allowed_values,
        display_as: d.display_as,
        unit: d.unit,
      })),
      skus: skus.map((s) => ({
        sku_id: s._id,
        seller_sku: s.seller_sku,
        attributes: s.attributes,
        price_override: s.price_override,
        status: s.status,
      })),
      categories: {
        primary_category_id: primaryAssignment?.category_id || product.primary_category_id || null,
        secondary_category_ids: secondaryAssignments,
      },
      media: (mediaItems || []).map((m) => ({
        media_id: m._id,
        url:
          this.storageService?.getPublicUrl(m.object_key) ??
          (m as unknown as { url?: string }).url ??
          m.object_key,
        status: m.status,
        is_cover: Boolean(m.is_cover),
      })),
      shop_projection: shopProjection,
      block_reason: product.status === ProductStatus.BLOCKED ? product.block_reason : null,
    };
  }

  /**
   * Updates product fields using atomic CAS mutation locked by shop_id and optimistic version.
   */
  async updateProduct(
    actorUserId: string | undefined,
    actorShopId: string,
    productId: string,
    dto: UpdateProductDto,
  ): Promise<UpdateProductResponseDto> {
    if (!actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    // Zero-Trust IDOR check
    if (product.shop_id !== actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác trên sản phẩm của shop khác.',
      });
    }

    // Lifecycle checks
    if (product.status === ProductStatus.ARCHIVED) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'Không thể cập nhật sản phẩm đã bị lưu trữ.',
      });
    }
    if (product.status === ProductStatus.BLOCKED) {
      throw new ForbiddenException({
        code: 'PRODUCT_BLOCKED',
        message: 'Không thể cập nhật sản phẩm đang bị khóa.',
      });
    }

    // Slug conflict check if changing slug
    if (dto.slug && dto.slug !== product.slug) {
      const existingSlug = await this.productRepository.findByShopAndSlug(actorShopId, dto.slug);
      if (existingSlug && existingSlug._id !== productId) {
        throw new ConflictException({
          code: 'PRODUCT_SLUG_CONFLICT',
          message: `Slug '${dto.slug}' đã tồn tại trong gian hàng của bạn.`,
        });
      }
    }

    // Price summary update rule (LLD §3.3):
    // price_summary in PATCH is only applied if product has no SKUs yet
    let priceSummaryToUpdate: ProductPriceSummary | undefined = undefined;
    if (dto.price_summary) {
      const skus = await this.skuRepository.findByProductId(productId);
      if (skus.length === 0) {
        priceSummaryToUpdate = {
          base_price: BigInt(dto.price_summary.base_price),
          sale_price: BigInt(dto.price_summary.sale_price),
          currency: dto.price_summary.currency || 'VND',
        };
      }
    }

    // Sanitize description if provided
    let sanitizedDescription = dto.description;
    if (sanitizedDescription !== undefined && sanitizedDescription !== null) {
      sanitizedDescription = sanitizeHtml(sanitizedDescription, STRICT_SANITIZE_OPTIONS);
    }

    const updateData: Record<string, unknown> = {};
    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.slug !== undefined) updateData.slug = dto.slug;
    if (sanitizedDescription !== undefined) updateData.description = sanitizedDescription;
    if (dto.brand !== undefined) updateData.brand = dto.brand;
    if (priceSummaryToUpdate !== undefined) updateData.price_summary = priceSummaryToUpdate;

    return this.transactionRunner.execute(async (session) => {
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        actorShopId,
        dto.version,
        updateData,
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // Record outbox event
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.updated',
          schema_version: 1,
          payload: {
            product_id: productId,
            shop_id: actorShopId,
            version: updatedProduct.version,
            status: updatedProduct.status,
            changes: Object.keys(updateData),
            ...updateData,
          },
          occurred_at: new Date(),
          topic: 'product.events.v1',
          version: BigInt(updatedProduct.version),
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      return {
        product_id: updatedProduct._id,
        shop_id: updatedProduct.shop_id,
        status: updatedProduct.status,
        version: updatedProduct.version,
        title: updatedProduct.title,
        slug: updatedProduct.slug,
        price_summary: updatedProduct.price_summary ?? null,
        updated_at: updatedProduct.updated_at,
      };
    });
  }

  /**
   * Assigns categories to a product (1 primary + max 2 secondary).
   * Validates uniqueness, ACTIVE status of categories, and CAS updates version atomically.
   */
  async assignCategories(
    actorUserId: string | undefined,
    actorShopId: string,
    productId: string,
    dto: AssignCategoriesDto,
  ): Promise<AssignCategoriesResponseDto> {
    if (!actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    if (!dto.primary_category_id) {
      throw new BadRequestException({
        code: 'PRODUCT_CATEGORY_INVALID',
        message: 'Primary category là bắt buộc.',
      });
    }

    const secondaryIds = dto.secondary_category_ids || [];
    if (secondaryIds.length > 2) {
      throw new BadRequestException({
        code: 'PRODUCT_CATEGORY_INVALID',
        message: 'Tối đa 2 danh mục phụ (secondary categories).',
      });
    }

    // Check duplicate between primary and secondary
    const allCategoryIds = [dto.primary_category_id, ...secondaryIds];
    if (new Set(allCategoryIds).size !== allCategoryIds.length) {
      throw new BadRequestException({
        code: 'PRODUCT_CATEGORY_INVALID',
        message: 'Primary và Secondary category không được trùng nhau.',
      });
    }

    // Check all categories exist and have ACTIVE status
    for (const catId of allCategoryIds) {
      const category = await this.categoryRepository.findById(catId);
      if (!category || category.status !== CategoryStatus.ACTIVE) {
        throw new BadRequestException({
          code: 'PRODUCT_CATEGORY_INVALID',
          message: `Danh mục '${catId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
        });
      }
    }

    // Check product existence, shop scope, and status
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    if (product.shop_id !== actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác trên sản phẩm của shop khác.',
      });
    }

    if (product.status === ProductStatus.ARCHIVED) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'Không thể gán danh mục cho sản phẩm đã bị lưu trữ.',
      });
    }

    if (product.status === ProductStatus.BLOCKED) {
      throw new ForbiddenException({
        code: 'PRODUCT_BLOCKED',
        message: 'Không thể gán danh mục cho sản phẩm đang bị khóa.',
      });
    }

    return this.transactionRunner.execute(async (session) => {
      // 1. CAS update product version and primary_category_id
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        actorShopId,
        dto.version,
        { primary_category_id: dto.primary_category_id },
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 2. Replace product_categories assignments
      const assignments = [
        {
          category_id: dto.primary_category_id,
          is_primary: true,
          assigned_by: actorUserId || SYSTEM_ACTOR_ID,
        },
        ...secondaryIds.map((catId) => ({
          category_id: catId,
          is_primary: false,
          assigned_by: actorUserId || SYSTEM_ACTOR_ID,
        })),
      ];

      await this.productCategoryRepository.replaceProductCategories(
        productId,
        assignments,
        session,
      );

      // 3. Outbox event product.category_changed
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.category_changed',
          schema_version: 1,
          payload: {
            product_id: productId,
            shop_id: actorShopId,
            primary_category_id: dto.primary_category_id,
            secondary_category_ids: secondaryIds,
            version: Number(updatedProduct.version),
          },
          occurred_at: new Date(),
          topic: 'catalog.events.v1',
          version: BigInt(updatedProduct.version),
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      return {
        product_id: productId,
        primary_category_id: dto.primary_category_id,
        secondary_category_ids: secondaryIds,
        version: updatedProduct.version,
      };
    });
  }
}
