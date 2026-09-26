import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { AdminModerationController } from '../../src/moderation/controllers/admin-moderation.controller';
import { ModerationService } from '../../src/moderation/services/moderation.service';
import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import {
  AuditAction,
  AuditTargetType,
  CatalogAuditDocument,
} from '../../src/database/schemas/catalog-audit.schema';
import { AggregateType } from '../../src/database/schemas/outbox-event.schema';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import {
  CATALOG_AUDIT_REPOSITORY_PORT,
  CatalogAuditRepositoryPort,
} from '../../src/moderation/repositories/catalog-audit.repository.interface';

// --- In-Memory Repositories for Moderation Integration Tests ---

class InMemoryProductRepo {
  private products = new Map<string, any>();

  set(doc: any): void {
    this.products.set(doc._id.toString(), { ...doc });
  }

  get(id: string): any {
    return this.products.get(id);
  }

  async findById(id: string): Promise<ProductDocument | null> {
    const p = this.products.get(id);
    return p ? ({ ...p } as unknown as ProductDocument) : null;
  }

  async atomicCasUpdate(
    id: string,
    shopId: string,
    expectedVersion: number,
    updateFields: any,
    _session: any,
  ): Promise<ProductDocument | null> {
    const existing = this.products.get(id);
    if (!existing) return null;
    if (existing.shop_id !== shopId) return null;
    if (Number(existing.version) !== Number(expectedVersion)) return null;

    const nextVer = BigInt(existing.version) + 1n;
    const updated = {
      ...existing,
      ...updateFields,
      version: nextVer,
      updated_at: new Date(),
    };
    this.products.set(id, updated);
    return { ...updated } as unknown as ProductDocument;
  }

  clear(): void {
    this.products.clear();
  }
}

class InMemoryAuditRepo implements Partial<CatalogAuditRepositoryPort> {
  private audits: CatalogAuditDocument[] = [];

  async record(audit: any): Promise<CatalogAuditDocument> {
    const doc = {
      _id: audit._id || 'audit-' + (this.audits.length + 1),
      ...audit,
      occurred_at: audit.occurred_at || new Date(),
    } as CatalogAuditDocument;
    this.audits.unshift(doc); // Store newest first
    return doc;
  }

  async findAudits(
    filter: any,
    page = 1,
    size = 20,
  ): Promise<{ items: CatalogAuditDocument[]; total: number }> {
    let filtered = [...this.audits];

    if (filter.target_id) {
      filtered = filtered.filter((a) => a.target_id === filter.target_id);
    }
    if (filter.target_type) {
      filtered = filtered.filter((a) => a.target_type === filter.target_type);
    }
    if (filter.actor_user_id) {
      filtered = filtered.filter((a) => a.actor_user_id === filter.actor_user_id);
    }
    if (filter.action) {
      filtered = filtered.filter((a) => a.action === filter.action);
    }

    const total = filtered.length;
    const skip = (page - 1) * size;
    const items = filtered.slice(skip, skip + size);

    return { items, total };
  }

  getAll(): CatalogAuditDocument[] {
    return this.audits;
  }

  clear(): void {
    this.audits = [];
  }
}

/**
 * Integration Test Suite for Admin Product Moderation & Audits [TEST-B07]
 *
 * References:
 * - Test Plan: product-catalog-docs/docs/test/product-catalog.md §3.3 (PC-API-041..044, PC-SEC-003)
 * - LLD: product-catalog-docs/docs/lld/product-catalog.md §3.6, §5.1, §6.1-6.2, §7
 * - API Spec: product-catalog-docs/docs/api/product-catalog.md §3.3
 */
