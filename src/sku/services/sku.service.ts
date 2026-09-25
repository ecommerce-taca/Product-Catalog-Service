import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { TransactionRunner } from '../../database/transaction.runner';
import { ProductStatus } from '../../database/schemas/product.schema';
import {
  AttributeDefinitionDocument,
  AttributeDefinitionStatus,
  AttributeDisplayAs,
  AttributeScopeType,
} from '../../database/schemas/attribute-definition.schema';
import { SkuDocument, SkuStatus } from '../../database/schemas/sku.schema';
import { AttributeDefinitionRepositoryPort } from '../../attribute/repositories/attribute-definition.repository.interface';
import { SkuRepositoryPort } from '../repositories/sku.repository.interface';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { OutboxRepositoryPort } from '../../outbox/repositories/outbox.repository.interface';
import { CatalogAuditRepositoryPort } from '../../audit/repositories/audit.repository.interface';
import { AggregateType } from '../../database/schemas/outbox-event.schema';
import { AuditTargetType } from '../../database/schemas/catalog-audit.schema';
import { TraceContextStorage } from '../../common/context/trace-context.storage';
import { VariantResolver } from './variant-resolver.service';
import { UpdateProductSkusDto } from '../dto/update-product-skus.dto';
import { SkuResponseDto } from '../dto/sku-response.dto';

const SYSTEM_ACTOR_ID = '01910000-0000-7000-8000-000000000000';

@Injectable()
export class SkuService {
  constructor(
    @Inject(forwardRef(() => 'ProductRepositoryPort'))
    private readonly productRepository: ProductRepositoryPort,
    @Inject('AttributeDefinitionRepositoryPort')
    private readonly attributeDefinitionRepository: AttributeDefinitionRepositoryPort,
    @Inject('SkuRepositoryPort')
    private readonly skuRepository: SkuRepositoryPort,
    private readonly variantResolver: VariantResolver,
    private readonly transactionRunner: TransactionRunner,
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly auditRepository: CatalogAuditRepositoryPort,
  ) {}

  /**
   * Replaces/updates the attribute definitions and SKU set for a product atomically.
   * Enforces Zero-Trust IDOR, definition limits, variant canonicalization, duplicate checks,
   * price resolution, and product price_summary calculation.
   */
  async updateProductSkus(
    productId: string,
    actorShopId: string,
    dto: UpdateProductSkusDto,
    actorUserId?: string,
  ): Promise<SkuResponseDto[]> {
    return this.transactionRunner.execute(async (session) => {
      // 1. Load product inside transaction
      const product = await this.productRepository.findById(productId, session);
      if (!product) {
        throw new NotFoundException({
          code: 'PRODUCT_NOT_FOUND',
          message: 'Không tìm thấy sản phẩm.',
        });
      }

      // 2. Zero-Trust IDOR check
      if (!actorShopId || product.shop_id !== actorShopId) {
        throw new ForbiddenException({
          code: 'PRODUCT_FORBIDDEN',
          message: 'Bạn không có quyền thao tác trên sản phẩm của shop khác.',
        });
      }

      // SF-05: Product lifecycle lock policy
      if (product.status === ProductStatus.ARCHIVED) {
        throw new ConflictException({
          code: 'PRODUCT_ARCHIVED',
          message: 'Không thể cập nhật biến thể của sản phẩm đã bị lưu trữ.',
        });
      }
      if (product.status === ProductStatus.BLOCKED) {
        throw new ForbiddenException({
          code: 'PRODUCT_BLOCKED',
          message: 'Không thể cập nhật biến thể của sản phẩm đang bị khóa.',
        });
      }

      // 3. Optimistic concurrency check
      if (
        dto.version !== undefined &&
        dto.version !== null &&
        BigInt(product.version) !== BigInt(dto.version)
      ) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi. Vui lòng tải lại.',
        });
      }

      // 4. Validate definition limits & uniqueness
      const defs = dto.attribute_definitions || [];
      if (defs.length > 50) {
        throw new BadRequestException({
          code: 'PRODUCT_ATTRIBUTE_INVALID',
          message: 'Số lượng thuộc tính vượt quá giới hạn tối đa 50.',
        });
      }

