import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import * as ExcelJS from 'exceljs';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import { v7 as uuidv7 } from 'uuid';

jest.mock('sanitize-html', () => {
  return jest.fn().mockImplementation((input: string) => {
    if (!input) return input;
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  });
});

import { SellerImportController } from '../../src/import/controllers/seller-import.controller';
import { ExcelTemplateService } from '../../src/import/services/excel-template.service';
import { ExcelResultService } from '../../src/import/services/excel-result.service';
import { MediaDownloadService } from '../../src/import/services/media-download.service';
import { ImportWorkerService } from '../../src/import/services/import-worker.service';
import { ExcelFormulaSanitizer } from '../../src/import/utils/excel-formula-sanitizer.util';
import { isPrivateOrBlockedUrl } from '../../src/import/utils/ssrf-validator.util';

import { ImportJobDocument, ImportJobStatus } from '../../src/database/schemas/import-job.schema';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuDocument, SkuStatus } from '../../src/database/schemas/sku.schema';
import { CategoryDocument, CategoryStatus } from '../../src/database/schemas/category.schema';
import { ProductCategoryDocument } from '../../src/database/schemas/product-category.schema';
import {
  MediaScope,
  MediaStatus,
  ProductMediaDocument,
} from '../../src/database/schemas/product-media.schema';
import { AggregateType, OutboxEventDocument } from '../../src/database/schemas/outbox-event.schema';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import {
  KycStatus,
  ShopSnapshotDocument,
  ShopStatus,
} from '../../src/database/schemas/shop-snapshot.schema';
import {
  AttributeDefinitionDocument,
  AttributeDefinitionStatus,
  AttributeScopeType,
  AttributeType,
} from '../../src/database/schemas/attribute-definition.schema';
import { InventoryProjectionDocument } from '../../src/database/schemas/inventory-projection.schema';

import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { VariantResolver } from '../../src/sku/services/variant-resolver.service';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { INVENTORY_PROJECTION_REPOSITORY_PORT } from '../../src/projections/repositories/inventory-projection.repository.interface';
import { ProductController } from '../../src/catalog-query/controllers/product.controller';
import { CatalogQueryService } from '../../src/catalog-query/services/catalog-query.service';
import { CategoryService } from '../../src/category/services/category.service';

const binaryParser = (res: any, callback: any) => {
  const data: Buffer[] = [];
  res.on('data', (chunk: Buffer) => data.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(data)));
};

// --- Valid 1x1 Transparent PNG binary fixture for media download testing ---
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// ============================================================================
// In-Memory Test Doubles for Integration Verification
// ============================================================================

class InMemoryImportJobRepo {
  private jobs = new Map<string, any>();

  set(doc: any): void {
    const wrapped = this.wrapDoc({ ...doc });
    this.jobs.set(String(doc._id), wrapped);
  }

  private wrapDoc(doc: any): any {
    const jobsMap = this.jobs;
    return {
      ...doc,
      save: async function (this: any) {
        jobsMap.set(String(this._id), this);
        return this;
      },
    };
  }

  async findById(id: string): Promise<ImportJobDocument | null> {
    const job = this.jobs.get(String(id));
    return job ? (job as ImportJobDocument) : null;
  }

  async findActiveJobByShop(shopId: string): Promise<ImportJobDocument | null> {
    for (const job of this.jobs.values()) {
      if (
        job.shop_id === shopId &&
        (job.status === ImportJobStatus.PENDING || job.status === ImportJobStatus.PROCESSING)
      ) {
        return job as ImportJobDocument;
      }
    }
    return null;
  }

  async create(data: any): Promise<ImportJobDocument> {
    const doc = this.wrapDoc({
      ...data,
      created_at: data.created_at || new Date(),
      updated_at: new Date(),
    });
    this.jobs.set(String(doc._id), doc);
    return doc as ImportJobDocument;
  }

  async update(filter: any, updateFields: any): Promise<any> {
    const id = filter._id ? String(filter._id) : null;
    if (!id) return null;
    const existing = this.jobs.get(id);
    if (!existing) return null;
    Object.assign(existing, updateFields, { updated_at: new Date() });
    this.jobs.set(id, existing);
    return existing;
  }

  async findByShopAndId(shopId: string, jobId: string): Promise<ImportJobDocument | null> {
    const job = this.jobs.get(String(jobId));
    if (job && job.shop_id === shopId) return job as ImportJobDocument;
    return null;
  }

  async claimNextPendingJob(leaseDurationMs = 120_000): Promise<ImportJobDocument | null> {
    const now = new Date();
    for (const job of this.jobs.values()) {
      if (job.status === ImportJobStatus.PENDING) {
        job.status = ImportJobStatus.PROCESSING;
        job.started_at = now;
        job.locked_until = new Date(now.getTime() + leaseDurationMs);
        return job as ImportJobDocument;
      }
    }
    return null;
  }

  async reclaimStaleJobs(now = new Date()): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (
        job.status === ImportJobStatus.PROCESSING &&
        job.locked_until &&
        new Date(job.locked_until).getTime() < now.getTime()
      ) {
        job.status = ImportJobStatus.FAILED;
        job.locked_until = null;
        count++;
      }
    }
    return count;
  }

  async updateHeartbeat(
    jobId: string,
    leaseDurationMs = 120_000,
  ): Promise<ImportJobDocument | null> {
    const job = this.jobs.get(String(jobId));
    if (job) {
      job.locked_until = new Date(Date.now() + leaseDurationMs);
      return job as ImportJobDocument;
    }
    return null;
  }

  async find(filter: any = {}): Promise<ImportJobDocument[]> {
    return Array.from(this.jobs.values()).filter((j) => {
      if (filter.shop_id && j.shop_id !== filter.shop_id) return false;
      if (filter.status && j.status !== filter.status) return false;
      return true;
    }) as ImportJobDocument[];
  }

  async findOne(filter: any = {}): Promise<ImportJobDocument | null> {
    const results = await this.find(filter);
    return results[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    return this.jobs.delete(String(id));
  }

  async count(filter: any = {}): Promise<number> {
    const items = await this.find(filter);
    return items.length;
  }

  clear(): void {
    this.jobs.clear();
  }
}

class InMemoryProductRepo {
  private products = new Map<string, any>();

  set(doc: any): void {
    this.products.set(String(doc._id), { ...doc });
  }

  async create(doc: any, _session?: any): Promise<ProductDocument> {
    const item = {
      ...doc,
      created_at: doc.created_at || new Date(),
      updated_at: new Date(),
    };
    this.products.set(String(item._id), item);
    return item as unknown as ProductDocument;
  }

  async findById(id: string): Promise<ProductDocument | null> {
    const item = this.products.get(String(id));
    return item ? ({ ...item } as unknown as ProductDocument) : null;
  }

