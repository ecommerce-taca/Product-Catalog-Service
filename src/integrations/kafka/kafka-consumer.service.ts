import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Consumer, EachMessagePayload, Kafka, logLevel } from 'kafkajs';
import { KafkaEventDispatcher } from './kafka-event-dispatcher.service';
import { KafkaEventEnvelope } from './kafka-event.interface';
import { TOPIC_INVENTORY_EVENTS, TOPIC_RATING_EVENTS, TOPIC_SHOP_EVENTS } from './kafka.constants';

/** Topic mà Product Catalog consume để dựng projection (shop snapshot, stock, rating summary). */
export const CONSUMED_TOPICS = [TOPIC_SHOP_EVENTS, TOPIC_INVENTORY_EVENTS, TOPIC_RATING_EVENTS];

/**
 * Đọc event từ Kafka và chuyển cho KafkaEventDispatcher (các projection consumer đã đăng ký handler theo event_type).
 * Retry/DLT do dispatcher đảm nhiệm; message không parse được bị bỏ qua có log để không chặn partition.
 */
@Injectable()
export class KafkaConsumerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumerService.name);
  private consumer?: Consumer;

  constructor(private readonly dispatcher: KafkaEventDispatcher) {}

  async onApplicationBootstrap(): Promise<void> {
    const brokers = (process.env.KAFKA_BROKERS || '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    if (
      !brokers.length ||
      process.env.KAFKA_CONSUMER_ENABLED === 'false' ||
      process.env.NODE_ENV === 'test'
    ) {
      this.logger.log(
        'Kafka consumer disabled (no KAFKA_BROKERS, KAFKA_CONSUMER_ENABLED=false or test env)',
      );
      return;
    }

    const kafka = new Kafka({
      clientId: process.env.KAFKA_CLIENT_ID || 'product-catalog-service',
      brokers,
      logLevel: logLevel.WARN,
    });

    try {
      // Chỉ subscribe topic đang tồn tại: topic của service chưa triển khai không được làm sập catalog
      const admin = kafka.admin();
      await admin.connect();
      const existing = new Set(await admin.listTopics());
      await admin.disconnect();
      const topics = CONSUMED_TOPICS.filter((t) => existing.has(t));
      const missing = CONSUMED_TOPICS.filter((t) => !existing.has(t));
      if (missing.length) {
        this.logger.warn(`Kafka topics not found, skipped: ${missing.join(', ')}`);
      }
      if (!topics.length) {
        return;
      }

      this.consumer = kafka.consumer({
        groupId: process.env.KAFKA_GROUP_ID || 'product-catalog-service',
      });
      await this.consumer.connect();
      // Group mới đọc từ đầu để dựng lại projection; group đã có offset tiếp tục từ offset đã commit
      await this.consumer.subscribe({ topics, fromBeginning: true });
      await this.consumer.run({ eachMessage: (payload) => this.handleMessage(payload) });
      this.logger.log(`Kafka consumer started: ${topics.join(', ')}`);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Kafka consumer failed to start: ${msg}`);
    }
  }

  async handleMessage({ topic, partition, message }: EachMessagePayload): Promise<void> {
    const raw = message.value?.toString();
    if (!raw) {
      return;
    }
    let event: KafkaEventEnvelope;
    try {
      event = JSON.parse(raw) as KafkaEventEnvelope;
    } catch {
      this.logger.warn(
        `Skip non-JSON message topic=${topic} partition=${partition} offset=${message.offset}`,
      );
      return;
    }
    if (!event?.event_id || !event?.event_type) {
      this.logger.warn(
        `Skip message without event_id/event_type topic=${topic} offset=${message.offset}`,
      );
      return;
    }
    await this.dispatcher.dispatch(event);
  }

  async onModuleDestroy(): Promise<void> {
    await this.consumer?.disconnect();
  }
}
