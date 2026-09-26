import { Test, TestingModule } from '@nestjs/testing';
import { KafkaEventDispatcher } from '../../src/integrations/kafka/kafka-event-dispatcher.service';
import { DeadLetterTopicService } from '../../src/integrations/kafka/dead-letter-topic.service';
import { KafkaEventEnvelope } from '../../src/integrations/kafka/kafka-event.interface';

describe('KafkaEventDispatcher', () => {
  let dispatcher: KafkaEventDispatcher;
  let dltService: DeadLetterTopicService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeadLetterTopicService, KafkaEventDispatcher],
    }).compile();

    dispatcher = module.get<KafkaEventDispatcher>(KafkaEventDispatcher);
    dltService = module.get<DeadLetterTopicService>(DeadLetterTopicService);
  });

  afterEach(() => {
    dltService.clear();
    dispatcher.resetMetrics();
  });

  it('should successfully dispatch event to registered handler', async () => {
    const handlerMock = jest.fn().mockResolvedValue(undefined);
    dispatcher.registerHandler('test.event.v1', handlerMock);

    const event: KafkaEventEnvelope<any> = {
      event_id: 'evt-001',
      event_type: 'test.event.v1',
      aggregate_type: 'TEST',
      aggregate_id: 'test-123',
      occurred_at: new Date().toISOString(),
      payload: { hello: 'world' },
    };

    const result = await dispatcher.dispatch(event);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.sent_to_dlt).toBe(false);
    expect(handlerMock).toHaveBeenCalledWith(event);

    const metrics = dispatcher.getMetrics();
    expect(metrics.totalReceived).toBe(1);
    expect(metrics.processed).toBe(1);
    expect(metrics.retried).toBe(0);
    expect(metrics.dlt).toBe(0);
  });

  it('should retry on transient failures and succeed if a retry succeeds', async () => {
    let callCount = 0;
    const handlerMock = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.reject(new Error(`Temporary database connection glitch ${callCount}`));
      }
      return Promise.resolve();
    });

    dispatcher.registerHandler('test.event.retry', handlerMock);

    const event: KafkaEventEnvelope<any> = {
      event_id: 'evt-002',
      event_type: 'test.event.retry',
      aggregate_type: 'TEST',
      aggregate_id: 'test-retry',
      occurred_at: new Date().toISOString(),
      payload: {},
    };

    const result = await dispatcher.dispatch(event);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(result.sent_to_dlt).toBe(false);
    expect(handlerMock).toHaveBeenCalledTimes(3);

    const metrics = dispatcher.getMetrics();
    expect(metrics.totalReceived).toBe(1);
    expect(metrics.processed).toBe(1);
    expect(metrics.retried).toBe(2);
    expect(metrics.dlt).toBe(0);
  });

  it('should forward to Dead Letter Topic (DLT) after 3 failed retries without blocking partition', async () => {
    const handlerMock = jest.fn().mockRejectedValue(new Error('Fatal unrecoverable error'));
    dispatcher.registerHandler('test.event.fatal', handlerMock);

    const event: KafkaEventEnvelope<any> = {
      event_id: 'evt-003',
      event_type: 'test.event.fatal',
      aggregate_type: 'TEST',
      aggregate_id: 'test-fatal',
      occurred_at: new Date().toISOString(),
      payload: { bad: 'data' },
    };

    // Non-blocking: should NOT throw an error!
    const result = await dispatcher.dispatch(event);

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.sent_to_dlt).toBe(true);
    expect(result.error).toBe('Fatal unrecoverable error');

    // Verify DLT service recorded the message
    const dlqMessages = dltService.getDeadLetterEvents();
    expect(dlqMessages).toHaveLength(1);
    expect(dlqMessages[0].original_event.event_id).toBe('evt-003');
    expect(dlqMessages[0].attempts).toBe(3);
    expect(dlqMessages[0].error_message).toBe('Fatal unrecoverable error');

    const metrics = dispatcher.getMetrics();
    expect(metrics.totalReceived).toBe(1);
    expect(metrics.processed).toBe(0);
    expect(metrics.retried).toBe(3);
    expect(metrics.dlt).toBe(1);
  });

  it('should gracefully handle event when no handler is registered', async () => {
    const event: KafkaEventEnvelope<any> = {
      event_id: 'evt-unhandled',
      event_type: 'unknown.event.type',
      aggregate_type: 'TEST',
      aggregate_id: 'test-unhandled',
      occurred_at: new Date().toISOString(),
      payload: {},
    };

    const result = await dispatcher.dispatch(event);

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(0);
    expect(result.sent_to_dlt).toBe(false);

    const metrics = dispatcher.getMetrics();
    expect(metrics.unhandled).toBe(1);
  });
});
