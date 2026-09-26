import { Test, TestingModule } from '@nestjs/testing';
import { KafkaEventDispatcher } from '../../src/integrations/kafka/kafka-event-dispatcher.service';
import { DeadLetterTopicService } from '../../src/integrations/kafka/dead-letter-topic.service';
import { ShopProjectionConsumer } from '../../src/projections/consumers/shop-projection.consumer';
import { InventoryProjectionConsumer } from '../../src/projections/consumers/inventory-projection.consumer';
import { RatingSummaryConsumer } from '../../src/projections/consumers/rating-summary.consumer';
import { ShopProjectionService } from '../../src/projections/services/shop-projection.service';
import { InventoryProjectionService } from '../../src/projections/services/inventory-projection.service';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../../src/projections/repositories/shop-snapshot.repository.interface';
import {
  INVENTORY_PROJECTION_REPOSITORY_PORT,
  InventoryProjectionRepositoryPort,
} from '../../src/projections/repositories/inventory-projection.repository.interface';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { ProductRepositoryPort } from '../../src/product/repositories/product.repository.interface';
import { KycStatus, ShopSnapshotDocument } from '../../src/database/schemas/shop-snapshot.schema';
import {
  InventoryProjectionDocument,
  InventoryStockStatus,
} from '../../src/database/schemas/inventory-projection.schema';
import {
  EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
  EVENT_RATING_AGGREGATE_UPDATED,
  EVENT_SHOP_CREATED,
  EVENT_SHOP_KYC_APPROVED,
  EVENT_SHOP_UPDATED,
} from '../../src/integrations/kafka/kafka.constants';
import { KafkaEventEnvelope } from '../../src/integrations/kafka/kafka-event.interface';
import { ProductDocument } from '../../src/database/schemas/product.schema';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('Consumer Idempotency and Ingestion Pipeline', () => {
  let dispatcher: KafkaEventDispatcher;
  let shopRepo: jest.Mocked<ShopSnapshotRepositoryPort>;
  let inventoryRepo: jest.Mocked<InventoryProjectionRepositoryPort>;
  let outboxRepo: jest.Mocked<OutboxRepositoryPort>;
  let productRepo: jest.Mocked<ProductRepositoryPort>;

  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';
  const mockSkuId = '01912f33-7a1b-7c12-9c55-8b1c34a6d923';
  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';

  beforeEach(async () => {
    shopRepo = {
      findByShopId: jest.fn(),
      upsertSnapshot: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    };

    inventoryRepo = {
      findBySkuId: jest.fn(),
      findByProductId: jest.fn(),
      upsertProjection: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    };

    outboxRepo = {
      saveEvent: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn(),
    };

    productRepo = {
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
        DeadLetterTopicService,
        KafkaEventDispatcher,
        ShopProjectionService,
        InventoryProjectionService,
        ShopProjectionConsumer,
        InventoryProjectionConsumer,
        RatingSummaryConsumer,
        {
          provide: SHOP_SNAPSHOT_REPOSITORY_PORT,
          useValue: shopRepo,
        },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: inventoryRepo,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: outboxRepo,
        },
        {
          provide: 'ProductRepositoryPort',
          useValue: productRepo,
        },
        {
          provide: TransactionRunner,
          useValue: {
            execute: jest
              .fn()
              .mockImplementation((fn: (session: any) => Promise<any>) => fn({} as any)),
          },
        },
      ],
    }).compile();

    dispatcher = module.get<KafkaEventDispatcher>(KafkaEventDispatcher);

    // Initialize consumers
    module.get<ShopProjectionConsumer>(ShopProjectionConsumer).onModuleInit();
    module.get<InventoryProjectionConsumer>(InventoryProjectionConsumer).onModuleInit();
    module.get<RatingSummaryConsumer>(RatingSummaryConsumer).onModuleInit();
  });

  describe('Shop Ingestion Pipeline', () => {
    it('should process shop.created -> shop.updated -> shop.kyc.approved sequentially', async () => {
      let currentSnapshot: ShopSnapshotDocument | null = null;
      shopRepo.findByShopId.mockImplementation(() => Promise.resolve(currentSnapshot));
      shopRepo.upsertSnapshot.mockImplementation((snap) => {
        currentSnapshot = {
          ...snap,
          _id: mockShopId,
          shop_id: mockShopId,
        } as unknown as ShopSnapshotDocument;
        return Promise.resolve(currentSnapshot);
      });

      // 1. shop.created (version 1)
      const createEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-s1',
        event_type: EVENT_SHOP_CREATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:00:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Shop Initial',
          slug: 'shop-initial',
          version: 1,
        },
      };

      const res1 = await dispatcher.dispatch(createEvent);
      expect(res1.success).toBe(true);
      expect(currentSnapshot!.name).toBe('Shop Initial');
      expect(currentSnapshot!.kyc_status).toBe(KycStatus.PENDING);
      expect(currentSnapshot!.source_version).toBe(BigInt(1));

      // 2. shop.updated with name change (version 2) -> triggers outbox reindex
      const updateEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-s2',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:10:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Shop Renamed',
          slug: 'shop-initial',
          version: 2,
        },
      };

      const res2 = await dispatcher.dispatch(updateEvent);
      expect(res2.success).toBe(true);
      expect(currentSnapshot!.name).toBe('Shop Renamed');
      expect(currentSnapshot!.source_version).toBe(BigInt(2));
      expect(outboxRepo.saveEvent).toHaveBeenCalled();

      // 3. shop.kyc.approved (unversioned KYC event) -> updates kyc_status to APPROVED
      const kycEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-s3-kyc',
        event_type: EVENT_SHOP_KYC_APPROVED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:20:00Z',
        payload: {
          shop_id: mockShopId,
        },
      };

      const res3 = await dispatcher.dispatch(kycEvent);
      expect(res3.success).toBe(true);
      expect(currentSnapshot!.kyc_status).toBe(KycStatus.APPROVED);

      // 4. Stale event arriving out-of-order (version 1 arriving again after version 2)
      const staleEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-s1-late',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:05:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Should Not Overwrite',
          slug: 'should-not-overwrite',
          version: 1,
        },
      };

      const res4 = await dispatcher.dispatch(staleEvent);
      expect(res4.success).toBe(true);
      // Verify snapshot was NOT overwritten by stale version
      expect(currentSnapshot!.name).toBe('Shop Renamed');
    });
  });

  describe('Inventory Ingestion Pipeline', () => {
    it('should process inventory snapshots and handle out-of-order versions idempotently', async () => {
      let currentProjection: InventoryProjectionDocument | null = null;
      inventoryRepo.findBySkuId.mockImplementation(() => Promise.resolve(currentProjection));
      inventoryRepo.upsertProjection.mockImplementation((proj) => {
        currentProjection = {
          ...proj,
          _id: mockSkuId,
          sku_id: mockSkuId,
        } as unknown as InventoryProjectionDocument;
        return Promise.resolve(currentProjection);
      });

      // 1. Initial snapshot with 12 items -> IN_STOCK (version 1)
      const now = new Date();
      const event1: KafkaEventEnvelope<any> = {
        event_id: 'inv-seq-01',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: now.toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 12,
          source_version: 1,
          as_of: now.toISOString(),
        },
      };

      const res1 = await dispatcher.dispatch(event1);
      expect(res1.success).toBe(true);
      expect(currentProjection!.stock_status).toBe(InventoryStockStatus.IN_STOCK);
      expect(currentProjection!.available_qty_snapshot).toBe(BigInt(12));

      // 2. Updated snapshot with 3 items -> LOW_STOCK (version 2)
      const event2: KafkaEventEnvelope<any> = {
        event_id: 'inv-seq-02',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: now.toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 3,
          source_version: 2,
          as_of: now.toISOString(),
        },
      };

      const res2 = await dispatcher.dispatch(event2);
      expect(res2.success).toBe(true);
      expect(currentProjection!.stock_status).toBe(InventoryStockStatus.LOW_STOCK);
      expect(currentProjection!.available_qty_snapshot).toBe(BigInt(3));

      // 3. Updated snapshot with 0 items -> OUT_OF_STOCK (version 3)
      const event3: KafkaEventEnvelope<any> = {
        event_id: 'inv-seq-03',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: now.toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 0,
          source_version: 3,
          as_of: now.toISOString(),
        },
      };

      const res3 = await dispatcher.dispatch(event3);
      expect(res3.success).toBe(true);
      expect(currentProjection!.stock_status).toBe(InventoryStockStatus.OUT_OF_STOCK);

      // 4. Delayed event arriving with version 2 (out-of-order) -> must be dropped
      const delayedEvent: KafkaEventEnvelope<any> = {
        event_id: 'inv-seq-delayed',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: now.toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 10,
          source_version: 2, // version 2 <= current 3
          as_of: now.toISOString(),
        },
      };

      const resDelayed = await dispatcher.dispatch(delayedEvent);
      expect(resDelayed.success).toBe(true);
      // Projection remains OUT_OF_STOCK with available_qty = 0
      expect(currentProjection!.stock_status).toBe(InventoryStockStatus.OUT_OF_STOCK);
      expect(currentProjection!.available_qty_snapshot).toBe(BigInt(0));
    });
  });

  describe('Rating Summary Pipeline', () => {
    it('should update product rating summary via Kafka dispatcher', async () => {
      productRepo.update.mockResolvedValue({ _id: mockProductId } as ProductDocument);

      const ratingEvent: KafkaEventEnvelope<any> = {
        event_id: 'rating-dispatch-01',
        event_type: EVENT_RATING_AGGREGATE_UPDATED,
        aggregate_type: 'PRODUCT',
        aggregate_id: mockProductId,
        occurred_at: '2026-09-26T10:00:00Z',
        payload: {
          product_id: mockProductId,
          avg: 4.8,
          count: 50,
        },
      };

      const res = await dispatcher.dispatch(ratingEvent);
      expect(res.success).toBe(true);
      expect(productRepo.update).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: mockProductId,
          $or: [
            { rating_summary: null },
            { 'rating_summary.updated_at': null },
            { 'rating_summary.updated_at': { $lte: new Date('2026-09-26T10:00:00Z') } },
          ],
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            rating_summary: {
              avg: 4.8,
              count: 50,
              updated_at: new Date('2026-09-26T10:00:00Z'),
            },
          }),
        }),
      );
    });
  });
});
