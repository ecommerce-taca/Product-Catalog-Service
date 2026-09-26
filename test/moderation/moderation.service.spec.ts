import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ModerationService } from '../../src/moderation/services/moderation.service';
import { ProductStatus } from '../../src/database/schemas/product.schema';
import { AuditAction, AuditTargetType } from '../../src/database/schemas/catalog-audit.schema';
import { AggregateType } from '../../src/database/schemas/outbox-event.schema';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { CATALOG_AUDIT_REPOSITORY_PORT } from '../../src/moderation/repositories/catalog-audit.repository.interface';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('ModerationService', () => {
  let service: ModerationService;

  const mockProductRepository = {
    findById: jest.fn(),
    atomicCasUpdate: jest.fn(),
  };

  const mockCatalogAuditRepository = {
    record: jest.fn(),
    findAudits: jest.fn(),
  };

  const mockOutboxRepository = {
    saveEvent: jest.fn(),
  };

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation((cb: (session: unknown) => Promise<unknown>) => cb({})),
  };

  const adminUserId = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const productId = '01912f31-7a1b-7c12-9c55-8b1c34a6d003';

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        {
          provide: 'ProductRepositoryPort',
          useValue: mockProductRepository,
        },
        {
          provide: CATALOG_AUDIT_REPOSITORY_PORT,
          useValue: mockCatalogAuditRepository,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: mockOutboxRepository,
        },
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
      ],
    }).compile();

    service = module.get<ModerationService>(ModerationService);
  });

  const createProductDoc = (overrides = {}) => ({
    _id: productId,
    shop_id: shopId,
    title: 'Sản phẩm thử nghiệm',
    status: ProductStatus.ACTIVE,
    version: BigInt(8),
    block_reason: null,
    ...overrides,
  });

  describe('blockProduct', () => {
    it('should throw PRODUCT_INVALID_INPUT when reason is missing or empty', async () => {
      await expect(
        service.blockProduct(adminUserId, productId, { version: 8, reason: '   ' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.blockProduct(adminUserId, productId, { version: 8, reason: '' }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_INVALID_INPUT' },
      });
    });

    it('should throw PRODUCT_NOT_FOUND when product does not exist', async () => {
      mockProductRepository.findById.mockResolvedValue(null);
      await expect(
        service.blockProduct(adminUserId, productId, {
          version: 8,
          reason: 'Vi phạm chính sách',
        }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_NOT_FOUND' },
      });
    });

    it('should throw PRODUCT_ARCHIVED when product is ARCHIVED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createProductDoc({ status: ProductStatus.ARCHIVED }),
      );
      await expect(
        service.blockProduct(adminUserId, productId, {
          version: 8,
          reason: 'Vi phạm chính sách',
        }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_ARCHIVED' },
      });
    });

    it('should throw PRODUCT_STATE_INVALID when product is already BLOCKED', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createProductDoc({ status: ProductStatus.BLOCKED }),
      );
      await expect(
        service.blockProduct(adminUserId, productId, {
          version: 8,
          reason: 'Vi phạm chính sách',
        }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_STATE_INVALID' },
      });
    });

    it('should throw PRODUCT_VERSION_CONFLICT when version mismatches', async () => {
      mockProductRepository.findById.mockResolvedValue(createProductDoc({ version: BigInt(9) }));
      await expect(
        service.blockProduct(adminUserId, productId, {
          version: 8,
          reason: 'Vi phạm chính sách',
        }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should block product, increment version, emit product.blocked outbox event, and record audit', async () => {
      const product = createProductDoc({ version: BigInt(8) });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.BLOCKED,
        version: BigInt(9),
        block_reason: 'Hàng giả/nhái',
      });

      const response = await service.blockProduct(adminUserId, productId, {
        version: 8,
        reason: '  Hàng giả/nhái  ',
      });

      expect(response).toMatchObject({
        product_id: productId,
        status: ProductStatus.BLOCKED,
        version: 9,
      });
      expect(response.blocked_at).toBeDefined();

      // Verify atomic CAS update
      expect(mockProductRepository.atomicCasUpdate).toHaveBeenCalledWith(
        productId,
        shopId,
        8,
        expect.objectContaining({
          status: ProductStatus.BLOCKED,
          block_reason: 'Hàng giả/nhái',
        }),
        expect.anything(),
      );

      // Verify outbox event
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.blocked',
          topic: 'product.events.v1',
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          version: BigInt(9),
          payload: expect.objectContaining({
            product_id: productId,
            reason: 'Hàng giả/nhái',
            actor: adminUserId,
            version: 9,
          }),
        }),
        expect.anything(),
      );

      // Verify catalog audit
      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.BLOCK,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          reason: 'Hàng giả/nhái',
          actor_user_id: adminUserId,
          shop_id: shopId,
        }),
        expect.anything(),
      );
    });
  });

  describe('unblockProduct', () => {
    it('should throw PRODUCT_NOT_FOUND when product does not exist', async () => {
      mockProductRepository.findById.mockResolvedValue(null);
      await expect(
        service.unblockProduct(adminUserId, productId, { version: 9 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_NOT_FOUND' },
      });
    });

    it('should throw PRODUCT_STATE_INVALID when product is NOT BLOCKED (e.g. ACTIVE)', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createProductDoc({ status: ProductStatus.ACTIVE }),
      );
      await expect(
        service.unblockProduct(adminUserId, productId, { version: 8 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_STATE_INVALID' },
      });
    });

    it('should throw PRODUCT_VERSION_CONFLICT when version mismatches', async () => {
      mockProductRepository.findById.mockResolvedValue(
        createProductDoc({ status: ProductStatus.BLOCKED, version: BigInt(10) }),
      );
      await expect(
        service.unblockProduct(adminUserId, productId, { version: 9 }),
      ).rejects.toMatchObject({
        response: { code: 'PRODUCT_VERSION_CONFLICT' },
      });
    });

    it('should unblock BLOCKED product to safe baseline INACTIVE, emit event, and record audit', async () => {
      const product = createProductDoc({
        status: ProductStatus.BLOCKED,
        version: BigInt(9),
        block_reason: 'Cần xác minh chứng từ',
      });
      mockProductRepository.findById.mockResolvedValue(product);
      mockProductRepository.atomicCasUpdate.mockResolvedValue({
        ...product,
        status: ProductStatus.INACTIVE,
        version: BigInt(10),
        block_reason: null,
      });

      const response = await service.unblockProduct(adminUserId, productId, {
        version: 9,
        reason: 'Đã bổ sung giấy tờ hợp lệ',
      });

      expect(response).toEqual({
        product_id: productId,
        status: ProductStatus.INACTIVE,
        next_status: ProductStatus.INACTIVE,
        version: 10,
      });

      // Verify CAS update
      expect(mockProductRepository.atomicCasUpdate).toHaveBeenCalledWith(
        productId,
        shopId,
        9,
        expect.objectContaining({
          status: ProductStatus.INACTIVE,
          block_reason: null,
        }),
        expect.anything(),
      );

      // Verify outbox event
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.unblocked',
          topic: 'product.events.v1',
          aggregate_type: AggregateType.PRODUCT,
          aggregate_id: productId,
          version: BigInt(10),
          payload: expect.objectContaining({
            product_id: productId,
            next_status: 'INACTIVE',
            actor: adminUserId,
            version: 10,
          }),
        }),
        expect.anything(),
      );

      // Verify catalog audit
      expect(mockCatalogAuditRepository.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UNBLOCK,
          target_type: AuditTargetType.PRODUCT,
          target_id: productId,
          reason: 'Đã bổ sung giấy tờ hợp lệ',
          actor_user_id: adminUserId,
        }),
        expect.anything(),
      );
    });
  });

  describe('getAudits', () => {
    it('should query audits with filtering and pagination and return paginated result', async () => {
      const mockAudits = [
        {
          _id: 'audit-01',
          action: 'PUBLISH',
          target_type: 'PRODUCT',
          target_id: productId,
          actor_user_id: adminUserId,
          occurred_at: new Date(),
        },
      ];

      mockCatalogAuditRepository.findAudits.mockResolvedValue({
        items: mockAudits,
        total: 1,
      });

      const result = await service.getAudits({
        target_id: productId,
        page: 1,
        size: 20,
      });

      expect(result).toEqual({
        data: mockAudits,
        meta: {
          page: 1,
          size: 20,
          total: 1,
          total_pages: 1,
        },
      });

      expect(mockCatalogAuditRepository.findAudits).toHaveBeenCalledWith(
        expect.objectContaining({
          target_id: productId,
        }),
        1,
        20,
      );
    });
  });
});
