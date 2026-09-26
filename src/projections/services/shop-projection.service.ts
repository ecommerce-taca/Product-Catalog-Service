import { Inject, Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  KycStatus,
  ShopSnapshot,
  ShopSnapshotDocument,
  ShopStatus,
} from '../../database/schemas/shop-snapshot.schema';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../repositories/shop-snapshot.repository.interface';
import { OutboxRepositoryPort } from '../../outbox/repositories/outbox.repository.interface';
import { AggregateType, OutboxEvent } from '../../database/schemas/outbox-event.schema';
import { KafkaEventEnvelope } from '../../integrations/kafka/kafka-event.interface';
import { ClientSession } from 'mongoose';
import { TransactionRunner } from '../../database/transaction.runner';
import {
  EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED,
  EVENT_SHOP_KYC_APPROVED,
  EVENT_SHOP_KYC_EXPIRED,
  EVENT_SHOP_KYC_NEEDS_INFO,
  EVENT_SHOP_KYC_REJECTED,
  EVENT_SHOP_KYC_SUBMITTED,
  EVENT_SHOP_STATUS_CHANGED,
  TOPIC_CATALOG_EVENTS,
} from '../../integrations/kafka/kafka.constants';

export interface ShopEventPayload {
  shop_id?: string;
  name?: string;
  slug?: string;
  logo_url?: string | null;
  status?: string;
  old_status?: string;
  new_status?: string;
  version?: number | bigint;
  source_version?: number | bigint;
  kyc_status?: string;
  kyc_case_id?: string;
  approved_at?: string;
}

export interface ProcessShopEventResult {
  success: boolean;
  dropped?: boolean;
  reason?: 'OUT_OF_ORDER' | 'DUPLICATE' | 'STALE';
  snapshot?: ShopSnapshotDocument;
}

@Injectable()
export class ShopProjectionService {
  private readonly logger = new Logger(ShopProjectionService.name);

