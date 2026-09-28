import { ConflictException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Response } from 'express';

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
import { ImportWorkerService } from '../../src/import/services/import-worker.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { ShopStatus } from '../../src/database/schemas/shop-snapshot.schema';
import { ActorContext } from '../../src/common/context/actor-context.interface';

describe('SellerImportController', () => {
  let controller: SellerImportController;

  const mockExcelTemplateService = {
    generateTemplate: jest.fn(),
    getOrInitTemplate: jest.fn(),
  };

  const mockShopSnapshotRepository = {
    findByShopId: jest.fn(),
  };

  const mockResponse = () => {
    const res: Partial<Response> = {};
    res.set = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  const mockRequest = (headers: Record<string, string> = {}) => ({ headers }) as unknown as Request;

  const activeActor: ActorContext = {
    userId: '01912f10-0001-7000-8000-000000000001',
    roles: ['SELLER'],
    permissions: [],
    shopScope: '01912f20-0001-7000-8000-000000000001',
    isAuthenticated: true,
  };

  const mockImportJobRepository = {
    findActiveJobByShop: jest.fn(),
    reclaimStaleJobs: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
  };

  const mockImportWorkerService = {
    processJob: jest.fn().mockResolvedValue(undefined),
  };

  const mockS3StorageService = {
    uploadBuffer: jest.fn().mockResolvedValue(undefined),
  };

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

  describe('POST /seller/products/import/template', () => {
    const customDto = {
      row_count: 10,
      category_ids: ['0191ec4d-91b7-7e6d-9d41-000000000100'],
    };

    it('should get or init template and return JSON envelope with presigned URL', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockExcelTemplateService.getOrInitTemplate.mockResolvedValue({
        downloadUrl:
          'http://localhost:9000/templates/product_import_template_abcd1234efgh5678.xlsx',
        filename: 'product_import_template_abcd1234efgh5678.xlsx',
        expiresAt: new Date(),
      });

      const req = mockRequest();
      const res = mockResponse();
      await controller.downloadTemplate(
        customDto,
        activeActor.shopScope!,
        activeActor,
        res,
        req as any,
      );

      expect(mockShopSnapshotRepository.findByShopId).toHaveBeenCalledWith(activeActor.shopScope);
      expect(mockExcelTemplateService.getOrInitTemplate).toHaveBeenCalledWith(
        customDto,
        activeActor.shopScope,
      );
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            download_url: expect.stringContaining('product_import_template_'),
            filename: expect.stringContaining('product_import_template_'),
          }),
        }),
      );
    });

    it('should stream binary buffer when Accept header requests spreadsheet binary', async () => {
      const dummyBuffer = Buffer.from('mock custom excel binary');
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockExcelTemplateService.getOrInitTemplate.mockResolvedValue({
        downloadUrl: 'http://localhost:9000/templates/custom.xlsx',
        filename: 'product_import_template_test.xlsx',
        expiresAt: new Date(),
      });
      mockExcelTemplateService.generateTemplate.mockResolvedValue(dummyBuffer);

      const req = mockRequest({
        accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const res = mockResponse();
      await controller.downloadTemplate(
        customDto,
        activeActor.shopScope!,
        activeActor,
        res,
        req as any,
      );

      expect(mockExcelTemplateService.generateTemplate).toHaveBeenCalledWith(
        customDto,
        activeActor.shopScope,
      );
      expect(res.set).toHaveBeenCalledWith({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="product_import_template_test.xlsx"',
        'Content-Length': dummyBuffer.length.toString(),
      });
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.send).toHaveBeenCalledWith(dummyBuffer);
    });

    it('should throw 403 PRODUCT_SHOP_SUSPENDED when shop is SUSPENDED', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: '01912f20-8888-7000-8000-000000008888',
        shop_status: ShopStatus.SUSPENDED,
      });

      const res = mockResponse();
      await expect(
        controller.downloadTemplate(
          customDto,
          '01912f20-8888-7000-8000-000000008888',
          { ...activeActor, shopScope: '01912f20-8888-7000-8000-000000008888' },
          res,
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockExcelTemplateService.generateTemplate).not.toHaveBeenCalled();
    });

    it('should throw 403 PRODUCT_FORBIDDEN when shopScope is missing', async () => {
      const res = mockResponse();
      await expect(
        controller.downloadTemplate(customDto, '', { ...activeActor, shopScope: undefined }, res),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('POST /seller/products/import (uploadImportFile)', () => {
    const validFilePayload = {
      originalname: 'products.xlsx',
      mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      size: 1024,
      buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), // PK zip magic header
    };

    it('should successfully upload import file, create job, and return 202 ACCEPTED', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockImportJobRepository.findActiveJobByShop.mockResolvedValue(null);
      mockImportJobRepository.create.mockResolvedValue({
        _id: '01912f30-0001-7000-8000-000000000001',
        created_at: new Date(),
      });

      const result = await controller.uploadImportFile(
        validFilePayload,
        activeActor.shopScope!,
        activeActor,
      );

      expect(mockImportJobRepository.reclaimStaleJobs).toHaveBeenCalled();
      expect(mockImportJobRepository.findActiveJobByShop).toHaveBeenCalledWith(
        activeActor.shopScope,
      );
      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalled();
      expect(mockImportJobRepository.create).toHaveBeenCalled();
      expect(result).toEqual(
        expect.objectContaining({
          status: 'PENDING',
          message: expect.stringContaining('đã được tiếp nhận'),
        }),
      );
    });

    it('should throw 409 ConflictException when active job is found prior to creation', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockImportJobRepository.findActiveJobByShop.mockResolvedValue({
        _id: '01912f30-0001-7000-8000-000000000001',
        status: 'PROCESSING',
      });

      await expect(
        controller.uploadImportFile(validFilePayload, activeActor.shopScope!, activeActor),
      ).rejects.toThrow(ConflictException);

      expect(mockImportJobRepository.create).not.toHaveBeenCalled();
    });

    it('should catch MongoDB E11000 duplicate key on active job index and throw 409 ConflictException (B-DB-03 / SF-ARCH-03)', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockImportJobRepository.findActiveJobByShop.mockResolvedValue(null);
      // Simulate race condition where concurrent request created an active job first
      const mongoError = new Error(
        'E11000 duplicate key error collection: import_jobs index: idx_import_jobs_active_shop_unique dup key: { shop_id: "01912f20-0001-7000-8000-000000000001" }',
      );
      (mongoError as any).code = 11000;
      mockImportJobRepository.create.mockRejectedValue(mongoError);

      try {
        await controller.uploadImportFile(validFilePayload, activeActor.shopScope!, activeActor);
        fail('Expected ConflictException was not thrown');
      } catch (err: any) {
        expect(err).toBeInstanceOf(ConflictException);
        const response = err.getResponse();
        expect(response).toEqual({
          code: 'PRODUCT_IMPORT_JOB_RUNNING',
          message: 'Gian hàng đang có tiến trình nhập sản phẩm đang xử lý. Vui lòng chờ hoàn tất.',
        });
      }
    });
  });
});
