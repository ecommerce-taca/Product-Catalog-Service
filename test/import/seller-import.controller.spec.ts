import { ForbiddenException, HttpStatus } from '@nestjs/common';
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

  describe('GET /seller/products/import/template', () => {
    it('should get or init template and return JSON envelope with presigned URL (AC-IM-01)', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockExcelTemplateService.getOrInitTemplate.mockResolvedValue({
        downloadUrl:
          'http://localhost:9000/taca-product-media-prod/templates/product_import_template_01912f20-0000-7000-8000-000000000001.xlsx',
        filename: 'product_import_template_01912f20-0000-7000-8000-000000000001.xlsx',
        expiresAt: new Date(),
      });

      const req = mockRequest();
      const res = mockResponse();
      await controller.downloadTemplate(
        { category_id: '01912f20-0000-7000-8000-000000000001' },
        activeActor.shopScope!,
        activeActor,
        res,
        req as any,
      );

      expect(mockShopSnapshotRepository.findByShopId).toHaveBeenCalledWith(activeActor.shopScope);
      expect(mockExcelTemplateService.getOrInitTemplate).toHaveBeenCalledWith(
        '01912f20-0000-7000-8000-000000000001',
      );
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            download_url: expect.stringContaining(
              'product_import_template_01912f20-0000-7000-8000-000000000001.xlsx',
            ),
            filename: 'product_import_template_01912f20-0000-7000-8000-000000000001.xlsx',
          }),
        }),
      );
    });

    it('should stream binary buffer when client explicitly requests binary spreadsheet in Accept header', async () => {
      const dummyBuffer = Buffer.from('mock excel binary');
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: activeActor.shopScope,
        shop_status: ShopStatus.ACTIVE,
      });
      mockExcelTemplateService.getOrInitTemplate.mockResolvedValue({
        downloadUrl: 'http://localhost:9000/templates/default.xlsx',
        filename: 'product_import_template_default.xlsx',
        expiresAt: new Date(),
      });
      mockExcelTemplateService.generateTemplate.mockResolvedValue(dummyBuffer);

      const req = mockRequest({
        accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const res = mockResponse();
      await controller.downloadTemplate({}, activeActor.shopScope!, activeActor, res, req as any);

      expect(mockExcelTemplateService.generateTemplate).toHaveBeenCalledWith(undefined);
      expect(res.set).toHaveBeenCalledWith({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="product_import_template_default.xlsx"',
        'Content-Length': dummyBuffer.length.toString(),
      });
      expect(res.status).toHaveBeenCalledWith(HttpStatus.OK);
      expect(res.send).toHaveBeenCalledWith(dummyBuffer);
    });

    it('should throw 403 PRODUCT_SHOP_SUSPENDED when shop is SUSPENDED (AC-IM-02, BR-IM-01)', async () => {
      mockShopSnapshotRepository.findByShopId.mockResolvedValue({
        shop_id: '01912f20-8888-7000-8000-000000008888',
        shop_status: ShopStatus.SUSPENDED,
      });

      const res = mockResponse();
      await expect(
        controller.downloadTemplate(
          { category_id: '01912f20-0000-7000-8000-000000000001' },
          '01912f20-8888-7000-8000-000000008888',
          { ...activeActor, shopScope: '01912f20-8888-7000-8000-000000008888' },
          res,
        ),
      ).rejects.toThrow(ForbiddenException);

      try {
        await controller.downloadTemplate(
          { category_id: '01912f20-0000-7000-8000-000000000001' },
          '01912f20-8888-7000-8000-000000008888',
          { ...activeActor, shopScope: '01912f20-8888-7000-8000-000000008888' },
          res,
        );
      } catch (err: unknown) {
        const error = err as ForbiddenException;
        const body = error.getResponse() as Record<string, unknown>;
        expect(body.code).toBe('PRODUCT_SHOP_SUSPENDED');
      }

      expect(mockExcelTemplateService.generateTemplate).not.toHaveBeenCalled();
    });

    it('should throw 403 PRODUCT_FORBIDDEN when shopScope is missing', async () => {
      const res = mockResponse();
      await expect(
        controller.downloadTemplate({}, '', { ...activeActor, shopScope: undefined }, res),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
