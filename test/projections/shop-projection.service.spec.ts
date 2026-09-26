import { Test, TestingModule } from '@nestjs/testing';
import { ShopProjectionService } from '../../src/projections/services/shop-projection.service';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import {
  KycStatus,
  ShopSnapshotDocument,
  ShopStatus,
} from '../../src/database/schemas/shop-snapshot.schema';
import {
  EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED,
  EVENT_SHOP_CREATED,
  EVENT_SHOP_KYC_APPROVED,
  EVENT_SHOP_KYC_EXPIRED,
  EVENT_SHOP_KYC_NEEDS_INFO,
  EVENT_SHOP_KYC_REJECTED,
  EVENT_SHOP_KYC_SUBMITTED,
  EVENT_SHOP_STATUS_CHANGED,
  EVENT_SHOP_UPDATED,
} from '../../src/integrations/kafka/kafka.constants';
import { KafkaEventEnvelope } from '../../src/integrations/kafka/kafka-event.interface';
import { AggregateType } from '../../src/database/schemas/outbox-event.schema';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('ShopProjectionService', () => {
  let service: ShopProjectionService;
  let mockShopRepo: jest.Mocked<ShopSnapshotRepositoryPort>;
  let mockOutboxRepo: jest.Mocked<OutboxRepositoryPort>;
  let mockTransactionRunner: { execute: jest.Mock };

  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';
  const mockSession = { id: 'mock-session-id' } as any;

  const createMockSnapshotDoc = (
    overrides?: Partial<ShopSnapshotDocument>,
  ): ShopSnapshotDocument => {
    return {
      _id: mockShopId,
      shop_id: mockShopId,
      name: 'Original Shop',
      slug: 'original-shop',
      logo_url: 'https://cdn.example.com/logo.png',
      shop_status: ShopStatus.ACTIVE,
      kyc_status: KycStatus.PENDING,
      source_version: BigInt(2),
      source_event_id: 'evt-original',
      updated_at: new Date('2026-09-20T10:00:00Z'),
      ...overrides,
    } as unknown as ShopSnapshotDocument;
  };

  beforeEach(async () => {
    mockTransactionRunner = {
      execute: jest
        .fn()
        .mockImplementation((fn: (session: any) => Promise<any>) => fn(mockSession)),
    };

    mockShopRepo = {
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

    mockOutboxRepo = {
      saveEvent: jest.fn(),
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
        ShopProjectionService,
        {
          provide: SHOP_SNAPSHOT_REPOSITORY_PORT,
          useValue: mockShopRepo,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: mockOutboxRepo,
        },
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
      ],
    }).compile();

    service = module.get<ShopProjectionService>(ShopProjectionService);
  });

  describe('shop.created', () => {
    it('should create new shop snapshot with default KYC status PENDING', async () => {
      mockShopRepo.findByShopId.mockResolvedValue(null);
      mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
        Promise.resolve(snap as ShopSnapshotDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-created-01',
        event_type: EVENT_SHOP_CREATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:00:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Taca Flagship Store',
          slug: 'taca-flagship-store',
          status: 'ACTIVE',
          version: 1,
        },
      };

      const result = await service.handleShopEvent(event);

      expect(result.success).toBe(true);
      expect(mockShopRepo.upsertSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: mockShopId,
          shop_id: mockShopId,
          name: 'Taca Flagship Store',
          slug: 'taca-flagship-store',
          shop_status: 'ACTIVE',
          kyc_status: KycStatus.PENDING,
          source_version: BigInt(1),
          source_event_id: 'evt-created-01',
        }),
        mockSession,
      );
      // Brand new snapshot creation does NOT trigger reindex outbox event
      expect(mockOutboxRepo.saveEvent).not.toHaveBeenCalled();
    });
  });

  describe('shop.updated', () => {
    it('should update name, slug and emit outbox event when name or slug changes', async () => {
      const existing = createMockSnapshotDoc();
      mockShopRepo.findByShopId.mockResolvedValue(existing);
      mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
        Promise.resolve(snap as ShopSnapshotDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-updated-01',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:30:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Renamed Shop',
          slug: 'renamed-shop',
          version: 3,
        },
      };

      const result = await service.handleShopEvent(event);

      expect(result.success).toBe(true);
      expect(mockTransactionRunner.execute).toHaveBeenCalled();
      expect(mockShopRepo.upsertSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Renamed Shop',
          slug: 'renamed-shop',
          source_version: BigInt(3),
        }),
        mockSession,
      );

      // Must emit product.shop_snapshot_updated outbox event with session
      expect(mockOutboxRepo.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          aggregate_type: AggregateType.SHOP_PROJECTION,
          aggregate_id: mockShopId,
          event_type: EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED,
          topic: 'catalog.events.v1',
          actor_user_id: null,
          payload: expect.objectContaining({
            shop_id: mockShopId,
            name: 'Renamed Shop',
            slug: 'renamed-shop',
            old_name: 'Original Shop',
            old_slug: 'original-shop',
          }),
        }),
        mockSession,
      );
    });

    it('should rollback transaction if outbox save fails [SF-02]', async () => {
      const existing = createMockSnapshotDoc();
      mockShopRepo.findByShopId.mockResolvedValue(existing);
      mockOutboxRepo.saveEvent.mockRejectedValue(new Error('Outbox write failure'));

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-tx-fail',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:30:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Atomic Fail Shop',
          version: 3,
        },
      };

      await expect(service.handleShopEvent(event)).rejects.toThrow('Outbox write failure');
    });

    it('should NOT emit outbox event if name and slug did not change', async () => {
      const existing = createMockSnapshotDoc({ name: 'Same Name', slug: 'same-slug' });
      mockShopRepo.findByShopId.mockResolvedValue(existing);
      mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
        Promise.resolve(snap as ShopSnapshotDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-updated-02',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:35:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Same Name',
          slug: 'same-slug',
          logo_url: 'https://cdn.example.com/new-logo.png',
          version: 3,
        },
      };

      const result = await service.handleShopEvent(event);

      expect(result.success).toBe(true);
      expect(mockOutboxRepo.saveEvent).not.toHaveBeenCalled();
    });
  });

  describe('shop.status_changed', () => {
    it('should update shop_status to SUSPENDED', async () => {
      const existing = createMockSnapshotDoc();
      mockShopRepo.findByShopId.mockResolvedValue(existing);
      mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
        Promise.resolve(snap as ShopSnapshotDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-status-01',
        event_type: EVENT_SHOP_STATUS_CHANGED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T09:00:00Z',
        payload: {
          shop_id: mockShopId,
          old_status: 'ACTIVE',
          new_status: 'SUSPENDED',
          version: 3,
        },
      };

      const result = await service.handleShopEvent(event);

      expect(result.success).toBe(true);
      expect(mockShopRepo.upsertSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          shop_status: 'SUSPENDED',
          source_version: BigInt(3),
        }),
        mockSession,
      );
    });
  });

  describe('KYC status inference from event types', () => {
    const kycTestCases = [
      { eventType: EVENT_SHOP_KYC_SUBMITTED, expected: KycStatus.PENDING },
      { eventType: EVENT_SHOP_KYC_APPROVED, expected: KycStatus.APPROVED },
      { eventType: EVENT_SHOP_KYC_NEEDS_INFO, expected: KycStatus.NEEDS_INFO },
      { eventType: EVENT_SHOP_KYC_REJECTED, expected: KycStatus.REJECTED },
      { eventType: EVENT_SHOP_KYC_EXPIRED, expected: KycStatus.EXPIRED },
    ];

    for (const { eventType, expected } of kycTestCases) {
      it(`should infer KYC status ${expected} from event ${eventType}`, async () => {
        const existing = createMockSnapshotDoc({
          updated_at: new Date('2026-09-20T10:00:00Z'),
        });
        mockShopRepo.findByShopId.mockResolvedValue(existing);
        mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
          Promise.resolve(snap as ShopSnapshotDocument),
        );

        const event: KafkaEventEnvelope<any> = {
          event_id: `evt-kyc-${eventType}`,
          event_type: eventType,
          aggregate_type: 'SHOP',
          aggregate_id: mockShopId,
          occurred_at: '2026-09-26T09:00:00Z',
          payload: {
            shop_id: mockShopId,
            kyc_case_id: 'case-123',
          },
        };

        const result = await service.handleShopEvent(event);

        expect(result.success).toBe(true);
        expect(mockShopRepo.upsertSnapshot).toHaveBeenCalledWith(
          expect.objectContaining({
            kyc_status: expected,
          }),
          mockSession,
        );
      });
    }

    it('should initialize snapshot with default name, slug, and source_version=1 when KYC event arrives before shop.created', async () => {
      mockShopRepo.findByShopId.mockResolvedValue(null);
      mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
        Promise.resolve(snap as ShopSnapshotDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-kyc-first',
        event_type: EVENT_SHOP_KYC_APPROVED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T09:00:00Z',
        payload: {
          shop_id: mockShopId,
          kyc_case_id: 'case-first',
        },
      };

      const result = await service.handleShopEvent(event);

      expect(result.success).toBe(true);
      expect(mockShopRepo.upsertSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: mockShopId,
          shop_id: mockShopId,
          name: `Shop ${mockShopId.substring(0, 8)}`,
          slug: `shop-${mockShopId.substring(0, 8)}`,
          kyc_status: KycStatus.APPROVED,
          source_version: BigInt(1),
          source_event_id: 'evt-kyc-first',
        }),
        mockSession,
      );
    });

    it('should accept explicit payload.kyc_status on generic/unknown event', async () => {
      mockShopRepo.findByShopId.mockResolvedValue(null);
      mockShopRepo.upsertSnapshot.mockImplementation((snap) =>
        Promise.resolve(snap as ShopSnapshotDocument),
      );

      const event: KafkaEventEnvelope<any> = {
        event_id: 'evt-generic-kyc',
        event_type: 'shop.custom.event',
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T09:00:00Z',
        payload: {
          shop_id: mockShopId,
          kyc_status: KycStatus.APPROVED,
        },
      };

      const result = await service.handleShopEvent(event);

      expect(result.success).toBe(true);
      expect(mockShopRepo.upsertSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          kyc_status: KycStatus.APPROVED,
        }),
        mockSession,
      );
    });
  });

  describe('Idempotency & Out-of-Order Handling', () => {
    it('should drop versioned event with DUPLICATE reason if source_event_id matches [SUG-01]', async () => {
      const existing = createMockSnapshotDoc({
        source_version: BigInt(3),
        source_event_id: 'evt-dup-versioned',
      });
      mockShopRepo.findByShopId.mockResolvedValue(existing);

      const dupEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-dup-versioned',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T09:00:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Duplicated Name',
          version: 2, // version <= 3, but should return DUPLICATE because event_id matched
        },
      };

      const result = await service.handleShopEvent(dupEvent);

      expect(result.dropped).toBe(true);
      expect(result.reason).toBe('DUPLICATE');
      expect(mockShopRepo.upsertSnapshot).not.toHaveBeenCalled();
      expect(mockOutboxRepo.saveEvent).not.toHaveBeenCalled();
    });

    it('should drop versioned event if event.version <= existing.source_version', async () => {
      const existing = createMockSnapshotDoc({ source_version: BigInt(5) });
      mockShopRepo.findByShopId.mockResolvedValue(existing);

      const staleEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-stale-01',
        event_type: EVENT_SHOP_UPDATED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T09:00:00Z',
        payload: {
          shop_id: mockShopId,
          name: 'Stale Shop Name',
          version: 4, // 4 <= 5
        },
      };

      const result = await service.handleShopEvent(staleEvent);

      expect(result.dropped).toBe(true);
      expect(result.reason).toBe('OUT_OF_ORDER');
      expect(mockShopRepo.upsertSnapshot).not.toHaveBeenCalled();
      expect(mockOutboxRepo.saveEvent).not.toHaveBeenCalled();
    });

    it('should drop unversioned KYC event if source_event_id is duplicate', async () => {
      const existing = createMockSnapshotDoc({ source_event_id: 'evt-dup-123' });
      mockShopRepo.findByShopId.mockResolvedValue(existing);

      const duplicateEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-dup-123',
        event_type: EVENT_SHOP_KYC_APPROVED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T09:00:00Z',
        payload: { shop_id: mockShopId },
      };

      const result = await service.handleShopEvent(duplicateEvent);

      expect(result.dropped).toBe(true);
      expect(result.reason).toBe('DUPLICATE');
      expect(mockShopRepo.upsertSnapshot).not.toHaveBeenCalled();
    });

    it('should drop unversioned KYC event if occurred_at is older than existing.updated_at', async () => {
      const existing = createMockSnapshotDoc({
        updated_at: new Date('2026-09-26T10:00:00Z'),
      });
      mockShopRepo.findByShopId.mockResolvedValue(existing);

      const olderEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-older-999',
        event_type: EVENT_SHOP_KYC_APPROVED,
        aggregate_type: 'SHOP',
        aggregate_id: mockShopId,
        occurred_at: '2026-09-26T08:00:00Z', // earlier than 10:00:00Z
        payload: { shop_id: mockShopId },
      };

      const result = await service.handleShopEvent(olderEvent);

      expect(result.dropped).toBe(true);
      expect(result.reason).toBe('STALE');
      expect(mockShopRepo.upsertSnapshot).not.toHaveBeenCalled();
    });

    it('should throw error if shop_id is missing', async () => {
      const invalidEvent: KafkaEventEnvelope<any> = {
        event_id: 'evt-inv-01',
        event_type: EVENT_SHOP_CREATED,
        aggregate_type: 'SHOP',
        aggregate_id: '',
        occurred_at: '2026-09-26T09:00:00Z',
        payload: {},
      };

      await expect(service.handleShopEvent(invalidEvent)).rejects.toThrow('missing shop_id');
    });
  });
});
