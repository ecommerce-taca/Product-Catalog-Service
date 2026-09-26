import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { ProductDocument, ProductStatus } from '../../database/schemas/product.schema';
import { CategoryDocument, CategoryStatus } from '../../database/schemas/category.schema';
import { SkuStatus } from '../../database/schemas/sku.schema';
import { MediaStatus } from '../../database/schemas/product-media.schema';
import { KycStatus, ShopStatus } from '../../database/schemas/shop-snapshot.schema';
import {
  InventoryProjectionDocument,
  InventoryStockStatus,
  LOW_STOCK_THRESHOLD,
} from '../../database/schemas/inventory-projection.schema';
import { AuditAction, AuditTargetType } from '../../database/schemas/catalog-audit.schema';
import { AggregateType } from '../../database/schemas/outbox-event.schema';
import { AttributeScopeType } from '../../database/schemas/attribute-definition.schema';
import { TransactionRunner } from '../../database/transaction.runner';
import { TraceContextStorage } from '../../common/context/trace-context.storage';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { ProductCategoryRepositoryPort } from '../../category/repositories/product-category.repository.interface';
import { CategoryRepositoryPort } from '../../category/repositories/category.repository.interface';
import { CategoryTreeService } from '../../category/services/category-tree.service';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { ProductMediaRepositoryPort } from '../../media/repositories/product-media.repository.interface';
import { AttributeDefinitionRepositoryPort } from '../../attribute/repositories/attribute-definition.repository.interface';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../../projections/repositories/shop-snapshot.repository.interface';
import {
  INVENTORY_PROJECTION_REPOSITORY_PORT,
  InventoryProjectionRepositoryPort,
} from '../../projections/repositories/inventory-projection.repository.interface';
import { OutboxRepositoryPort } from '../../outbox/repositories/outbox.repository.interface';
import { CatalogAuditRepositoryPort } from '../../audit/repositories/audit.repository.interface';
import {
  ArchiveProductDto,
  PublishProductDto,
  UnpublishProductDto,
} from '../dto/publish-product.dto';
import {
  ArchiveResponseDto,
  PublishResponseDto,
  UnpublishResponseDto,
} from '../dto/publish-response.dto';

const SYSTEM_ACTOR_ID = '01910000-0000-7000-8000-000000000000';

