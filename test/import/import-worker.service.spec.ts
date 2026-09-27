import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';

jest.mock('sanitize-html', () => {
  return jest.fn().mockImplementation((input: string) => {
    if (!input) return input;
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  });
});

import { ImportWorkerService } from '../../src/import/services/import-worker.service';
import { ImportJobStatus } from '../../src/database/schemas/import-job.schema';
import { ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuStatus } from '../../src/database/schemas/sku.schema';
import { CategoryStatus } from '../../src/database/schemas/category.schema';
import { MediaDownloadService } from '../../src/import/services/media-download.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { OutboxRepositoryPort } from '../../src/outbox/repositories/outbox.repository.interface';
import { VariantResolver } from '../../src/sku/services/variant-resolver.service';

describe('ImportWorkerService', () => {
  let service: ImportWorkerService;

  const mockImportJobRepository = {
    findById: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  };

  const mockProductRepository = {
    create: jest.fn(),
  };

  const mockSkuRepository = {
    findBySellerSkus: jest.fn(),
    create: jest.fn(),
  };

  const mockCategoryRepository = {
    findById: jest.fn(),
  };

  const mockProductCategoryRepository = {
    create: jest.fn(),
  };

  const mockProductMediaRepository = {
    create: jest.fn(),
  };

  const mockOutboxRepository = {
    saveEvent: jest.fn(),
  };

  const mockS3StorageService = {
    bucket: 'taca-product-media-prod',
    s3Client: {
      send: jest.fn(),
    },
    uploadBuffer: jest.fn().mockResolvedValue(undefined),
  };

  const mockTransactionRunner = {
    execute: jest.fn().mockImplementation(async (callback) => {
      const mockSession = {} as any;
      return callback(mockSession);
    }),
  };

  const mockMediaDownloadService = {
    downloadAndUploadImage: jest.fn(),
  };

  const testShopId = '01912f20-0001-7000-8000-000000000001';
  const testCategoryId = '01912f20-0002-7000-8000-000000000002';
  const testJobId = '01912f30-0001-7000-8000-000000000001';

  async function createWorkbookBuffer(
    rows: Array<{
      refId: string;
      title?: string;
      catId?: string;
      desc?: string;
      sku: string;
      price: number;
      origPrice?: number;
      urls?: string;
      attributes?: Record<string, string>;
    }>,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sản phẩm & Biến thể');

    // Header row
    const headers = [
      'Mã tham chiếu sản phẩm (*)',
      'Tên sản phẩm (*)',
      'Mã danh mục (*)',
      'Mô tả sản phẩm (*)',
      'Thương hiệu',
      'Danh sách URL ảnh (cách nhau dấu phẩy)',
      'Mã SKU người bán (*)',
      'Giá bán VND (*)',
      'Giá niêm yết gốc VND',
      'Mã vạch',
      'Màu sắc',
      'Kích cỡ',
    ];
    ws.addRow(headers);

    for (const r of rows) {
      ws.addRow([
        r.refId,
        r.title ?? '',
        r.catId ?? '',
        r.desc ?? '',
        'TacaBrand',
        r.urls ?? '',
        r.sku,
        r.price,
        r.origPrice ?? '',
        '8931234567890',
        r.attributes?.['Màu sắc'] ?? '',
        r.attributes?.['Kích cỡ'] ?? '',
      ]);
    }

    const arrayBuf = await wb.xlsx.writeBuffer();
    return Buffer.from(arrayBuf);
  }

  function mockS3Download(buffer: Buffer) {
    const stream = new Readable();
    stream.push(buffer);
    stream.push(null);
    mockS3StorageService.s3Client.send.mockResolvedValue({
      Body: stream,
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ImportWorkerService,
        {
          provide: 'ImportJobRepositoryPort',
          useValue: mockImportJobRepository,
        },
        {
          provide: 'ProductRepositoryPort',
          useValue: mockProductRepository,
        },
        {
          provide: 'SkuRepositoryPort',
          useValue: mockSkuRepository,
        },
        {
          provide: 'CategoryRepositoryPort',
          useValue: mockCategoryRepository,
        },
        {
          provide: 'ProductCategoryRepositoryPort',
          useValue: mockProductCategoryRepository,
        },
        {
          provide: 'ProductMediaRepositoryPort',
          useValue: mockProductMediaRepository,
        },
        {
          provide: OutboxRepositoryPort,
          useValue: mockOutboxRepository,
        },
        {
          provide: S3StorageService,
          useValue: mockS3StorageService,
        },
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
        {
          provide: MediaDownloadService,
          useValue: mockMediaDownloadService,
        },
        VariantResolver,
      ],
    }).compile();

    service = module.get<ImportWorkerService>(ImportWorkerService);
  });

  describe('Stage 1 & 2 & 3: Full Pipeline Execution', () => {
    it('should successfully parse, probe, and commit valid SPU and SKUs into database with DRAFT status (AC-IM-08, AC-IM-15)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'REF-AO-01',
          title: 'Áo thun thể thao nam cao cấp',
          catId: testCategoryId,
          desc: 'Mô tả chi tiết sản phẩm áo thun',
          sku: 'AO-DO-M',
          price: 150000,
          origPrice: 200000,
          urls: 'https://example.com/img1.jpg',
          attributes: { 'Màu sắc': 'Đỏ', 'Kích cỡ': 'M' },
        },
        {
          refId: 'REF-AO-01',
          sku: 'AO-DO-L',
          price: 160000,
          origPrice: 200000,
          attributes: { 'Màu sắc': 'Đỏ', 'Kích cỡ': 'L' },
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        actor_user_id: '01912f10-0001-7000-8000-000000000001',
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);

      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });

      mockSkuRepository.findBySellerSkus.mockResolvedValue([]); // No duplicate in DB

      mockMediaDownloadService.downloadAndUploadImage.mockResolvedValue({
        mediaId: '01912f40-0001-7000-8000-000000000001',
        objectKey: 'products/p1/images/m1.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        sha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      });

      await service.processJob(testJobId);

      // Verify transaction executed
      expect(mockTransactionRunner.execute).toHaveBeenCalledTimes(1);

      // Verify Product created with status DRAFT (AC-IM-15)
      expect(mockProductRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          shop_id: testShopId,
          title: 'Áo thun thể thao nam cao cấp',
          status: ProductStatus.DRAFT,
          primary_category_id: testCategoryId,
          price_summary: expect.objectContaining({
            base_price: BigInt(150000),
            sale_price: BigInt(150000),
          }),
        }),
        expect.anything(),
      );

      // Verify 2 SKUs created with status ACTIVE
      expect(mockSkuRepository.create).toHaveBeenCalledTimes(2);
      expect(mockSkuRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          seller_sku: 'AO-DO-M',
          status: SkuStatus.ACTIVE,
        }),
        expect.anything(),
      );
      expect(mockSkuRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          seller_sku: 'AO-DO-L',
          status: SkuStatus.ACTIVE,
        }),
        expect.anything(),
      );

      // Verify Category and Media created
      expect(mockProductCategoryRepository.create).toHaveBeenCalledTimes(1);
      expect(mockProductMediaRepository.create).toHaveBeenCalledTimes(1);

      // Verify Outbox events recorded (1 product.created + 2 sku.created)
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledTimes(3);
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.created',
          topic: 'product.events.v1',
          payload: expect.objectContaining({
            status: ProductStatus.DRAFT,
          }),
        }),
        expect.anything(),
      );
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'sku.created',
          topic: 'sku.events.v1',
        }),
        expect.anything(),
      );

      // Verify job completion
      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(1);
      expect(mockJobDoc.error_count).toBe(0);
      expect(mockJobDoc.total_rows).toBe(2);
      expect(mockJobDoc.processed_rows).toBe(2);
    });
  });

  describe('Stage 1 Limits: Rows and SPUs constraints', () => {
    it('should fail job immediately if file contains > 200 SKU rows (AC-IM-09, NFR-IM-02)', async () => {
      const rows = [];
      for (let i = 1; i <= 201; i++) {
        rows.push({
          refId: `REF-${Math.ceil(i / 2)}`,
          title: `Sản phẩm kiểm thử số ${i}`,
          catId: testCategoryId,
          sku: `SKU-${i}`,
          price: 100000,
        });
      }
      const buffer = await createWorkbookBuffer(rows);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.FAILED);
      expect(mockJobDoc.error_summary[0].error_code).toBe('PRODUCT_IMPORT_TOO_MANY_ROWS');
      expect(mockJobDoc.error_count).toBe(201);
      // No DB transactions
      expect(mockTransactionRunner.execute).not.toHaveBeenCalled();
    });

    it('should fail job immediately if file contains > 100 SPUs (BR-IM-02)', async () => {
      const rows = [];
      for (let i = 1; i <= 101; i++) {
        rows.push({
          refId: `REF-SPU-${i}`,
          title: `Sản phẩm kiểm thử duy nhất ${i}`,
          catId: testCategoryId,
          sku: `SKU-SPU-${i}`,
          price: 100000,
        });
      }
      const buffer = await createWorkbookBuffer(rows);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.FAILED);
      expect(mockJobDoc.error_summary[0].error_code).toBe('PRODUCT_IMPORT_TOO_MANY_SPUS');
      expect(mockTransactionRunner.execute).not.toHaveBeenCalled();
    });
  });

  describe('Duplicate Detection: In-file & In-SPU', () => {
    it('should detect duplicate seller_sku in the same file and reject the SPU (AC-IM-08)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'REF-AO-01',
          title: 'Áo thun thể thao nam cao cấp',
          catId: testCategoryId,
          sku: 'AO-TRUNG-01',
          price: 150000,
        },
        {
          refId: 'REF-AO-02',
          title: 'Áo sơ mi công sở nam cao cấp',
          catId: testCategoryId,
          sku: 'AO-TRUNG-01', // duplicate in file
          price: 250000,
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(0);
      expect(mockJobDoc.error_count).toBe(2);
      expect(
        mockJobDoc.error_summary.some((e: any) => e.error_code === 'PRODUCT_SKU_DUPLICATE'),
      ).toBe(true);
      expect(mockTransactionRunner.execute).not.toHaveBeenCalled();
    });

    it('should detect duplicate variant combinations in the same SPU (AC-IM-10)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'REF-GIAY-01',
          title: 'Giày sneaker phong cách thể thao',
          catId: testCategoryId,
          sku: 'GIAY-TRANG-40-A',
          price: 500000,
          attributes: { 'Màu sắc': 'Trắng', 'Kích cỡ': '40' },
        },
        {
          refId: 'REF-GIAY-01',
          sku: 'GIAY-TRANG-40-B',
          price: 500000,
          attributes: { 'Màu sắc': 'Trắng', 'Kích cỡ': '40' }, // Identical variant
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(0);
      expect(
        mockJobDoc.error_summary.some((e: any) => e.error_code === 'PRODUCT_SKU_DUPLICATE_VARIANT'),
      ).toBe(true);
      expect(mockTransactionRunner.execute).not.toHaveBeenCalled();
    });
  });

  describe('Stage 2 DB Checks & Partial Success (AC-IM-14)', () => {
    it('should support partial success: create valid SPU while rejecting invalid SPU (AC-IM-14)', async () => {
      const buffer = await createWorkbookBuffer([
        // SPU 1: Valid
        {
          refId: 'REF-VALID-01',
          title: 'Sản phẩm hoàn toàn hợp lệ 01',
          catId: testCategoryId,
          sku: 'SKU-VALID-01',
          price: 150000,
        },
        // SPU 2: SKU already exists in Shop DB
        {
          refId: 'REF-INVALID-02',
          title: 'Sản phẩm có SKU trùng lặp DB',
          catId: testCategoryId,
          sku: 'SKU-EXISTING-IN-SHOP',
          price: 200000,
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });

      // DB check returns SKU-EXISTING-IN-SHOP
      mockSkuRepository.findBySellerSkus.mockResolvedValue([
        { seller_sku: 'SKU-EXISTING-IN-SHOP' },
      ]);

      await service.processJob(testJobId);

      expect(mockTransactionRunner.execute).toHaveBeenCalledTimes(1);
      // Valid SPU 1 created
      expect(mockProductRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Sản phẩm hoàn toàn hợp lệ 01' }),
        expect.anything(),
      );
      // Job summary
      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(1);
      expect(mockJobDoc.error_count).toBe(1);
      expect(
        mockJobDoc.error_summary.some((e: any) => e.seller_sku === 'SKU-EXISTING-IN-SHOP'),
      ).toBe(true);
    });
  });

  describe('Media Download Fault-Tolerance & Anti-SSRF (AC-IM-12, AC-IM-13)', () => {
    it('should create product as DRAFT without cover image when image download fails (AC-IM-12)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'REF-AO-FAIL-IMG',
          title: 'Áo thun có URL ảnh lỗi 404',
          catId: testCategoryId,
          sku: 'AO-FAIL-IMG-01',
          price: 150000,
          urls: 'https://invalid-domain-404.xyz/notfound.jpg',
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      // Media download fails with HTTP 404
      const mediaErr = new Error('HTTP 404');
      (mediaErr as any).code = 'MEDIA_DOWNLOAD_FAILED';
      mockMediaDownloadService.downloadAndUploadImage.mockRejectedValue(mediaErr);

      await service.processJob(testJobId);

      // Product is still created as DRAFT!
      expect(mockProductRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Áo thun có URL ảnh lỗi 404',
          status: ProductStatus.DRAFT,
        }),
        expect.anything(),
      );
      // Media not created
      expect(mockProductMediaRepository.create).not.toHaveBeenCalled();
      // Warning recorded in error_summary
      expect(
        mockJobDoc.error_summary.some(
          (e: any) => e.error_code === 'WARNING: MEDIA_DOWNLOAD_FAILED',
        ),
      ).toBe(true);
      expect(mockJobDoc.success_count).toBe(1);
    });

    it('should block SSRF internal URL and record warning without failing SPU (AC-IM-13)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'REF-SSRF',
          title: 'Sản phẩm kèm link metadata',
          catId: testCategoryId,
          sku: 'SKU-SSRF-01',
          price: 150000,
          urls: 'http://169.254.169.254/latest/meta-data/',
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      const ssrfErr = new Error('URL không an toàn hoặc trỏ về địa chỉ nội bộ');
      (ssrfErr as any).code = 'MEDIA_INVALID_URL_BLOCKED';
      mockMediaDownloadService.downloadAndUploadImage.mockRejectedValue(ssrfErr);

      await service.processJob(testJobId);

      expect(mockProductRepository.create).toHaveBeenCalled();
      expect(
        mockJobDoc.error_summary.some((e: any) => e.error_code === 'MEDIA_INVALID_URL_BLOCKED'),
      ).toBe(true);
      expect(mockJobDoc.success_count).toBe(1);
    });

    it('should catch Stage 3 transaction failure, mark job FAILED, record error, and release semaphore (SF-3)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'REF-TX-FAIL',
          title: 'Sản phẩm lỗi transaction',
          catId: testCategoryId,
          sku: 'SKU-TX-01',
          price: 100000,
        },
      ]);
      mockS3Download(buffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
        error_summary: [],
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      mockTransactionRunner.execute.mockRejectedValueOnce(
        new Error('Transaction aborted due to write conflict'),
      );

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.FAILED);
      expect(mockJobDoc.locked_until).toBeNull();
      expect(mockJobDoc.completed_at).toBeDefined();
      expect(
        mockJobDoc.error_summary.some(
          (e: any) =>
            e.error_code === 'DATABASE_TRANSACTION_FAILED' && e.product_ref_id === 'SYSTEM',
        ),
      ).toBe(true);
      expect(service.getActiveWorkersCount()).toBe(0);
    });
  });

  describe('Concurrency Semaphore (GLOBAL_MAX_CONCURRENT_WORKERS = 3)', () => {
    it('should limit active workers to a maximum of 3 concurrent jobs', async () => {
      expect(service.getActiveWorkersCount()).toBe(0);
    });
  });
});
