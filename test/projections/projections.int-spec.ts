import { Test, TestingModule } from '@nestjs/testing';
import { KafkaEventDispatcher } from '../../src/integrations/kafka/kafka-event-dispatcher.service';
import { DeadLetterTopicService } from '../../src/integrations/kafka/dead-letter-topic.service';
import { ShopProjectionService } from '../../src/projections/services/shop-projection.service';
import { InventoryProjectionService } from '../../src/projections/services/inventory-projection.service';
import { ShopProjectionConsumer } from '../../src/projections/consumers/shop-projection.consumer';
import { InventoryProjectionConsumer } from '../../src/projections/consumers/inventory-projection.consumer';
import { RatingSummaryConsumer } from '../../src/projections/consumers/rating-summary.consumer';
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
import {
  KycStatus,
  ShopSnapshot,
  ShopSnapshotDocument,
  ShopStatus,
} from '../../src/database/schemas/shop-snapshot.schema';
import {
  InventoryProjection,
  InventoryProjectionDocument,
  InventoryStockStatus,
} from '../../src/database/schemas/inventory-projection.schema';
import {
  EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
  EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED,
  EVENT_RATING_AGGREGATE_UPDATED,
  EVENT_SHOP_CREATED,
  EVENT_SHOP_KYC_APPROVED,
  EVENT_SHOP_STATUS_CHANGED,
  EVENT_SHOP_UPDATED,
  TOPIC_DLQ,
} from '../../src/integrations/kafka/kafka.constants';
import { KafkaEventEnvelope } from '../../src/integrations/kafka/kafka-event.interface';
import { ProductDocument } from '../../src/database/schemas/product.schema';
import { OutboxEvent } from '../../src/database/schemas/outbox-event.schema';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('Projections Integration Suite (PC-INT-008 & Projections E2E)', () => {
  let moduleRef: TestingModule;
  let dispatcher: KafkaEventDispatcher;
  let dltService: DeadLetterTopicService;

  // In-memory state store to emulate MongoDB
  const shopStore = new Map<string, ShopSnapshotDocument>();
  const inventoryStore = new Map<string, InventoryProjectionDocument>();
  const productStore = new Map<string, ProductDocument>();
  const outboxStore: Partial<OutboxEvent>[] = [];

  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';
  const mockSkuId = '01912f33-7a1b-7c12-9c55-8b1c34a6d923';
  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';

  beforeAll(async () => {
    const mockShopRepo: Partial<ShopSnapshotRepositoryPort> = {
      findByShopId: jest.fn().mockImplementation((id: string) => {
        return Promise.resolve(shopStore.get(id) || null);
      }),
      upsertSnapshot: jest.fn().mockImplementation((snap: Partial<ShopSnapshot>) => {
        const id = snap.shop_id || snap._id!;
        const existing = shopStore.get(id);
        const merged = {
          ...existing,
          ...snap,
          _id: id,
          shop_id: id,
        } as unknown as ShopSnapshotDocument;
        shopStore.set(id, merged);
        return Promise.resolve(merged);
      }),
    };

    const mockInventoryRepo: Partial<InventoryProjectionRepositoryPort> = {
      findBySkuId: jest.fn().mockImplementation((skuId: string) => {
        return Promise.resolve(inventoryStore.get(skuId) || null);
      }),
      findByProductId: jest.fn().mockImplementation((prodId: string) => {
        const list = Array.from(inventoryStore.values()).filter((p) => p.product_id === prodId);
        return Promise.resolve(list);
      }),
      upsertProjection: jest.fn().mockImplementation((proj: Partial<InventoryProjection>) => {
        const id = proj.sku_id || proj._id!;
        const existing = inventoryStore.get(id);
        const merged = {
          ...existing,
          ...proj,
          _id: id,
          sku_id: id,
        } as unknown as InventoryProjectionDocument;
        inventoryStore.set(id, merged);
        return Promise.resolve(merged);
      }),
    };

    const mockOutboxRepo: Partial<OutboxRepositoryPort> = {
      saveEvent: jest.fn().mockImplementation((event: Partial<OutboxEvent>) => {
        outboxStore.push(event);
        return Promise.resolve(event as any);
      }),
    };

    const mockProductRepo: Partial<ProductRepositoryPort> = {
      update: jest.fn().mockImplementation((filter: { _id: string }, updateQuery: any) => {
        const prod = productStore.get(filter._id);
        if (!prod) return Promise.resolve(null);
        if (updateQuery.$set?.rating_summary) {
          prod.rating_summary = updateQuery.$set.rating_summary;
        }
        return Promise.resolve(prod);
      }),
    };

    moduleRef = await Test.createTestingModule({
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
          useValue: mockShopRepo,
        },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: mockInventoryRepo,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: mockOutboxRepo,
        },
        {
          provide: 'ProductRepositoryPort',
          useValue: mockProductRepo,
        },
        {
          provide: TransactionRunner,
          useValue: {
            execute: jest
              .fn()
              .mockImplementation((fn: (session: any) => Promise<any>) =>
                fn({ id: 'mock-session' }),
              ),
          },
        },
      ],
    }).compile();

    dispatcher = moduleRef.get<KafkaEventDispatcher>(KafkaEventDispatcher);
    dltService = moduleRef.get<DeadLetterTopicService>(DeadLetterTopicService);

    // Boot consumers
    moduleRef.get<ShopProjectionConsumer>(ShopProjectionConsumer).onModuleInit();
    moduleRef.get<InventoryProjectionConsumer>(InventoryProjectionConsumer).onModuleInit();
    moduleRef.get<RatingSummaryConsumer>(RatingSummaryConsumer).onModuleInit();
  });

  beforeEach(() => {
    shopStore.clear();
    inventoryStore.clear();
    productStore.clear();
    outboxStore.length = 0;
    dltService.clear();

    productStore.set(mockProductId, {
      _id: mockProductId,
      shop_id: mockShopId,
      title: 'Taca Test Product',
      slug: 'taca-test-product',
      rating_summary: null,
    } as unknown as ProductDocument);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('should compile and wire all projection components', () => {
    expect(moduleRef.get(ShopProjectionService)).toBeDefined();
    expect(moduleRef.get(InventoryProjectionService)).toBeDefined();
    expect(moduleRef.get(ShopProjectionConsumer)).toBeDefined();
    expect(moduleRef.get(InventoryProjectionConsumer)).toBeDefined();
    expect(moduleRef.get(RatingSummaryConsumer)).toBeDefined();
  });

  it('should execute end-to-end shop projection lifecycle with KYC and Outbox Search reindexing', async () => {
    // 1. shop.created
    await dispatcher.dispatch({
      event_id: 'e2e-shop-1',
      event_type: EVENT_SHOP_CREATED,
      aggregate_type: 'SHOP',
      aggregate_id: mockShopId,
      occurred_at: '2026-09-26T08:00:00Z',
      payload: {
        shop_id: mockShopId,
        name: 'Alpha Electronics',
        slug: 'alpha-electronics',
        status: 'ACTIVE',
        version: 1,
      },
    });

    const s1 = shopStore.get(mockShopId);
    expect(s1).toBeDefined();
    expect(s1!.name).toBe('Alpha Electronics');
    expect(s1!.kyc_status).toBe(KycStatus.PENDING);
    expect(outboxStore).toHaveLength(0);

    // 2. shop.updated with name change -> triggers outbox
    await dispatcher.dispatch({
      event_id: 'e2e-shop-2',
      event_type: EVENT_SHOP_UPDATED,
      aggregate_type: 'SHOP',
      aggregate_id: mockShopId,
      occurred_at: '2026-09-26T08:05:00Z',
      payload: {
        shop_id: mockShopId,
        name: 'Alpha Superstore',
        version: 2,
      },
    });

    const s2 = shopStore.get(mockShopId);
    expect(s2!.name).toBe('Alpha Superstore');
    expect(outboxStore).toHaveLength(1);
    expect(outboxStore[0].event_type).toBe(EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED);
    expect(outboxStore[0].payload).toMatchObject({
      name: 'Alpha Superstore',
      old_name: 'Alpha Electronics',
    });

    // 3. shop.kyc.approved -> status APPROVED
    await dispatcher.dispatch({
      event_id: 'e2e-shop-3',
      event_type: EVENT_SHOP_KYC_APPROVED,
      aggregate_type: 'SHOP',
      aggregate_id: mockShopId,
      occurred_at: '2026-09-26T08:10:00Z',
      payload: {
        shop_id: mockShopId,
      },
    });

    const s3 = shopStore.get(mockShopId);
    expect(s3!.kyc_status).toBe(KycStatus.APPROVED);

    // 4. shop.status_changed -> SUSPENDED
    await dispatcher.dispatch({
      event_id: 'e2e-shop-4',
      event_type: EVENT_SHOP_STATUS_CHANGED,
      aggregate_type: 'SHOP',
      aggregate_id: mockShopId,
      occurred_at: '2026-09-26T08:15:00Z',
      payload: {
        shop_id: mockShopId,
        new_status: 'SUSPENDED',
        version: 4,
      },
    });

    const s4 = shopStore.get(mockShopId);
    expect(s4!.shop_status).toBe(ShopStatus.SUSPENDED);
  });

  it('should execute end-to-end inventory stock projection with stock status transitions', async () => {
    const now = new Date();

    // 1. Initial stock = 20 -> IN_STOCK
    await dispatcher.dispatch({
      event_id: 'e2e-inv-1',
      event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
      aggregate_type: 'SKU',
      aggregate_id: mockSkuId,
      occurred_at: now.toISOString(),
      payload: {
        product_id: mockProductId,
        sku_id: mockSkuId,
        available_qty: 20,
        reserved_qty: 1,
        source_version: 1,
        as_of: now.toISOString(),
      },
    });

    expect(inventoryStore.get(mockSkuId)!.stock_status).toBe(InventoryStockStatus.IN_STOCK);

    // 2. Decreased stock = 4 -> LOW_STOCK (<= 5)
    await dispatcher.dispatch({
      event_id: 'e2e-inv-2',
      event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
      aggregate_type: 'SKU',
      aggregate_id: mockSkuId,
      occurred_at: now.toISOString(),
      payload: {
        product_id: mockProductId,
        sku_id: mockSkuId,
        available_qty: 4,
        source_version: 2,
        as_of: now.toISOString(),
      },
    });

    expect(inventoryStore.get(mockSkuId)!.stock_status).toBe(InventoryStockStatus.LOW_STOCK);

    // 3. Out of stock = 0 -> OUT_OF_STOCK
    await dispatcher.dispatch({
      event_id: 'e2e-inv-3',
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
    });

    expect(inventoryStore.get(mockSkuId)!.stock_status).toBe(InventoryStockStatus.OUT_OF_STOCK);

    // 4. Duplicate event_id replay -> dropped, state unchanged
    await dispatcher.dispatch({
      event_id: 'e2e-inv-3',
      event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
      aggregate_type: 'SKU',
      aggregate_id: mockSkuId,
      occurred_at: now.toISOString(),
      payload: {
        product_id: mockProductId,
        sku_id: mockSkuId,
        available_qty: 100, // Should be ignored
        source_version: 3,
        as_of: now.toISOString(),
      },
    });

    expect(inventoryStore.get(mockSkuId)!.stock_status).toBe(InventoryStockStatus.OUT_OF_STOCK);
  });

  it('should forward unrecoverable schema/parsing errors to Dead Letter Topic (DLT) non-blockingly', async () => {
    const invalidEvent: KafkaEventEnvelope<any> = {
      event_id: 'e2e-invalid-inv',
      event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
      aggregate_type: 'SKU',
      aggregate_id: mockSkuId,
      occurred_at: new Date().toISOString(),
      payload: {
        product_id: mockProductId,
        sku_id: mockSkuId,
        available_qty: -999, // Unrecoverable invalid negative quantity
        source_version: 1,
        as_of: new Date().toISOString(),
      },
    };

    const res = await dispatcher.dispatch(invalidEvent);

    expect(res.success).toBe(false);
    expect(res.sent_to_dlt).toBe(true);
    expect(res.attempts).toBe(3);

    const dltEvents = dltService.getDeadLetterEvents();
    expect(dltEvents).toHaveLength(1);
    expect(dltEvents[0].topic).toBe(TOPIC_DLQ);
    expect(dltEvents[0].original_event.event_id).toBe('e2e-invalid-inv');
    expect(dltEvents[0].error_message).toContain('available_qty must be an integer >= 0');
  });

  it('should update product rating summary via RatingSummaryConsumer', async () => {
    const ratingEvent: KafkaEventEnvelope<any> = {
      event_id: 'e2e-rating-1',
      event_type: EVENT_RATING_AGGREGATE_UPDATED,
      aggregate_type: 'PRODUCT',
      aggregate_id: mockProductId,
      occurred_at: '2026-09-26T11:00:00Z',
      payload: {
        product_id: mockProductId,
        avg: 4.88,
        count: 120,
      },
    };

    const res = await dispatcher.dispatch(ratingEvent);
    expect(res.success).toBe(true);

    const prod = productStore.get(mockProductId);
    expect(prod!.rating_summary).toEqual({
      avg: 4.9,
      count: 120,
      updated_at: new Date('2026-09-26T11:00:00Z'),
    });
  });
});