@Injectable()
export class PublishPolicyService {
  constructor(
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
    @Inject('ProductCategoryRepositoryPort')
    private readonly productCategoryRepository: ProductCategoryRepositoryPort,
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepository: CategoryRepositoryPort,
    private readonly categoryTreeService: CategoryTreeService,
    @Inject('SkuRepositoryPort')
    private readonly skuRepository: SkuRepositoryPort,
    @Inject('ProductMediaRepositoryPort')
    private readonly mediaRepository: ProductMediaRepositoryPort,
    @Inject('AttributeDefinitionRepositoryPort')
    private readonly attributeDefinitionRepository: AttributeDefinitionRepositoryPort,
    @Inject(SHOP_SNAPSHOT_REPOSITORY_PORT)
    private readonly shopSnapshotRepository: ShopSnapshotRepositoryPort,
    @Inject(INVENTORY_PROJECTION_REPOSITORY_PORT)
    private readonly inventoryProjectionRepository: InventoryProjectionRepositoryPort,
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly catalogAuditRepository: CatalogAuditRepositoryPort,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * Evaluates all Publish readiness conditions (Publish Gate).
   * Throws appropriate domain exceptions (400, 403, 409) if any condition is not met.
   */
  async validatePublishReadiness(
    product: ProductDocument,
    shopScope: string,
  ): Promise<{
    primaryCategory: CategoryDocument;
    categoryPath: string[];
    taxRateBps: number | null;
    activeSkus: Array<
      Record<string, unknown> & { _id: string; seller_sku: string; variant_key: string }
    >;
    stockStatus: string;
    stockAsOf: Date | null;
  }> {
    // 1. Title validation
    if (!product.title || typeof product.title !== 'string' || !product.title.trim()) {
      throw new BadRequestException({
        code: 'PRODUCT_TITLE_REQUIRED',
        message: 'Tên sản phẩm không được để trống khi xuất bản.',
      });
    }
    if (product.title.trim().length > 200) {
      throw new BadRequestException({
        code: 'PRODUCT_TITLE_REQUIRED',
        message: 'Tên sản phẩm không được vượt quá 200 ký tự.',
      });
    }

    // 2. Description validation
    if (
      !product.description ||
      typeof product.description !== 'string' ||
      !product.description.trim()
    ) {
      throw new BadRequestException({
        code: 'PRODUCT_DESCRIPTION_INVALID',
        message: 'Mô tả sản phẩm không được để trống khi xuất bản.',
      });
    }
    if (product.description.length > 100000) {
      throw new BadRequestException({
        code: 'PRODUCT_DESCRIPTION_INVALID',
        message: 'Mô tả sản phẩm không được vượt quá 100.000 ký tự.',
      });
    }

    // 3. Primary category validation
    const assignments = await this.productCategoryRepository.findByProductId(product._id);
    const primaryAssign = assignments.find((a) => a.is_primary);
    const primaryCategoryId = primaryAssign?.category_id || product.primary_category_id;

    if (!primaryCategoryId) {
      throw new BadRequestException({
        code: 'PRODUCT_CATEGORY_REQUIRED',
        message: 'Sản phẩm bắt buộc phải có danh mục chính (primary category) khi xuất bản.',
      });
    }

    const primaryCategory = await this.categoryRepository.findById(primaryCategoryId);
    if (!primaryCategory || primaryCategory.status !== CategoryStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'PRODUCT_CATEGORY_INVALID',
        message: 'Danh mục chính không tồn tại hoặc không ở trạng thái hoạt động (ACTIVE).',
      });
    }

    // Build category path and resolve effective tax rate
    const pathIds = (primaryCategory.path || '').split('/').filter(Boolean);
    const pathCategories = await Promise.all(
      pathIds.map((id) => this.categoryRepository.findById(id)),
    );
    const validPathCategories = pathCategories.filter((c): c is CategoryDocument => c !== null);
    const categoryPath = validPathCategories.map((c) => c.name);
    const taxRateBps = this.categoryTreeService.resolveEffectiveTaxRateFromList(
      primaryCategory._id,
      validPathCategories,
    );

    // 4. SKU validation: at least 1 active SKU
    const allSkus = await this.skuRepository.findByProductId(product._id);
    const activeSkus = allSkus.filter((s) => s.status === SkuStatus.ACTIVE);
    if (activeSkus.length === 0) {
      throw new BadRequestException({
        code: 'PRODUCT_SKU_REQUIRED',
        message: 'Sản phẩm phải có ít nhất 1 SKU ở trạng thái hoạt động (ACTIVE).',
      });
    }

    // 5. SKU Price validation: price > 0 and <= 999,999,999,999 VND
    for (const sku of activeSkus) {
      const price =
        sku.price_override !== null && sku.price_override !== undefined
          ? BigInt(sku.price_override)
          : product.price_summary?.sale_price !== null &&
              product.price_summary?.sale_price !== undefined
            ? BigInt(product.price_summary.sale_price)
            : null;

      if (price === null || price <= 0n || price > 999999999999n) {
        throw new BadRequestException({
          code: 'PRODUCT_PRICE_INVALID',
          message: `SKU '${sku.seller_sku}' không có giá bán hợp lệ (phải là số nguyên từ 1 đến 999.999.999.999 VND).`,
        });
      }
    }

    // 6. Media validation: exactly 1 cover image in READY status
    const mediaItems = this.mediaRepository.findActiveByProductId
      ? await this.mediaRepository.findActiveByProductId(product._id)
      : await this.mediaRepository.findByProductId(product._id);

    const readyCoverMedia = (mediaItems || []).filter(
      (m) => Boolean(m.is_cover) && m.status === MediaStatus.READY,
    );

