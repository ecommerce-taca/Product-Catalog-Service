import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as ExcelJS from 'exceljs';
import { ExcelTemplateService } from '../../src/import/services/excel-template.service';
import { CategoryStatus } from '../../src/database/schemas/category.schema';
import {
  AttributeDefinitionStatus,
  AttributeScopeType,
  AttributeType,
} from '../../src/database/schemas/attribute-definition.schema';

import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';

describe('ExcelTemplateService', () => {
  let service: ExcelTemplateService;

  const mockCategoryRepository = {
    findById: jest.fn(),
    findAllPaginated: jest.fn(),
  };

  const mockAttributeDefinitionRepository = {
    findByScope: jest.fn(),
  };

  const mockS3StorageService = {
    verifyObjectUploaded: jest.fn(),
    uploadBuffer: jest.fn(),
    generatePresignedDownloadUrl: jest.fn(),
  };

  const sampleCategory = {
    _id: '01912f20-0000-7000-8000-000000000001',
    name: 'Thời Trang Nam',
    slug: 'thoi-trang-nam',
    path: '/01912f20-0000-7000-8000-000000000001',
    depth: 1,
    status: CategoryStatus.ACTIVE,
  };

  const sampleAttributeDefs = [
    {
      _id: '01912f25-0000-7000-8000-000000000001',
      scope_type: AttributeScopeType.CATEGORY,
      scope_id: sampleCategory._id,
      key: 'color',
      label: 'Màu sắc',
      type: AttributeType.ENUM,
      allowed_values: ['Đỏ', 'Xanh', 'Đen'],
      status: AttributeDefinitionStatus.ACTIVE,
      sort_order: 1,
    },
    {
      _id: '01912f25-0000-7000-8000-000000000002',
      scope_type: AttributeScopeType.CATEGORY,
      scope_id: sampleCategory._id,
      key: 'size',
      label: 'Kích cỡ',
      type: AttributeType.ENUM,
      allowed_values: ['S', 'M', 'L', 'XL'],
      status: AttributeDefinitionStatus.ACTIVE,
      sort_order: 2,
    },
    {
      _id: '01912f25-0000-7000-8000-000000000003',
      scope_type: AttributeScopeType.CATEGORY,
      scope_id: sampleCategory._id,
      key: 'material',
      label: 'Chất liệu',
      type: AttributeType.STRING,
      allowed_values: [],
      status: AttributeDefinitionStatus.ACTIVE,
      sort_order: 3,
    },
  ];

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExcelTemplateService,
        { provide: 'CategoryRepositoryPort', useValue: mockCategoryRepository },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttributeDefinitionRepository,
        },
        { provide: S3StorageService, useValue: mockS3StorageService },
      ],
    }).compile();

    service = module.get<ExcelTemplateService>(ExcelTemplateService);
  });

  describe('generateTemplate', () => {
    it('should generate default template with 3 sheets (including Ví dụ điền mẫu) and 10 fixed columns when no categoryId is provided', async () => {
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [sampleCategory],
        total: 1,
      });

      const buffer = await service.generateTemplate();
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);

      // Verify the generated Excel workbook using ExcelJS reader
      const workbook = new ExcelJS.Workbook();
      interface ExcelReader {
        load(data: unknown): Promise<ExcelJS.Workbook>;
      }
      await (workbook.xlsx as unknown as ExcelReader).load(buffer);

      expect(workbook.worksheets.length).toBe(3);

      const sheet1 = workbook.getWorksheet('Sản phẩm & Biến thể');
      expect(sheet1).toBeDefined();

      // Check fixed column headers
      const expectedHeaders = [
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
      ];

      expect(sheet1?.columnCount).toBe(10);
      expectedHeaders.forEach((expectedHeader, index) => {
        const cell = sheet1?.getRow(1).getCell(index + 1);
        expect(cell?.value).toBe(expectedHeader);
        expect(cell?.font?.bold).toBe(true);
      });

      // Verify frozen header row
      const view = sheet1?.views?.[0] as ExcelJS.WorksheetViewFrozen | undefined;
      expect(view?.state).toBe('frozen');
      expect(view?.ySplit).toBe(1);

      // Verify Sheet 2: Ví dụ điền mẫu
      const sheetExample = workbook.getWorksheet('Ví dụ điền mẫu');
      expect(sheetExample).toBeDefined();
      expect(sheetExample?.columnCount).toBe(10);
      expect(sheetExample?.rowCount).toBe(5); // 1 header + 4 example data rows
      expect(sheetExample?.getRow(2).getCell(1).value).toBe('AO-THUN-NAM-01');
      expect(sheetExample?.views?.[0]?.state).toBe('frozen');

      // Verify Sheet 3: Hướng dẫn & Danh mục
      const sheet3 = workbook.getWorksheet('Hướng dẫn & Danh mục');
      expect(sheet3).toBeDefined();
      expect(sheet3?.getRow(1).getCell(1).value).toBe('Mục / Trường dữ liệu');
      expect(sheet3?.views?.[0]?.state).toBe('frozen');

      // Verify Sheet 1 without categoryId: no prefilled category, no worksheet protection
      expect(sheet1?.getCell(2, 3).value).toBeFalsy();
      expect((sheet1 as any)?.sheetProtection).toBeFalsy();
    });

    it('should generate template with dynamic attribute columns and dropdown validations when valid categoryId is provided (AC-IM-01)', async () => {
      mockCategoryRepository.findById.mockResolvedValue(sampleCategory);
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue(sampleAttributeDefs);
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [sampleCategory],
        total: 1,
      });

      const buffer = await service.generateTemplate(sampleCategory._id);
      expect(buffer).toBeInstanceOf(Buffer);

      const workbook = new ExcelJS.Workbook();
      interface ExcelReader {
        load(data: unknown): Promise<ExcelJS.Workbook>;
      }
      await (workbook.xlsx as unknown as ExcelReader).load(buffer);
      expect(workbook.worksheets.length).toBe(3);

      const sheet1 = workbook.getWorksheet('Sản phẩm & Biến thể');
      expect(sheet1).toBeDefined();

      const sheetExample = workbook.getWorksheet('Ví dụ điền mẫu');
      expect(sheetExample).toBeDefined();
      expect(sheetExample?.columnCount).toBe(13);

      // 10 fixed + 3 dynamic = 13 columns
      expect(sheet1?.columnCount).toBe(13);
      expect(sheet1?.getRow(1).getCell(11).value).toBe('Màu sắc');
      expect(sheet1?.getRow(1).getCell(12).value).toBe('Kích cỡ');
      expect(sheet1?.getRow(1).getCell(13).value).toBe('Chất liệu');

      // Check Data Validation for ENUM attributes on rows 2, 100, 201
      const colorCellRow2 = sheet1?.getCell(2, 11);
      expect(colorCellRow2?.dataValidation).toBeDefined();
      expect(colorCellRow2?.dataValidation?.type).toBe('list');
      expect(colorCellRow2?.dataValidation?.formulae).toEqual(['"Đỏ,Xanh,Đen"']);

      const sizeCellRow201 = sheet1?.getCell(201, 12);
      expect(sizeCellRow201?.dataValidation).toBeDefined();
      expect(sizeCellRow201?.dataValidation?.type).toBe('list');
      expect(sizeCellRow201?.dataValidation?.formulae).toEqual(['"S,M,L,XL"']);

      // STRING attribute should NOT have dropdown validation
      const materialCellRow2 = sheet1?.getCell(2, 13);
      expect(materialCellRow2?.dataValidation).toBeUndefined();

      // Price columns should have VND number format
      expect(sheet1?.getCell(2, 8).numFmt).toBe('#,##0');
      expect(sheet1?.getCell(2, 9).numFmt).toBe('#,##0');

      // Verify category_id prefilled and locked on Sheet 1 (PCAT-IMP-07)
      expect(sheet1?.getCell(2, 3).value).toBe(sampleCategory._id);
      expect(sheet1?.getCell(201, 3).value).toBe(sampleCategory._id);
      // In Excel OpenXML, cells are locked by default unless explicitly unlocked with locked: false
      expect(sheet1?.getCell(2, 3).protection?.locked).not.toBe(false);
      expect(sheet1?.getCell(2, 1).protection?.locked).toBe(false);
      expect(sheet1?.getCell(2, 2).protection?.locked).toBe(false);
      expect(sheet1?.getCell(2, 4).protection?.locked).toBe(false);
      expect((sheet1 as any)?.sheetProtection?.sheet).toBe(true);
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID when categoryId does not exist (AC-IM-03)', async () => {
      mockCategoryRepository.findById.mockResolvedValue(null);

      await expect(service.generateTemplate('CAT-NOT-EXIST')).rejects.toThrow(BadRequestException);

      try {
        await service.generateTemplate('CAT-NOT-EXIST');
      } catch (err: unknown) {
        const error = err as BadRequestException;
        const res = error.getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_CATEGORY_INVALID');
      }
    });

    it('should throw 400 PRODUCT_CATEGORY_INVALID when category is not ACTIVE', async () => {
      mockCategoryRepository.findById.mockResolvedValue({
        ...sampleCategory,
        status: CategoryStatus.INACTIVE,
      });

      await expect(service.generateTemplate(sampleCategory._id)).rejects.toThrow(
        BadRequestException,
      );

      try {
        await service.generateTemplate(sampleCategory._id);
      } catch (err: unknown) {
        const error = err as BadRequestException;
        const res = error.getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_CATEGORY_INVALID');
      }
    });
  });

  describe('getOrInitTemplate', () => {
    it('should initialize and upload template to MinIO when it does not exist', async () => {
      mockS3StorageService.verifyObjectUploaded.mockResolvedValue({ verified: false });
      mockS3StorageService.uploadBuffer.mockResolvedValue(undefined);
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl:
          'http://localhost:9000/taca-product-media-prod/templates/product_import_template_default.xlsx?sig=123',
        expiresAt: new Date(Date.now() + 3600000),
      });

      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [sampleCategory],
        total: 1,
      });

      const result = await service.getOrInitTemplate();

      expect(mockS3StorageService.verifyObjectUploaded).toHaveBeenCalledWith(
        'templates/product_import_template_default.xlsx',
      );
      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
        'templates/product_import_template_default.xlsx',
        expect.any(Buffer),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'attachment; filename="product_import_template_default.xlsx"',
      );
      expect(mockS3StorageService.generatePresignedDownloadUrl).toHaveBeenCalledWith(
        'templates/product_import_template_default.xlsx',
        3600,
      );
      expect(result.downloadUrl).toContain('product_import_template_default.xlsx');
      expect(result.filename).toBe('product_import_template_default.xlsx');
    });

    it('should return presigned URL directly from MinIO when template already exists (no re-generation)', async () => {
      mockS3StorageService.verifyObjectUploaded.mockResolvedValue({
        verified: true,
        actualSize: 11000,
      });
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl:
          'http://localhost:9000/taca-product-media-prod/templates/product_import_template_default.xlsx?sig=cached',
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await service.getOrInitTemplate();

      expect(mockS3StorageService.verifyObjectUploaded).toHaveBeenCalledWith(
        'templates/product_import_template_default.xlsx',
      );
      expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
      expect(mockS3StorageService.generatePresignedDownloadUrl).toHaveBeenCalledWith(
        'templates/product_import_template_default.xlsx',
        3600,
      );
      expect(result.downloadUrl).toContain('sig=cached');
    });

    it('should reject with 400 when categoryId does not exist or is INACTIVE', async () => {
      mockCategoryRepository.findById.mockResolvedValue(null);

      await expect(service.getOrInitTemplate('invalid-cat')).rejects.toThrow(BadRequestException);
    });
  });
});
