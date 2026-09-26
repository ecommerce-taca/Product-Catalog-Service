import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';

import { ExcelResultService } from '../../src/import/services/excel-result.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { ImportJobDocument, ImportJobStatus } from '../../src/database/schemas/import-job.schema';

describe('ExcelResultService', () => {
  let service: ExcelResultService;

  const mockS3StorageService = {
    bucket: 'test-bucket',
    s3Client: {
      send: jest.fn(),
    },
    uploadBuffer: jest.fn().mockResolvedValue(undefined),
    generatePresignedDownloadUrl: jest.fn().mockResolvedValue({
      downloadUrl: 'https://s3.example.com/imports/test-download.xlsx',
      expiresAt: new Date(Date.now() + 1800 * 1000),
    }),
  };

  const mockImportJobRepository = {
    update: jest.fn().mockResolvedValue({}),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExcelResultService,
        {
          provide: S3StorageService,
          useValue: mockS3StorageService,
        },
        {
          provide: 'ImportJobRepositoryPort',
          useValue: mockImportJobRepository,
        },
      ],
    }).compile();

    service = module.get<ExcelResultService>(ExcelResultService);
  });

  const createSampleOriginalWorkbookBuffer = async (): Promise<Buffer> => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Sản phẩm & Biến thể');

    sheet.columns = [
      { header: 'Mã tham chiếu (product_ref_id)', key: 'product_ref_id', width: 20 },
      { header: 'Tên sản phẩm (title)', key: 'title', width: 25 },
      { header: 'Mã danh mục (category_id)', key: 'category_id', width: 20 },
      { header: 'Mã SKU (seller_sku)', key: 'seller_sku', width: 20 },
      { header: 'Giá bán (price)', key: 'price', width: 15 },
    ];

    sheet.addRow({
      product_ref_id: 'REF-01',
      title: 'Áo sơ mi nam',
      category_id: '01912f20-0000-7000-8000-000000000001',
      seller_sku: 'SM-TRANG-M',
      price: 250000,
    });

    sheet.addRow({
      product_ref_id: 'REF-02',
      title: '=cmd|/c calc!A0', // Potential formula injection
      category_id: '01912f20-0000-7000-8000-000000000001',
      seller_sku: '+SKU-EXPLOIT',
      price: 300000,
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  };

  describe('generateResultBuffer', () => {
    it('should annotate original Excel file from S3 with status and error reasons (AC-IM-17)', async () => {
      const originalBuffer = await createSampleOriginalWorkbookBuffer();
      const mockStream = Readable.from([originalBuffer]);

      mockS3StorageService.s3Client.send.mockResolvedValueOnce({
        Body: mockStream,
      });

      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: 'imports/shop-01/01923456-789a-7bc8-9def-0123456789ab.xlsx',
        status: ImportJobStatus.COMPLETED,
        total_rows: 2,
        processed_rows: 2,
        success_count: 1,
        error_count: 1,
        error_summary: [
          {
            row_index: 3,
            product_ref_id: 'REF-02',
            seller_sku: '+SKU-EXPLOIT',
            error_code: 'PRODUCT_SKU_DUPLICATE',
            error_message: 'Mã seller_sku đã tồn tại trong gian hàng.',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(mockJob as ImportJobDocument);
      expect(resultBuffer).toBeInstanceOf(Buffer);

      // Verify the generated Excel contents
      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      const sheet = resultWorkbook.getWorksheet('Sản phẩm & Biến thể');
      expect(sheet).toBeDefined();

      const headerRow = sheet!.getRow(1);
      const colCount = headerRow.actualCellCount || headerRow.cellCount;

      // Ensure the two new columns were appended
      expect(headerRow.getCell(colCount - 1).value).toBe('Trạng thái xử lý (Import Status)');
      expect(headerRow.getCell(colCount).value).toBe('Lý do lỗi (Error Reason)');

      // Row 2 is valid (SUCCESS)
      const row2 = sheet!.getRow(2);
      expect(row2.getCell(colCount - 1).value).toBe('THÀNH CÔNG (SUCCESS)');
      expect(row2.getCell(colCount).value).toBe('Đã tạo DRAFT');

      // Row 3 is failed (FAILED) with reason
      const row3 = sheet!.getRow(3);
      expect(row3.getCell(colCount - 1).value).toBe('THẤT BẠI (FAILED)');
      expect(row3.getCell(colCount).value).toBe('Mã seller_sku đã tồn tại trong gian hàng.');

      // Check red fill styling on failed row
      const failedFill = row3.getCell(colCount).fill as any;
      expect(failedFill).toBeDefined();
      expect(failedFill.type).toBe('pattern');
      expect(failedFill.fgColor?.argb).toBe('FFFFC7CE');
    });

    it('should sanitize 100% text cells against Formula Injection CWE-1236 (Lesson L-07)', async () => {
      const originalBuffer = await createSampleOriginalWorkbookBuffer();
      const mockStream = Readable.from([originalBuffer]);

      mockS3StorageService.s3Client.send.mockResolvedValueOnce({
        Body: mockStream,
      });

      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: 'imports/shop-01/01923456.xlsx',
        status: ImportJobStatus.COMPLETED,
        total_rows: 2,
        processed_rows: 2,
        success_count: 1,
        error_count: 1,
        error_summary: [
          {
            row_index: 3,
            product_ref_id: '=REF-INJECT',
            seller_sku: '+SKU-EXPLOIT',
            error_code: 'PRODUCT_SKU_DUPLICATE',
            error_message: '@Formula error message',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(mockJob as ImportJobDocument);
      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      const sheet = resultWorkbook.getWorksheet(1);
      const row3 = sheet!.getRow(3);

      // Verify that malicious formulas in row 3 have been prefixed with single quote
      const titleVal = row3.getCell(2).value?.toString();
      expect(titleVal?.startsWith("'=")).toBe(true);

      const skuVal = row3.getCell(4).value?.toString();
      expect(skuVal?.startsWith("'+")).toBe(true);
    });

    it('should fallback to clean error summary workbook when original file fails to load from S3', async () => {
      // S3 rejects with error
      mockS3StorageService.s3Client.send.mockRejectedValueOnce(new Error('S3 Access Denied'));

      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: 'imports/non-existent.xlsx',
        status: ImportJobStatus.COMPLETED,
        total_rows: 5,
        processed_rows: 5,
        success_count: 4,
        error_count: 1,
        error_summary: [
          {
            row_index: 4,
            product_ref_id: 'PROD-ERR-99',
            seller_sku: 'SKU-ERR-99',
            error_code: 'PRODUCT_CATEGORY_INVALID',
            error_message: 'Danh mục không tồn tại.',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(mockJob as ImportJobDocument);
      expect(resultBuffer).toBeInstanceOf(Buffer);

      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      const sheet = resultWorkbook.getWorksheet('Báo cáo kết quả');
      expect(sheet).toBeDefined();

      const headerRow = sheet!.getRow(1);
      expect(headerRow.getCell(1).value).toBe('Dòng');
      expect(headerRow.getCell(2).value).toBe('Mã tham chiếu (product_ref_id)');
      expect(headerRow.getCell(5).value).toBe('Chi tiết lỗi (error_message)');

      const errorRow = sheet!.getRow(2);
      expect(errorRow.getCell(1).value).toBe(4);
      expect(errorRow.getCell(2).value).toBe('PROD-ERR-99');
      expect(errorRow.getCell(5).value).toBe('Danh mục không tồn tại.');
    });
  });

  describe('generateAndUploadResultFile', () => {
    it('should generate buffer, upload to S3, generate presigned download URL and update job', async () => {
      const mockSave = jest.fn().mockResolvedValue(undefined);
      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: null as any,
        status: ImportJobStatus.COMPLETED,
        total_rows: 1,
        processed_rows: 1,
        success_count: 0,
        error_count: 1,
        error_summary: [
          {
            row_index: 2,
            product_ref_id: 'REF-01',
            seller_sku: 'SKU-01',
            error_code: 'PRODUCT_INVALID',
            error_message: 'Tiêu đề không hợp lệ.',
          },
        ],
        save: mockSave,
      };

      const result = await service.generateAndUploadResultFile(mockJob as ImportJobDocument);

      const expectedS3Key = `imports/shop-${mockJob.shop_id}/${mockJob._id}-errors.xlsx`;
      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
        expectedS3Key,
        expect.any(Buffer),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(mockS3StorageService.generatePresignedDownloadUrl).toHaveBeenCalledWith(
        expectedS3Key,
        1800,
      );
      expect(mockJob.result_file_url).toBe(expectedS3Key);
      expect(mockSave).toHaveBeenCalled();
      expect(result.downloadUrl).toBe('https://s3.example.com/imports/test-download.xlsx');
      expect(result.s3Key).toBe(expectedS3Key);
      expect(result.expiresAt).toBeDefined();
    });
  });
});
