import { Injectable, OnModuleInit } from '@nestjs/common';
import { KafkaEventDispatcher } from '../../integrations/kafka/kafka-event-dispatcher.service';
import {
  InventoryProjectionService,
  InventoryStockSnapshotPayload,
} from '../services/inventory-projection.service';
import { KafkaEventEnvelope } from '../../integrations/kafka/kafka-event.interface';
import { EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED } from '../../integrations/kafka/kafka.constants';

@Injectable()
export class InventoryProjectionConsumer implements OnModuleInit {
  constructor(
    private readonly dispatcher: KafkaEventDispatcher,
    private readonly inventoryProjectionService: InventoryProjectionService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler<InventoryStockSnapshotPayload>(
      EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
      this.consume.bind(this),
    );
  }

  async consume(event: KafkaEventEnvelope<InventoryStockSnapshotPayload>): Promise<void> {
    await this.inventoryProjectionService.handleStockSnapshotUpdated(event);
  }
}
