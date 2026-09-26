import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { DeadLetterEvent, KafkaEventEnvelope } from './kafka-event.interface';
import { TOPIC_DLQ } from './kafka.constants';

@Injectable()
export class DeadLetterTopicService {
  private readonly logger = new Logger(DeadLetterTopicService.name);
  private readonly dlqEvents: DeadLetterEvent[] = [];

  async sendToDlt<T = unknown>(
    event: KafkaEventEnvelope<T>,
    error: Error,
    attempts: number,
  ): Promise<DeadLetterEvent<T>> {
    const dltRecord: DeadLetterEvent<T> = {
      dlt_id: uuidv7(),
      topic: TOPIC_DLQ,
      original_event: event,
      error_message: error.message || 'Unknown processing error',
      error_stack: error.stack,
      attempts,
      failed_at: new Date(),
    };

    this.dlqEvents.push(dltRecord as DeadLetterEvent);

    this.logger.error(
      `[DLT] Message forwarded to Dead Letter Topic: topic=${TOPIC_DLQ} event_id=${event.event_id} event_type=${event.event_type} attempts=${attempts} error=${error.message}`,
      error.stack,
    );

    return dltRecord;
  }

  getDeadLetterEvents(): DeadLetterEvent[] {
    return [...this.dlqEvents];
  }

  clear(): void {
    this.dlqEvents.length = 0;
  }
}
