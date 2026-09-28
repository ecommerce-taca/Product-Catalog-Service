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
    downloadBuffer: jest.fn(),
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

    mockS3StorageService.downloadBuffer.mockImplementation(async (key: string) => {
      const res = await mockS3StorageService.s3Client.send({ input: { Key: key } });
      if (res && res.Body) {
        const chunks: Buffer[] = [];
        for await (const chunk of res.Body) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
        }
        return Buffer.concat(chunks);
      }
      return Buffer.from('');
    });

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
      expect(headerRow.getCell(1).value).toBe('Tên Sheet');
      expect(headerRow.getCell(2).value).toBe('Dòng');
      expect(headerRow.getCell(3).value).toBe('Mã tham chiếu (product_ref_id)');
      expect(headerRow.getCell(6).value).toBe('Chi tiết lỗi (error_message)');

      const errorRow = sheet!.getRow(2);
      expect(errorRow.getCell(1).value).toBe('');
      expect(errorRow.getCell(2).value).toBe(4);
      expect(errorRow.getCell(3).value).toBe('PROD-ERR-99');
      expect(errorRow.getCell(6).value).toBe('Danh mục không tồn tại.');
    });

    it('should redirect to fallback error summary workbook when job.status === FAILED to prevent ghost success annotations (BLOCKER-01)', async () => {
      const failedJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ff',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: 'imports/shop-01/failed-file.xlsx',
        status: ImportJobStatus.FAILED,
        total_rows: 2,
        processed_rows: 0,
        success_count: 0,
        error_count: 1,
        error_summary: [
          {
            row_index: 0,
            product_ref_id: 'SYSTEM',
            error_code: 'PRODUCT_IMPORT_WORKER_TIMEOUT',
            error_message: 'Tiến trình import bị quá hạn heartbeat.',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(failedJob as ImportJobDocument);
      expect(resultBuffer).toBeInstanceOf(Buffer);

      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      // Must be fallback sheet 'Báo cáo kết quả', NOT original 'Sản phẩm & Biến thể'
      const sheet = resultWorkbook.getWorksheet('Báo cáo kết quả');
      expect(sheet).toBeDefined();

      const errorRow = sheet!.getRow(2);
      expect(errorRow.getCell(3).value).toBe('SYSTEM');
      expect(errorRow.getCell(5).value).toBe('PRODUCT_IMPORT_WORKER_TIMEOUT');
    });

    it('should skip empty template rows and not label them as SUCCESS or FAILED (B-UX-01 / B-LR-02)', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sản phẩm & Biến thể');

      sheet.columns = [
        { header: 'Mã tham chiếu (product_ref_id)', key: 'product_ref_id', width: 20 },
        { header: 'Tên sản phẩm (title)', key: 'title', width: 25 },
        { header: 'Mã danh mục (category_id)', key: 'category_id', width: 20 },
        { header: 'Mã SKU (seller_sku)', key: 'seller_sku', width: 20 },
        { header: 'Giá bán (price)', key: 'price', width: 15 },
      ];

      // Row 2: Valid product row
      sheet.addRow({
        product_ref_id: 'REF-VALID',
        title: 'Áo sơ mi hợp lệ',
        category_id: '01912f20-0000-7000-8000-000000000001',
        seller_sku: 'SKU-VALID',
        price: 200000,
      });

      // Row 3: Empty template row (category prefilled, but 4 business fields empty)
      sheet.addRow({
        product_ref_id: '',
        title: '',
        category_id: '[01912f20-0000-7000-8000-000000000001] Quần Áo Nam',
        seller_sku: '',
        price: '',
      });

      // Row 4: Empty template row with whitespace
      sheet.addRow({
        product_ref_id: '   ',
        title: '   ',
        category_id: '[01912f20-0000-7000-8000-000000000001] Quần Áo Nam',
        seller_sku: '  ',
        price: '   ',
      });

      // Row 5: Product row with error
      sheet.addRow({
        product_ref_id: 'REF-ERR',
        title: 'Áo lỗi',
        category_id: '01912f20-0000-7000-8000-000000000001',
        seller_sku: 'SKU-ERR',
        price: 150000,
      });

      const buffer = await workbook.xlsx.writeBuffer();
      mockS3StorageService.s3Client.send.mockResolvedValueOnce({
        Body: Readable.from([Buffer.from(buffer)]),
      });

      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: 'imports/shop-01/test-empty-rows.xlsx',
        status: ImportJobStatus.COMPLETED,
        total_rows: 2,
        processed_rows: 2,
        success_count: 1,
        error_count: 1,
        error_summary: [
          {
            row_index: 5,
            product_ref_id: 'REF-ERR',
            seller_sku: 'SKU-ERR',
            error_code: 'INVALID_BARCODE',
            error_message: 'Mã vạch không hợp lệ',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(mockJob as ImportJobDocument);
      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      const resultSheet = resultWorkbook.getWorksheet('Sản phẩm & Biến thể');
      const headerRow = resultSheet!.getRow(1);
      const colCount = headerRow.actualCellCount || headerRow.cellCount;
      const statusCol = colCount - 1;

      // Row 2: Successfully created draft
      const row2 = resultSheet!.getRow(2);
      expect(row2.getCell(statusCol).value).toBe('THÀNH CÔNG (SUCCESS)');

      // Row 3: Empty template row -> skipped, NO status assigned
      const row3 = resultSheet!.getRow(3);
      expect(row3.getCell(statusCol).value).toBeNull();

      // Row 4: Whitespace-only template row -> skipped, NO status assigned
      const row4 = resultSheet!.getRow(4);
      expect(row4.getCell(statusCol).value).toBeNull();

      // Row 5: Failed product row
      const row5 = resultSheet!.getRow(5);
      expect(row5.getCell(statusCol).value).toBe('THẤT BẠI (FAILED)');
    });

    it('should label row as THÀNH CÔNG (CÓ CẢNH BÁO) with yellow fill and orange text when all errors are warnings (BUG-03)', async () => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Sản phẩm');

      sheet.columns = [
        { header: 'Mã tham chiếu (product_ref_id)', key: 'product_ref_id', width: 20 },
        { header: 'Tên sản phẩm (title)', key: 'title', width: 25 },
        { header: 'Mã SKU (seller_sku)', key: 'seller_sku', width: 20 },
        { header: 'Giá bán (price)', key: 'price', width: 15 },
      ];

      // Row 2: SPU with image download warning only
      sheet.addRow({
        product_ref_id: 'REF-WARN-ONLY',
        title: 'Áo thun cảnh báo ảnh',
        seller_sku: 'SKU-WARN',
        price: 180000,
      });

      // Row 3: SPU with mixed errors: image download warning + fatal SKU duplicate
      sheet.addRow({
        product_ref_id: 'REF-FATAL-MIX',
        title: 'Áo thun lỗi chí tử',
        seller_sku: 'SKU-FATAL',
        price: 220000,
      });

      const buffer = await workbook.xlsx.writeBuffer();
      mockS3StorageService.s3Client.send.mockResolvedValueOnce({
        Body: Readable.from([Buffer.from(buffer)]),
      });

      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: 'imports/shop-01/test-warnings.xlsx',
        status: ImportJobStatus.COMPLETED,
        total_rows: 2,
        processed_rows: 2,
        success_count: 1,
        error_count: 1,
        error_summary: [
          {
            row_index: 2,
            sheet_name: 'Sản phẩm',
            product_ref_id: 'REF-WARN-ONLY',
            seller_sku: 'SKU-WARN',
            error_code: 'WARNING: MEDIA_DOWNLOAD_FAILED',
            error_message: 'Không thể tải ảnh từ URL: https://example.com/broken.jpg',
          },
          {
            row_index: 3,
            sheet_name: 'Sản phẩm',
            product_ref_id: 'REF-FATAL-MIX',
            seller_sku: 'SKU-FATAL',
            error_code: 'WARNING: MEDIA_DOWNLOAD_FAILED',
            error_message: 'Không thể tải ảnh từ URL: https://example.com/broken2.jpg',
          },
          {
            row_index: 3,
            sheet_name: 'Sản phẩm',
            product_ref_id: 'REF-FATAL-MIX',
            seller_sku: 'SKU-FATAL',
            error_code: 'PRODUCT_SKU_DUPLICATE',
            error_message: 'Mã seller_sku đã tồn tại',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(mockJob as ImportJobDocument);
      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      const resultSheet = resultWorkbook.getWorksheet('Sản phẩm');
      const headerRow = resultSheet!.getRow(1);
      const colCount = headerRow.actualCellCount || headerRow.cellCount;
      const statusCol = colCount - 1;
      const errorCol = colCount;

      // Row 2: Warning only -> THÀNH CÔNG (CÓ CẢNH BÁO) with light yellow fill and dark orange font
      const row2 = resultSheet!.getRow(2);
      expect(row2.getCell(statusCol).value).toBe('THÀNH CÔNG (CÓ CẢNH BÁO)');
      expect(row2.getCell(errorCol).value).toContain('Không thể tải ảnh');
      const warnFill = row2.getCell(statusCol).fill as any;
      expect(warnFill?.fgColor?.argb).toBe('FFFFEB9C');
      const warnFont = row2.getCell(statusCol).font as any;
      expect(warnFont?.color?.argb).toBe('FF9C5700');

      // Row 3: Mixed errors with fatal error -> THẤT BẠI (FAILED) with light red fill and dark red font
      const row3 = resultSheet!.getRow(3);
      expect(row3.getCell(statusCol).value).toBe('THẤT BẠI (FAILED)');
      const fatalFill = row3.getCell(statusCol).fill as any;
      expect(fatalFill?.fgColor?.argb).toBe('FFFFC7CE');
      const fatalFont = row3.getCell(statusCol).font as any;
      expect(fatalFont?.color?.argb).toBe('FF9C0006');
    });

    it('should include Tên Sheet column with multi-sheet error reporting in fallback table (BUG-04)', async () => {
      const mockJob: Partial<ImportJobDocument> = {
        _id: '01923456-789a-7bc8-9def-0123456789ab',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        file_url: null as any,
        status: ImportJobStatus.COMPLETED,
        total_rows: 3,
        processed_rows: 3,
        success_count: 0,
        error_count: 3,
        error_summary: [
          {
            sheet_name: 'Thời trang nam',
            row_index: 3,
            product_ref_id: 'REF-M01',
            seller_sku: 'SKU-M01',
            error_code: 'ERR_COLOR_INVALID',
            error_message: 'Màu sắc không hợp lệ',
          },
          {
            sheet_name: 'Thời trang nữ',
            row_index: 7,
            product_ref_id: 'REF-F01',
            seller_sku: 'SKU-F01',
            error_code: 'ERR_SIZE_INVALID',
            error_message: 'Kích cỡ không hợp lệ',
          },
          {
            sheet_name: '=cmd|evilSheet',
            row_index: 10,
            product_ref_id: 'REF-EVIL',
            seller_sku: 'SKU-EVIL',
            error_code: 'ERR_INJECTION',
            error_message: 'Sheet injection test',
          },
        ],
      };

      const resultBuffer = await service.generateResultBuffer(mockJob as ImportJobDocument);
      const resultWorkbook = new ExcelJS.Workbook();
      await resultWorkbook.xlsx.load(resultBuffer as any);

      const sheet = resultWorkbook.getWorksheet('Báo cáo kết quả');
      expect(sheet).toBeDefined();

      const headerRow = sheet!.getRow(1);
      expect(headerRow.getCell(1).value).toBe('Tên Sheet');
      expect(headerRow.getCell(2).value).toBe('Dòng');
      expect(headerRow.getCell(3).value).toBe('Mã tham chiếu (product_ref_id)');
      expect(headerRow.getCell(4).value).toBe('Mã SKU (seller_sku)');
      expect(headerRow.getCell(5).value).toBe('Mã lỗi (error_code)');
      expect(headerRow.getCell(6).value).toBe('Chi tiết lỗi (error_message)');

      // Row 2: Sheet 1 error
      const row2 = sheet!.getRow(2);
      expect(row2.getCell(1).value).toBe('Thời trang nam');
      expect(row2.getCell(2).value).toBe(3);
      expect(row2.getCell(3).value).toBe('REF-M01');

      // Row 3: Sheet 2 error
      const row3 = sheet!.getRow(3);
      expect(row3.getCell(1).value).toBe('Thời trang nữ');
      expect(row3.getCell(2).value).toBe(7);
      expect(row3.getCell(3).value).toBe('REF-F01');

      // Row 4: Sheet 3 formula injection sanitized
      const row4 = sheet!.getRow(4);
      expect(row4.getCell(1).value).toBe("'=cmd|evilSheet");
    });
  });

  describe('isRowEmpty helper (B-UX-01 / B-LR-02)', () => {
    it('should return true when all 4 business fields are empty, even if category is prefilled', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('test');
      ws.columns = [
        { header: 'Mã tham chiếu sản phẩm (*)', key: 'product_ref_id' },
        { header: 'Tên sản phẩm (*)', key: 'title' },
        { header: 'Mã danh mục (*)', key: 'category_id' },
        { header: 'Mã SKU người bán (*)', key: 'seller_sku' },
        { header: 'Giá bán VND (*)', key: 'price' },
      ];

      const row = ws.addRow({
        category_id: '[01912f20-0000-7000-8000-000000000001] Quần Áo Nam',
        product_ref_id: '',
        title: '',
        seller_sku: '',
        price: '',
      });

      expect(service.isRowEmpty(row)).toBe(true);
    });

    it('should return true when 4 business fields contain only whitespace', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('test');
      ws.columns = [
        { header: 'product_ref_id', key: 'product_ref_id' },
        { header: 'title', key: 'title' },
        { header: 'seller_sku', key: 'seller_sku' },
        { header: 'price', key: 'price' },
      ];

      const row = ws.addRow({
        product_ref_id: '   ',
        title: '  ',
        seller_sku: '\t',
        price: ' \n ',
      });

      expect(service.isRowEmpty(row)).toBe(true);
    });

    it('should return false when at least one business field is present', () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('test');
      ws.columns = [
        { header: 'product_ref_id', key: 'product_ref_id' },
        { header: 'title', key: 'title' },
        { header: 'seller_sku', key: 'seller_sku' },
        { header: 'price', key: 'price' },
      ];

      const rowWithTitle = ws.addRow({ title: 'Áo Nam' });
      expect(service.isRowEmpty(rowWithTitle)).toBe(false);

      const rowWithSku = ws.addRow({ seller_sku: 'SKU-001' });
      expect(service.isRowEmpty(rowWithSku)).toBe(false);

      const rowWithRef = ws.addRow({ product_ref_id: 'REF-001' });
      expect(service.isRowEmpty(rowWithRef)).toBe(false);

      const rowWithPrice = ws.addRow({ price: 0 });
      expect(service.isRowEmpty(rowWithPrice)).toBe(false);
    });
  });

  describe('isWarningError helper (BUG-03)', () => {
    it('should recognize WARNING:, CẢNH BÁO: and MEDIA_DOWNLOAD_FAILED', () => {
      expect(service.isWarningError('WARNING: MEDIA_DOWNLOAD_FAILED')).toBe(true);
      expect(service.isWarningError('cảnh báo: không tải được ảnh')).toBe(true);
      expect(service.isWarningError('MEDIA_DOWNLOAD_FAILED')).toBe(true);
      expect(
        service.isWarningError({
          error_code: 'WARNING: MEDIA_DOWNLOAD_FAILED',
          error_message: 'Timeout downloading media',
        }),
      ).toBe(true);
      expect(
        service.isWarningError({
          errorCode: 'MEDIA_DOWNLOAD_FAILED',
          errorMessage: 'Failed to fetch image',
        }),
      ).toBe(true);
    });

    it('should return false for fatal errors', () => {
      expect(service.isWarningError('PRODUCT_SKU_DUPLICATE')).toBe(false);
      expect(service.isWarningError('MEDIA_INVALID_URL_BLOCKED')).toBe(false);
      expect(
        service.isWarningError({
          error_code: 'PRODUCT_TITLE_REQUIRED',
          error_message: 'Tiêu đề sản phẩm là bắt buộc',
        }),
      ).toBe(false);
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
