import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FilterQuery } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import { ProductStatus } from '../../database/schemas/product.schema';
import {
  AuditAction,
  AuditTargetType,
  CatalogAuditDocument,
} from '../../database/schemas/catalog-audit.schema';
import { AggregateType } from '../../database/schemas/outbox-event.schema';
import { TransactionRunner } from '../../database/transaction.runner';
import { TraceContextStorage } from '../../common/context/trace-context.storage';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { OutboxRepositoryPort } from '../../outbox/repositories/outbox.repository.interface';
import {
  CATALOG_AUDIT_REPOSITORY_PORT,
  CatalogAuditRepositoryPort,
} from '../repositories/catalog-audit.repository.interface';
import { BlockProductDto } from '../dto/block-product.dto';
import { UnblockProductDto } from '../dto/unblock-product.dto';
import { QueryAuditsDto } from '../dto/query-audits.dto';
import {
  BlockProductResponseDto,
  PaginatedAuditsResponseDto,
  UnblockProductResponseDto,
} from '../dto/moderation-response.dto';

const SYSTEM_ACTOR_ID = '01910000-0000-7000-8000-000000000000';

@Injectable()
export class ModerationService {
  constructor(
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
    @Inject(CATALOG_AUDIT_REPOSITORY_PORT)
    private readonly catalogAuditRepository: CatalogAuditRepositoryPort,
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * Blocks a product (admin emergency / policy violation action).
   * Transition: from any non-ARCHIVED status to BLOCKED.
   * Emits product.blocked event to notify Search to hide the listing.
   */
  async blockProduct(
    actorUserId: string | undefined,
    productId: string,
    dto: BlockProductDto,
  ): Promise<BlockProductResponseDto> {
    if (!dto.reason || typeof dto.reason !== 'string' || !dto.reason.trim()) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'Lý do khóa sản phẩm (reason) là bắt buộc và không được để trống.',
      });
    }

    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    // Preconditions
    if (product.status === ProductStatus.ARCHIVED) {
      throw new ConflictException({
        code: 'PRODUCT_ARCHIVED',
        message: 'Không thể khóa sản phẩm đã bị lưu trữ.',
      });
    }
    if (product.status === ProductStatus.BLOCKED) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Sản phẩm đã ở trạng thái BLOCKED.',
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
    const trimmedReason = dto.reason.trim();

    return this.transactionRunner.execute(async (session) => {
      // 1. CAS update product status to BLOCKED
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        product.shop_id,
        dto.version,
        {
          status: ProductStatus.BLOCKED,
          blocked_at: now,
          block_reason: trimmedReason,
        },
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 2. Outbox event product.blocked
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.blocked',
          schema_version: 1,
          payload: {
            product_id: productId,
            reason: trimmedReason,
            actor: actorUserId || SYSTEM_ACTOR_ID,
            blocked_at: now.toISOString(),
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
          action: AuditAction.BLOCK,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          reason: trimmedReason,
          actor_user_id: actorUserId || SYSTEM_ACTOR_ID,
          shop_id: product.shop_id,
          metadata: {
            previous_status: product.status,
            new_status: ProductStatus.BLOCKED,
            version: Number(nextVersion),
          },
          occurred_at: now,
        },
        session,
      );

      return {
        product_id: productId,
        status: ProductStatus.BLOCKED,
        blocked_at: now,
        version: Number(nextVersion),
      };
    });
  }

  /**
   * Unblocks a BLOCKED product, returning it to a safe INACTIVE baseline.
   * Requires status to be BLOCKED.
   */
  async unblockProduct(
    actorUserId: string | undefined,
    productId: string,
    dto: UnblockProductDto,
  ): Promise<UnblockProductResponseDto> {
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    // Preconditions: MUST be in BLOCKED status
    if (product.status !== ProductStatus.BLOCKED) {
      throw new ConflictException({
        code: 'PRODUCT_STATE_INVALID',
        message: 'Chỉ có thể mở khóa sản phẩm đang ở trạng thái BLOCKED.',
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
    const reason = dto.reason ? dto.reason.trim() : null;

    return this.transactionRunner.execute(async (session) => {
      // 1. CAS update product status to INACTIVE and clear block_reason
      const updatedProduct = await this.productRepository.atomicCasUpdate(
        productId,
        product.shop_id,
        dto.version,
        {
          status: ProductStatus.INACTIVE,
          block_reason: null,
        },
        session,
      );

      if (!updatedProduct) {
        throw new ConflictException({
          code: 'PRODUCT_VERSION_CONFLICT',
          message: 'Sản phẩm đã được thay đổi bởi thao tác khác. Vui lòng tải lại.',
        });
      }

      // 2. Outbox event product.unblocked
      await this.outboxRepository.saveEvent(
        {
          _id: uuidv7(),
          event_id: uuidv7(),
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          event_type: 'product.unblocked',
          schema_version: 1,
          payload: {
            product_id: productId,
            next_status: 'INACTIVE',
            actor: actorUserId || SYSTEM_ACTOR_ID,
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
          action: AuditAction.UNBLOCK,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          reason,
          actor_user_id: actorUserId || SYSTEM_ACTOR_ID,
          shop_id: product.shop_id,
          metadata: {
            previous_status: ProductStatus.BLOCKED,
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
        next_status: ProductStatus.INACTIVE,
        version: Number(nextVersion),
      };
    });
  }

  /**
   * Retrieves paginated catalog audit logs.
   * Sorted descending by occurred_at.
   */
  async getAudits(query: QueryAuditsDto): Promise<PaginatedAuditsResponseDto> {
    const filter: FilterQuery<CatalogAuditDocument> = {};

    if (query.target_id) {
      filter.target_id = query.target_id;
    }
    if (query.target_type) {
      filter.target_type = query.target_type;
    }
    if (query.actor_user_id) {
      filter.actor_user_id = query.actor_user_id;
    }
    if (query.action) {
      filter.action = query.action;
    }

    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const size = query.size && query.size > 0 ? Math.min(Number(query.size), 100) : 20;

    const { items, total } = await this.catalogAuditRepository.findAudits(filter, page, size);

    return {
      data: items,
      meta: {
        page,
        size,
        total,
        total_pages: Math.ceil(total / size) || 1,
      },
    };
  }
}
