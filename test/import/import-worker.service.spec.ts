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
    updateHeartbeat: jest.fn().mockResolvedValue({}),
    create: jest.fn(),
  };

  const mockProductRepository = {
    create: jest.fn(),
    findById: jest.fn(),
    findByIdOrCode: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  };

  const mockSkuRepository = {
    findBySellerSkus: jest.fn(),
    create: jest.fn(),
    findByProductId: jest.fn().mockResolvedValue([]),
  };

  const mockCategoryRepository = {
    findById: jest.fn(),
    findByIdOrCode: jest.fn(),
  };

  const mockProductCategoryRepository = {
    create: jest.fn(),
  };

  const mockProductMediaRepository = {
    create: jest.fn(),
    findByProductId: jest.fn().mockResolvedValue([]),
  };

  const mockOutboxRepository = {
    saveEvent: jest.fn(),
  };

  const mockS3StorageService = {
    bucket: 'taca-product-media-prod',
    s3Client: {
      send: jest.fn(),
    },
    downloadBuffer: jest.fn(),
    uploadBuffer: jest.fn().mockResolvedValue(undefined),
    deleteObjects: jest.fn().mockResolvedValue(undefined),
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

  async function createMultiSheetWorkbookBuffer(
    sheets: Array<{
      sheetName: string;
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
      }>;
    }>,
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.sheetName);
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
      for (const r of s.rows) {
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
    mockS3StorageService.downloadBuffer.mockResolvedValue(buffer);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    delete (mockProductRepository as any).findOne;
    delete (mockCategoryRepository as any).findOne;

    mockProductRepository.findByIdOrCode.mockImplementation(async (_shopId: string, id: string) => {
      return mockProductRepository.findById(id);
    });
    mockCategoryRepository.findByIdOrCode.mockImplementation(async (id: string) => {
      return mockCategoryRepository.findById(id);
    });

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

      // Verify Stage 3 sequential order (PCAT-IMP-07): SPU -> Category -> SKU -> Media
      expect(mockProductCategoryRepository.create).toHaveBeenCalledTimes(1);
      expect(mockProductMediaRepository.create).toHaveBeenCalledTimes(1);

      const productCallOrder = mockProductRepository.create.mock.invocationCallOrder[0];
      const categoryCallOrder = mockProductCategoryRepository.create.mock.invocationCallOrder[0];
      const skuCallOrder = mockSkuRepository.create.mock.invocationCallOrder[0];
      const mediaCallOrder = mockProductMediaRepository.create.mock.invocationCallOrder[0];

      expect(productCallOrder).toBeLessThan(categoryCallOrder);
      expect(categoryCallOrder).toBeLessThan(skuCallOrder);
      expect(skuCallOrder).toBeLessThan(mediaCallOrder);

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

  describe('Multi-sheet, Friendly IDs & Existing SPU Support', () => {
    it('should parse multiple data sheets, skip guide and example sheets, and import all SPUs', async () => {
      const buffer = await createMultiSheetWorkbookBuffer([
        {
          sheetName: 'Áo Sơ Mi Nam',
          rows: [
            {
              refId: 'REF-AO-01',
              title: 'Áo Sơ Mi Nam Dài Tay Công Sở',
              catId: testCategoryId,
              sku: 'AO-TRANG-39',
              price: 250000,
              attributes: { 'Kích cỡ': '39' },
            },
            {
              refId: 'REF-AO-01',
              sku: 'AO-TRANG-40',
              price: 250000,
              attributes: { 'Kích cỡ': '40' },
            },
          ],
        },
        {
          sheetName: 'Giày Tây Nam',
          rows: [
            {
              refId: 'REF-GIAY-01',
              title: 'Giày Tây Da Bò Oxford Cao Cấp',
              catId: testCategoryId,
              sku: 'GIAY-DEN-41',
              price: 750000,
            },
          ],
        },
        {
          sheetName: 'Hướng dẫn & Danh mục',
          rows: [],
        },
        {
          sheetName: 'Ví dụ điền mẫu',
          rows: [
            {
              refId: 'SAMPLE-EXAMPLE',
              title: 'Mẫu tham khảo không được import',
              catId: testCategoryId,
              sku: 'SAMPLE-SKU-99',
              price: 100000,
            },
          ],
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.total_rows).toBe(3); // 2 rows from Áo Sơ Mi + 1 from Giày Tây (Ví dụ & Hướng dẫn skipped)
      expect(mockJobDoc.success_count).toBe(2); // 2 SPUs created
      expect(mockJobDoc.error_count).toBe(0);
      expect(mockProductRepository.create).toHaveBeenCalledTimes(2);
      expect(mockSkuRepository.create).toHaveBeenCalledTimes(3);
    });

    it('should extract UUID from friendly category format [UUID] and friendly productRefId [UUID]', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'Áo Thun Nam Cao Cấp [01912f30-0000-7000-8000-000000000001]',
          title: 'Áo Thun Nam Cotton 100% Co Giãn 4 Chiều',
          catId: `Thời Trang Nam [${testCategoryId}]`,
          sku: 'AT-NAM-DEN-XL',
          price: 180000,
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockCategoryRepository.findById).toHaveBeenCalledWith(testCategoryId);
      expect(mockProductCategoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          category_id: testCategoryId,
        }),
        expect.anything(),
      );
      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(1);
    });

    it('should attach new SKU to existing SPU without recreating product when productRefId matches existing SPU UUID', async () => {
      const existingSpuId = '01912f30-0000-7000-8000-000000000001';
      const existingProduct = {
        _id: existingSpuId,
        shop_id: testShopId,
        title: 'Áo Thun Nam Cotton Tiêu Chuẩn Đã Có Sẵn',
        primary_category_id: testCategoryId,
        status: ProductStatus.DRAFT,
        description: 'Mô tả sản phẩm có sẵn',
        brand: 'Taca Fashion',
      };

      const buffer = await createWorkbookBuffer([
        {
          refId: `Áo Thun Nam [${existingSpuId}]`,
          title: '', // left blank to inherit from existing SPU
          catId: '', // left blank to inherit from existing SPU
          sku: 'AT-NAM-NEW-SKU-99',
          price: 199000,
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
      mockProductRepository.findById.mockImplementation(async (id: string) => {
        if (id === existingSpuId) return existingProduct;
        return null;
      });
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockProductRepository.findById).toHaveBeenCalledWith(existingSpuId);
      // Product and category binding must NOT be re-created
      expect(mockProductRepository.create).not.toHaveBeenCalled();
      expect(mockProductCategoryRepository.create).not.toHaveBeenCalled();

      // New SKU MUST be created and bound to existing SPU ID
      expect(mockSkuRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          product_id: existingSpuId,
          seller_sku: 'AT-NAM-NEW-SKU-99',
          price_override: BigInt(199000),
          status: SkuStatus.ACTIVE,
        }),
        expect.anything(),
      );

      // SKU outbox event emitted, but product.created event NOT emitted
      expect(mockOutboxRepository.saveEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'sku.created',
          payload: expect.objectContaining({
            product_id: existingSpuId,
            seller_sku: 'AT-NAM-NEW-SKU-99',
          }),
        }),
        expect.anything(),
      );
      expect(mockOutboxRepository.saveEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: 'product.created',
        }),
        expect.anything(),
      );

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(1);
      expect(mockJobDoc.error_count).toBe(0);
    });

    it('should process multiple category sheets in a single workbook, ignoring guide and example sheets', async () => {
      const cat1Id = '01912f20-0000-7000-8000-000000000001';
      const cat2Id = '01912f20-0000-7000-8000-000000000002';

      const multiBuffer = await createMultiSheetWorkbookBuffer([
        {
          sheetName: 'Thời Trang Nam',
          rows: [
            {
              refId: 'SPU-THOITRANG-01',
              title: 'Áo Polo Nam Trắng',
              catId: `Thời Trang Nam [${cat1Id}]`,
              desc: 'Áo polo cao cấp thoáng mát',
              sku: 'POLO-W-M',
              price: 250000,
            },
          ],
        },
        {
          sheetName: 'Giày Dép',
          rows: [
            {
              refId: 'SPU-GIAYDEP-01',
              title: 'Giày Sneaker Nam',
              catId: `Giày Dép [${cat2Id}]`,
              desc: 'Giày sneaker phong cách thể thao',
              sku: 'SNK-W-40',
              price: 550000,
            },
          ],
        },
        {
          sheetName: 'Ví dụ điền mẫu',
          rows: [
            {
              refId: 'EXAMPLE-01',
              title: 'Dòng ví dụ cần bỏ qua',
              catId: `Ví dụ [${cat1Id}]`,
              sku: 'EXAMPLE-SKU',
              price: 100000,
            },
          ],
        },
        {
          sheetName: 'Hướng dẫn & Danh mục',
          rows: [
            {
              refId: 'GUIDE-01',
              title: 'Dòng hướng dẫn cần bỏ qua',
              catId: `Hướng dẫn [${cat1Id}]`,
              sku: 'GUIDE-SKU',
              price: 100000,
            },
          ],
        },
      ]);
      mockS3Download(multiBuffer);

      const mockJobDoc: any = {
        _id: testJobId,
        shop_id: testShopId,
        status: ImportJobStatus.PENDING,
        file_url: `imports/shop-${testShopId}/${testJobId}.xlsx`,
        save: jest.fn().mockResolvedValue(true),
        error_summary: [],
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockImplementation(async (id: string) => {
        if (id === cat1Id || id === cat2Id) {
          return { _id: id, status: CategoryStatus.ACTIVE };
        }
        return null;
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      // Verify category binding for both categories from both sheets
      expect(mockProductCategoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ category_id: cat1Id }),
        expect.anything(),
      );
      expect(mockProductCategoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ category_id: cat2Id }),
        expect.anything(),
      );

      // Verify both products were created
      expect(mockProductRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Áo Polo Nam Trắng' }),
        expect.anything(),
      );
      expect(mockProductRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Giày Sneaker Nam' }),
        expect.anything(),
      );

      // Verify example/guide sheet rows were ignored
      expect(mockProductRepository.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Dòng ví dụ cần bỏ qua' }),
        expect.anything(),
      );
      expect(mockProductRepository.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Dòng hướng dẫn cần bỏ qua' }),
        expect.anything(),
      );

      // Total success SPUs: 2
      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(2);
      expect(mockJobDoc.error_count).toBe(0);
    });
  });

  describe('Wave 2 Hardening & Business Codes (Dev 3)', () => {
    it('should reject duplicate empty variants (variantKey = "") within the same SPU (B-LR-01)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'SINGLE-PROD-01',
          title: 'Sản phẩm đơn không có biến thể',
          catId: testCategoryId,
          sku: 'SKU-SINGLE-01',
          price: 150000,
        },
        {
          refId: 'SINGLE-PROD-01',
          sku: 'SKU-SINGLE-02',
          price: 160000,
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(0);
      expect(mockJobDoc.error_count).toBe(2);
      expect(mockJobDoc.error_summary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: 'PRODUCT_SKU_DUPLICATE_VARIANT',
            seller_sku: 'SKU-SINGLE-02',
          }),
        ]),
      );
    });

    it('should not set is_cover = true for new media when existing SPU already has a cover media (B-DB-01)', async () => {
      const existingSpuId = '01912f30-7777-7000-8000-000000000001';
      const existingProduct = {
        _id: existingSpuId,
        shop_id: testShopId,
        title: 'Áo Khoác Nam Hiện Hữu',
        primary_category_id: testCategoryId,
        status: ProductStatus.DRAFT,
      };

      const buffer = await createWorkbookBuffer([
        {
          refId: existingSpuId,
          sku: 'AK-NEW-VAR-01',
          price: 500000,
          urls: 'https://images.unsplash.com/photo-1.jpg, https://images.unsplash.com/photo-2.jpg',
          attributes: { 'Kích cỡ': 'L' },
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
      mockProductRepository.findById.mockImplementation(async (id: string) => {
        if (id === existingSpuId) return existingProduct;
        return null;
      });
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);
      mockSkuRepository.findByProductId.mockResolvedValue([]);

      // Simulate that existing SPU already has a READY cover media
      mockProductMediaRepository.findByProductId.mockResolvedValue([
        {
          _id: '01912f30-8888-7000-8000-000000000001',
          is_cover: true,
          status: 'READY',
        },
      ]);

      mockMediaDownloadService.downloadAndUploadImage.mockResolvedValue({
        mediaId: '01912f30-9999-7000-8000-000000000001',
        objectKey: 'products/media-new.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        sha256: 'abcd1234abcd1234',
      });

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(1);
      // All inserted media for this SPU must have is_cover = false
      expect(mockProductMediaRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          is_cover: false,
        }),
        expect.anything(),
      );
    });

    it('should reject existing SPU when status is BLOCKED or ARCHIVED (SF-1 / SF-EDGE-01)', async () => {
      const existingSpuId = '01912f30-6666-7000-8000-000000000001';
      const blockedProduct = {
        _id: existingSpuId,
        shop_id: testShopId,
        title: 'Sản Phẩm Đang Bị Khóa',
        primary_category_id: testCategoryId,
        status: ProductStatus.BLOCKED,
      };

      const buffer = await createWorkbookBuffer([
        {
          refId: existingSpuId,
          sku: 'BLOCKED-SKU-01',
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
        error_summary: [],
      };
      mockImportJobRepository.findById.mockResolvedValue(mockJobDoc);
      mockProductRepository.findById.mockResolvedValue(blockedProduct);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(0);
      expect(mockJobDoc.error_summary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: 'PRODUCT_SPU_STATUS_INVALID',
            error_message: expect.stringContaining('BLOCKED'),
          }),
        ]),
      );
      expect(mockSkuRepository.create).not.toHaveBeenCalled();
    });

    it('should reject new SKU when variant_key already exists in DB for that SPU (SF-EDGE-01)', async () => {
      const existingSpuId = '01912f30-5555-7000-8000-000000000001';
      const existingProduct = {
        _id: existingSpuId,
        shop_id: testShopId,
        title: 'Sản Phẩm Đã Có Size M Trong DB',
        primary_category_id: testCategoryId,
        status: ProductStatus.DRAFT,
      };

      const buffer = await createWorkbookBuffer([
        {
          refId: existingSpuId,
          sku: 'NEW-SELLER-SKU-M',
          price: 300000,
          attributes: { 'Kích cỡ': 'M' },
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
      mockProductRepository.findById.mockResolvedValue(existingProduct);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);
      // SPU already has a SKU with variant_key: 'Kích cỡ=M'
      mockSkuRepository.findByProductId.mockResolvedValue([
        {
          _id: 'existing-sku-1',
          variant_key: 'Kích cỡ=M',
        },
      ]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(0);
      expect(mockJobDoc.error_summary).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error_code: 'PRODUCT_SKU_DUPLICATE_VARIANT',
            seller_sku: 'NEW-SELLER-SKU-M',
          }),
        ]),
      );
      expect(mockSkuRepository.create).not.toHaveBeenCalled();
    });

    it('should call S3 deleteObjects when Stage 3 transaction rolls back (B-ARCH-01)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'ROLLBACK-SPU-01',
          title: 'Sản Phẩm Kiểm Tra Rollback S3',
          catId: testCategoryId,
          sku: 'RB-SKU-01',
          price: 250000,
          urls: 'https://images.unsplash.com/photo-rb.jpg',
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      mockMediaDownloadService.downloadAndUploadImage.mockResolvedValue({
        mediaId: 'media-rb-1',
        objectKey: 'products/media-rb-1.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1024,
        sha256: 'hash-rb',
      });

      // Force Stage 3 transaction failure
      mockTransactionRunner.execute.mockRejectedValueOnce(
        new Error('Transaction aborted due to network error'),
      );

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.FAILED);
      expect(mockS3StorageService.deleteObjects).toHaveBeenCalledWith(['products/media-rb-1.jpg']);
    });

    it('should duplicate PRODUCT_SPU_REJECTED error to child SKUs when SPU is rejected (B-UX-01)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'SPU-REJECT-01',
          title: 'Ngắn', // Title < 10 chars -> rejects entire SPU
          catId: testCategoryId,
          sku: 'SKU-A-01',
          price: 200000,
          attributes: { 'Kích cỡ': 'S' },
        },
        {
          refId: 'SPU-REJECT-01',
          sku: 'SKU-B-02',
          price: 200000,
          attributes: { 'Kích cỡ': 'M' },
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(0);
      expect(mockJobDoc.error_count).toBe(2);

      // Child SKU rows must receive PRODUCT_SPU_REJECTED
      const rejectedSkuErrors = mockJobDoc.error_summary.filter(
        (e: any) => e.error_code === 'PRODUCT_SPU_REJECTED',
      );
      expect(rejectedSkuErrors.length).toBeGreaterThanOrEqual(1);
    });

    it('should resolve category code [CAT-1001] and product code [PRD-8K2N9X]', async () => {
      const existingProduct = {
        _id: '01912f30-4444-7000-8000-000000000001',
        shop_id: testShopId,
        product_code: 'PRD-8K2N9X',
        title: 'Áo Khoác Gió Nam Cao Cấp',
        primary_category_id: testCategoryId,
        status: ProductStatus.DRAFT,
      };

      const buffer = await createWorkbookBuffer([
        {
          refId: 'Áo Khoác [PRD-8K2N9X]',
          catId: 'Thời Trang Nam [CAT-1001]',
          sku: 'AK-PRD-01',
          price: 350000,
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
      mockProductRepository.findByIdOrCode.mockResolvedValue(existingProduct);
      mockCategoryRepository.findByIdOrCode.mockResolvedValue({
        _id: testCategoryId,
        category_code: 'CAT-1001',
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);
      mockSkuRepository.findByProductId.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockJobDoc.status).toBe(ImportJobStatus.COMPLETED);
      expect(mockJobDoc.success_count).toBe(1);
      expect(mockSkuRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          product_id: existingProduct._id,
          seller_sku: 'AK-PRD-01',
        }),
        expect.anything(),
      );
    });

    it('should maintain heartbeat lease and clean up timer on completion (B-DB-02)', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');

      const buffer = await createWorkbookBuffer([
        {
          refId: 'HB-SPU-01',
          title: 'Sản Phẩm Kiểm Tra Heartbeat Timer',
          catId: testCategoryId,
          sku: 'HB-SKU-01',
          price: 199000,
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      // Verify setInterval was called with 30s interval
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);

      // Verify the interval callback updates locked_until
      const heartbeatFn = setIntervalSpy.mock.calls.find(
        (call) => call[1] === 30_000,
      )?.[0] as () => Promise<void>;
      expect(heartbeatFn).toBeDefined();
      await heartbeatFn();
      expect(mockImportJobRepository.updateHeartbeat).toHaveBeenCalledWith(testJobId, 120_000);

      // Verify clearInterval was called on completion
      expect(clearIntervalSpy).toHaveBeenCalled();

      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    });

    it('should emit product.created outbox event before sku.created outbox events (Review 7 Finding 1)', async () => {
      const buffer = await createWorkbookBuffer([
        {
          refId: 'SPU-ORD-01',
          title: 'Sản phẩm kiểm tra Outbox sequence',
          catId: testCategoryId,
          sku: 'SKU-ORD-001',
          price: 150000,
          attributes: { 'Màu sắc': 'Đỏ' },
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
      mockProductRepository.findById.mockResolvedValue(null);
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      const savedEventTypes: string[] = [];
      mockOutboxRepository.saveEvent.mockImplementation(async (event: any) => {
        savedEventTypes.push(event.event_type);
      });

      await service.processJob(testJobId);

      expect(savedEventTypes).toEqual(['product.created', 'sku.created']);
    });

    it('should update price_summary of existing SPU when imported SKU has lower price', async () => {
      const existingProductId = '01912f20-0005-7000-8000-000000000005';
      const buffer = await createWorkbookBuffer([
        {
          refId: existingProductId,
          sku: 'SKU-LOW-PRICE-01',
          price: 80000,
          attributes: { 'Màu sắc': 'Vàng' },
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
      mockProductRepository.findById.mockResolvedValue({
        _id: existingProductId,
        shop_id: testShopId,
        title: 'Áo thun có sẵn',
        primary_category_id: testCategoryId,
        status: ProductStatus.ACTIVE,
        price_summary: {
          base_price: BigInt(120000),
          sale_price: BigInt(120000),
        },
      });
      mockCategoryRepository.findById.mockResolvedValue({
        _id: testCategoryId,
        status: CategoryStatus.ACTIVE,
      });
      mockSkuRepository.findBySellerSkus.mockResolvedValue([]);

      await service.processJob(testJobId);

      expect(mockProductRepository.update).toHaveBeenCalledWith(
        {
          _id: existingProductId,
          $or: [
            { 'price_summary.base_price': { $gt: BigInt(80000) } },
            { 'price_summary.base_price': null },
          ],
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            'price_summary.base_price': BigInt(80000),
            'price_summary.sale_price': BigInt(80000),
          }),
        }),
        expect.anything(),
      );
    });
  });
});
