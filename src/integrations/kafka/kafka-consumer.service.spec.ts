import { EachMessagePayload } from 'kafkajs';
import { KafkaConsumerService, CONSUMED_TOPICS } from './kafka-consumer.service';
import { KafkaEventDispatcher } from './kafka-event-dispatcher.service';

describe('KafkaConsumerService', () => {
  let dispatch: jest.Mock;
  let service: KafkaConsumerService;

  const message = (value: string | null): EachMessagePayload =>
    ({
      topic: 'shop.events.v1',
      partition: 0,
      message: { value: value === null ? null : Buffer.from(value), offset: '7' },
    }) as unknown as EachMessagePayload;

  beforeEach(() => {
    dispatch = jest.fn().mockResolvedValue({ success: true });
    service = new KafkaConsumerService({ dispatch } as unknown as KafkaEventDispatcher);
  });

  it('consumes shop events from shop.events.v1 (Auth User contract)', () => {
    expect(CONSUMED_TOPICS).toContain('shop.events.v1');
  });

  it('dispatches a valid event envelope', async () => {
    const envelope = {
      event_id: 'e-1',
      event_type: 'shop.kyc.approved',
      occurred_at: '2026-10-19T15:46:00Z',
      aggregate_type: 'SHOP',
      aggregate_id: 'shop-1',
      payload: { shop_id: 'shop-1' },
    };
    await service.handleMessage(message(JSON.stringify(envelope)));
    expect(dispatch).toHaveBeenCalledWith(envelope);
  });

  it('skips non-JSON, empty and incomplete messages without throwing', async () => {
    await service.handleMessage(message('not json'));
    await service.handleMessage(message(null));
    await service.handleMessage(message(JSON.stringify({ event_type: 'shop.created' })));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not start a consumer in test env', async () => {
    process.env.KAFKA_BROKERS = 'localhost:9092';
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    delete process.env.KAFKA_BROKERS;
  });
});