    if (readyCoverMedia.length !== 1) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_REQUIRED',
        message: 'Sản phẩm bắt buộc phải có đúng 1 ảnh bìa (cover image) ở trạng thái READY.',
      });
    }

    // 7. Duplicate variant_key among active SKUs
    const variantKeys = activeSkus
      .map((s) => s.variant_key)
      .filter((k): k is string => k !== null && k !== undefined);
    if (new Set(variantKeys).size !== variantKeys.length) {
      throw new ConflictException({
        code: 'PRODUCT_SKU_DUPLICATE',
        message: 'Có SKU trùng lặp variant_key giữa các active SKUs trong sản phẩm.',
      });
    }

    // 8. Shop KYC Gate & Shop Status
    const shopSnapshot = await this.shopSnapshotRepository.findByShopId(shopScope);
    if (!shopSnapshot || shopSnapshot.kyc_status !== KycStatus.APPROVED) {
      throw new ForbiddenException({
        code: 'PRODUCT_KYC_REQUIRED',
        message: 'Gian hàng chưa hoàn tất xác thực KYC (APPROVED) để xuất bản sản phẩm.',
      });
    }

    if (shopSnapshot.shop_status === ShopStatus.SUSPENDED) {
      throw new ForbiddenException({
        code: 'PRODUCT_SHOP_SUSPENDED',
        message: 'Gian hàng đang bị tạm ngưng hoạt động (SUSPENDED).',
      });
    }

    // 9. Stock Snapshot projection (Stock = 0 is allowed and does NOT block publish!)
    let stockStatus: string = InventoryStockStatus.UNKNOWN;
    let stockAsOf: Date | null = null;

    const projections: InventoryProjectionDocument[] =
      await this.inventoryProjectionRepository.findByProductId(product._id);

    if (projections && projections.length > 0) {
      const totalAvailable = projections.reduce(
        (acc, p) => acc + (p.available_qty_snapshot ? BigInt(p.available_qty_snapshot) : 0n),
        0n,
      );

      const latestAsOf = projections.reduce(
        (latest, p) => {
          if (!latest) return p.as_of;
          if (p.as_of && new Date(p.as_of) > new Date(latest)) return p.as_of;
          return latest;
        },
        null as Date | null,
      );

      if (totalAvailable === 0n) {
        stockStatus = InventoryStockStatus.OUT_OF_STOCK;
      } else if (totalAvailable <= BigInt(LOW_STOCK_THRESHOLD)) {
        stockStatus = InventoryStockStatus.LOW_STOCK;
      } else {
        stockStatus = InventoryStockStatus.IN_STOCK;
      }
      stockAsOf = latestAsOf;
    }

    return {
      primaryCategory,
      categoryPath,
      taxRateBps,
      activeSkus: activeSkus as unknown as Array<
        Record<string, unknown> & { _id: string; seller_sku: string; variant_key: string }
      >,
      stockStatus,
      stockAsOf,
    };
  }

  /**
   * Publishes a product from DRAFT or INACTIVE to ACTIVE.
   * Runs all Publish Gate checks, OCC check, updates product and records outbox + audit in atomic transaction.
   */
  async publish(
    actorUserId: string | undefined,
    shopScope: string,
    productId: string,
    dto: PublishProductDto,
  ): Promise<PublishResponseDto> {
    if (!shopScope) {
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
    if (product.shop_id !== shopScope) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác trên sản phẩm của gian hàng khác.',
      });
    }

    // Preconditions on product lifecycle state
    if (product.status === ProductStatus.BLOCKED) {
      throw new ForbiddenException({
        code: 'PRODUCT_BLOCKED',
        message: 'Không thể xuất bản sản phẩm đang bị khóa bởi quản trị viên.',
      });
    }
    if (product.status === ProductStatus.ARCHIVED) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'Không thể xuất bản sản phẩm đã bị lưu trữ.',
      });
    }
    if (product.status === ProductStatus.ACTIVE) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Sản phẩm đã ở trạng thái ACTIVE.',
      });
    }
    if (product.status !== ProductStatus.DRAFT && product.status !== ProductStatus.INACTIVE) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Trạng thái sản phẩm không hợp lệ để xuất bản.',
      });
    }

    // OCC Check
    if (product.version !== BigInt(dto.version)) {
      throw new ConflictException({
        code: 'PRODUCT_VERSION_CONFLICT',
        message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
      });
    }

    // Run full Publish readiness gate checks
    const readiness = await this.validatePublishReadiness(product, shopScope);

    // Retrieve descriptive attributes and media for Outbox payload
    const [attributeDefinitions, mediaList] = await Promise.all([
      this.attributeDefinitionRepository.findByScope(AttributeScopeType.PRODUCT, productId),
      this.mediaRepository.findActiveByProductId
        ? this.mediaRepository.findActiveByProductId(productId)
        : this.mediaRepository.findByProductId(productId),
    ]);

    const now = new Date();
    const nextVersion = BigInt(dto.version) + BigInt(1);

    return this.transactionRunner.execute(async (session) => {
      // 1. CAS update product to ACTIVE
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        shopScope,
        dto.version,
        {
          status: ProductStatus.ACTIVE,
          published_at: now,
          unpublished_at: null,
        },
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 2. Outbox event product.published
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.published',
          schema_version: 1,
          payload: {
            product_id: productId,
            shop_id: shopScope,
            title: product.title,
            slug: product.slug,
            brand: product.brand || null,
            primary_category_id: readiness.primaryCategory._id,
            category_path: readiness.categoryPath,
            visibility_status: 'PUBLISHED',
            attributes: (attributeDefinitions || []).map((d) => ({
              key: d.key,
              label: d.label,
              type: d.type,
              is_variant_dimension: d.is_variant_dimension,
            })),
            media: (mediaList || []).map((m) => ({
              media_id: m._id,
              url: m.object_key,
              is_cover: Boolean(m.is_cover),
              status: m.status,
            })),
            price: {
              base: product.price_summary?.base_price
                ? Number(product.price_summary.base_price)
                : 0,
              sale: product.price_summary?.sale_price
                ? Number(product.price_summary.sale_price)
                : 0,
              currency: product.price_summary?.currency || 'VND',
            },
            tax_rate_bps: readiness.taxRateBps,
            active_sku_ids: readiness.activeSkus.map((s) => s._id),
            published_at: now.toISOString(),
            version: Number(nextVersion),
          },
          occurred_at: now,
          topic: 'product.events.v1',
          version: nextVersion,
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      // 3. Catalog audit record
      await this.catalogAuditRepository.record(
        {
          _id: uuidv7(),
          action: AuditAction.PUBLISH,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          actor_user_id: actorUserId || SYSTEM_ACTOR_ID,
          shop_id: shopScope,
          reason: null,
          metadata: {
            previous_status: product.status,
            new_status: ProductStatus.ACTIVE,
            version: Number(nextVersion),
          },
          occurred_at: now,
        },
        session,
      );

      return {
        product_id: productId,
        status: ProductStatus.ACTIVE,
        published_at: now,
        version: Number(nextVersion),
        stock_display: {
          status: readiness.stockStatus,
          as_of: readiness.stockAsOf,
        },
      };
    });
  }

  /**
   * Unpublishes an ACTIVE product, transitioning it to INACTIVE.
   * Keeps SKUs, media, and price history intact.
   */
  async unpublish(
    actorUserId: string | undefined,
    shopScope: string,
    productId: string,
    dto: UnpublishProductDto,
  ): Promise<UnpublishResponseDto> {
    if (!shopScope) {
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
    if (product.shop_id !== shopScope) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác trên sản phẩm của gian hàng khác.',
      });
    }

    // Preconditions
    if (product.status === ProductStatus.BLOCKED) {
      throw new ForbiddenException({
        code: 'PRODUCT_BLOCKED',
        message: 'Không thể tạm dừng sản phẩm đang bị khóa bởi quản trị viên.',
      });
    }
    if (product.status === ProductStatus.ARCHIVED) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'Không thể tạm dừng sản phẩm đã bị lưu trữ.',
      });
    }
    if (product.status !== ProductStatus.ACTIVE) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Chỉ có thể unpublish sản phẩm đang ở trạng thái ACTIVE.',
      });
    }

    // OCC Check
    if (product.version !== BigInt(dto.version)) {
      throw new ConflictException({
        code: 'PRODUCT_VERSION_CONFLICT',
        message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
      });
    }

    const now = new Date();
    const nextVersion = BigInt(dto.version) + BigInt(1);

    return this.transactionRunner.execute(async (session) => {
      // 1. CAS update product to INACTIVE
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        shopScope,
        dto.version,
        {
          status: ProductStatus.INACTIVE,
          unpublished_at: now,
        },
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 2. Outbox event product.unpublished
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.unpublished',
          schema_version: 1,
          payload: {
            product_id: productId,
            reason: dto.reason || null,
            version: Number(nextVersion),
          },
          occurred_at: now,
          topic: 'product.events.v1',
          version: nextVersion,
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      // 3. Catalog audit record
      await this.catalogAuditRepository.record(
        {
          _id: uuidv7(),
          action: AuditAction.UNPUBLISH,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          actor_user_id: actorUserId || SYSTEM_ACTOR_ID,
          shop_id: shopScope,
          reason: dto.reason || null,
          metadata: {
            previous_status: product.status,
            new_status: ProductStatus.INACTIVE,
            version: Number(nextVersion),
          },
          occurred_at: now,
        },
        session,
      );

      return {
        product_id: productId,
        status: ProductStatus.INACTIVE,
        version: Number(nextVersion),
      };
    });
  }

  /**
   * Archives a product (soft lifecycle delete).
   * Valid from DRAFT, INACTIVE, or ACTIVE.
   */
  async archive(
    actorUserId: string | undefined,
    shopScope: string,
    productId: string,
    dto: ArchiveProductDto,
  ): Promise<ArchiveResponseDto> {
    if (!shopScope) {
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
    if (product.shop_id !== shopScope) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác trên sản phẩm của gian hàng khác.',
      });
    }

    // Preconditions
    if (product.status === ProductStatus.ARCHIVED) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Sản phẩm đã ở trạng thái ARCHIVED.',
      });
    }
    if (product.status === ProductStatus.BLOCKED) {
      throw new ForbiddenException({
        code: 'PRODUCT_BLOCKED',
        message: 'Không thể lưu trữ sản phẩm đang bị khóa bởi quản trị viên.',
      });
    }

    const allowedStatuses = [ProductStatus.DRAFT, ProductStatus.INACTIVE, ProductStatus.ACTIVE];
    if (!allowedStatuses.includes(product.status)) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Trạng thái sản phẩm không hợp lệ để lưu trữ.',
      });
    }

    // OCC Check
    if (product.version !== BigInt(dto.version)) {
      throw new ConflictException({
        code: 'PRODUCT_VERSION_CONFLICT',
        message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
      });
    }

    const now = new Date();
    const nextVersion = BigInt(dto.version) + BigInt(1);

    return this.transactionRunner.execute(async (session) => {
      // 1. CAS update product to ARCHIVED
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        shopScope,
        dto.version,
        {
          status: ProductStatus.ARCHIVED,
          archived_at: now,
        },
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 2. Outbox event product.archived
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.archived',
          schema_version: 1,
          payload: {
            product_id: productId,
            reason: dto.reason || null,
            archived_at: now.toISOString(),
            version: Number(nextVersion),
          },
          occurred_at: now,
          topic: 'product.events.v1',
          version: nextVersion,
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      // 3. Catalog audit record
      await this.catalogAuditRepository.record(
        {
          _id: uuidv7(),
          action: AuditAction.ARCHIVE,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          actor_user_id: actorUserId || SYSTEM_ACTOR_ID,
          shop_id: shopScope,
          reason: dto.reason || null,
          metadata: {
            previous_status: product.status,
            new_status: ProductStatus.ARCHIVED,
            version: Number(nextVersion),
          },
          occurred_at: now,
        },
        session,
      );

      return {
        product_id: productId,
        status: ProductStatus.ARCHIVED,
        version: Number(nextVersion),
      };
    });
  }
}
