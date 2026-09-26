import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  ExportService,
  PRODUCT_EXPORT_MAX_ROWS,
  PRODUCT_EXPORT_URL_TTL,
} from '../../src/export/services/export.service';
import { ExportFormat } from '../../src/export/dto/export-products.dto';
import { ProductStatus } from '../../src/database/schemas/product.schema';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';

describe('ExportService', () => {
  let service: ExportService;

  const mockProductRepository = {
    find: jest.fn(),
    count: jest.fn(),
  };

  const mockSkuRepository = {
    find: jest.fn(),
  };

  const mockCategoryRepository = {
    find: jest.fn(),
  };

  const mockS3StorageService = {
    uploadBuffer: jest.fn(),
    generatePresignedDownloadUrl: jest.fn(),
  };

  const sampleProduct = {
    _id: 'prod-01',
    shop_id: 'shop-01',
    title: 'Áo khoác cotton',
    slug: 'ao-khoac-cotton',
    status: ProductStatus.ACTIVE,
    primary_category_id: 'cat-01',
    price_summary: {
      base_price: BigInt(299000),
      sale_price: BigInt(249000),
      currency: 'VND',
    },
    updated_at: new Date('2026-08-30T09:00:00Z'),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportService,
        { provide: 'ProductRepositoryPort', useValue: mockProductRepository },
        { provide: 'SkuRepositoryPort', useValue: mockSkuRepository },
        { provide: 'CategoryRepositoryPort', useValue: mockCategoryRepository },
        { provide: S3StorageService, useValue: mockS3StorageService },
      ],
    }).compile();

    service = module.get<ExportService>(ExportService);
  });

  describe('exportProducts', () => {
    it('should query products, format CSV, upload to S3, and return presigned URL', async () => {
      mockProductRepository.count.mockResolvedValue(1);
      mockProductRepository.find.mockResolvedValue([sampleProduct]);
      mockSkuRepository.find.mockResolvedValue([
        { _id: 'sku-1', product_id: 'prod-01' },
        { _id: 'sku-2', product_id: 'prod-01' },
      ]);
      mockCategoryRepository.find.mockResolvedValue([{ _id: 'cat-01', name: 'Thời trang nam' }]);
      mockS3StorageService.uploadBuffer.mockResolvedValue(undefined);
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl: 'https://storage.example/signed-download/products-export.csv',
        expiresAt: new Date(Date.now() + 1800000),
      });

      const result = await service.exportProducts('shop-01', {
        format: ExportFormat.CSV,
      });

      expect(result).toBeDefined();
      expect(result.export_url).toBe('https://storage.example/signed-download/products-export.csv');
      expect(result.format).toBe('csv');
      expect(result.row_count).toBe(1);
      expect(result.generated_at).toBeDefined();
      expect(result.expires_at).toBeDefined();

      expect(mockProductRepository.count).toHaveBeenCalledWith(
        expect.objectContaining({ shop_id: 'shop-01' }),
      );
      expect(mockProductRepository.find).toHaveBeenCalledWith(
        expect.objectContaining({ shop_id: 'shop-01' }),
        expect.objectContaining({ sort: { updated_at: -1 }, limit: PRODUCT_EXPORT_MAX_ROWS }),
      );
      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/^exports\/products-shop-shop-01-\d{14}\.csv$/),
        expect.any(Buffer),
        'text/csv; charset=utf-8',
      );
      expect(mockS3StorageService.generatePresignedDownloadUrl).toHaveBeenCalledWith(
        expect.stringMatching(/^exports\/products-shop-shop-01-\d{14}\.csv$/),
        PRODUCT_EXPORT_URL_TTL,
      );
    });

    it('should format CSV content correctly with UTF-8 BOM, escaped fields, and formula injection protection (SG-02)', async () => {
      mockProductRepository.count.mockResolvedValue(1);
      mockProductRepository.find.mockResolvedValue([
        {
          ...sampleProduct,
          title: '=cmd|\' /C calc\'!A0, "test"',
          slug: '+84901234567',
        },
      ]);
      mockSkuRepository.find.mockResolvedValue([]);
      mockCategoryRepository.find.mockResolvedValue([]);
      mockS3StorageService.uploadBuffer.mockResolvedValue(undefined);
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl: 'https://storage.example/signed.csv',
        expiresAt: new Date(),
      });

      await service.exportProducts('shop-01', {});

      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/\.csv$/),
        expect.any(Buffer),
        'text/csv; charset=utf-8',
      );

      const bufferArg = mockS3StorageService.uploadBuffer.mock.calls[0][1] as Buffer;
      const csvContent = bufferArg.toString('utf-8');
      expect(csvContent.startsWith('\uFEFF')).toBe(true);
      expect(csvContent).toContain(
        'product_id,title,slug,status,primary_category,base_price,sale_price,sku_count,updated_at',
      );
      // SG-02: Formula injection protection prefixes '= and wraps with quotes
      expect(csvContent).toContain("'=cmd|' /C calc'!A0");
      expect(csvContent).toContain("'+84901234567");
    });

    it('should throw 400 PRODUCT_INVALID_INPUT when format is xlsx (unsupported in v1)', async () => {
      await expect(
        service.exportProducts('shop-01', { format: ExportFormat.XLSX }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should apply filters for status, q, and date ranges', async () => {
      mockProductRepository.count.mockResolvedValue(0);
      mockProductRepository.find.mockResolvedValue([]);
      mockS3StorageService.uploadBuffer.mockResolvedValue(undefined);
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl: 'url',
        expiresAt: new Date(),
      });

      await service.exportProducts('shop-01', {
        status: ProductStatus.DRAFT,
        q: 'cotton',
        updated_from: '2026-08-01T00:00:00Z',
        updated_to: '2026-08-31T23:59:59Z',
      });

      expect(mockProductRepository.count).toHaveBeenCalledWith(
        expect.objectContaining({
          shop_id: 'shop-01',
          status: ProductStatus.DRAFT,
          $or: [{ title: expect.any(RegExp) }, { slug: expect.any(RegExp) }],
          updated_at: {
            $gte: new Date('2026-08-01T00:00:00Z'),
            $lte: new Date('2026-08-31T23:59:59Z'),
          },
        }),
      );
    });

    it('should throw 400 PRODUCT_EXPORT_TOO_LARGE when count > 10000', async () => {
      mockProductRepository.count.mockResolvedValue(10001);

      await expect(service.exportProducts('shop-01', {})).rejects.toThrow(BadRequestException);
    });

    it('should throw 400 PRODUCT_INVALID_INPUT when updated_from is invalid date', async () => {
      await expect(
        service.exportProducts('shop-01', { updated_from: 'not-a-date' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw 400 PRODUCT_INVALID_INPUT when updated_to is invalid date', async () => {
      await expect(service.exportProducts('shop-01', { updated_to: 'invalid' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw 400 PRODUCT_INVALID_INPUT when updated_from > updated_to', async () => {
      await expect(
        service.exportProducts('shop-01', {
          updated_from: '2026-09-01T00:00:00Z',
          updated_to: '2026-08-01T00:00:00Z',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
