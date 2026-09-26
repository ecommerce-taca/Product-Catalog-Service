import { Test, TestingModule } from '@nestjs/testing';
import { InventoryProjectionService } from '../../src/projections/services/inventory-projection.service';
import {
  INVENTORY_PROJECTION_REPOSITORY_PORT,
  InventoryProjectionRepositoryPort,
} from '../../src/projections/repositories/inventory-projection.repository.interface';
import {
  InventoryProjectionDocument,
  InventoryStockStatus,
} from '../../src/database/schemas/inventory-projection.schema';
import { KafkaEventEnvelope } from '../../src/integrations/kafka/kafka-event.interface';
import { EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED } from '../../src/integrations/kafka/kafka.constants';

describe('InventoryProjectionService', () => {
  let service: InventoryProjectionService;
  let mockInventoryRepo: jest.Mocked<InventoryProjectionRepositoryPort>;

  const mockSkuId = '01912f33-7a1b-7c12-9c55-8b1c34a6d923';
  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';

  const createMockProjectionDoc = (
    overrides?: Partial<InventoryProjectionDocument>,
  ): InventoryProjectionDocument => {
    return {
      _id: mockSkuId,
      sku_id: mockSkuId,
      product_id: mockProductId,
      available_qty_snapshot: BigInt(10),
      reserved_qty_snapshot: BigInt(2),
      committed_qty_snapshot: BigInt(1),
      stock_status: InventoryStockStatus.IN_STOCK,
      as_of: new Date('2026-09-26T09:00:00Z'),
      source_version: BigInt(10),
      source_event_id: 'inv-evt-original',
      updated_at: new Date('2026-09-26T09:00:01Z'),
      ...overrides,
    } as unknown as InventoryProjectionDocument;
  };

  beforeEach(async () => {
    mockInventoryRepo = {
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryProjectionService,
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: mockInventoryRepo,
        },
      ],
    }).compile();

    service = module.get<InventoryProjectionService>(InventoryProjectionService);
  });

  describe('handleStockSnapshotUpdated', () => {
    it('should consume valid event and upsert read-only projection with IN_STOCK status', async () => {
      mockInventoryRepo.findBySkuId.mockResolvedValue(null);
      mockInventoryRepo.upsertProjection.mockImplementation((proj) =>
        Promise.resolve(proj as InventoryProjectionDocument),
      );

      const now = new Date();
      const event: KafkaEventEnvelope<any> = {
        event_id: 'inv-evt-01',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: now.toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 15,
          reserved_qty: 3,
          committed_qty: 2,
          source_version: 1,
          as_of: now.toISOString(),
        },
      };

      const result = await service.handleStockSnapshotUpdated(event);

      expect(result.success).toBe(true);
      expect(mockInventoryRepo.upsertProjection).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: mockSkuId,
          sku_id: mockSkuId,
          product_id: mockProductId,
          available_qty_snapshot: BigInt(15),
          reserved_qty_snapshot: BigInt(3),
          committed_qty_snapshot: BigInt(2),
          stock_status: InventoryStockStatus.IN_STOCK,
          source_version: BigInt(1),
          source_event_id: 'inv-evt-01',
        }),
      );
    });

    it('should map available_qty = 0 to OUT_OF_STOCK', async () => {
      mockInventoryRepo.findBySkuId.mockResolvedValue(null);
      mockInventoryRepo.upsertProjection.mockImplementation((proj) =>
        Promise.resolve(proj as InventoryProjectionDocument),
      );

      const now = new Date();
      const event: KafkaEventEnvelope<any> = {
        event_id: 'inv-evt-02',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: now.toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 0,
          source_version: 2,
          as_of: now.toISOString(),
        },
      };

      const result = await service.handleStockSnapshotUpdated(event);

      expect(result.success).toBe(true);
      expect(mockInventoryRepo.upsertProjection).toHaveBeenCalledWith(
        expect.objectContaining({
          stock_status: InventoryStockStatus.OUT_OF_STOCK,
        }),
      );
    });

    it('should map available_qty between 1 and 5 to LOW_STOCK', async () => {
      mockInventoryRepo.findBySkuId.mockResolvedValue(null);
      mockInventoryRepo.upsertProjection.mockImplementation((proj) =>
        Promise.resolve(proj as InventoryProjectionDocument),
      );

      const now = new Date();
      for (const qty of [1, 3, 5]) {
        const event: KafkaEventEnvelope<any> = {
          event_id: `inv-evt-low-${qty}`,
          event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
          aggregate_type: 'SKU',
          aggregate_id: mockSkuId,
          occurred_at: now.toISOString(),
          payload: {
            product_id: mockProductId,
            sku_id: mockSkuId,
            available_qty: qty,
            source_version: 1,
            as_of: now.toISOString(),
          },
        };

        await service.handleStockSnapshotUpdated(event);
        expect(mockInventoryRepo.upsertProjection).toHaveBeenCalledWith(
          expect.objectContaining({
            stock_status: InventoryStockStatus.LOW_STOCK,
          }),
        );
      }
    });

    it('should map status to STALE if snapshot as_of is older than 60 seconds', () => {
      const now = new Date('2026-09-26T12:05:00Z');
      const staleAsOf = new Date('2026-09-26T12:03:50Z'); // 70 seconds ago

      expect(service.isStale(staleAsOf, now)).toBe(true);
      expect(service.determineStockStatus(10, staleAsOf, now)).toBe(InventoryStockStatus.STALE);
    });

    it('should NOT decrement or reserve stock - Product Catalog is strictly read-only projection', async () => {
      mockInventoryRepo.findBySkuId.mockResolvedValue(null);
      mockInventoryRepo.upsertProjection.mockImplementation((proj) =>
        Promise.resolve(proj as InventoryProjectionDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'inv-evt-readonly',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 20,
          source_version: 1,
          as_of: new Date().toISOString(),
        },
      };

      await service.handleStockSnapshotUpdated(event);

      // Verify only upsertProjection is called; no decrement/reserve methods exist or called
      expect(mockInventoryRepo.upsertProjection).toHaveBeenCalledTimes(1);
    });
  });

  describe('Validation', () => {
    const validPayload = {
      product_id: mockProductId,
      sku_id: mockSkuId,
      available_qty: 10,
      source_version: 1,
      as_of: new Date().toISOString(),
    };

    it('should throw error if sku_id is missing', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-01',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, sku_id: '' },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow('sku_id is required');
    });

    it('should throw error if product_id is missing', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-02',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, product_id: '' },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'product_id is required',
      );
    });

    it('should throw error if available_qty is negative', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-03',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, available_qty: -1 },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'available_qty must be an integer >= 0',
      );
    });

    it('should throw error if available_qty is float', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-04',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, available_qty: 5.5 },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'available_qty must be an integer >= 0',
      );
    });

    it('should throw error if as_of is invalid date', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-05',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, as_of: 'not-a-date' },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'as_of must be a valid date',
      );
    });

    it('should throw error if payload is missing', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-06',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: null as any,
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'Inventory snapshot payload is missing',
      );
    });

    it('should throw error if reserved_qty is negative or not integer', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-07',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, reserved_qty: -1 },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'reserved_qty must be an integer >= 0',
      );
    });

    it('should throw error if committed_qty is negative or not integer', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-08',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, committed_qty: -2 },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'committed_qty must be an integer >= 0',
      );
    });

    it('should throw error if source_version is negative or not integer', async () => {
      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-val-09',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: { ...validPayload, source_version: -5 },
      };

      await expect(service.handleStockSnapshotUpdated(event)).rejects.toThrow(
        'source_version must be a non-negative integer',
      );
    });
  });

  describe('resolveStockStatus', () => {
    const fixedNow = new Date('2026-09-26T12:00:00Z');

    it('should return STALE if projection as_of is older than 60 seconds', () => {
      const staleDoc = createMockProjectionDoc({
        as_of: new Date('2026-09-26T11:58:00Z'), // 120s ago
        available_qty_snapshot: BigInt(20),
      });

      expect(service.resolveStockStatus(staleDoc, fixedNow)).toBe(InventoryStockStatus.STALE);
    });

    it('should return OUT_OF_STOCK if fresh and available_qty is 0', () => {
      const oosDoc = createMockProjectionDoc({
        as_of: new Date('2026-09-26T11:59:50Z'), // 10s ago
        available_qty_snapshot: BigInt(0),
      });

      expect(service.resolveStockStatus(oosDoc, fixedNow)).toBe(InventoryStockStatus.OUT_OF_STOCK);
    });

    it('should return LOW_STOCK if fresh and available_qty <= 5', () => {
      const lowDoc = createMockProjectionDoc({
        as_of: new Date('2026-09-26T11:59:50Z'), // 10s ago
        available_qty_snapshot: BigInt(4),
      });

      expect(service.resolveStockStatus(lowDoc, fixedNow)).toBe(InventoryStockStatus.LOW_STOCK);
    });

    it('should return IN_STOCK if fresh and available_qty > 5', () => {
      const inStockDoc = createMockProjectionDoc({
        as_of: new Date('2026-09-26T11:59:50Z'), // 10s ago
        available_qty_snapshot: BigInt(15),
      });

      expect(service.resolveStockStatus(inStockDoc, fixedNow)).toBe(InventoryStockStatus.IN_STOCK);
    });
  });

  describe('Idempotency & Out-of-Order Handling', () => {
    it('should drop event if source_version <= existing.source_version', async () => {
      const existing = createMockProjectionDoc({ source_version: BigInt(10) });
      mockInventoryRepo.findBySkuId.mockResolvedValue(existing);

      const olderEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-stale-inv',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 5,
          source_version: 8, // 8 <= 10
          as_of: new Date().toISOString(),
        },
      };

      const result = await service.handleStockSnapshotUpdated(olderEvent);

      expect(result.dropped).toBe(true);
      expect(result.reason).toBe('OUT_OF_ORDER');
      expect(mockInventoryRepo.upsertProjection).not.toHaveBeenCalled();
    });

    it('should drop event if source_event_id is duplicate', async () => {
      const existing = createMockProjectionDoc({ source_event_id: 'inv-dup-123' });
      mockInventoryRepo.findBySkuId.mockResolvedValue(existing);

      const dupEvent: KafkaEventEnvelope<any> = {
        event_id: 'inv-dup-123',
        event_type: EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED,
        aggregate_type: 'SKU',
        aggregate_id: mockSkuId,
        occurred_at: new Date().toISOString(),
        payload: {
          product_id: mockProductId,
          sku_id: mockSkuId,
          available_qty: 25,
          source_version: 15,
          as_of: new Date().toISOString(),
        },
      };

      const result = await service.handleStockSnapshotUpdated(dupEvent);

      expect(result.dropped).toBe(true);
      expect(result.reason).toBe('DUPLICATE');
      expect(mockInventoryRepo.upsertProjection).not.toHaveBeenCalled();
    });
  });

  describe('Query Projection Helpers', () => {
    it('should get projection by sku_id', async () => {
      const mockDoc = createMockProjectionDoc();
      mockInventoryRepo.findBySkuId.mockResolvedValue(mockDoc);

      const result = await service.getProjectionBySkuId(mockSkuId);
      expect(result).toBe(mockDoc);
    });

    it('should get projections by product_id', async () => {
      const mockList = [createMockProjectionDoc()];
      mockInventoryRepo.findByProductId.mockResolvedValue(mockList);

      const result = await service.getProjectionsByProductId(mockProductId);
      expect(result).toEqual(mockList);
    });
  });
});