  async find(filter: any = {}, _options?: any): Promise<ProductDocument[]> {
    let list = Array.from(this.products.values());
    if (filter._id) {
      if (typeof filter._id === 'object' && '$in' in filter._id) {
        const inIds = new Set(filter._id.$in.map(String));
        list = list.filter((p) => inIds.has(String(p._id)));
      } else {
        list = list.filter((p) => String(p._id) === String(filter._id));
      }
    }
    if (filter.shop_id) {
      list = list.filter((p) => p.shop_id === filter.shop_id);
    }
    if (filter.status) {
      list = list.filter((p) => p.status === filter.status);
    }
    if (filter.archived_at === null) {
      list = list.filter((p) => p.archived_at === null || p.archived_at === undefined);
    }
    return list as unknown as ProductDocument[];
  }

  async count(filter: any = {}): Promise<number> {
    const results = await this.find(filter);
    return results.length;
  }

  async delete(id: string): Promise<boolean> {
    return this.products.delete(String(id));
  }

  clear(): void {
    this.products.clear();
  }
}

class InMemorySkuRepo {
  private skus: any[] = [];

  set(doc: any): void {
    this.skus.push({ ...doc });
  }

  async create(doc: any, _session?: any): Promise<SkuDocument> {
    const item = {
      ...doc,
      created_at: doc.created_at || new Date(),
      updated_at: new Date(),
    };
    this.skus.push(item);
    return item as unknown as SkuDocument;
  }

  async findByProductId(productId: string): Promise<SkuDocument[]> {
    return this.skus.filter((s) => s.product_id === productId) as unknown as SkuDocument[];
  }

  async findBySellerSku(shopId: string, sellerSku: string): Promise<SkuDocument | null> {
    const item = this.skus.find(
      (s) => s.shop_id === shopId && s.seller_sku.toLowerCase() === sellerSku.toLowerCase(),
    );
    return item ? (item as unknown as SkuDocument) : null;
  }

  async findBySellerSkus(shopId: string, sellerSkus: string[]): Promise<SkuDocument[]> {
    const normSet = new Set(sellerSkus.map((s) => s.toLowerCase()));
    return this.skus.filter(
      (s) => s.shop_id === shopId && normSet.has((s.seller_sku || '').toLowerCase()),
    ) as unknown as SkuDocument[];
  }

  async countBySellerSku(shopId: string, sellerSku: string): Promise<number> {
    return this.skus.filter(
      (s) => s.shop_id === shopId && s.seller_sku.toLowerCase() === sellerSku.toLowerCase(),
    ).length;
  }

  async bulkUpsert(skus: Partial<SkuDocument>[]): Promise<void> {
    for (const sku of skus) {
      this.skus.push({ ...sku });
    }
  }

  clear(): void {
    this.skus = [];
  }
}

class InMemoryCategoryRepo {
  private categories = new Map<string, any>();

  set(doc: any): void {
    this.categories.set(String(doc._id), { ...doc });
  }

  async findById(id: string): Promise<CategoryDocument | null> {
    const cat = this.categories.get(String(id));
    return cat ? ({ ...cat } as unknown as CategoryDocument) : null;
  }

  async find(): Promise<CategoryDocument[]> {
    return Array.from(this.categories.values()) as unknown as CategoryDocument[];
  }

  clear(): void {
    this.categories.clear();
  }
}

class InMemoryProductCategoryRepo {
  private assignments: any[] = [];

  set(doc: any): void {
    this.assignments.push({ ...doc });
  }

  async create(doc: any, _session?: any): Promise<ProductCategoryDocument> {
    this.assignments.push({ ...doc });
    return doc as unknown as ProductCategoryDocument;
  }

  async find(filter: any = {}): Promise<ProductCategoryDocument[]> {
    return this.assignments.filter((a) => {
      if (filter.category_id && a.category_id !== filter.category_id) return false;
      if (filter.product_id && a.product_id !== filter.product_id) return false;
      return true;
    }) as unknown as ProductCategoryDocument[];
  }

  async findByProductId(productId: string): Promise<ProductCategoryDocument[]> {
    return this.assignments.filter(
      (a) => a.product_id === productId,
    ) as unknown as ProductCategoryDocument[];
  }

  async countByCategoryId(categoryId: string): Promise<number> {
    return this.assignments.filter((a) => a.category_id === categoryId).length;
  }

  clear(): void {
    this.assignments = [];
  }
}

class InMemoryProductMediaRepo {
  private media: any[] = [];

  set(doc: any): void {
    this.media.push({ ...doc });
  }

  async create(doc: any, _session?: any): Promise<ProductMediaDocument> {
    this.media.push({ ...doc });
    return doc as unknown as ProductMediaDocument;
  }

  async findByProductId(productId: string): Promise<ProductMediaDocument[]> {
    return this.media.filter(
      (m) => m.product_id === productId,
    ) as unknown as ProductMediaDocument[];
  }

  async findByProductIds(productIds: string[]): Promise<ProductMediaDocument[]> {
    const idSet = new Set(productIds.map(String));
    return this.media.filter((m) =>
      idSet.has(String(m.product_id)),
    ) as unknown as ProductMediaDocument[];
  }

  clear(): void {
    this.media = [];
  }
}

class InMemoryOutboxRepo {
  private events: any[] = [];

  async saveEvent(event: any, _session?: any): Promise<OutboxEventDocument> {
    const item = {
      ...event,
      created_at: new Date(),
    };
    this.events.push(item);
    return item as unknown as OutboxEventDocument;
  }

  async find(filter: any = {}): Promise<OutboxEventDocument[]> {
    return this.events.filter((e) => {
      if (filter.aggregate_type && e.aggregate_type !== filter.aggregate_type) return false;
      if (filter.event_type && e.event_type !== filter.event_type) return false;
      return true;
    }) as unknown as OutboxEventDocument[];
  }

  clear(): void {
    this.events = [];
  }
}

class InMemoryShopSnapshotRepo {
  private snapshots = new Map<string, any>();

  set(doc: any): void {
    this.snapshots.set(String(doc.shop_id), { ...doc });
  }

  async findByShopId(shopId: string): Promise<ShopSnapshotDocument | null> {
    const s = this.snapshots.get(String(shopId));
    return s ? ({ ...s } as unknown as ShopSnapshotDocument) : null;
  }

  clear(): void {
    this.snapshots.clear();
  }
}

class InMemoryAttributeDefinitionRepo {
  private definitions: any[] = [];

  set(doc: any): void {
    this.definitions.push({ ...doc });
  }

  async findByScope(
    scope: string,
    scopeId?: string,
    status?: string,
  ): Promise<AttributeDefinitionDocument[]> {
    return this.definitions.filter((d) => {
      if (d.scope !== scope) return false;
      if (scopeId && d.scope_id && d.scope_id !== scopeId) return false;
      if (status && d.status && d.status !== status) return false;
      return true;
    }) as unknown as AttributeDefinitionDocument[];
  }

  clear(): void {
    this.definitions = [];
  }
}

class InMemoryInventoryProjectionRepo {
  private projections: any[] = [];