describe('Admin Moderation & Audit Integration Spec [TEST-B07]', () => {
  let app: INestApplication;

  const inMemoryProductRepo = new InMemoryProductRepo();
  const inMemoryAuditRepo = new InMemoryAuditRepo();
  const savedOutboxEvents: any[] = [];

  const mockOutboxRepo: OutboxRepositoryPort = {
    saveEvent: jest.fn().mockImplementation(async (event: any) => {
      savedOutboxEvents.push(event);
      return event;
    }),
  } as any;

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation(async (cb: (session: any) => Promise<any>) => cb({})),
  };

  // Test Fixtures
  const adminId = '01912f30-7a1b-7c12-9c55-8b1c34a6d101';
  const sellerId = '01912f30-7a1b-7c12-9c55-8b1c34a6d102';
  const shopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d201';
  const productId = '01912f31-7a1b-7c12-9c55-8b1c34a6d301';

  const adminHeaders = {
    'x-user-id': adminId,
    'x-user-roles': 'CATALOG_ADMIN',
    'x-user-permissions': 'CATALOG_MODERATE,AUDIT_READ',
  };

  const superAdminHeaders = {
    'x-user-id': adminId,
    'x-user-roles': 'SUPER_ADMIN',
    'x-user-permissions': 'ALL',
  };

  const sellerHeaders = {
    'x-user-id': sellerId,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'PRODUCT_WRITE',
    'x-user-shop-scope': shopId,
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AdminModerationController],
      providers: [
        ModerationService,
        { provide: 'ProductRepositoryPort', useValue: inMemoryProductRepo },
        { provide: CATALOG_AUDIT_REPOSITORY_PORT, useValue: inMemoryAuditRepo },
        { provide: OutboxRepositoryPort, useValue: mockOutboxRepo },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new ActorContextGuard(reflector));
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(reflector));
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const setupProduct = (
    status = ProductStatus.ACTIVE,
    version = 8n,
    blockReason: string | null = null,
  ) => {
    inMemoryProductRepo.set({
      _id: productId,
      shop_id: shopId,
      title: 'Thực phẩm chức năng không rõ nguồn gốc',
      slug: 'thuc-pham-chuc-nang-khong-ro-nguon-goc',
      description: 'Mô tả chi tiết sản phẩm vi phạm.',
      status,
      version,
      block_reason: blockReason,
      blocked_at: status === ProductStatus.BLOCKED ? new Date('2026-09-20T00:00:00Z') : null,
      published_at: new Date('2026-09-01T00:00:00Z'),
    });
  };

  beforeEach(() => {
    inMemoryProductRepo.clear();
    inMemoryAuditRepo.clear();
    savedOutboxEvents.length = 0;
    jest.clearAllMocks();
  });

  // =========================================================================
  // PC-API-041..042: POST /admin/catalog/products/{productId}/block
  // =========================================================================
  describe('POST /admin/catalog/products/{productId}/block', () => {
    it('PC-API-041: Should block an ACTIVE product when called by CATALOG_ADMIN with valid reason and version', async () => {
      setupProduct(ProductStatus.ACTIVE, 8n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(adminHeaders)
        .send({ version: 8, reason: 'Phát hiện hàng giả, vi phạm chính sách sàn' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: {
          product_id: productId,
          status: 'BLOCKED',
          version: 9,
        },
      });
      expect(res.body.data.blocked_at).toBeDefined();

      // Check DB CAS update
      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.BLOCKED);
      expect(dbProduct.version).toBe(9n);
      expect(dbProduct.block_reason).toBe('Phát hiện hàng giả, vi phạm chính sách sàn');

      // Check Outbox event (LLD §6.2)
      expect(savedOutboxEvents.length).toBe(1);
      const outbox = savedOutboxEvents[0];
      expect(outbox.event_type).toBe('product.blocked');
      expect(outbox.topic).toBe('product.events.v1');
      expect(outbox.aggregate_id).toBe(productId);
      expect(outbox.aggregate_type).toBe(AggregateType.PRODUCT);
      expect(outbox.version).toBe(9n);
      expect(outbox.payload).toMatchObject({
        product_id: productId,
        reason: 'Phát hiện hàng giả, vi phạm chính sách sàn',
        actor: adminId,
        version: 9,
      });

      // Check Audit record
      const audits = inMemoryAuditRepo.getAll();
      expect(audits.length).toBe(1);
      const audit = audits[0];
      expect(audit.action).toBe(AuditAction.BLOCK);
      expect(audit.target_type).toBe(AuditTargetType.PRODUCT);
      expect(audit.target_id).toBe(productId);
      expect(audit.actor_user_id).toBe(adminId);
      expect(audit.shop_id).toBe(shopId);
      expect(audit.reason).toBe('Phát hiện hàng giả, vi phạm chính sách sàn');
      expect(audit.metadata).toMatchObject({
        previous_status: ProductStatus.ACTIVE,
        new_status: ProductStatus.BLOCKED,
        version: 9,
      });
    });

    it('PC-API-041b: Should allow block when called by SUPER_ADMIN', async () => {
      setupProduct(ProductStatus.ACTIVE, 1n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(superAdminHeaders)
        .send({ version: 1, reason: 'Yêu cầu pháp lý khẩn cấp từ cơ quan quản lý' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('BLOCKED');
      expect(res.body.data.version).toBe(2);
    });

    it('PC-API-042a: Should return 403 PRODUCT_FORBIDDEN when called by SELLER role (RBAC Defense)', async () => {
      setupProduct(ProductStatus.ACTIVE, 8n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(sellerHeaders)
        .send({ version: 8, reason: 'Tự block' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');

      // Product must remain ACTIVE
      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.ACTIVE);
      expect(dbProduct.version).toBe(8n);
      expect(savedOutboxEvents.length).toBe(0);
    });

    it('PC-API-042b: Should return 401 UNAUTHORIZED when no authentication headers provided', async () => {
      setupProduct(ProductStatus.ACTIVE, 8n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .send({ version: 8, reason: 'Block không danh tính' });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('PC-API-042c: Should return 400 PRODUCT_INVALID_INPUT when reason is missing or empty or whitespace only', async () => {
      setupProduct(ProductStatus.ACTIVE, 8n);

      const resEmpty = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(adminHeaders)
        .send({ version: 8, reason: '   ' });

      expect(resEmpty.status).toBe(400);
      expect(resEmpty.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      const resMissing = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(adminHeaders)
        .send({ version: 8 });

      expect(resMissing.status).toBe(400);
      expect(resMissing.body.error.code).toBe('PRODUCT_INVALID_INPUT');

      // Product must NOT be blocked
      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.ACTIVE);
      expect(dbProduct.version).toBe(8n);
    });

    it('Precondition: Should return 404 PRODUCT_NOT_FOUND when product does not exist', async () => {
      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/non-existent-product-id/block`)
        .set(adminHeaders)
        .send({ version: 1, reason: 'Block sản phẩm ảo' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('Precondition: Should return 409 PRODUCT_ARCHIVED when product is ARCHIVED', async () => {
      setupProduct(ProductStatus.ARCHIVED, 5n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(adminHeaders)
        .send({ version: 5, reason: 'Block sản phẩm đã lưu trữ' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_ARCHIVED');
    });

    it('Precondition: Should return 409 PRODUCT_STATE_INVALID when product is already BLOCKED', async () => {
      setupProduct(ProductStatus.BLOCKED, 9n, 'Lý do cũ');

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(adminHeaders)
        .send({ version: 9, reason: 'Block lại lần nữa' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_STATE_INVALID');
    });

    it('OCC Invariant: Should return 409 PRODUCT_VERSION_CONFLICT on version mismatch during block', async () => {
      setupProduct(ProductStatus.ACTIVE, 8n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/block`)
        .set(adminHeaders)
        .send({ version: 7, reason: 'Phiên bản cũ' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_VERSION_CONFLICT');
    });
  });

  // =========================================================================
  // PC-API-043..044: POST /admin/catalog/products/{productId}/unblock
  // =========================================================================
  describe('POST /admin/catalog/products/{productId}/unblock', () => {
    it('PC-API-043: Should unblock BLOCKED product to INACTIVE baseline with event and audit', async () => {
      setupProduct(ProductStatus.BLOCKED, 9n, 'Nghi ngờ vi phạm bản quyền');

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/unblock`)
        .set(adminHeaders)
        .send({ version: 9, reason: 'Người bán đã xuất trình giấy phép bản quyền hợp lệ' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        data: {
          product_id: productId,
          status: 'INACTIVE',
          next_status: 'INACTIVE',
          version: 10,
        },
      });

      // Check DB CAS update: block_reason cleared, status INACTIVE (not ACTIVE)
      const dbProduct = inMemoryProductRepo.get(productId);
      expect(dbProduct.status).toBe(ProductStatus.INACTIVE);
      expect(dbProduct.version).toBe(10n);
      expect(dbProduct.block_reason).toBeNull();

      // Check Outbox event (LLD §6.2)
      expect(savedOutboxEvents.length).toBe(1);
      const outbox = savedOutboxEvents[0];
      expect(outbox.event_type).toBe('product.unblocked');
      expect(outbox.topic).toBe('product.events.v1');
      expect(outbox.aggregate_id).toBe(productId);
      expect(outbox.version).toBe(10n);
      expect(outbox.payload).toMatchObject({
        product_id: productId,
        next_status: 'INACTIVE',
        actor: adminId,
        version: 10,
      });

      // Check Audit record
      const audits = inMemoryAuditRepo.getAll();
      expect(audits.length).toBe(1);
      const audit = audits[0];
      expect(audit.action).toBe(AuditAction.UNBLOCK);
      expect(audit.target_type).toBe(AuditTargetType.PRODUCT);
      expect(audit.target_id).toBe(productId);
      expect(audit.actor_user_id).toBe(adminId);
      expect(audit.reason).toBe('Người bán đã xuất trình giấy phép bản quyền hợp lệ');
      expect(audit.metadata).toMatchObject({
        previous_status: ProductStatus.BLOCKED,
        new_status: ProductStatus.INACTIVE,
        version: 10,
      });
    });

    it('PC-API-044a: Should return 409 PRODUCT_STATE_INVALID when product is NOT BLOCKED (e.g. ACTIVE)', async () => {
      setupProduct(ProductStatus.ACTIVE, 3n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/unblock`)
        .set(adminHeaders)
        .send({ version: 3, reason: 'Unblock sản phẩm đang active' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_STATE_INVALID');
    });

    it('PC-API-044b: Should return 409 PRODUCT_STATE_INVALID when product is in DRAFT', async () => {
      setupProduct(ProductStatus.DRAFT, 1n);

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/unblock`)
        .set(adminHeaders)
        .send({ version: 1 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_STATE_INVALID');
    });

    it('PC-API-044c: Should return 409 PRODUCT_VERSION_CONFLICT on version mismatch during unblock', async () => {
      setupProduct(ProductStatus.BLOCKED, 9n, 'Vi phạm');

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/unblock`)
        .set(adminHeaders)
        .send({ version: 8 });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_VERSION_CONFLICT');
    });

    it('RBAC Defense: Should return 403 PRODUCT_FORBIDDEN when role SELLER attempts to unblock', async () => {
      setupProduct(ProductStatus.BLOCKED, 9n, 'Vi phạm');

      const res = await request(app.getHttpServer())
        .post(`/admin/catalog/products/${productId}/unblock`)
        .set(sellerHeaders)
        .send({ version: 9 });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });
  });

  // =========================================================================
  // Audits Query: GET /admin/catalog/audits
  // =========================================================================
  describe('GET /admin/catalog/audits', () => {
    beforeEach(async () => {
      // Seed some audit records
      await inMemoryAuditRepo.record({
        _id: 'audit-001',
        action: AuditAction.PUBLISH,
        target_type: AuditTargetType.PRODUCT,
        target_id: productId,
        actor_user_id: sellerId,
        shop_id: shopId,
        occurred_at: new Date('2026-09-20T08:00:00Z'),
      });
      await inMemoryAuditRepo.record({
        _id: 'audit-002',
        action: AuditAction.BLOCK,
        target_type: AuditTargetType.PRODUCT,
        target_id: productId,
        actor_user_id: adminId,
        shop_id: shopId,
        reason: 'Vi phạm chính sách',
        occurred_at: new Date('2026-09-21T09:00:00Z'),
      });
      await inMemoryAuditRepo.record({
        _id: 'audit-003',
        action: AuditAction.UNBLOCK,
        target_type: AuditTargetType.PRODUCT,
        target_id: productId,
        actor_user_id: adminId,
        shop_id: shopId,
        occurred_at: new Date('2026-09-22T10:00:00Z'),
      });
      await inMemoryAuditRepo.record({
        _id: 'audit-004',
        action: AuditAction.CATEGORY_CHANGE,
        target_type: AuditTargetType.CATEGORY,
        target_id: 'cat-999',
        actor_user_id: adminId,
        occurred_at: new Date('2026-09-23T11:00:00Z'),
      });
    });

    it('Should return paginated audit logs for admin', async () => {
      const res = await request(app.getHttpServer()).get('/admin/catalog/audits').set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(4);
      expect(res.body.meta).toMatchObject({
        page: 1,
        size: 20,
        total: 4,
        total_pages: 1,
      });
    });

    it('Should filter audit logs by action', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/catalog/audits?action=BLOCK')
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].action).toBe(AuditAction.BLOCK);
      expect(res.body.meta.total).toBe(1);
    });

    it('Should filter audit logs by target_type and target_id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/catalog/audits?target_type=PRODUCT&target_id=${productId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(3);
      expect(res.body.meta.total).toBe(3);
    });

    it('Should filter audit logs by actor_user_id', async () => {
      const res = await request(app.getHttpServer())
        .get(`/admin/catalog/audits?actor_user_id=${sellerId}`)
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].actor_user_id).toBe(sellerId);
    });

    it('Should respect pagination parameters (page, size)', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/catalog/audits?page=2&size=2')
        .set(adminHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
      expect(res.body.meta).toMatchObject({
        page: 2,
        size: 2,
        total: 4,
        total_pages: 2,
      });
    });

    it('RBAC Defense: Should return 403 PRODUCT_FORBIDDEN when SELLER attempts to query admin audits', async () => {
      const res = await request(app.getHttpServer())
        .get('/admin/catalog/audits')
        .set(sellerHeaders);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });
  });
});
