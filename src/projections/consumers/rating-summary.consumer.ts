import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KafkaEventDispatcher } from '../../integrations/kafka/kafka-event-dispatcher.service';
import { KafkaEventEnvelope } from '../../integrations/kafka/kafka-event.interface';
import { EVENT_RATING_AGGREGATE_UPDATED } from '../../integrations/kafka/kafka.constants';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';

export interface RatingAggregatePayload {
  product_id: string;
  avg: number | null;
  count: number;
  distribution?: Record<string, number>;
}

@Injectable()
export class RatingSummaryConsumer implements OnModuleInit {
  private readonly logger = new Logger(RatingSummaryConsumer.name);

  constructor(
    private readonly dispatcher: KafkaEventDispatcher,
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerHandler<RatingAggregatePayload>(
      EVENT_RATING_AGGREGATE_UPDATED,
      this.consume.bind(this),
    );
  }

  async consume(event: KafkaEventEnvelope<RatingAggregatePayload>): Promise<void> {
    const payload = event.payload;
    const productId = payload?.product_id || event.aggregate_id;

    if (!productId) {
      throw new Error(`Rating aggregate event ${event.event_id} missing product_id`);
    }

    const count =
      typeof payload?.count === 'number' && payload.count >= 0 ? Math.floor(payload.count) : 0;

    let avg: number | null = null;
    if (count > 0 && typeof payload?.avg === 'number' && !isNaN(payload.avg)) {
      avg = Math.max(0, Math.min(5, Math.round(payload.avg * 10) / 10));
    }

    const eventTime = new Date(event.occurred_at || Date.now());
    const ratingSummary = {
      avg,
      count,
      updated_at: eventTime,
    };

    const updated = await this.productRepository.update(
      {
        _id: productId,
        $or: [
          { rating_summary: null },
          { 'rating_summary.updated_at': null },
          { 'rating_summary.updated_at': { $lte: eventTime } },
        ],
      },
      {
        $set: {
          rating_summary: ratingSummary,
        },
      },
    );

    if (!updated) {
      this.logger.warn(
        `Product ${productId} not found or stale rating_summary event from event ${event.event_id}`,
      );
    } else {
      this.logger.log(
        `Updated rating_summary for product ${productId}: avg=${avg}, count=${count}`,
      );
    }
  }
}