  constructor(
    @Inject(SHOP_SNAPSHOT_REPOSITORY_PORT)
    private readonly shopSnapshotRepository: ShopSnapshotRepositoryPort,
    private readonly outboxRepository: OutboxRepositoryPort,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  async handleShopEvent(
    event: KafkaEventEnvelope<ShopEventPayload>,
  ): Promise<ProcessShopEventResult> {
    const shopId = event.payload?.shop_id || event.aggregate_id;
    if (!shopId) {
      throw new Error(`Invalid shop event ${event.event_id}: missing shop_id`);
    }

    const existing = await this.shopSnapshotRepository.findByShopId(shopId);

    // 0. Idempotency check: duplicate event_id replay
    if (existing && existing.source_event_id === event.event_id) {
      this.logger.log(`Dropping duplicate event ${event.event_id} for shop ${shopId}`);
      return { success: true, dropped: true, reason: 'DUPLICATE' };
    }

    // 1. Versioned event check (out-of-order / idempotency)
    const eventVersion =
      event.payload?.source_version ??
      event.payload?.version ??
      (event as unknown as { version?: number | bigint }).version;

    if (eventVersion !== undefined && eventVersion !== null) {
      const ver = BigInt(eventVersion);
      if (existing && ver <= existing.source_version) {
        this.logger.log(
          `Dropping out-of-order/stale event ${event.event_id} for shop ${shopId}. Event version: ${ver}, current: ${existing.source_version}`,
        );
        return { success: true, dropped: true, reason: 'OUT_OF_ORDER' };
      }
    } else {
      // 2. Unversioned events (e.g. shop.kyc.*) timestamp ordering
      if (existing) {
        const eventTime = new Date(event.occurred_at).getTime();
        const existingTime = new Date(existing.updated_at).getTime();
        if (eventTime < existingTime) {
          this.logger.log(
            `Dropping stale unversioned event ${event.event_id} for shop ${shopId}. Event time: ${eventTime} < current: ${existingTime}`,
          );
          return { success: true, dropped: true, reason: 'STALE' };
        }
      }
    }

    // 3. Infer KYC status
    let nextKycStatus: KycStatus;
    switch (event.event_type) {
      case EVENT_SHOP_KYC_SUBMITTED:
        nextKycStatus = KycStatus.PENDING;
        break;
      case EVENT_SHOP_KYC_APPROVED:
        nextKycStatus = KycStatus.APPROVED;
        break;
      case EVENT_SHOP_KYC_NEEDS_INFO:
        nextKycStatus = KycStatus.NEEDS_INFO;
        break;
      case EVENT_SHOP_KYC_REJECTED:
        nextKycStatus = KycStatus.REJECTED;
        break;
      case EVENT_SHOP_KYC_EXPIRED:
        nextKycStatus = KycStatus.EXPIRED;
        break;
      default:
        if (
          event.payload?.kyc_status &&
          Object.values(KycStatus).includes(event.payload.kyc_status as KycStatus)
        ) {
          nextKycStatus = event.payload.kyc_status as KycStatus;
        } else if (existing) {
          nextKycStatus = existing.kyc_status as KycStatus;
        } else {
          nextKycStatus = KycStatus.PENDING;
        }
    }

    // 4. Infer shop status
    let nextShopStatus: string;
    if (event.event_type === EVENT_SHOP_STATUS_CHANGED) {
      nextShopStatus = event.payload?.new_status || event.payload?.status || ShopStatus.ACTIVE;
    } else if (event.payload?.status) {
      nextShopStatus = event.payload.status;
    } else if (existing) {
      nextShopStatus = existing.shop_status;
    } else {
      nextShopStatus = ShopStatus.ACTIVE;
    }

    // 5. Compute name and slug
    const newName =
      event.payload?.name !== undefined &&
      event.payload?.name !== null &&
      event.payload.name.trim() !== ''
        ? event.payload.name.trim()
        : existing?.name || `Shop ${shopId.substring(0, 8)}`;

    const newSlug =
      event.payload?.slug !== undefined &&
      event.payload?.slug !== null &&
      event.payload.slug.trim() !== ''
        ? event.payload.slug.trim().toLowerCase()
        : existing?.slug || `shop-${shopId.substring(0, 8)}`;

    const newLogoUrl =
      event.payload?.logo_url !== undefined ? event.payload.logo_url : (existing?.logo_url ?? null);

    // 6. Compute source version
    let nextSourceVersion: bigint;
    if (eventVersion !== undefined && eventVersion !== null) {
      nextSourceVersion = BigInt(eventVersion);
    } else if (existing) {
      nextSourceVersion = existing.source_version + BigInt(1);
    } else {
      nextSourceVersion = BigInt(1);
    }

    // 7. Check if name or slug changed -> emit outbox event for Search reindexing
    const isNameChanged =
      existing && event.payload?.name !== undefined && event.payload.name.trim() !== existing.name;

    const isSlugChanged =
      existing &&
      event.payload?.slug !== undefined &&
      event.payload.slug.trim().toLowerCase() !== existing.slug;

    // 8. Atomic Upsert snapshot and outbox inside transaction
    const snapshotToSave: Partial<ShopSnapshot> = {
      _id: shopId,
      shop_id: shopId,
      name: newName,
      slug: newSlug,
      logo_url: newLogoUrl,
      shop_status: nextShopStatus,
      kyc_status: nextKycStatus,
      source_version: nextSourceVersion,
      source_event_id: event.event_id,
      updated_at: new Date(event.occurred_at || Date.now()),
    };

    const savedSnapshot = await this.transactionRunner.execute(async (session) => {
      if (isNameChanged || isSlugChanged) {
        await this.emitShopSnapshotUpdatedOutboxEvent(
          {
            shopId,
            name: newName,
            slug: newSlug,
            oldName: existing.name,
            oldSlug: existing.slug,
            version: nextSourceVersion,
          },
          session,
        );
      }

      return this.shopSnapshotRepository.upsertSnapshot(snapshotToSave, session);
    });

    return { success: true, snapshot: savedSnapshot };
  }

  private async emitShopSnapshotUpdatedOutboxEvent(
    params: {
      shopId: string;
      name: string;
      slug: string;
      oldName: string;
      oldSlug: string;
      version: bigint;
    },
    session?: ClientSession,
  ): Promise<void> {
    const eventId = uuidv7();
    const outboxRecord: Partial<OutboxEvent> = {
      _id: eventId,
      event_id: eventId,
      aggregate_type: AggregateType.SHOP_PROJECTION,
      aggregate_id: params.shopId,
      event_type: EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED,
      schema_version: 1,
      payload: {
        shop_id: params.shopId,
        name: params.name,
        slug: params.slug,
        old_name: params.oldName,
        old_slug: params.oldSlug,
        updated_at: new Date(),
      },
      occurred_at: new Date(),
      topic: TOPIC_CATALOG_EVENTS,
      version: params.version,
      actor_user_id: null,
      traceparent: null,
    };

    await this.outboxRepository.saveEvent(outboxRecord, session);
    this.logger.log(
      `Emitted ${EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED} to outbox for shop=${params.shopId}`,
    );
  }
}
