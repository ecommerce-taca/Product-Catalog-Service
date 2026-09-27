import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';

jest.mock('sanitize-html', () => {
  return jest.fn().mockImplementation((input: string) => {
    if (!input) return input;
    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '');
  });
});

import {
  SellerImportController,
  UploadedFilePayload,
} from '../../src/import/controllers/seller-import.controller';
import { ExcelTemplateService } from '../../src/import/services/excel-template.service';
import { ImportWorkerService } from '../../src/import/services/import-worker.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { ShopStatus } from '../../src/database/schemas/shop-snapshot.schema';
import { ActorContext } from '../../src/common/context/actor-context.interface';
import { ImportJobStatus } from '../../src/database/schemas/import-job.schema';

describe('SellerImportController - POST /seller/products/import', () => {
  let controller: SellerImportController;

  const mockExcelTemplateService = {
    generateTemplate: jest.fn(),
  };

  const mockShopSnapshotRepository = {
    findByShopId: jest.fn(),
  };

  const mockImportJobRepository = {
    findActiveJobByShop: jest.fn(),
    create: jest.fn(),
    reclaimStaleJobs: jest.fn().mockResolvedValue(0),
  };

  const mockImportWorkerService = {
    processJob: jest.fn().mockResolvedValue(undefined),
  };

  const mockS3StorageService = {
    uploadBuffer: jest.fn().mockResolvedValue(undefined),
  };

  const activeActor: ActorContext = {
    userId: '01912f10-0001-7000-8000-000000000001',
    roles: ['SELLER'],
    permissions: [],
    shopScope: '01912f20-0001-7000-8000-000000000001',
    isAuthenticated: true,
  };

  let validXlsxBuffer: Buffer;

  beforeAll(async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sản phẩm & Biến thể');
    ws.addRow(['product_ref_id', 'title', 'category_id', 'seller_sku', 'price']);
    ws.addRow(['REF-1', 'Áo thun thể thao nam mẫu 1', 'CAT-1', 'SKU-001', 150000]);
    const arrayBuf = await wb.xlsx.writeBuffer();
    validXlsxBuffer = Buffer.from(arrayBuf);
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerImportController],
      providers: [
        { provide: ExcelTemplateService, useValue: mockExcelTemplateService },
        {
          provide: SHOP_SNAPSHOT_REPOSITORY_PORT,
          useValue: mockShopSnapshotRepository,
        },
        {
          provide: 'ImportJobRepositoryPort',
          useValue: mockImportJobRepository,
        },
        {
          provide: ImportWorkerService,
          useValue: mockImportWorkerService,
        },
        {
          provide: S3StorageService,
          useValue: mockS3StorageService,
        },
      ],
    }).compile();

    controller = module.get<SellerImportController>(SellerImportController);
  });

  it('should accept valid .xlsx file and return 202 Accepted with PENDING status (AC-IM-04)', async () => {
    mockShopSnapshotRepository.findByShopId.mockResolvedValue({
      shop_id: activeActor.shopScope,
      shop_status: ShopStatus.ACTIVE,
    });
    mockImportJobRepository.findActiveJobByShop.mockResolvedValue(null);
    mockImportJobRepository.create.mockImplementation((dto) =>
      Promise.resolve({
        ...dto,
        created_at: new Date('2026-09-26T14:30:00.000Z'),
      }),
    );

    const validFile: UploadedFilePayload = {
      originalname: 'products.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: validXlsxBuffer.length,
      buffer: validXlsxBuffer,
    };

    const result = await controller.uploadImportFile(
      validFile,
      activeActor.shopScope!,
      activeActor,
    );

    expect(result).toBeDefined();
    expect(result.job_id).toBeDefined();
    expect(result.status).toBe(ImportJobStatus.PENDING);
    expect(result.message).toContain('đang xếp hàng');
    expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
      expect.stringContaining(`imports/shop-${activeActor.shopScope}/`),
      validXlsxBuffer,
      validFile.mimetype,
    );
    expect(mockImportJobRepository.reclaimStaleJobs).toHaveBeenCalled();
    expect(mockImportJobRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        shop_id: activeActor.shopScope,
        status: ImportJobStatus.PENDING,
      }),
    );
  });

  it('should throw 400 PRODUCT_IMPORT_FILE_TOO_LARGE when file exceeds 2MB (AC-IM-05)', async () => {
    const oversizeBuffer = Buffer.alloc(2 * 1024 * 1024 + 1); // 2MB + 1 byte
    // Prepend PK magic bytes
    oversizeBuffer[0] = 0x50;
    oversizeBuffer[1] = 0x4b;
    oversizeBuffer[2] = 0x03;
    oversizeBuffer[3] = 0x04;

    const file: UploadedFilePayload = {
      originalname: 'huge_products.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: oversizeBuffer.length,
      buffer: oversizeBuffer,
    };

    try {
      await controller.uploadImportFile(file, activeActor.shopScope!, activeActor);
      fail('Expected BadRequestException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BadRequestException);
      const res = (err as BadRequestException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_IMPORT_FILE_TOO_LARGE');
    }
  });

  it('should throw 400 PRODUCT_IMPORT_FILE_TYPE_INVALID when file format is not .xlsx (AC-IM-06)', async () => {
    const csvBuffer = Buffer.from('product_ref_id,title,seller_sku,price\nREF1,Title,SKU1,100000');
    const file: UploadedFilePayload = {
      originalname: 'products.csv',
      mimetype: 'text/csv',
      size: csvBuffer.length,
      buffer: csvBuffer,
    };

    try {
      await controller.uploadImportFile(file, activeActor.shopScope!, activeActor);
      fail('Expected BadRequestException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BadRequestException);
      const res = (err as BadRequestException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_IMPORT_FILE_TYPE_INVALID');
    }
  });

  it('should throw 400 PRODUCT_IMPORT_FILE_TYPE_INVALID when fake .xlsx has no zip magic bytes', async () => {
    const fakeBuffer = Buffer.from('this is plain text disguised as xlsx');
    const file: UploadedFilePayload = {
      originalname: 'fake.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: fakeBuffer.length,
      buffer: fakeBuffer,
    };

    try {
      await controller.uploadImportFile(file, activeActor.shopScope!, activeActor);
      fail('Expected BadRequestException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BadRequestException);
      const res = (err as BadRequestException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_IMPORT_FILE_TYPE_INVALID');
    }
  });

  it('should throw 400 PRODUCT_IMPORT_FILE_TYPE_INVALID when no file is uploaded', async () => {
    try {
      await controller.uploadImportFile(null as any, activeActor.shopScope!, activeActor);
      fail('Expected BadRequestException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(BadRequestException);
      const res = (err as BadRequestException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_IMPORT_FILE_TYPE_INVALID');
    }
  });

  it('should throw 409 PRODUCT_IMPORT_JOB_RUNNING when an active job is already running for the shop (AC-IM-07, BR-IM-06)', async () => {
    mockShopSnapshotRepository.findByShopId.mockResolvedValue({
      shop_id: activeActor.shopScope,
      shop_status: ShopStatus.ACTIVE,
    });
    mockImportJobRepository.findActiveJobByShop.mockResolvedValue({
      _id: '01912f20-9999-7000-8000-000000009999',
      shop_id: activeActor.shopScope,
      status: ImportJobStatus.PROCESSING,
    });

    const validFile: UploadedFilePayload = {
      originalname: 'products.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: validXlsxBuffer.length,
      buffer: validXlsxBuffer,
    };

    try {
      await controller.uploadImportFile(validFile, activeActor.shopScope!, activeActor);
      fail('Expected ConflictException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ConflictException);
      const res = (err as ConflictException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_IMPORT_JOB_RUNNING');
    }
  });

  it('should throw 403 PRODUCT_SHOP_SUSPENDED when shop is SUSPENDED (BR-IM-01)', async () => {
    mockShopSnapshotRepository.findByShopId.mockResolvedValue({
      shop_id: activeActor.shopScope,
      shop_status: ShopStatus.SUSPENDED,
    });

    const validFile: UploadedFilePayload = {
      originalname: 'products.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: validXlsxBuffer.length,
      buffer: validXlsxBuffer,
    };

    try {
      await controller.uploadImportFile(validFile, activeActor.shopScope!, activeActor);
      fail('Expected ForbiddenException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const res = (err as ForbiddenException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_SHOP_SUSPENDED');
    }
  });

  it('should throw 403 PRODUCT_FORBIDDEN when shopScope is missing', async () => {
    const validFile: UploadedFilePayload = {
      originalname: 'products.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: validXlsxBuffer.length,
      buffer: validXlsxBuffer,
    };

    try {
      await controller.uploadImportFile(validFile, '', {} as any);
      fail('Expected ForbiddenException');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const res = (err as ForbiddenException).getResponse() as any;
      expect(res.code).toBe('PRODUCT_FORBIDDEN');
    }
  });
});