  async findByProductId(productId: string): Promise<InventoryProjectionDocument[]> {
    return this.projections.filter(
      (p) => p.product_id === productId,
    ) as unknown as InventoryProjectionDocument[];
  }

  async findByProductIds(productIds: string[]): Promise<InventoryProjectionDocument[]> {
    const idSet = new Set(productIds.map(String));
    return this.projections.filter((p) =>
      idSet.has(String(p.product_id)),
    ) as unknown as InventoryProjectionDocument[];
  }

  clear(): void {
    this.projections = [];
  }
}

// ============================================================================
// Helper: Generates Excel .xlsx buffer in memory
// ============================================================================
async function createImportExcelBuffer(
  rows: Array<{
    refId: string;
    title?: string;
    desc?: string;
    catId?: string;
    brand?: string;
    urls?: string;
    sku: string;
    price: number;
    origPrice?: number | null;
    barcode?: string | null;
    dynamicAttrs?: Record<string, string>;
  }>,
  dynamicHeaders: string[] = ['Màu sắc', 'Kích cỡ'],
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sản phẩm & Biến thể');

  const headers = [
    'Mã tham chiếu sản phẩm (*)',
    'Tên sản phẩm (*)',
    'Mô tả sản phẩm (*)',
    'Mã danh mục (*)',
    'Thương hiệu',
    'Danh sách URL ảnh',
    'Mã SKU người bán (*)',
    'Giá bán (VND) (*)',
    'Giá niêm yết gốc (VND)',
    'Mã vạch',
    ...dynamicHeaders,
  ];
  ws.addRow(headers);

  for (const r of rows) {
    const rowValues: any[] = [
      r.refId,
      r.title ?? '',
      r.desc ?? '',
      r.catId ?? '',
      r.brand ?? '',
      r.urls ?? '',
      r.sku,
      r.price,
      r.origPrice ?? '',
      r.barcode ?? '',
    ];
    if (r.dynamicAttrs) {
      for (const h of dynamicHeaders) {
        rowValues.push(r.dynamicAttrs[h] ?? '');
      }
    }
    ws.addRow(rowValues);
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ============================================================================
// MAIN INTEGRATION TEST SUITE [PCAT-IMP-05]
// ============================================================================

describe('Bulk Product Import Integration Spec [PCAT-IMP-05]', () => {
  let app: INestApplication;

  const inMemoryImportJobRepo = new InMemoryImportJobRepo();
  const inMemoryProductRepo = new InMemoryProductRepo();
  const inMemorySkuRepo = new InMemorySkuRepo();
  const inMemoryCategoryRepo = new InMemoryCategoryRepo();
  const inMemoryProductCategoryRepo = new InMemoryProductCategoryRepo();
  const inMemoryProductMediaRepo = new InMemoryProductMediaRepo();
  const inMemoryOutboxRepo = new InMemoryOutboxRepo();
  const inMemoryShopSnapshotRepo = new InMemoryShopSnapshotRepo();
  const inMemoryAttributeDefinitionRepo = new InMemoryAttributeDefinitionRepo();
  const inMemoryInventoryProjectionRepo = new InMemoryInventoryProjectionRepo();

  const s3StorageMap = new Map<string, Buffer>();
  const transactionDurations: number[] = [];

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation(async (callback) => {
      const start = performance.now();
      const mockSession = {
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        abortTransaction: jest.fn(),
        endSession: jest.fn(),
      } as any;
      try {
        const result = await callback(mockSession);
        transactionDurations.push(performance.now() - start);
        return result;
      } catch (err) {
        transactionDurations.push(performance.now() - start);
        throw err;
      }
    }),
  };

  const mockS3StorageService = {
    bucket: 'taca-product-import-files',
    s3Client: {
      send: jest.fn(async (command: any) => {
        const key = command.input?.Key?.replace(/^\//, '');
        const buffer = s3StorageMap.get(key);
        if (!buffer) {
          throw new Error(`NoSuchKey: ${key}`);
        }
        return {
          Body: Readable.from(buffer),
        };
      }),
    },
    uploadBuffer: jest.fn(async (key: string, buffer: Buffer, _contentType?: string) => {
      s3StorageMap.set(key.replace(/^\//, ''), buffer);
    }),
    generatePresignedDownloadUrl: jest.fn(async (key: string, _ttl?: number) => {
      return {
        downloadUrl: `https://storage.taca.test/${key}?signed=true`,
        expiresAt: new Date(Date.now() + 1800 * 1000),
      };
    }),
    getPublicUrl: jest.fn((key: string) => `https://cdn.taca.test/${key}`),
  };

  const mockCategoryService = {
    resolveEffectiveTaxRate: jest.fn().mockResolvedValue(1000),
  };

  // --- Test Tenancy & User Fixtures ---
  const shopA = '01912f30-7a1b-7c12-9c55-8b1c34a6d001';
  const shopB = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const shopSuspended = '01912f30-7a1b-7c12-9c55-8b1c34a6d099';

  const userSellerA = '01912f30-7a1b-7c12-9c55-8b1c34a6d101';
  const userSellerB = '01912f30-7a1b-7c12-9c55-8b1c34a6d102';
  const userSuspended = '01912f30-7a1b-7c12-9c55-8b1c34a6d103';

  const sellerAHeaders = {
    'x-user-id': userSellerA,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'PRODUCT_IMPORT,PRODUCT_READ',
    'x-user-shop-scope': shopA,
  };

  const sellerBHeaders = {
    'x-user-id': userSellerB,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'PRODUCT_IMPORT,PRODUCT_READ',
    'x-user-shop-scope': shopB,
  };

  const suspendedShopHeaders = {
    'x-user-id': userSuspended,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'PRODUCT_IMPORT,PRODUCT_READ',
    'x-user-shop-scope': shopSuspended,
  };

  const catFashion = '01912f20-7a1b-7c12-9c55-8b1c34a6d201';
  const catInactive = '01912f20-7a1b-7c12-9c55-8b1c34a6d202';

  // Global fetch mock handler for media downloading & SSRF verification
  const originalFetch = globalThis.fetch;
  let fetchMockHandler: ((url: string, init?: any) => Promise<any>) | null = null;
  const fetchSpy = jest.fn((url: string, init?: any) => {
    if (fetchMockHandler) {
      return fetchMockHandler(url, init);
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'image/png' }),
      arrayBuffer: async () => VALID_PNG_BUFFER,
    });
  });

  let workerService: ImportWorkerService;

  beforeAll(async () => {
    globalThis.fetch = fetchSpy as any;

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SellerImportController, ProductController],
      providers: [
        ExcelTemplateService,
        ExcelResultService,
        MediaDownloadService,
        ImportWorkerService,
        VariantResolver,
        CatalogQueryService,
        { provide: 'ImportJobRepositoryPort', useValue: inMemoryImportJobRepo },
        { provide: 'ProductRepositoryPort', useValue: inMemoryProductRepo },
        { provide: 'SkuRepositoryPort', useValue: inMemorySkuRepo },
        { provide: 'CategoryRepositoryPort', useValue: inMemoryCategoryRepo },
        { provide: 'ProductCategoryRepositoryPort', useValue: inMemoryProductCategoryRepo },
        { provide: 'ProductMediaRepositoryPort', useValue: inMemoryProductMediaRepo },
        { provide: OutboxRepositoryPort, useValue: inMemoryOutboxRepo },
        { provide: SHOP_SNAPSHOT_REPOSITORY_PORT, useValue: inMemoryShopSnapshotRepo },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: inMemoryAttributeDefinitionRepo,
        },
        {
          provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
          useValue: inMemoryInventoryProjectionRepo,
        },
        { provide: S3StorageService, useValue: mockS3StorageService },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
        { provide: CategoryService, useValue: mockCategoryService },
        Reflector,
      ],
    }).compile();

    workerService = moduleRef.get<ImportWorkerService>(ImportWorkerService);

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new ActorContextGuard(reflector));
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(reflector));
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
      }),
    );

    await app.init();
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 20));
    inMemoryImportJobRepo.clear();
    inMemoryProductRepo.clear();
    inMemorySkuRepo.clear();
    inMemoryCategoryRepo.clear();
    inMemoryProductCategoryRepo.clear();
    inMemoryProductMediaRepo.clear();
    inMemoryOutboxRepo.clear();
    inMemoryShopSnapshotRepo.clear();
    inMemoryAttributeDefinitionRepo.clear();
    inMemoryInventoryProjectionRepo.clear();
    s3StorageMap.clear();
    transactionDurations.length = 0;
    fetchMockHandler = null;
    jest.clearAllMocks();

    // 1. Seed Shop Snapshots
    inMemoryShopSnapshotRepo.set({
      shop_id: shopA,
      shop_name: 'Shop Thời Trang Nam A',
      shop_slug: 'shop-thoi-trang-nam-a',
      shop_status: ShopStatus.ACTIVE,
      kyc_status: KycStatus.APPROVED,
    });

    inMemoryShopSnapshotRepo.set({
      shop_id: shopB,
      shop_name: 'Shop Công Nghệ B',
      shop_slug: 'shop-cong-nghe-b',
      shop_status: ShopStatus.ACTIVE,
      kyc_status: KycStatus.APPROVED,
    });

    inMemoryShopSnapshotRepo.set({
      shop_id: shopSuspended,
      shop_name: 'Shop Bị Khóa',
      shop_slug: 'shop-bi-khoa',
      shop_status: ShopStatus.SUSPENDED,
      kyc_status: KycStatus.APPROVED,
    });

    // 2. Seed Categories
    inMemoryCategoryRepo.set({
      _id: catFashion,
      name: 'Thời trang nam',
      slug: 'thoi-trang-nam',
      status: CategoryStatus.ACTIVE,
      is_leaf: true,
    });

    inMemoryCategoryRepo.set({
      _id: catInactive,
      name: 'Danh mục tạm ngưng',
      slug: 'danh-muc-tam-ngung',
      status: CategoryStatus.INACTIVE,
      is_leaf: true,
    });

    // 3. Seed Dynamic Attributes for catFashion
    inMemoryAttributeDefinitionRepo.set({
      _id: 'attr-color-01',
      key: 'mau_sac',
      label: 'Màu sắc',
      type: AttributeType.ENUM,
      allowed_values: ['Đỏ', 'Xanh', 'Đen'],
      scope: AttributeScopeType.CATEGORY,
      scope_id: catFashion,
      status: AttributeDefinitionStatus.ACTIVE,
    });

    inMemoryAttributeDefinitionRepo.set({
      _id: 'attr-size-01',
      key: 'kich_co',
      label: 'Kích cỡ',
      type: AttributeType.ENUM,
      allowed_values: ['S', 'M', 'L', 'XL'],
      scope: AttributeScopeType.CATEGORY,
      scope_id: catFashion,
      status: AttributeDefinitionStatus.ACTIVE,
    });
  });

  // ==========================================================================
  // NHÓM 1: Dynamic Template Engine (FR-IM-01)
  // ==========================================================================
  describe('Nhóm 1: Dynamic Template Engine (FR-IM-01)', () => {
    it('[AC-IM-01] GET /seller/products/import/template: tải template hợp lệ kèm Data Validation dropdown ENUM', async () => {
      const res = await request(app.getHttpServer())
        .get(`/seller/products/import/template?category_id=${catFashion}`)
        .set(sellerAHeaders)
        .buffer(true)
        .parse(binaryParser);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(res.headers['content-disposition']).toContain(
        `filename="product_import_template_${catFashion}.xlsx"`,
      );

      // Verify Excel contents
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body);

      const sheet1 = wb.getWorksheet('Sản phẩm & Biến thể');
      const sheet2 = wb.getWorksheet('Hướng dẫn & Danh mục');
      expect(sheet1).toBeDefined();
      expect(sheet2).toBeDefined();

      // Check header columns in Sheet 1: 6 SPU + 4 SKU + dynamic attributes
      const headerRow = sheet1!.getRow(1);
      const headers: string[] = [];
      headerRow.eachCell((cell) => {
        headers.push(String(cell.value || ''));
      });

      expect(headers).toContain('Mã tham chiếu sản phẩm (*)');
      expect(headers).toContain('Tên sản phẩm (*)');
      expect(headers).toContain('Mô tả sản phẩm (*)');
      expect(headers).toContain('Mã danh mục (*)');
      expect(headers).toContain('Thương hiệu');
      expect(headers).toContain('Danh sách URL ảnh (cách nhau dấu phẩy)');
      expect(headers).toContain('Mã SKU người bán (*)');
      expect(headers).toContain('Giá bán VND (*)');
      expect(headers).toContain('Giá niêm yết gốc VND');
      expect(headers).toContain('Mã vạch');
      expect(headers).toContain('Màu sắc');
      expect(headers).toContain('Kích cỡ');

      // Check Data Validation dropdown list for ENUM attributes on row 2
      const colorColIdx = headers.indexOf('Màu sắc') + 1;
      const cellRow2 = sheet1!.getCell(2, colorColIdx);
      expect(cellRow2.dataValidation).toBeDefined();
      expect(cellRow2.dataValidation?.type).toBe('list');
      expect(cellRow2.dataValidation?.formulae?.[0]).toContain('Đỏ');
    });

    it('[AC-IM-02] Shop bị SUSPENDED cố tải template -> từ chối 403 PRODUCT_SHOP_SUSPENDED', async () => {
      const res = await request(app.getHttpServer())
        .get(`/seller/products/import/template?category_id=${catFashion}`)
        .set(suspendedShopHeaders);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PRODUCT_SHOP_SUSPENDED');
      expect(res.body.error.message).toContain('SUSPENDED');
    });

    it('[AC-IM-03] Tải template với category_id không tồn tại hoặc inactive -> trả 400 PRODUCT_CATEGORY_INVALID', async () => {
      // Non-existent category (valid UUID format but not present in database)
      const nonExistentCat = '01912f20-7a1b-7c12-9c55-8b1c34a6d999';
      const resNotFound = await request(app.getHttpServer())
        .get(`/seller/products/import/template?category_id=${nonExistentCat}`)
        .set(sellerAHeaders);

      expect(resNotFound.status).toBe(400);
      expect(resNotFound.body.error.code).toBe('PRODUCT_CATEGORY_INVALID');

      // Inactive category
      const resInactive = await request(app.getHttpServer())
        .get(`/seller/products/import/template?category_id=${catInactive}`)
        .set(sellerAHeaders);

      expect(resInactive.status).toBe(400);
      expect(resInactive.body.error.code).toBe('PRODUCT_CATEGORY_INVALID');
    });
  });

  // ==========================================================================
  // NHÓM 2: Upload & File Acceptance (FR-IM-02)
  // ==========================================================================
  describe('Nhóm 2: Upload & File Acceptance (FR-IM-02)', () => {
    it('[AC-IM-04] Upload file .xlsx hợp lệ -> trả 202 ACCEPTED trong < 500ms, trả về jobId, PENDING', async () => {
      const validBuffer = await createImportExcelBuffer([
        {
          refId: 'REF-001',
          title: 'Áo thun phong cách nam cotton cao cấp',
          catId: catFashion,
          sku: 'SKU-AO-COTTON-M',
          price: 150000,
        },
      ]);

      const start = performance.now();
      const res = await request(app.getHttpServer())
        .post('/seller/products/import')
        .set(sellerAHeaders)
        .attach('file', validBuffer, 'products.xlsx');
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500); // NFR-IM-01: Upload p95 < 500ms
      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe(ImportJobStatus.PENDING);
      expect(res.body.data.job_id).toBeDefined();

      const jobId = res.body.data.job_id;
      const jobInDb = await inMemoryImportJobRepo.findById(jobId);
      expect(jobInDb).not.toBeNull();
      expect(jobInDb!.shop_id).toBe(shopA);
      expect(s3StorageMap.has(jobInDb!.file_url.replace(/^\//, ''))).toBe(true);

      // Drain background worker to prevent bleeding into later tests
      await new Promise((r) => setTimeout(r, 60));
    });

    it('[AC-IM-05] Upload file vượt quá 2MB -> từ chối ngay 400 PRODUCT_IMPORT_FILE_TOO_LARGE', async () => {
      // 2.5MB payload buffer
      const largeBuffer = Buffer.alloc(2.5 * 1024 * 1024, 0);

      const res = await request(app.getHttpServer())
        .post('/seller/products/import')
        .set(sellerAHeaders)
        .attach('file', largeBuffer, 'huge_file.xlsx');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('PRODUCT_IMPORT_FILE_TOO_LARGE');
    });

    it('[AC-IM-06] Upload file sai định dạng (tệp .csv hoặc file text giả mạo) -> từ chối 400 PRODUCT_IMPORT_FILE_TYPE_INVALID', async () => {
      // 1. Text file with .csv extension
      const csvBuffer = Buffer.from('product_ref_id,title,price\nREF-1,Áo,100000');
      const resCsv = await request(app.getHttpServer())
        .post('/seller/products/import')
        .set(sellerAHeaders)
        .attach('file', csvBuffer, 'products.csv');

      expect(resCsv.status).toBe(400);
      expect(resCsv.body.error.code).toBe('PRODUCT_IMPORT_FILE_TYPE_INVALID');

      // 2. Text file disguised as .xlsx (lacks 'PK' zip magic bytes)
      const fakeXlsxBuffer = Buffer.from('This is a fake text file disguised as xlsx');
      const resFake = await request(app.getHttpServer())
        .post('/seller/products/import')
        .set(sellerAHeaders)
        .attach('file', fakeXlsxBuffer, 'disguised.xlsx');

      expect(resFake.status).toBe(400);
      expect(resFake.body.error.code).toBe('PRODUCT_IMPORT_FILE_TYPE_INVALID');
    });

    it('[AC-IM-07] Gian hàng đang có 1 job PROCESSING hoặc PENDING -> chặn job thứ 2 với 409 PRODUCT_IMPORT_JOB_RUNNING', async () => {
      // Seed active job for Shop A
      inMemoryImportJobRepo.set({
        _id: '01912f70-7a1b-7c12-9c55-8b1c34a6d901',
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PROCESSING,
        file_url: 'imports/shop-01/active.xlsx',
        total_rows: 50,
        processed_rows: 10,
        success_count: 5,
        error_count: 0,
        error_summary: [],
      });

      const validBuffer = await createImportExcelBuffer([
        {
          refId: 'REF-002',
          title: 'Áo thun thứ hai khi job đang chạy',
          catId: catFashion,
          sku: 'SKU-002',
          price: 150000,
        },
      ]);

      const res = await request(app.getHttpServer())
        .post('/seller/products/import')
        .set(sellerAHeaders)
        .attach('file', validBuffer, 'products.xlsx');

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PRODUCT_IMPORT_JOB_RUNNING');
    });
  });

  // ==========================================================================
  // NHÓM 3: Worker SPU-SKU Parsing & Validation (FR-IM-03)
  // ==========================================================================
  describe('Nhóm 3: Worker SPU-SKU Parsing & Validation (FR-IM-03)', () => {
    it('[AC-IM-08] Gom nhóm đa biến thể: các dòng có cùng product_ref_id gom vào 1 SPU với nhiều SKUs', async () => {
      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-AO-01',
          title: 'Áo thun thể thao nam',
          catId: catFashion,
          desc: 'Mô tả áo thun',
          sku: 'AO-DO-M',
          price: 150000,
          dynamicAttrs: { 'Màu sắc': 'Đỏ', 'Kích cỡ': 'M' },
        },
        {
          refId: 'REF-AO-01',
          title: '', // Inherit from SPU row
          catId: '',
          sku: 'AO-DO-L',
          price: 150000,
          dynamicAttrs: { 'Màu sắc': 'Đỏ', 'Kích cỡ': 'L' },
        },
        {
          refId: 'REF-QUAN-01',
          title: 'Quần jean ống suông',
          catId: catFashion,
          desc: 'Mô tả quần jean',
          sku: 'QUAN-DEN-30',
          price: 250000,
          dynamicAttrs: { 'Màu sắc': 'Đen', 'Kích cỡ': '30' },
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 3,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      expect(job?.status).toBe(ImportJobStatus.COMPLETED);
      expect(job?.success_count).toBe(2); // 2 SPUs
      expect(job?.error_count).toBe(0);

      const products = await inMemoryProductRepo.find({ shop_id: shopA });
      expect(products.length).toBe(2);

      const spuAo = products.find((p) => p.title === 'Áo thun thể thao nam');
      const spuQuan = products.find((p) => p.title === 'Quần jean ống suông');
      expect(spuAo).toBeDefined();
      expect(spuQuan).toBeDefined();

      const skusAo = await inMemorySkuRepo.findByProductId(String(spuAo!._id));
      expect(skusAo.length).toBe(2);
      expect(skusAo.map((s) => s.seller_sku).sort()).toEqual(['AO-DO-L', 'AO-DO-M']);

      const skusQuan = await inMemorySkuRepo.findByProductId(String(spuQuan!._id));
      expect(skusQuan.length).toBe(1);
      expect(skusQuan[0].seller_sku).toBe('QUAN-DEN-30');
    });

    it('[AC-IM-09] File vượt quá 200 dòng SKU -> worker đánh dấu FAILED với PRODUCT_IMPORT_TOO_MANY_ROWS, 0 sản phẩm được tạo', async () => {
      // 201 SKU rows
      const excessiveRows: any[] = [];
      for (let i = 1; i <= 201; i++) {
        excessiveRows.push({
          refId: `REF-${i}`,
          title: `Sản phẩm hàng loạt ${i} hợp lệ đủ dài`,
          catId: catFashion,
          sku: `SKU-ROW-${i}`,
          price: 100000,
        });
      }

      const buffer = await createImportExcelBuffer(excessiveRows);
      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 201,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      expect(job?.status).toBe(ImportJobStatus.FAILED);
      expect(job?.error_summary?.[0]?.error_code).toBe('PRODUCT_IMPORT_TOO_MANY_ROWS');

      // 0 products created
      const products = await inMemoryProductRepo.find({ shop_id: shopA });
      expect(products.length).toBe(0);
    });

    it('[AC-IM-10] Trùng lặp biến thể trong cùng SPU (kể cả hoán vị cột) -> gắn cờ lỗi PRODUCT_SKU_DUPLICATE_VARIANT', async () => {
      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-GIAY-01',
          title: 'Giày thể thao chạy bộ nam',
          catId: catFashion,
          sku: 'GIAY-TRANG-40-A',
          price: 500000,
          dynamicAttrs: { 'Màu sắc': 'Trắng', 'Kích cỡ': '40' },
        },
        {
          refId: 'REF-GIAY-01',
          title: '',
          catId: '',
          sku: 'GIAY-TRANG-40-B',
          price: 500000,
          dynamicAttrs: { 'Màu sắc': 'Trắng', 'Kích cỡ': '40' }, // Duplicate combination
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 2,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      expect(job?.status).toBe(ImportJobStatus.COMPLETED);
      expect(job?.success_count).toBe(0);
      expect(job?.error_count).toBe(2);

      const duplicateError = job?.error_summary?.find(
        (e) => e.error_code === 'PRODUCT_SKU_DUPLICATE_VARIANT',
      );
      expect(duplicateError).toBeDefined();
      expect(duplicateError?.error_message).toContain('Trùng lặp tổ hợp thuộc tính biến thể');
    });
  });

  // ==========================================================================
  // NHÓM 4: Media Streaming & SSRF Defense (FR-IM-04)
  // ==========================================================================
  describe('Nhóm 4: Media Streaming & SSRF Defense (FR-IM-04)', () => {
    it('[AC-IM-11] Tải stream ảnh hợp lệ từ URL sang S3/MinIO, tạo product_media is_cover=true, READY, SHA-256', async () => {
      const validImageUrl = 'https://cdn.example.com/products/shirt-blue.png';
      const expectedSha256 = crypto.createHash('sha256').update(VALID_PNG_BUFFER).digest('hex');

      fetchMockHandler = async (url: string) => {
        if (url === validImageUrl) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers({ 'content-type': 'image/png' }),
            arrayBuffer: async () => VALID_PNG_BUFFER,
          };
        }
        return { ok: false, status: 404, statusText: 'Not Found' };
      };

      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-IMG-01',
          title: 'Áo thun có hình ảnh hợp lệ chuẩn',
          catId: catFashion,
          sku: 'SKU-IMG-01',
          price: 200000,
          urls: validImageUrl,
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 1,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      expect(job?.status).toBe(ImportJobStatus.COMPLETED);
      expect(job?.success_count).toBe(1);

      const products = await inMemoryProductRepo.find({ shop_id: shopA });
      expect(products.length).toBe(1);
      const productId = String(products[0]._id);

      const mediaList = await inMemoryProductMediaRepo.findByProductId(productId);
      expect(mediaList.length).toBe(1);
      expect(mediaList[0].is_cover).toBe(true);
      expect(mediaList[0].status).toBe(MediaStatus.READY);
      expect(mediaList[0].scope).toBe(MediaScope.SPU);
      expect(mediaList[0].sha256).toBe(expectedSha256);
      expect(mediaList[0].content_type).toBe('image/png');
    });

    it('[AC-IM-12] Fault-Tolerance: URL ảnh bị chết (404) hoặc timeout -> SPU vẫn tạo thành công DRAFT, cảnh báo ghi vào báo cáo', async () => {
      const deadImageUrl = 'https://broken-cdn.test/notfound.jpg';

      fetchMockHandler = async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers({ 'content-type': 'text/html' }),
        arrayBuffer: async () => Buffer.from('Not found'),
      });

      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-IMG-404',
          title: 'Áo thun có URL ảnh bị chết 404',
          catId: catFashion,
          sku: 'SKU-IMG-404',
          price: 200000,
          urls: deadImageUrl,
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 1,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      expect(job?.status).toBe(ImportJobStatus.COMPLETED);
      expect(job?.success_count).toBe(1); // SPU still created successfully!
      expect(job?.error_count).toBe(0); // SPU itself succeeded

      // Warning recorded in error_summary
      const warning = job?.error_summary?.find((e) =>
        e.error_code.includes('MEDIA_DOWNLOAD_FAILED'),
      );
      expect(warning).toBeDefined();
      expect(warning?.error_message).toContain('HTTP 404');

      // Product exists in DRAFT
      const products = await inMemoryProductRepo.find({ shop_id: shopA });
      expect(products.length).toBe(1);
      expect(products[0].status).toBe(ProductStatus.DRAFT);

      // 0 media records
      const mediaList = await inMemoryProductMediaRepo.findByProductId(String(products[0]._id));
      expect(mediaList.length).toBe(0);
    });

    it('[AC-IM-13] Phòng chống SSRF: URL trỏ về IP nội bộ / loopback bị chặn đứng ngay, không phát sinh kết nối mạng nguy hiểm', async () => {
      const ssrfUrls = [
        'http://127.0.0.1:8080/admin',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/internal/secret',
        'http://192.168.1.1/router/config',
        'http://localhost:3000/api/keys',
      ];

      // 1. Static validator unit verification
      for (const url of ssrfUrls) {
        expect(isPrivateOrBlockedUrl(url)).toBe(true);
      }

      // 2. Worker pipeline verification
      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-SSRF',
          title: 'Sản phẩm thử nghiệm SSRF nội bộ',
          catId: catFashion,
          sku: 'SKU-SSRF',
          price: 200000,
          urls: 'http://169.254.169.254/latest/meta-data/',
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 1,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      const ssrfError = job?.error_summary?.find(
        (e) => e.error_code === 'MEDIA_INVALID_URL_BLOCKED',
      );
      expect(ssrfError).toBeDefined();
      expect(ssrfError?.error_message).toContain('URL không an toàn hoặc trỏ về địa chỉ nội bộ');

      // Fetch was NEVER called for the SSRF destination
      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('169.254.169.254'),
        expect.anything(),
      );
    });
  });

  // ==========================================================================
  // NHÓM 5: Transaction & Outbox CDC (FR-IM-05)
  // ==========================================================================
  describe('Nhóm 5: Transaction & Outbox CDC (FR-IM-05)', () => {
    it('[AC-IM-14] Partial Success: 10 SPU (8 hợp lệ, 2 lỗi) -> đúng 8 SPU tạo thành công, 8 sự kiện CDC outbox, 0 dữ liệu rác', async () => {
      // Seed existing SKU in Shop A to trigger duplicate SKU on SPU 7
      inMemorySkuRepo.set({
        _id: 'sku-existing-01',
        product_id: 'prod-existing-01',
        shop_id: shopA,
        seller_sku: 'EXISTING-SKU-07',
        price_override: BigInt(200000),
        status: SkuStatus.ACTIVE,
      });

      const spuRows: any[] = [];
      for (let i = 1; i <= 10; i++) {
        if (i === 3) {
          // SPU 3: Error - title too short (< 10 chars)
          spuRows.push({
            refId: `REF-${i}`,
            title: 'Ngắn',
            catId: catFashion,
            sku: `SKU-PARTIAL-${i}`,
            price: 150000,
          });
        } else if (i === 7) {
          // SPU 7: Error - seller_sku already exists in shop
          spuRows.push({
            refId: `REF-${i}`,
            title: `Sản phẩm số ${i} hợp lệ đủ độ dài tiêu đề`,
            catId: catFashion,
            sku: 'EXISTING-SKU-07',
            price: 150000,
          });
        } else {
          // Valid SPUs
          spuRows.push({
            refId: `REF-${i}`,
            title: `Sản phẩm số ${i} hợp lệ đủ độ dài tiêu đề`,
            catId: catFashion,
            sku: `SKU-PARTIAL-${i}`,
            price: 150000,
          });
        }
      }

      const buffer = await createImportExcelBuffer(spuRows);
      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 10,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const job = await inMemoryImportJobRepo.findById(jobId);
      expect(job?.status).toBe(ImportJobStatus.COMPLETED);
      expect(job?.success_count).toBe(8); // Exactly 8 valid SPUs created
      expect(job?.error_count).toBe(2); // Exactly 2 failed SKU rows

      // Verify Products in DB
      const products = await inMemoryProductRepo.find({ shop_id: shopA });
      expect(products.length).toBe(8);

      // Verify no residue for SPU 3 and SPU 7
      const spu3 = products.find((p) => p.title.includes('Ngắn'));
      const spu7 = products.find((p) => p.title.includes('số 7'));
      expect(spu3).toBeUndefined();
      expect(spu7).toBeUndefined();

      // Verify 8 Outbox CDC product.created events
      const outboxEvents = await inMemoryOutboxRepo.find({
        aggregate_type: AggregateType.PRODUCT,
        event_type: 'product.created',
      });
      expect(outboxEvents.length).toBe(8);
    });

    it('[AC-IM-15] Bảo tồn Publish Gate 9 điều kiện: 100% sản phẩm tạo ra ở DRAFT, GET /products/:id trả 404 (Zero Leak Check)', async () => {
      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-GATE-01',
          title: 'Sản phẩm kiểm tra Publish Gate bảo mật',
          catId: catFashion,
          sku: 'SKU-GATE-01',
          price: 300000,
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 1,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      const products = await inMemoryProductRepo.find({ shop_id: shopA });
      expect(products.length).toBe(1);
      const product = products[0];

      // 1. Must be DRAFT
      expect(product.status).toBe(ProductStatus.DRAFT);

      // 2. Zero Leak Check on Public Endpoint: GET /products/:productId
      const publicRes = await request(app.getHttpServer()).get(`/products/${product._id}`);

      expect(publicRes.status).toBe(404);
      expect(publicRes.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  // ==========================================================================
  // NHÓM 6: Job Tracking & Result Export (FR-IM-06)
  // ==========================================================================
  describe('Nhóm 6: Job Tracking & Result Export (FR-IM-06)', () => {
    it('[AC-IM-16] GET /seller/products/import/jobs/:jobId: tra cứu tiến độ real-time', async () => {
      const jobId = '01912f70-7a1b-7c12-9c55-8b1c34a6da01';
      const startedAt = new Date('2026-09-26T14:30:00.000Z');
      const completedAt = new Date('2026-09-26T14:30:02.000Z');

      inMemoryImportJobRepo.set({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.COMPLETED,
        file_url: 'imports/shop-01/job.xlsx',
        total_rows: 100,
        processed_rows: 100,
        success_count: 95,
        error_count: 5,
        started_at: startedAt,
        completed_at: completedAt,
        error_summary: [],
      });

      const res = await request(app.getHttpServer())
        .get(`/seller/products/import/jobs/${jobId}`)
        .set(sellerAHeaders);

      expect(res.status).toBe(200);
      expect(res.body.data.job_id).toBe(jobId);
      expect(res.body.data.status).toBe(ImportJobStatus.COMPLETED);
      expect(res.body.data.total_rows).toBe(100);
      expect(res.body.data.processed_rows).toBe(100);
      expect(res.body.data.success_count).toBe(95);
      expect(res.body.data.error_count).toBe(5);
      expect(res.body.data.started_at).toBe(startedAt.toISOString());
      expect(res.body.data.completed_at).toBe(completedAt.toISOString());
    });

    it('[AC-IM-17] GET /seller/products/import/jobs/:jobId/result: tải file kết quả lỗi, khử độc 100% Formula Injection CWE-1236', async () => {
      const jobId = '01912f70-7a1b-7c12-9c55-8b1c34a6da02';

      // Seed error summary containing dangerous formulas
      const maliciousErrors = [
        {
          row_index: 2,
          product_ref_id: ExcelFormulaSanitizer.sanitize('=cmd|"/C calc"!A0'),
          seller_sku: ExcelFormulaSanitizer.sanitize('+SKU-MALICIOUS'),
          error_code: 'PRODUCT_INVALID_PRICE',
          error_message: ExcelFormulaSanitizer.sanitize('@SUM(A1:A10) Giá bán không hợp lệ'),
        },
      ];

      inMemoryImportJobRepo.set({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.COMPLETED,
        file_url: 'imports/shop-01/job.xlsx',
        total_rows: 5,
        processed_rows: 5,
        success_count: 4,
        error_count: 1,
        error_summary: maliciousErrors,
      });

      // 1. Test binary download stream (default)
      const resStream = await request(app.getHttpServer())
        .get(`/seller/products/import/jobs/${jobId}/result`)
        .set(sellerAHeaders)
        .buffer(true)
        .parse(binaryParser);

      expect(resStream.status).toBe(200);
      expect(resStream.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );

      // Verify Excel formula sanitization on generated result file
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(resStream.body);
      const sheet = wb.getWorksheet(1);
      expect(sheet).toBeDefined();

      sheet!.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return; // Skip headers
        row.eachCell((cell) => {
          const val = String(cell.value || '');
          if (val) {
            // Verify that no cell starts directly with dangerous =, +, -, @ characters
            expect(val).not.toMatch(/^[=+\-@]/);
          }
        });
      });

      // 2. Test JSON response negotiation (Accept: application/json)
      const resJson = await request(app.getHttpServer())
        .get(`/seller/products/import/jobs/${jobId}/result`)
        .set({ ...sellerAHeaders, Accept: 'application/json' });

      expect(resJson.status).toBe(200);
      const downloadUrl = resJson.body.result_file_url || resJson.body.data?.result_file_url;
      expect(downloadUrl).toContain('https://storage.taca.test');
      expect(resJson.body.expires_at || resJson.body.data?.expires_at).toBeDefined();

      // 3. Test when job has 0 errors -> 400 PRODUCT_IMPORT_NO_ERRORS
      const noErrorJobId = '01912f70-7a1b-7c12-9c55-8b1c34a6da03';
      inMemoryImportJobRepo.set({
        _id: noErrorJobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.COMPLETED,
        file_url: 'imports/shop-01/job.xlsx',
        total_rows: 5,
        processed_rows: 5,
        success_count: 5,
        error_count: 0,
        error_summary: [],
      });

      const resNoError = await request(app.getHttpServer())
        .get(`/seller/products/import/jobs/${noErrorJobId}/result`)
        .set(sellerAHeaders);

      expect(resNoError.status).toBe(400);
      expect(resNoError.body.error.code).toBe('PRODUCT_IMPORT_NO_ERRORS');
    });

    it('[AC-IM-18] Zero-Trust IDOR check: Seller B cố tình tra cứu hoặc tải kết quả của Seller A -> 404 PRODUCT_NOT_FOUND', async () => {
      const jobAId = '01912f70-7a1b-7c12-9c55-8b1c34a6da04';
      inMemoryImportJobRepo.set({
        _id: jobAId,
        shop_id: shopA, // Belongs to Shop A
        actor_user_id: userSellerA,
        status: ImportJobStatus.COMPLETED,
        file_url: 'imports/shop-01/job.xlsx',
        total_rows: 10,
        processed_rows: 10,
        success_count: 8,
        error_count: 2,
        error_summary: [{ row_index: 2, error_message: 'Error' }],
      });

      // Seller B queries Job A progress
      const resProgressIdor = await request(app.getHttpServer())
        .get(`/seller/products/import/jobs/${jobAId}`)
        .set(sellerBHeaders);

      expect(resProgressIdor.status).toBe(404);
      expect(resProgressIdor.body.error.code).toBe('PRODUCT_NOT_FOUND');

      // Seller B queries Job A error result
      const resResultIdor = await request(app.getHttpServer())
        .get(`/seller/products/import/jobs/${jobAId}/result`)
        .set(sellerBHeaders);

      expect(resResultIdor.status).toBe(404);
      expect(resResultIdor.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  // ==========================================================================
  // NHÓM 7: Non-Functional Requirements & Resource Invariants (NFR-IM-01..04)
  // ==========================================================================
  describe('Nhóm 7: Non-Functional Requirements & Resource Invariants (NFR-IM-01..04)', () => {
    it('[NFR-IM-01 & NFR-IM-03] Connection pool isolation (L-06): Transaction duration < 80ms, 0 connection in Stage 1 & 2', async () => {
      const buffer = await createImportExcelBuffer([
        {
          refId: 'REF-PERF-01',
          title: 'Sản phẩm đo lường thời gian chiếm giữ connection transaction',
          catId: catFashion,
          sku: 'SKU-PERF-01',
          price: 250000,
        },
      ]);

      const jobId = uuidv7();
      const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
      s3StorageMap.set(s3Key, buffer);

      await inMemoryImportJobRepo.create({
        _id: jobId,
        shop_id: shopA,
        actor_user_id: userSellerA,
        status: ImportJobStatus.PENDING,
        file_url: s3Key,
        total_rows: 1,
        processed_rows: 0,
        success_count: 0,
        error_count: 0,
        error_summary: [],
      });

      await workerService.processJob(jobId);

      // Verify that transactionRunner was executed exactly once in Stage 3
      expect(mockTransactionRunner.execute).toHaveBeenCalledTimes(1);
      expect(transactionDurations.length).toBe(1);

      // Transaction duration must be extremely fast (< 80ms)
      expect(transactionDurations[0]).toBeLessThan(80);
    });

    it('[NFR-IM-03] Worker Concurrency Semaphore: Max 3 concurrent workers enforced (GLOBAL_MAX_CONCURRENT_WORKERS = 3)', async () => {
      // Check active workers count
      expect(workerService.getActiveWorkersCount()).toBe(0);

      // Simulate 4 concurrent job processings
      const jobPromises: Promise<void>[] = [];
      const workerCountsDuringExec: number[] = [];

      for (let i = 1; i <= 4; i++) {
        const jobId = uuidv7();
        const s3Key = `imports/shop-${shopA}/${jobId}.xlsx`;
        const buffer = await createImportExcelBuffer([
          {
            refId: `REF-CONC-${i}`,
            title: `Sản phẩm kiểm tra semaphore đồng thời ${i}`,
            catId: catFashion,
            sku: `SKU-CONC-${i}`,
            price: 150000,
          },
        ]);
        s3StorageMap.set(s3Key, buffer);

        await inMemoryImportJobRepo.create({
          _id: jobId,
          shop_id: shopA,
          actor_user_id: userSellerA,
          status: ImportJobStatus.PENDING,
          file_url: s3Key,
          total_rows: 1,
          processed_rows: 0,
          success_count: 0,
          error_count: 0,
          error_summary: [],
        });

        jobPromises.push(
          (async () => {
            const p = workerService.processJob(jobId);
            workerCountsDuringExec.push(workerService.getActiveWorkersCount());
            await p;
          })(),
        );
      }

      await Promise.all(jobPromises);

      // The maximum observed concurrent workers must not exceed 3
      for (const count of workerCountsDuringExec) {
        expect(count).toBeLessThanOrEqual(3);
      }

      // After all finishes, active workers returns to 0
      expect(workerService.getActiveWorkersCount()).toBe(0);
    });
  });
});
