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
import { TemplateLayoutMode } from '../../src/import/dto/generate-custom-template.dto';

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
    it('should generate default template with 3 sheets (including Ví dụ điền mẫu) and 10 fixed columns when empty options provided', async () => {
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [sampleCategory],
        total: 1,
      });

      const buffer = await service.generateTemplate({});
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
      expect(sheetExample?.columnCount).toBe(12);
      expect(sheetExample?.rowCount).toBe(9); // 1 header + 8 example data rows (4 Polo + 1 Balo + 3 Sneaker)
      expect(sheetExample?.getRow(2).getCell(1).value).toBe('AO-POLO-NAM');
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

    const cat1 = {
      _id: '01912f20-0000-7000-8000-000000000001',
      name: 'Thời Trang Nam',
      status: CategoryStatus.ACTIVE,
      path: '/01912f20-0000-7000-8000-000000000001',
    };
    const cat2 = {
      _id: '01912f20-0000-7000-8000-000000000002',
      name: 'Giày Dép',
      status: CategoryStatus.ACTIVE,
      path: '/01912f20-0000-7000-8000-000000000002',
    };

    it('should generate MULTI_SHEET layout with dedicated sheet per category and friendly name format', async () => {
      mockCategoryRepository.findById.mockImplementation(async (id: string) => {
        if (id === cat1._id) return cat1;
        if (id === cat2._id) return cat2;
        return null;
      });
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [cat1, cat2],
        total: 2,
      });
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([]);

      const buffer = await service.generateTemplate({
        category_ids: [cat1._id, cat2._id],
        layout_mode: TemplateLayoutMode.MULTI_SHEET,
        row_count: 10,
      });

      expect(buffer).toBeInstanceOf(Buffer);

      const workbook = new ExcelJS.Workbook();
      interface ExcelReader {
        load(data: unknown): Promise<ExcelJS.Workbook>;
      }
      await (workbook.xlsx as unknown as ExcelReader).load(buffer);

      // Verify sheets: 2 category sheets + "Ví dụ điền mẫu" + "Hướng dẫn & Danh mục"
      expect(workbook.worksheets.length).toBe(4);
      const sheetCat1 = workbook.getWorksheet('Thời Trang Nam');
      const sheetCat2 = workbook.getWorksheet('Giày Dép');
      const sheetExample = workbook.getWorksheet('Ví dụ điền mẫu');
      const sheetGuide = workbook.getWorksheet('Hướng dẫn & Danh mục');

      expect(sheetCat1).toBeDefined();
      expect(sheetCat2).toBeDefined();
      expect(sheetExample).toBeDefined();
      expect(sheetGuide).toBeDefined();

      // Check friendly category display format: Tên [UUID]
      const expectedCat1Value = `${cat1.name} [${cat1._id}]`;
      expect(sheetCat1?.getCell(2, 3).value).toBe(expectedCat1Value);
      expect(sheetCat1?.getCell(11, 3).value).toBe(expectedCat1Value); // row_count: 10 => rows 2..11
      expect(sheetCat1?.getCell(2, 3).protection?.locked).not.toBe(false);
      expect(sheetCat1?.getCell(2, 1).protection?.locked).toBe(false);
      expect((sheetCat1 as any)?.sheetProtection?.sheet).toBe(true);

      const expectedCat2Value = `${cat2.name} [${cat2._id}]`;
      expect(sheetCat2?.getCell(2, 3).value).toBe(expectedCat2Value);
    });

    it('should automatically default to MULTI_SHEET layout when multiple categories provided without specifying layout_mode', async () => {
      mockCategoryRepository.findById.mockImplementation(async (id: string) => {
        if (id === cat1._id) return cat1;
        if (id === cat2._id) return cat2;
        return null;
      });
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [cat1, cat2],
        total: 2,
      });
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([]);

      // Calling without layout_mode and without row_count
      const buffer = await service.generateTemplate({
        category_ids: [cat1._id, cat2._id],
      });

      expect(buffer).toBeInstanceOf(Buffer);

      const workbook = new ExcelJS.Workbook();
      interface ExcelReader {
        load(data: unknown): Promise<ExcelJS.Workbook>;
      }
      await (workbook.xlsx as unknown as ExcelReader).load(buffer);

      // Verify automatic multi-sheet structure: 2 categories + 2 guide/example sheets
      expect(workbook.worksheets.length).toBe(4);
      const sheetCat1 = workbook.getWorksheet('Thời Trang Nam');
      const sheetCat2 = workbook.getWorksheet('Giày Dép');
      expect(sheetCat1).toBeDefined();
      expect(sheetCat2).toBeDefined();

      // Verify default 100 prefilled rows (rows 2..101)
      const expectedCat1Value = `${cat1.name} [${cat1._id}]`;
      expect(sheetCat1?.getCell(2, 3).value).toBe(expectedCat1Value);
      expect(sheetCat1?.getCell(101, 3).value).toBe(expectedCat1Value);
      expect(sheetCat1?.getCell(2, 3).protection?.locked).not.toBe(false);
      expect((sheetCat1 as any)?.sheetProtection?.sheet).toBe(true);
    });

    it('should generate SINGLE_SHEET layout with prefilled category when single category requested', async () => {
      mockCategoryRepository.findById.mockResolvedValue(cat1);
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [cat1],
        total: 1,
      });
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue(sampleAttributeDefs);

      const buffer = await service.generateTemplate({
        category_ids: [cat1._id],
        layout_mode: TemplateLayoutMode.SINGLE_SHEET,
        row_count: 5,
      });

      const workbook = new ExcelJS.Workbook();
      interface ExcelReader {
        load(data: unknown): Promise<ExcelJS.Workbook>;
      }
      await (workbook.xlsx as unknown as ExcelReader).load(buffer);

      const sheet = workbook.getWorksheet('Sản phẩm & Biến thể');
      expect(sheet).toBeDefined();

      const expectedCatValue = `${cat1.name} [${cat1._id}]`;
      expect(sheet?.getCell(2, 3).value).toBe(expectedCatValue);
      expect(sheet?.getCell(2, 3).protection?.locked).not.toBe(false);
      expect(sheet?.getCell(2, 1).protection?.locked).toBe(false);
      expect((sheet as any)?.sheetProtection?.sheet).toBe(true);
      // Dynamic attributes should also be present (columns 11, 12, 13)
      expect(sheet?.columnCount).toBe(13);
    });

    it('should generate SINGLE_SHEET layout with category dropdown when multiple categories requested', async () => {
      mockCategoryRepository.findById.mockImplementation(async (id: string) => {
        if (id === cat1._id) return cat1;
        if (id === cat2._id) return cat2;
        return null;
      });
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [cat1, cat2],
        total: 2,
      });

      const buffer = await service.generateTemplate({
        category_ids: [cat1._id, cat2._id],
        layout_mode: TemplateLayoutMode.SINGLE_SHEET,
        row_count: 15,
      });

      const workbook = new ExcelJS.Workbook();
      interface ExcelReader {
        load(data: unknown): Promise<ExcelJS.Workbook>;
      }
      await (workbook.xlsx as unknown as ExcelReader).load(buffer);

      const sheet = workbook.getWorksheet('Sản phẩm & Biến thể');
      expect(sheet).toBeDefined();

      // Check that category column (col 3) has dropdown dataValidation
      const cellValidation = sheet?.getCell(2, 3).dataValidation;
      expect(cellValidation?.type).toBe('list');
      expect(cellValidation?.formulae?.[0]).toContain(cat1._id);
      expect(cellValidation?.formulae?.[0]).toContain(cat2._id);
    });

    it('should throw BadRequestException when any requested category is not found or inactive', async () => {
      mockCategoryRepository.findById.mockResolvedValue(null);

      await expect(
        service.generateTemplate({
          category_ids: ['non-existent-uuid'],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getOrInitTemplate', () => {
    const cat1 = {
      _id: '01912f20-0000-7000-8000-000000000001',
      name: 'Thời Trang Nam',
      status: CategoryStatus.ACTIVE,
    };

    it('should generate and upload template when not cached in MinIO', async () => {
      mockCategoryRepository.findById.mockResolvedValue(cat1);
      mockCategoryRepository.findAllPaginated.mockResolvedValue({
        items: [cat1],
        total: 1,
      });
      mockAttributeDefinitionRepository.findByScope.mockResolvedValue([]);
      mockS3StorageService.verifyObjectUploaded.mockResolvedValue({ verified: false });
      mockS3StorageService.uploadBuffer.mockResolvedValue(undefined);
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl: 'http://localhost:9000/taca-media/templates/template.xlsx',
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await service.getOrInitTemplate(
        { category_ids: [cat1._id], row_count: 10 },
        'shop-123',
      );

      expect(mockS3StorageService.verifyObjectUploaded).toHaveBeenCalledWith(
        expect.stringMatching(/^templates\/product_import_template_/),
      );
      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/^templates\/product_import_template_/),
        expect.any(Buffer),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        expect.stringContaining('attachment; filename="product_import_template_'),
      );
      expect(result.downloadUrl).toBe('http://localhost:9000/taca-media/templates/template.xlsx');
      expect(result.filename).toMatch(/^product_import_template_/);
    });

    it('should return presigned URL directly when template is already cached in MinIO', async () => {
      mockCategoryRepository.findById.mockResolvedValue(cat1);
      mockS3StorageService.verifyObjectUploaded.mockResolvedValue({ verified: true });
      mockS3StorageService.generatePresignedDownloadUrl.mockResolvedValue({
        downloadUrl: 'http://localhost:9000/taca-media/templates/cached.xlsx',
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await service.getOrInitTemplate(
        { category_ids: [cat1._id], row_count: 10 },
        'shop-123',
      );

      expect(mockS3StorageService.verifyObjectUploaded).toHaveBeenCalled();
      expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
      expect(result.downloadUrl).toBe('http://localhost:9000/taca-media/templates/cached.xlsx');
    });

    it('should throw BadRequestException when category_ids in DTO is invalid', async () => {
      mockCategoryRepository.findById.mockResolvedValue(null);

      await expect(
        service.getOrInitTemplate({
          category_ids: ['invalid-cat-id'],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
