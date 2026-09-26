import { Injectable, Logger } from '@nestjs/common';
import { DispatchResult, KafkaEventEnvelope } from './kafka-event.interface';
import { MAX_RETRY_ATTEMPTS, RETRY_BACKOFF_BASE_MS } from './kafka.constants';
import { DeadLetterTopicService } from './dead-letter-topic.service';

export type KafkaEventHandler<T = unknown> = (event: KafkaEventEnvelope<T>) => Promise<unknown>;

@Injectable()
export class KafkaEventDispatcher {
  private readonly logger = new Logger(KafkaEventDispatcher.name);
  private readonly handlers = new Map<string, KafkaEventHandler<unknown>[]>();

  private metrics = {
    totalReceived: 0,
    processed: 0,
    retried: 0,
    dlt: 0,
    unhandled: 0,
  };

  constructor(private readonly deadLetterTopicService: DeadLetterTopicService) {}

  registerHandler<T = unknown>(eventType: string, handler: KafkaEventHandler<T>): void {
    const list = this.handlers.get(eventType) || [];
    list.push(handler as KafkaEventHandler<unknown>);
    this.handlers.set(eventType, list);
    this.logger.log(`Registered handler for event type: ${eventType}`);
  }

  getHandlers(eventType: string): KafkaEventHandler<unknown>[] {
    return this.handlers.get(eventType) || [];
  }

  async dispatch<T = unknown>(event: KafkaEventEnvelope<T>): Promise<DispatchResult> {
    this.metrics.totalReceived++;
    const handlers = this.handlers.get(event.event_type);

    if (!handlers || handlers.length === 0) {
      this.metrics.unhandled++;
      this.logger.debug(
        `No handler registered for event_type=${event.event_type}, skipping event_id=${event.event_id}`,
      );
      return {
        success: true,
        event_id: event.event_id,
        event_type: event.event_type,
        attempts: 0,
        sent_to_dlt: false,
      };
    }

    let lastError: Error | null = null;
    let attempts = 0;

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      attempts = attempt;
      try {
        for (const handler of handlers) {
          await handler(event);
        }
        this.metrics.processed++;
        return {
          success: true,
          event_id: event.event_id,
          event_type: event.event_type,
          attempts,
          sent_to_dlt: false,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.metrics.retried++;
        this.logger.warn(
          `Error processing event_id=${event.event_id} event_type=${event.event_type} on attempt ${attempt}/${MAX_RETRY_ATTEMPTS}: ${lastError.message}`,
        );

        if (attempt < MAX_RETRY_ATTEMPTS) {
          const delay = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted -> Non-blocking forward to Dead Letter Topic (DLT)
    this.metrics.dlt++;
    await this.deadLetterTopicService.sendToDlt(
      event,
      lastError || new Error('Max retries exceeded with unknown error'),
      attempts,
    );

    return {
      success: false,
      event_id: event.event_id,
      event_type: event.event_type,
      attempts,
      sent_to_dlt: true,
      error: lastError?.message,
    };
  }

  getMetrics(): typeof this.metrics {
    return { ...this.metrics };
  }

  resetMetrics(): void {
    this.metrics = {
      totalReceived: 0,
      processed: 0,
      retried: 0,
      dlt: 0,
      unhandled: 0,
    };
  }
}
