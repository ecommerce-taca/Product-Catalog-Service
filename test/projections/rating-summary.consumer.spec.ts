import { Test, TestingModule } from '@nestjs/testing';
import { RatingSummaryConsumer } from '../../src/projections/consumers/rating-summary.consumer';
import { KafkaEventDispatcher } from '../../src/integrations/kafka/kafka-event-dispatcher.service';
import { ProductRepositoryPort } from '../../src/product/repositories/product.repository.interface';
import { EVENT_RATING_AGGREGATE_UPDATED } from '../../src/integrations/kafka/kafka.constants';
import { KafkaEventEnvelope } from '../../src/integrations/kafka/kafka-event.interface';
import { ProductDocument } from '../../src/database/schemas/product.schema';

describe('RatingSummaryConsumer', () => {
  let consumer: RatingSummaryConsumer;
  let mockDispatcher: jest.Mocked<KafkaEventDispatcher>;
  let mockProductRepo: jest.Mocked<ProductRepositoryPort>;

  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';

  beforeEach(async () => {
    mockDispatcher = {
      registerHandler: jest.fn(),
      getHandlers: jest.fn(),
      dispatch: jest.fn(),
      getMetrics: jest.fn(),
      resetMetrics: jest.fn(),
    } as unknown as jest.Mocked<KafkaEventDispatcher>;

    mockProductRepo = {
      update: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
      findByShopAndSlug: jest.fn(),
      findByShopAndId: jest.fn(),
      findSellerProducts: jest.fn(),
      atomicCasUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RatingSummaryConsumer,
        {
          provide: KafkaEventDispatcher,
          useValue: mockDispatcher,
        },
        {
          provide: 'ProductRepositoryPort',
          useValue: mockProductRepo,
        },
      ],
    }).compile();

    consumer = module.get<RatingSummaryConsumer>(RatingSummaryConsumer);
  });

  it('should register handler for rating.aggregate.updated on init', () => {
    consumer.onModuleInit();
    expect(mockDispatcher.registerHandler).toHaveBeenCalledWith(
      EVENT_RATING_AGGREGATE_UPDATED,
      expect.any(Function),
    );
  });

  it('should update product rating_summary when valid rating event arrives', async () => {
    mockProductRepo.update.mockResolvedValue({ _id: mockProductId } as ProductDocument);

    const event: KafkaEventEnvelope<any> = {
      event_id: 'rating-evt-01',
      event_type: EVENT_RATING_AGGREGATE_UPDATED,
      aggregate_type: 'PRODUCT',
      aggregate_id: mockProductId,
      occurred_at: '2026-09-26T10:00:00Z',
      payload: {
        product_id: mockProductId,
        avg: 4.67,
        count: 24,
      },
    };

    await consumer.consume(event);

    const eventTime = new Date('2026-09-26T10:00:00Z');
    expect(mockProductRepo.update).toHaveBeenCalledWith(
      {
        _id: mockProductId,
        $or: [
          { rating_summary: null },
          { 'rating_summary.updated_at': null },
          { 'rating_summary.updated_at': { $lte: eventTime } },
        ],
      },
      {
        $set: {
          rating_summary: {
            avg: 4.7, // Rounded to 1 decimal place
            count: 24,
            updated_at: eventTime,
          },
        },
      },
    );
  });

  it('should set avg to null if count is 0', async () => {
    mockProductRepo.update.mockResolvedValue({ _id: mockProductId } as ProductDocument);

    const event: KafkaEventEnvelope<any> = {
      event_id: 'rating-evt-02',
      event_type: EVENT_RATING_AGGREGATE_UPDATED,
      aggregate_type: 'PRODUCT',
      aggregate_id: mockProductId,
      occurred_at: '2026-09-26T10:00:00Z',
      payload: {
        product_id: mockProductId,
        avg: null,
        count: 0,
      },
    };

    await consumer.consume(event);

    const eventTime = new Date('2026-09-26T10:00:00Z');
    expect(mockProductRepo.update).toHaveBeenCalledWith(
      {
        _id: mockProductId,
        $or: [
          { rating_summary: null },
          { 'rating_summary.updated_at': null },
          { 'rating_summary.updated_at': { $lte: eventTime } },
        ],
      },
      {
        $set: {
          rating_summary: {
            avg: null,
            count: 0,
            updated_at: eventTime,
          },
        },
      },
    );
  });

  it('should ignore out-of-order rating events when updated_at condition is not met [SF-01]', async () => {
    // When $or condition fails in MongoDB, update returns null
    mockProductRepo.update.mockResolvedValue(null);

    const staleEvent: KafkaEventEnvelope<any> = {
      event_id: 'rating-evt-stale',
      event_type: EVENT_RATING_AGGREGATE_UPDATED,
      aggregate_type: 'PRODUCT',
      aggregate_id: mockProductId,
      occurred_at: '2026-09-25T10:00:00Z', // older timestamp
      payload: {
        product_id: mockProductId,
        avg: 3.5,
        count: 10,
      },
    };

    await expect(consumer.consume(staleEvent)).resolves.not.toThrow();

    const eventTime = new Date('2026-09-25T10:00:00Z');
    expect(mockProductRepo.update).toHaveBeenCalledWith(
      {
        _id: mockProductId,
        $or: [
          { rating_summary: null },
          { 'rating_summary.updated_at': null },
          { 'rating_summary.updated_at': { $lte: eventTime } },
        ],
      },
      {
        $set: {
          rating_summary: {
            avg: 3.5,
            count: 10,
            updated_at: eventTime,
          },
        },
      },
    );
  });

  it('should gracefully handle if product does not exist in collection', async () => {
    mockProductRepo.update.mockResolvedValue(null);

    const event: KafkaEventEnvelope<any> = {
      event_id: 'rating-evt-03',
      event_type: EVENT_RATING_AGGREGATE_UPDATED,
      aggregate_type: 'PRODUCT',
      aggregate_id: 'non-existent-product',
      occurred_at: '2026-09-26T10:00:00Z',
      payload: {
        product_id: 'non-existent-product',
        avg: 5.0,
        count: 1,
      },
    };

    // Should not throw error
    await expect(consumer.consume(event)).resolves.not.toThrow();
  });

  it('should throw error if product_id is missing', async () => {
    const event: KafkaEventEnvelope<any> = {
      event_id: 'rating-evt-04',
      event_type: EVENT_RATING_AGGREGATE_UPDATED,
      aggregate_type: 'PRODUCT',
      aggregate_id: '',
      occurred_at: '2026-09-26T10:00:00Z',
      payload: {},
    };

    await expect(consumer.consume(event)).rejects.toThrow('missing product_id');
  });
});