      const seenDefKeys = new Set<string>();
      for (const def of defs) {
        if (seenDefKeys.has(def.key)) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Thuộc tính '${def.key}' bị trùng lặp trong danh sách khai báo.`,
          });
        }
        seenDefKeys.add(def.key);

        if (def.allowed_values && new Set(def.allowed_values).size !== def.allowed_values.length) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Danh sách allowed_values của thuộc tính '${def.key}' chứa giá trị trùng lặp.`,
          });
        }
      }

      const variantDimensions = defs.filter((d) => d.is_variant_dimension);
      if (variantDimensions.length > 10) {
        throw new BadRequestException({
          code: 'PRODUCT_ATTRIBUTE_INVALID',
          message:
            'Số lượng thuộc tính biến thể (is_variant_dimension) vượt quá giới hạn tối đa 10.',
        });
      }

      // 5. Validate SKU limits
      const skuDtos = dto.skus || [];
      if (skuDtos.length > 1000) {
        throw new ConflictException({
          code: 'PRODUCT_SKU_LIMIT_EXCEEDED',
          message: 'Số lượng SKU vượt quá giới hạn tối đa 1000.',
        });
      }

      // 5.5. Load existing SKUs of this product for IDOR validation & duplicate key prevention
      const existingSkus = await this.skuRepository.findByProductId(productId, session);
      const existingSkuIds = new Set(existingSkus.map((s) => s._id));
      const existingByVariantKey = new Map(existingSkus.map((s) => [s.variant_key, s]));

      // 6. Validate and canonicalize each SKU
      const processedSkus = skuDtos.map((item) => {
        const sellerSku = item.seller_sku?.trim();
        if (!sellerSku) {
          throw new BadRequestException({
            code: 'PRODUCT_INVALID_INPUT',
            message: 'Mã seller_sku không được để trống.',
          });
        }

        const { canonicalAttributes, variantKey } = this.variantResolver.validateAndCanonicalize(
          item.attributes,
          defs,
        );

        let skuId: string;
        if (item.sku_id) {
          if (!existingSkuIds.has(item.sku_id)) {
            throw new ForbiddenException({
              code: 'PRODUCT_FORBIDDEN',
              message: 'SKU không thuộc về sản phẩm này.',
            });
          }
          skuId = item.sku_id;
        } else {
          const existingMatch = existingByVariantKey.get(variantKey);
          skuId = existingMatch ? existingMatch._id : uuidv7();
        }

        return {
          sku_id: skuId,
          product_id: productId,
          shop_id: product.shop_id,
          seller_sku: sellerSku,
          attributes: canonicalAttributes,
          variant_key: variantKey,
          price_override:
            item.price_override !== null && item.price_override !== undefined
              ? BigInt(item.price_override)
              : null,
          status: item.status || SkuStatus.ACTIVE,
          media_ids: item.media_ids || [],
          version: BigInt(1),
        };
      });

      // 7. In-batch duplicate detection (both variant_key and seller_sku)
      this.variantResolver.detectDuplicates(processedSkus);

      // 8. DB duplicate seller_sku in same shop (batch query to eliminate N+1)
      const sellerSkusToCheck = processedSkus.map((s) => s.seller_sku);
      const existingWithSellerSkus = await this.skuRepository.findBySellerSkus(
        product.shop_id,
        sellerSkusToCheck,
        session,
      );
      for (const existing of existingWithSellerSkus) {
        if (existing.product_id !== productId) {
          throw new ConflictException({
            code: 'PRODUCT_SKU_DUPLICATE',
            message: `Mã seller_sku '${existing.seller_sku}' đã được sử dụng ở sản phẩm khác trong shop.`,
          });
        }
      }

      // 9. Atomic attribute definitions update
      await this.attributeDefinitionRepository.deleteByScope(
        AttributeScopeType.PRODUCT,
        productId,
        session,
      );

      if (defs.length > 0) {
        const definitionDocs: Partial<AttributeDefinitionDocument>[] = defs.map((def, idx) => ({
          _id: uuidv7(),
          scope_type: AttributeScopeType.PRODUCT,
          scope_id: productId,
          key: def.key,
          label: def.label,
          type: def.type,
          is_variant_dimension: Boolean(def.is_variant_dimension),
          allowed_values: def.allowed_values || [],
          unit: def.unit || null,
          display_as: def.display_as || AttributeDisplayAs.PLAIN,
          value_meta: def.value_meta || null,
          sort_order: def.sort_order ?? idx,
          status: AttributeDefinitionStatus.ACTIVE,
        }));
        await this.attributeDefinitionRepository.bulkUpsert(definitionDocs, session);
      }

      // 10. Atomic SKUs update
      const newSkuIds = new Set(processedSkus.map((s) => s.sku_id));
      const omittedSkus = existingSkus.filter((s) => !newSkuIds.has(s._id));

      for (const omitted of omittedSkus) {
        if (omitted.status !== SkuStatus.ARCHIVED) {
          omitted.status = SkuStatus.INACTIVE;
          await omitted.save({ session });
        }
      }

      if (processedSkus.length > 0) {
        const skuUpserts = processedSkus.map((s) => ({
          _id: s.sku_id,
          product_id: s.product_id,
          shop_id: s.shop_id,
          seller_sku: s.seller_sku,
          attributes: s.attributes,
          variant_key: s.variant_key,
          price_override: s.price_override,
          status: s.status,
          media_ids: s.media_ids,
          version: s.version,
        }));
        await this.skuRepository.bulkUpsert(skuUpserts as Partial<SkuDocument>[], session);
      }

      // 11. Recompute product price_summary & atomic CAS update
      const currentBasePrice = Number(product.price_summary?.base_price ?? 0);
      const currentSalePrice = Number(product.price_summary?.sale_price ?? currentBasePrice);

      const activeSkus = processedSkus.filter((s) => s.status === SkuStatus.ACTIVE);
      let newPriceSummary = product.price_summary;
      if (activeSkus.length > 0) {
        const salePrices = activeSkus.map((s) =>
          s.price_override !== null && s.price_override !== undefined
            ? Number(s.price_override)
            : currentSalePrice,
        );
        const minSalePrice = Math.min(...salePrices);

        newPriceSummary = {
          base_price: BigInt(currentBasePrice),
          sale_price: BigInt(minSalePrice),
          currency: 'VND',
        };
      }

      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        actorShopId,
        product.version,
        { price_summary: newPriceSummary },
        session,
      );
      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được cập nhật bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 12. Record transactional outbox event (SF-4)
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.skus_updated',
          schema_version: 1,
          payload: {
            product_id: productId,
            shop_id: actorShopId,
            version: updatedProduct.version,
            skus: processedSkus,
          },
          occurred_at: new Date(),
          topic: 'product.events.v1',
          version: BigInt(updatedProduct.version),
          actor_user_id: actorUserId || null,
          traceparent: TraceContextStorage.getTraceparent() || null,
        },
        session,
      );

      // Record audit log (SF-4)
      await this.auditRepository.create(
        {
          _id: uuidv7(),
          actor_user_id: actorUserId || SYSTEM_ACTOR_ID,
          shop_id: actorShopId,
          action: 'SKU_CONFIGURED',
          target_type: AuditTargetType.SKU,
          target_id: productId,
          entity_type: 'SKU',
          entity_id: productId,
          metadata: {
            sku_count: processedSkus.length,
            attribute_definitions_count: defs.length,
            skus: processedSkus.map((s) => ({
              sku_id: s.sku_id,
              seller_sku: s.seller_sku,
              variant_key: s.variant_key,
              price_override: s.price_override,
              status: s.status,
            })),
          },
          changes: {
            sku_count: processedSkus.length,
            attribute_definitions_count: defs.length,
            skus: processedSkus.map((s) => ({
              sku_id: s.sku_id,
              seller_sku: s.seller_sku,
              variant_key: s.variant_key,
              price_override: s.price_override,
              status: s.status,
            })),
          },
          occurred_at: new Date(),
        },
        session,
      );

      // 13. Build and return SkuResponseDto[]
      const resolvedBase = Number(newPriceSummary?.base_price ?? 0);
      const resolvedSale = Number(newPriceSummary?.sale_price ?? resolvedBase);

      return processedSkus.map((s) => {
        const itemSalePrice =
          s.price_override !== null && s.price_override !== undefined
            ? Number(s.price_override)
            : resolvedSale;

        return {
          sku_id: s.sku_id,
          product_id: s.product_id,
          shop_id: s.shop_id,
          seller_sku: s.seller_sku,
          attributes: s.attributes,
          variant_key: s.variant_key,
          price_override: s.price_override !== null ? Number(s.price_override) : null,
          price: {
            base_price: resolvedBase,
            sale_price: itemSalePrice,
            currency: 'VND',
          },
          status: s.status,
          media_ids: s.media_ids,
          version: Number(s.version),
        };
      });
    });
  }

  /**
   * Retrieves SKUs for a product, resolving prices from the product's price_summary.
   * If actorShopId is provided, validates that the product belongs to that shop (Zero-Trust IDOR).
   */
  async getSkusByProductId(productId: string, actorShopId?: string): Promise<SkuResponseDto[]> {
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    if (!actorShopId || product.shop_id !== actorShopId) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền xem SKU của sản phẩm thuộc shop khác.',
      });
    }

    const skus = await this.skuRepository.findByProductId(productId);

    const basePrice = Number(product.price_summary?.base_price ?? 0);
    const productSalePrice = Number(product.price_summary?.sale_price ?? basePrice);

    return skus.map((s) => {
      const salePrice =
        s.price_override !== null && s.price_override !== undefined
          ? Number(s.price_override)
          : productSalePrice;

      return {
        sku_id: s._id,
        product_id: s.product_id,
        shop_id: s.shop_id,
        seller_sku: s.seller_sku,
        attributes: s.attributes,
        variant_key: s.variant_key,
        price_override: s.price_override !== null ? Number(s.price_override) : null,
        price: {
          base_price: basePrice,
          sale_price: salePrice,
          currency: 'VND',
        },
        status: s.status,
        media_ids: s.media_ids || [],
        version: Number(s.version),
        created_at: s.created_at,
        updated_at: s.updated_at,
      };
    });
  }
}
