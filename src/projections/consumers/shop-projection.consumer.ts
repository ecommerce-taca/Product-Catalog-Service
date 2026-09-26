import { Injectable, OnModuleInit } from '@nestjs/common';
import { KafkaEventDispatcher } from '../../integrations/kafka/kafka-event-dispatcher.service';
import { ShopProjectionService, ShopEventPayload } from '../services/shop-projection.service';
import { KafkaEventEnvelope } from '../../integrations/kafka/kafka-event.interface';
import {
  EVENT_SHOP_CREATED,
  EVENT_SHOP_KYC_APPROVED,
  EVENT_SHOP_KYC_EXPIRED,
  EVENT_SHOP_KYC_NEEDS_INFO,
  EVENT_SHOP_KYC_REJECTED,
  EVENT_SHOP_KYC_SUBMITTED,
  EVENT_SHOP_STATUS_CHANGED,
  EVENT_SHOP_UPDATED,
} from '../../integrations/kafka/kafka.constants';

@Injectable()
export class ShopProjectionConsumer implements OnModuleInit {
  constructor(
    private readonly dispatcher: KafkaEventDispatcher,
    private readonly shopProjectionService: ShopProjectionService,
  ) {}

  onModuleInit(): void {
    const shopEvents = [
      EVENT_SHOP_CREATED,
      EVENT_SHOP_UPDATED,
      EVENT_SHOP_STATUS_CHANGED,
      EVENT_SHOP_KYC_SUBMITTED,
      EVENT_SHOP_KYC_APPROVED,
      EVENT_SHOP_KYC_NEEDS_INFO,
      EVENT_SHOP_KYC_REJECTED,
      EVENT_SHOP_KYC_EXPIRED,
    ];

    for (const eventType of shopEvents) {
      this.dispatcher.registerHandler<ShopEventPayload>(eventType, this.consume.bind(this));
    }
  }

  async consume(event: KafkaEventEnvelope<ShopEventPayload>): Promise<void> {
    await this.shopProjectionService.handleShopEvent(event);
  }
}
