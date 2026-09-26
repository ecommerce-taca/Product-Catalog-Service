import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  InventoryProjection,
  InventoryProjectionDocument,
  InventoryStockStatus,
  INVENTORY_SNAPSHOT_STALE_AFTER_SECONDS,
  LOW_STOCK_THRESHOLD,
} from '../../database/schemas/inventory-projection.schema';
import {
  INVENTORY_PROJECTION_REPOSITORY_PORT,
  InventoryProjectionRepositoryPort,
} from '../repositories/inventory-projection.repository.interface';
import { KafkaEventEnvelope } from '../../integrations/kafka/kafka-event.interface';

export interface InventoryStockSnapshotPayload {
  product_id: string;
  sku_id: string;
  available_qty: number;
  reserved_qty?: number;
  committed_qty?: number;
  source_version: number | bigint;
  as_of: string | Date;
}

export interface ProcessInventoryResult {
  success: boolean;
  dropped?: boolean;
  reason?: 'OUT_OF_ORDER' | 'DUPLICATE';
  projection?: InventoryProjectionDocument;
}

@Injectable()
export class InventoryProjectionService {
  private readonly logger = new Logger(InventoryProjectionService.name);

  constructor(
    @Inject(INVENTORY_PROJECTION_REPOSITORY_PORT)
    private readonly inventoryProjectionRepository: InventoryProjectionRepositoryPort,
  ) {}

  async handleStockSnapshotUpdated(
    event: KafkaEventEnvelope<InventoryStockSnapshotPayload>,
  ): Promise<ProcessInventoryResult> {
    const payload = event.payload;

    // 1. Validation
    this.validatePayload(payload);

    const skuId = payload.sku_id;
    const existing = await this.inventoryProjectionRepository.findBySkuId(skuId);

    // 2. Dedupe & Out-of-order check
    if (existing) {
      if (existing.source_event_id === event.event_id) {
        this.logger.log(
          `Dropping duplicate inventory snapshot event ${event.event_id} for sku ${skuId}`,
        );
        return { success: true, dropped: true, reason: 'DUPLICATE' };
      }

      const eventVersion = BigInt(payload.source_version);
      if (eventVersion <= existing.source_version) {
        this.logger.log(
          `Dropping out-of-order inventory snapshot event ${event.event_id} for sku ${skuId}. Event version: ${eventVersion} <= current: ${existing.source_version}`,
        );
        return { success: true, dropped: true, reason: 'OUT_OF_ORDER' };
      }
    }

    // 3. Parse and determine stock_status
    const asOfDate = new Date(payload.as_of);
    const stockStatus = this.determineStockStatus(payload.available_qty, asOfDate);

    // 4. Save projection (Read-only snapshot, never mutate original stock)
    const projectionData: Partial<InventoryProjection> = {
      _id: skuId,
      sku_id: skuId,
      product_id: payload.product_id,
      available_qty_snapshot: BigInt(payload.available_qty),
      reserved_qty_snapshot:
        payload.reserved_qty !== undefined && payload.reserved_qty !== null
          ? BigInt(payload.reserved_qty)
          : null,
      committed_qty_snapshot:
        payload.committed_qty !== undefined && payload.committed_qty !== null
          ? BigInt(payload.committed_qty)
          : null,
      stock_status: stockStatus,
      as_of: asOfDate,
      source_version: BigInt(payload.source_version),
      source_event_id: event.event_id,
      updated_at: new Date(),
    };

    const saved = await this.inventoryProjectionRepository.upsertProjection(projectionData);
    return { success: true, projection: saved };
  }

  determineStockStatus(
    availableQty: number,
    asOf: Date,
    now: Date = new Date(),
  ): InventoryStockStatus {
    if (this.isStale(asOf, now)) {
      return InventoryStockStatus.STALE;
    }
    if (availableQty === 0) {
      return InventoryStockStatus.OUT_OF_STOCK;
    }
    if (availableQty <= LOW_STOCK_THRESHOLD) {
      return InventoryStockStatus.LOW_STOCK;
    }
    return InventoryStockStatus.IN_STOCK;
  }

  isStale(asOf: Date, now: Date = new Date()): boolean {
    const diffSeconds = (now.getTime() - asOf.getTime()) / 1000;
    return diffSeconds > INVENTORY_SNAPSHOT_STALE_AFTER_SECONDS;
  }

  resolveStockStatus(
    projection: InventoryProjectionDocument,
    now: Date = new Date(),
  ): InventoryStockStatus {
    if (this.isStale(projection.as_of, now)) {
      return InventoryStockStatus.STALE;
    }
    const qty = Number(projection.available_qty_snapshot);
    if (qty === 0) {
      return InventoryStockStatus.OUT_OF_STOCK;
    }
    if (qty <= LOW_STOCK_THRESHOLD) {
      return InventoryStockStatus.LOW_STOCK;
    }
    return InventoryStockStatus.IN_STOCK;
  }

  async getProjectionBySkuId(skuId: string): Promise<InventoryProjectionDocument | null> {
    return this.inventoryProjectionRepository.findBySkuId(skuId);
  }

  async getProjectionsByProductId(productId: string): Promise<InventoryProjectionDocument[]> {
    return this.inventoryProjectionRepository.findByProductId(productId);
  }

  private validatePayload(payload: InventoryStockSnapshotPayload): void {
    if (!payload) {
      throw new Error('Inventory snapshot payload is missing');
    }
    if (!payload.sku_id || typeof payload.sku_id !== 'string') {
      throw new Error('sku_id is required and must be a string');
    }
    if (!payload.product_id || typeof payload.product_id !== 'string') {
      throw new Error('product_id is required and must be a string');
    }

    if (
      payload.available_qty === undefined ||
      payload.available_qty === null ||
      !Number.isInteger(payload.available_qty) ||
      payload.available_qty < 0
    ) {
      throw new Error('available_qty must be an integer >= 0');
    }

    if (
      payload.reserved_qty !== undefined &&
      payload.reserved_qty !== null &&
      (!Number.isInteger(payload.reserved_qty) || payload.reserved_qty < 0)
    ) {
      throw new Error('reserved_qty must be an integer >= 0');
    }

    if (
      payload.committed_qty !== undefined &&
      payload.committed_qty !== null &&
      (!Number.isInteger(payload.committed_qty) || payload.committed_qty < 0)
    ) {
      throw new Error('committed_qty must be an integer >= 0');
    }

    if (
      payload.source_version === undefined ||
      payload.source_version === null ||
      (typeof payload.source_version === 'number' &&
        (!Number.isInteger(payload.source_version) || payload.source_version < 0))
    ) {
      throw new Error('source_version must be a non-negative integer');
    }

    if (!payload.as_of || isNaN(new Date(payload.as_of).getTime())) {
      throw new Error('as_of must be a valid date');
    }
  }
}
