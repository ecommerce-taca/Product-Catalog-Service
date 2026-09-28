import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';

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
import { ExcelResultService } from '../../src/import/services/excel-result.service';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from '../../src/projections/repositories/shop-snapshot.repository.interface';
import { ImportJobDocument, ImportJobStatus } from '../../src/database/schemas/import-job.schema';
import { ActorContext } from '../../src/common/context/actor-context.interface';

describe('SellerImportController - Tracking & Result Export (FR-IM-06)', () => {
  let controller: SellerImportController;

  const mockExcelTemplateService = {
    generateTemplate: jest.fn(),
    getOrInitTemplate: jest.fn(),
  };

  const mockShopSnapshotRepository = {
    findByShopId: jest.fn(),
  };

  const mockImportJobRepository = {
    findById: jest.fn(),
    findActiveJobByShop: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };

  const mockImportWorkerService = {
    processJob: jest.fn(),
  };

  const mockS3StorageService = {
    generatePresignedDownloadUrl: jest.fn(),
  };

  const mockExcelResultService = {
    generateResultBuffer: jest.fn(),
    generateAndUploadResultFile: jest.fn(),
  };

  const activeActor: ActorContext = {
    userId: '01912f10-0001-7000-8000-000000000001',
    roles: ['SELLER'],
    permissions: [],
    shopScope: '01912f20-0001-7000-8000-000000000001',
    isAuthenticated: true,
  };

  const mockResponse = () => {
    const res: Partial<Response> = {};
    res.set = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res as Response;
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerImportController],
      providers: [
        { provide: ExcelTemplateService, useValue: mockExcelTemplateService },
        { provide: SHOP_SNAPSHOT_REPOSITORY_PORT, useValue: mockShopSnapshotRepository },
        { provide: 'ImportJobRepositoryPort', useValue: mockImportJobRepository },
        { provide: ImportWorkerService, useValue: mockImportWorkerService },
        { provide: S3StorageService, useValue: mockS3StorageService },
        { provide: ExcelResultService, useValue: mockExcelResultService },
      ],
    }).compile();

    controller = module.get<SellerImportController>(SellerImportController);
  });

  describe('GET /seller/products/import/jobs/:jobId (Real-time Progress - AC-IM-16)', () => {
    it('should return progress data when jobId exists and belongs to actor shop', async () => {
      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: activeActor.shopScope,
        status: ImportJobStatus.PROCESSING,
        total_rows: 500,
        processed_rows: 250,
        success_count: 40,
        error_count: 10,
        started_at: new Date('2026-09-26T14:30:00.000Z'),
        completed_at: null,
        created_at: new Date('2026-09-26T14:29:00.000Z'),
        error_summary: [],
      };

      mockImportJobRepository.findById.mockResolvedValueOnce(mockJob);

      const result = await controller.getJobProgress(
        '01923456-789a-7bc8-9def-0123456789ab',
        activeActor.shopScope!,
        activeActor,
      );

      expect(mockImportJobRepository.findById).toHaveBeenCalledWith(
        '01923456-789a-7bc8-9def-0123456789ab',
      );
      expect(result.job_id).toBe('01923456-789a-7bc8-9def-0123456789ab');
      expect(result.status).toBe(ImportJobStatus.PROCESSING);
      expect(result.total_rows).toBe(500);
      expect(result.processed_rows).toBe(250);
      expect(result.success_count).toBe(40);
      expect(result.error_count).toBe(10);
    });

    it('should throw 400 PRODUCT_INVALID_INPUT when jobId is not a valid UUID', async () => {
      await expect(
        controller.getJobProgress('not-a-valid-uuid', activeActor.shopScope!, activeActor),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 403 PRODUCT_FORBIDDEN when shopScope is missing', async () => {
      await expect(
        controller.getJobProgress('01923456-789a-7bc8-9def-0123456789ab', '', {
          ...activeActor,
          shopScope: undefined,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw 404 PRODUCT_NOT_FOUND when job does not exist', async () => {
      mockImportJobRepository.findById.mockResolvedValueOnce(null);

      await expect(
        controller.getJobProgress(
          '01923456-789a-7bc8-9def-0123456789ab',
          activeActor.shopScope!,
          activeActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 404 PRODUCT_NOT_FOUND on IDOR attempt (job belongs to another shop - AC-IM-18)', async () => {
      const otherShopJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-9999-7000-8000-000000009999', // Different shop
        status: ImportJobStatus.COMPLETED,
        total_rows: 10,
        processed_rows: 10,
        success_count: 10,
        error_count: 0,
      };

      mockImportJobRepository.findById.mockResolvedValueOnce(otherShopJob);

      await expect(
        controller.getJobProgress(
          '01923456-789a-7bc8-9def-0123456789ab',
          activeActor.shopScope!,
          activeActor,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /seller/products/import/jobs/:jobId/result (Error Result Export - AC-IM-17)', () => {
    const completedJobWithErrors: Partial<ImportJobDocument> = {
      _id: '01923456-789a-7bc8-9def-0123456789ab',
      shop_id: activeActor.shopScope,
      status: ImportJobStatus.COMPLETED,
      total_rows: 10,
      processed_rows: 10,
      success_count: 8,
      error_count: 2,
      result_file_url: 'imports/shop-01/01923456-errors.xlsx',
      error_summary: [
        {
          row_index: 2,
          product_ref_id: 'REF-01',
          seller_sku: 'SKU-01',
          error_code: 'PRODUCT_SKU_DUPLICATE',
          error_message: 'Mã seller_sku đã tồn tại',
        },
      ],
    };

    it('should throw 400 PRODUCT_IMPORT_JOB_NOT_FINISHED when job is still PENDING or PROCESSING', async () => {
      mockImportJobRepository.findById.mockResolvedValueOnce({
        ...completedJobWithErrors,
        status: ImportJobStatus.PROCESSING,
      });

      const req = { headers: {} } as Request;
      const res = mockResponse();

      await expect(
        controller.getJobResult(
          '01923456-789a-7bc8-9def-0123456789ab',
          activeActor.shopScope!,
          activeActor,
          req,
          res,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 400 PRODUCT_IMPORT_NO_ERRORS when job has 0 errors (100% success)', async () => {
      mockImportJobRepository.findById.mockResolvedValueOnce({
        ...completedJobWithErrors,
        error_count: 0,
        error_summary: [],
      });

      const req = { headers: {} } as Request;
      const res = mockResponse();

      await expect(
        controller.getJobResult(
          '01923456-789a-7bc8-9def-0123456789ab',
          activeActor.shopScope!,
          activeActor,
          req,
          res,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 404 PRODUCT_NOT_FOUND on IDOR attempt for result export (AC-IM-18)', async () => {
      mockImportJobRepository.findById.mockResolvedValueOnce({
        ...completedJobWithErrors,
        shop_id: '01912f20-9999-7000-8000-000000009999', // Other shop
      });

      const req = { headers: {} } as Request;
      const res = mockResponse();

      await expect(
        controller.getJobResult(
          '01923456-789a-7bc8-9def-0123456789ab',
          activeActor.shopScope!,
          activeActor,
          req,
          res,
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return JSON with presigned download URL when Accept includes application/json', async () => {
      mockImportJobRepository.findById.mockResolvedValueOnce(completedJobWithErrors);
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValueOnce({
        downloadUrl: 'https://s3.example.com/imports/presigned-result.xlsx',
        expiresAt: new Date(Date.now() + 1800 * 1000),
      });

      const req = { headers: { accept: 'application/json' } } as unknown as Request;
      const res = mockResponse();

      await controller.getJobResult(
        '01923456-789a-7bc8-9def-0123456789ab',
        activeActor.shopScope!,
        activeActor,
        req,
        res,
      );

      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            job_id: '01923456-789a-7bc8-9def-0123456789ab',
            result_file_url: 'https://s3.example.com/imports/presigned-result.xlsx',
            total_rows: 10,
            success_count: 8,
            error_count: 2,
          }),
          meta: expect.objectContaining({
            as_of: expect.any(String),
          }),
        }),
      );
    });

    it('should stream binary .xlsx attachment when Accept header is not application/json (AC-IM-17)', async () => {
      mockImportJobRepository.findById.mockResolvedValueOnce(completedJobWithErrors);
      const dummyBuffer = Buffer.from('mock excel result binary content');
      mockExcelResultService.generateResultBuffer.mockResolvedValueOnce(dummyBuffer);

      const req = {
        headers: { accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      } as unknown as Request;
      const res = mockResponse();

      await controller.getJobResult(
        '01923456-789a-7bc8-9def-0123456789ab',
        activeActor.shopScope!,
        activeActor,
        req,
        res,
      );

      expect(mockExcelResultService.generateResultBuffer).toHaveBeenCalled();
      expect(res.set).toHaveBeenCalledWith({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition':
          'attachment; filename="import_errors_01923456-789a-7bc8-9def-0123456789ab.xlsx"',
        'Content-Length': dummyBuffer.length.toString(),
      });
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.send).toHaveBeenCalledWith(dummyBuffer);
    });
  });
});
