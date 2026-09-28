import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as crypto from 'crypto';
import { CategoryDocument, CategoryStatus } from '../../database/schemas/category.schema';
import {
  AttributeDefinitionDocument,
  AttributeDefinitionStatus,
  AttributeScopeType,
  AttributeType,
} from '../../database/schemas/attribute-definition.schema';
import { CategoryRepositoryPort } from '../../category/repositories/category.repository.interface';
import { AttributeDefinitionRepositoryPort } from '../../attribute/repositories/attribute-definition.repository.interface';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { ProductDocument } from '../../database/schemas/product.schema';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { GenerateCustomTemplateDto, TemplateLayoutMode } from '../dto/generate-custom-template.dto';
import { ExcelFormulaSanitizer } from '../utils/excel-formula-sanitizer.util';

export interface TemplatePresignedResult {
  downloadUrl: string;
  filename: string;
  expiresAt: Date;
}

@Injectable()
export class ExcelTemplateService {
  private readonly logger = new Logger(ExcelTemplateService.name);

  constructor(
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepository: CategoryRepositoryPort,
    @Inject('AttributeDefinitionRepositoryPort')
    private readonly attributeDefinitionRepository: AttributeDefinitionRepositoryPort,
    private readonly storageService: S3StorageService,
    @Optional()
    @Inject('ProductRepositoryPort')
    private readonly productRepository?: ProductRepositoryPort,
  ) {}
  /**
   * Retrieves or initializes an Excel template based on seller filter options (POST body).
   * Generates a deterministic hash for MinIO cache and returns a Presigned Download URL (TTL 1 hour).
   */
  async getOrInitTemplate(
    dto: GenerateCustomTemplateDto = {},
    shopId?: string,
  ): Promise<TemplatePresignedResult> {
    if (dto.category_ids && dto.category_ids.length > 0) {
      for (const catId of dto.category_ids) {
        const category = await this.categoryRepository.findById(catId);
        if (!category || category.status !== CategoryStatus.ACTIVE) {
          throw new BadRequestException({
            code: 'PRODUCT_CATEGORY_INVALID',
            message: `Danh mục '${catId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
          });
        }
      }
    }

    let filename: string;
    if (
      dto.category_ids &&
      dto.category_ids.length === 1 &&
      !dto.row_count &&
      !dto.product_ids &&
      !dto.layout_mode
    ) {
      filename = `product_import_template_${dto.category_ids[0]}.xlsx`;
    } else if (
      (!dto.category_ids || dto.category_ids.length === 0) &&
      !dto.row_count &&
      !dto.product_ids &&
      !dto.layout_mode
    ) {
      filename = 'product_import_template_default.xlsx';
    } else {
      const hashPayload = JSON.stringify({
        row_count: dto.row_count,
        category_ids: dto.category_ids?.slice().sort(),
        product_ids: dto.product_ids?.slice().sort(),
        layout_mode: dto.layout_mode,
        shopId,
      });
      const hash = crypto.createHash('sha256').update(hashPayload).digest('hex').substring(0, 16);
      filename = `product_import_template_${hash}.xlsx`;
    }
    const s3Key = `templates/${filename}`;

    const check = await this.storageService.verifyObjectUploaded(s3Key);
    if (!check.verified) {
      this.logger.log(`Template '${s3Key}' not in MinIO. Generating...`);
      const buffer = await this.generateTemplate(dto, shopId);
      await this.storageService.uploadBuffer(
        s3Key,
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        `attachment; filename="${filename}"`,
      );
      this.logger.log(`Template '${s3Key}' successfully uploaded to MinIO.`);
    }

    const presigned = await this.storageService.generatePresignedDownloadUrl(s3Key, 3600);
    return {
      downloadUrl: presigned.downloadUrl,
      filename,
      expiresAt: presigned.expiresAt,
    };
  }

  /**
   * Generates an Excel workbook template based on seller options.
   * Supports:
   * - Custom row count (5..200)
   * - Friendly category name format: "Tên Danh Mục [ID]"
   * - Multi-sheet layout (one tab sheet per category with dedicated attributes and protection)
   * - Single-sheet layout with dropdown category selection
   * - SPU prepopulation when product_ids are selected
   */
  async generateTemplate(dto: GenerateCustomTemplateDto = {}, shopId?: string): Promise<Buffer> {
    const rowCount = Math.max(5, Math.min(200, dto.row_count || 100));

    // Load validated categories
    const categories: CategoryDocument[] = [];
    if (dto.category_ids && dto.category_ids.length > 0) {
      for (const catId of dto.category_ids) {
        const cat = await this.categoryRepository.findById(catId);
        if (!cat || cat.status !== CategoryStatus.ACTIVE) {
          throw new BadRequestException({
            code: 'PRODUCT_CATEGORY_INVALID',
            message: `Danh mục '${catId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
          });
        }
        categories.push(cat);
      }
    }

    // Load products if product_ids provided
    const prefillProducts: ProductDocument[] = [];
    if (dto.product_ids && dto.product_ids.length > 0 && this.productRepository && shopId) {
      for (const prodId of dto.product_ids) {
        const prod = await this.productRepository.findByShopAndId(shopId, prodId);
        if (prod) {
          prefillProducts.push(prod);
          if (categories.length === 0 && prod.primary_category_id) {
            const cat = await this.categoryRepository.findById(prod.primary_category_id);
            if (
              cat &&
              cat.status === CategoryStatus.ACTIVE &&
              !categories.some((c) => c._id === cat._id)
            ) {
              categories.push(cat);
            }
          }
        }
      }
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Taca Ecommerce';
    workbook.created = new Date();
    workbook.modified = new Date();

    const layoutMode =
      dto.layout_mode ||
      (categories.length > 1 ? TemplateLayoutMode.MULTI_SHEET : TemplateLayoutMode.SINGLE_SHEET);

    if (layoutMode === TemplateLayoutMode.MULTI_SHEET && categories.length > 0) {
      // -------------------------------------------------------------
      // MULTI-SHEET MODE: One tab sheet per selected category
      // -------------------------------------------------------------
      const usedSheetNames = new Set<string>();

      for (const cat of categories) {
        const baseName =
          cat.name
            .replace(/[\\/?*[\]:]/g, ' ')
            .trim()
            .substring(0, 28) || 'Danh mục';
        let sheetName = baseName;
        let counter = 2;
        while (usedSheetNames.has(sheetName.toLowerCase())) {
          sheetName = `${baseName} (${counter++})`.substring(0, 31);
        }
        usedSheetNames.add(sheetName.toLowerCase());

        const attributeDefinitions = await this.attributeDefinitionRepository.findByScope(
          AttributeScopeType.CATEGORY,
          cat._id,
          AttributeDefinitionStatus.ACTIVE,
        );

        const sheet = workbook.addWorksheet(sheetName, {
          views: [{ state: 'frozen', ySplit: 1 }],
        });

        const columns = this.buildBaseColumns();
        for (const def of attributeDefinitions) {
          const label = def.label || def.key;
          columns.push({
            header: label,
            key: `attr_${def.key}`,
            width: Math.max(label.length + 6, 20),
          });
        }
        sheet.columns = columns;

        this.applyHeaderStyle(sheet);
        this.configureEnumDropdowns(sheet, attributeDefinitions, 2, rowCount + 1);

        sheet.getColumn(8).numFmt = '#,##0';
        sheet.getColumn(9).numFmt = '#,##0';

        const friendlyCatValue = `${cat.name} [${cat._id}]`;

        // Prepopulate existing SPU products if any belong to this category
        const catProducts = prefillProducts.filter((p) => p.primary_category_id === cat._id);
        let currentRow = 2;
        if (catProducts.length > 0) {
          for (const prod of catProducts) {
            const row = sheet.getRow(currentRow++);
            row.getCell(1).value = ExcelFormulaSanitizer.sanitize(prod.slug || prod._id);
            row.getCell(2).value = ExcelFormulaSanitizer.sanitize(prod.title);
            row.getCell(3).value = ExcelFormulaSanitizer.sanitize(friendlyCatValue);
            row.getCell(4).value = ExcelFormulaSanitizer.sanitize(prod.description || '');
            row.getCell(5).value = ExcelFormulaSanitizer.sanitize(prod.brand || '');
          }
        }

        // Fill remaining rows with prefilled & locked friendly category value
        const totalCols = columns.length;
        for (let r = 2; r <= rowCount + 1; r++) {
          const cellCat = sheet.getCell(r, 3);
          if (!cellCat.value) {
            cellCat.value = ExcelFormulaSanitizer.sanitize(friendlyCatValue);
          }
          cellCat.protection = { locked: true };

          for (let c = 1; c <= totalCols; c++) {
            if (c !== 3) {
              sheet.getCell(r, c).protection = { locked: false };
            }
          }
        }

        await sheet.protect('', {
          spinCount: 1,
          selectLockedCells: true,
          selectUnlockedCells: true,
        });
      }
    } else {
      // -------------------------------------------------------------
      // SINGLE-SHEET MODE: All products in one sheet
      // -------------------------------------------------------------
      const sheet1 = workbook.addWorksheet('Sản phẩm & Biến thể', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });

      let attributeDefinitions: AttributeDefinitionDocument[] = [];
      if (categories.length === 1) {
        attributeDefinitions = await this.attributeDefinitionRepository.findByScope(
          AttributeScopeType.CATEGORY,
          categories[0]._id,
          AttributeDefinitionStatus.ACTIVE,
        );
      }

      const columns = this.buildBaseColumns();
      for (const def of attributeDefinitions) {
        const label = def.label || def.key;
        columns.push({
          header: label,
          key: `attr_${def.key}`,
          width: Math.max(label.length + 6, 20),
        });
      }
      sheet1.columns = columns;

      this.applyHeaderStyle(sheet1);
      this.configureEnumDropdowns(sheet1, attributeDefinitions, 2, rowCount + 1);

      sheet1.getColumn(8).numFmt = '#,##0';
      sheet1.getColumn(9).numFmt = '#,##0';

      const totalCols = columns.length;

      if (categories.length === 1) {
        const cat = categories[0];
        const friendlyCatValue = `${cat.name} [${cat._id}]`;

        let currentRow = 2;
        if (prefillProducts.length > 0) {
          for (const prod of prefillProducts) {
            const row = sheet1.getRow(currentRow++);
            row.getCell(1).value = ExcelFormulaSanitizer.sanitize(prod.slug || prod._id);
            row.getCell(2).value = ExcelFormulaSanitizer.sanitize(prod.title);
            row.getCell(3).value = ExcelFormulaSanitizer.sanitize(friendlyCatValue);
            row.getCell(4).value = ExcelFormulaSanitizer.sanitize(prod.description || '');
            row.getCell(5).value = ExcelFormulaSanitizer.sanitize(prod.brand || '');
          }
        }

        for (let r = 2; r <= rowCount + 1; r++) {
          const cellCat = sheet1.getCell(r, 3);
          if (!cellCat.value) {
            cellCat.value = ExcelFormulaSanitizer.sanitize(friendlyCatValue);
          }
          cellCat.protection = { locked: true };

          for (let c = 1; c <= totalCols; c++) {
            if (c !== 3) {
              sheet1.getCell(r, c).protection = { locked: false };
            }
          }
        }

        await sheet1.protect('', {
          spinCount: 1,
          selectLockedCells: true,
          selectUnlockedCells: true,
        });
      } else if (categories.length > 1) {
        // Dropdown selection for multiple categories in column 3
        const catDropdownFormula = [`"${categories.map((c) => `${c.name} [${c._id}]`).join(',')}"`];
        for (let r = 2; r <= rowCount + 1; r++) {
          sheet1.getCell(r, 3).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae: catDropdownFormula,
            showErrorMessage: true,
            errorTitle: 'Chọn danh mục',
            error: 'Vui lòng chọn một danh mục trong danh sách có sẵn.',
          };
          for (let c = 1; c <= totalCols; c++) {
            sheet1.getCell(r, c).protection = { locked: false };
          }
        }

        await sheet1.protect('', {
          spinCount: 1,
          selectLockedCells: true,
          selectUnlockedCells: true,
        });
      }
    }

    // Append Example & Guidance worksheets
    const sampleCat = categories[0];
    const sampleCatFriendly = sampleCat ? `${sampleCat.name} [${sampleCat._id}]` : undefined;
    this.appendExampleWorksheet(workbook, sampleCatFriendly);
    await this.appendGuidanceWorksheet(workbook);

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private buildBaseColumns(): Array<{ header: string; key: string; width: number }> {
    return [
      { header: 'Mã tham chiếu sản phẩm (*)', key: 'product_ref_id', width: 28 },
      { header: 'Tên sản phẩm (*)', key: 'title', width: 32 },
      { header: 'Mã danh mục (*)', key: 'category_id', width: 42 },
      { header: 'Mô tả sản phẩm (*)', key: 'description', width: 40 },
      { header: 'Thương hiệu', key: 'brand', width: 20 },
      { header: 'Danh sách URL ảnh (cách nhau dấu phẩy)', key: 'image_urls', width: 42 },
      { header: 'Mã SKU người bán (*)', key: 'seller_sku', width: 26 },
      { header: 'Giá bán VND (*)', key: 'price', width: 20 },
      { header: 'Giá niêm yết gốc VND', key: 'original_price', width: 22 },
      { header: 'Mã vạch', key: 'barcode', width: 20 },
    ];
  }

  private applyHeaderStyle(sheet: ExcelJS.Worksheet): void {
    const headerRow = sheet.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'medium', color: { argb: 'FF4682B4' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
      cell.protection = { locked: true };
    });
  }

  private configureEnumDropdowns(
    sheet: ExcelJS.Worksheet,
    attributeDefinitions: AttributeDefinitionDocument[],
    startRow: number,
    endRow: number,
  ): void {
    attributeDefinitions.forEach((def, index) => {
      if (
        def.type === AttributeType.ENUM &&
        Array.isArray(def.allowed_values) &&
        def.allowed_values.length > 0
      ) {
        const colIndex = 11 + index;
        const formulae = [`"${def.allowed_values.join(',')}"`];
        for (let r = startRow; r <= endRow; r++) {
          sheet.getCell(r, colIndex).dataValidation = {
            type: 'list',
            allowBlank: true,
            formulae,
            showErrorMessage: true,
            errorTitle: 'Giá trị không hợp lệ',
            error: `Vui lòng chọn một giá trị trong danh sách (${def.allowed_values.join(', ')})`,
          };
        }
      }
    });
  }

  private appendExampleWorksheet(workbook: ExcelJS.Workbook, sampleCatFriendly?: string): void {
    const sheetExample = workbook.addWorksheet('Ví dụ điền mẫu', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const columns = this.buildBaseColumns();
    columns.push(
      { header: 'Màu sắc', key: 'attr_color', width: 20 },
      { header: 'Kích cỡ', key: 'attr_size', width: 20 },
    );
    sheetExample.columns = columns;

    const exampleHeaderRow = sheetExample.getRow(1);
    exampleHeaderRow.height = 30;
    exampleHeaderRow.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'medium', color: { argb: 'FF548235' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
    });

    sheetExample.getColumn(8).numFmt = '#,##0';
    sheetExample.getColumn(9).numFmt = '#,##0';

    const catVal = sampleCatFriendly || 'Thời Trang Nam [01912f20-0000-7000-8000-000000000001]';

    // SPU 1: AO-POLO-NAM (4 biến thể: Trắng-M, Trắng-L, Đen-M, Đen-L), giá 250.000
    sheetExample.addRow({
      product_ref_id: 'AO-POLO-NAM',
      title: 'Áo Polo Nam Thể Thao Phối Viền Co Giãn Thoáng Khí',
      category_id: catVal,
      description:
        'Chất liệu vải cá sấu mè cao cấp, co giãn 4 chiều, thấm hút mồ hôi tối đa, thoáng khí giữ form chuẩn.',
      brand: 'Taca Fashion',
      image_urls:
        'https://images.unsplash.com/photo-1581655353564-df123a1eb820?w=800,https://images.unsplash.com/photo-1586363104862-3a5e2ab60d99?w=800',
      seller_sku: 'POLO-NAM-TRANG-M',
      price: 250000,
      original_price: 350000,
      barcode: '8938500102011',
      attr_color: 'Trắng',
      attr_size: 'M',
    });

    sheetExample.addRow({
      product_ref_id: 'AO-POLO-NAM',
      title: '',
      category_id: '',
      description: '',
      brand: '',
      image_urls: '',
      seller_sku: 'POLO-NAM-TRANG-L',
      price: 250000,
      original_price: 350000,
      barcode: '8938500102012',
      attr_color: 'Trắng',
      attr_size: 'L',
    });

    sheetExample.addRow({
      product_ref_id: 'AO-POLO-NAM',
      title: '',
      category_id: '',
      description: '',
      brand: '',
      image_urls: '',
      seller_sku: 'POLO-NAM-DEN-M',
      price: 250000,
      original_price: 350000,
      barcode: '8938500102013',
      attr_color: 'Đen',
      attr_size: 'M',
    });

    sheetExample.addRow({
      product_ref_id: 'AO-POLO-NAM',
      title: '',
      category_id: '',
      description: '',
      brand: '',
      image_urls: '',
      seller_sku: 'POLO-NAM-DEN-L',
      price: 250000,
      original_price: 350000,
      barcode: '8938500102014',
      attr_color: 'Đen',
      attr_size: 'L',
    });

    // SPU 2: BALO-CHONG-NUOC (1 biến thể đơn duy nhất: Đen Carbon - Tiêu chuẩn 45L), giá 450.000
    sheetExample.addRow({
      product_ref_id: 'BALO-CHONG-NUOC',
      title: 'Balo Du Lịch Chống Nước Đa Năng 45L Có Ngăn Laptop',
      category_id: catVal,
      description:
        'Vải Oxford cao cấp chống nước tuyệt đối, quai đeo đệm thoáng khí, ngăn laptop 15.6 inch.',
      brand: 'Taca Travel',
      image_urls: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800',
      seller_sku: 'BALO-CN-45L-DEN',
      price: 450000,
      original_price: 650000,
      barcode: '8938500201011',
      attr_color: 'Đen Carbon',
      attr_size: 'Tiêu chuẩn 45L',
    });

    // SPU 3: GIAY-SNEAKER (3 biến thể: Trắng-39, Trắng-40, Trắng-41), giá 500.000
    sheetExample.addRow({
      product_ref_id: 'GIAY-SNEAKER',
      title: 'Giày Sneaker Thể Thao Nam Nữ Phong Cách Hàn Quốc',
      category_id: catVal,
      description:
        'Đế cao su lưu hóa siêu êm, thân vải canvas thoáng khí, thiết kế trẻ trung năng động.',
      brand: 'Taca Sneaker',
      image_urls:
        'https://images.unsplash.com/photo-1542291026-7eec264c27ff?w=800,https://images.unsplash.com/photo-1549298916-b41d501d3772?w=800',
      seller_sku: 'SNK-TRANG-39',
      price: 500000,
      original_price: 750000,
      barcode: '8938500301011',
      attr_color: 'Trắng',
      attr_size: '39',
    });

    sheetExample.addRow({
      product_ref_id: 'GIAY-SNEAKER',
      title: '',
      category_id: '',
      description: '',
      brand: '',
      image_urls: '',
      seller_sku: 'SNK-TRANG-40',
      price: 500000,
      original_price: 750000,
      barcode: '8938500301012',
      attr_color: 'Trắng',
      attr_size: '40',
    });

    sheetExample.addRow({
      product_ref_id: 'GIAY-SNEAKER',
      title: '',
      category_id: '',
      description: '',
      brand: '',
      image_urls: '',
      seller_sku: 'SNK-TRANG-41',
      price: 500000,
      original_price: 750000,
      barcode: '8938500301013',
      attr_color: 'Trắng',
      attr_size: '41',
    });
  }

  private async appendGuidanceWorksheet(workbook: ExcelJS.Workbook): Promise<void> {
    const sheetGuide = workbook.addWorksheet('Hướng dẫn & Danh mục', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheetGuide.columns = [
      { header: 'Mục / Trường dữ liệu', key: 'section', width: 35 },
      { header: 'Quy tắc & Hướng dẫn chi tiết', key: 'rule', width: 55 },
      { header: 'Ví dụ minh họa / Ghi chú', key: 'example', width: 45 },
    ];

    const header = sheetGuide.getRow(1);
    header.height = 30;
    header.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'medium', color: { argb: 'FF4682B4' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
    });

    const instructions = [
      {
        section: '★ NGUYÊN TẮC VÀNG PHÂN CỤM BIẾN THỂ',
        rule: 'CÙNG Mã tham chiếu (product_ref_id) = Các biến thể của cùng 1 sản phẩm (nhiều màu sắc, kích cỡ). ĐỔI Mã tham chiếu = Bắt đầu một sản phẩm mới hoàn toàn.',
        example:
          'Xem sheet "Ví dụ điền mẫu": 4 dòng AO-POLO-NAM (1 SPU), 1 dòng BALO-CHONG-NUOC (1 SPU), 3 dòng GIAY-SNEAKER (1 SPU).',
      },
      {
        section: '1. Dòng SPU cha (Dòng đầu tiên)',
        rule: 'Dòng đầu tiên của mỗi nhóm Mã tham chiếu bắt buộc điền đầy đủ: Tên sản phẩm, Mã danh mục, Mô tả sản phẩm, Thương hiệu, Danh sách URL ảnh.',
        example:
          'Các dòng tiếp theo của cùng Mã tham chiếu để trống các cột cha; hệ thống tự động kế thừa.',
      },
      {
        section: '2. Các dòng SKU biến thể tiếp theo',
        rule: 'Các dòng tiếp theo CÙNG Mã tham chiếu chỉ cần điền: Mã SKU, Giá bán, Giá niêm yết, Mã vạch và các thuộc tính biến thể (Màu sắc, Size). CỘT TÊN VÀ MÔ TẢ ĐỂ TRỐNG.',
        example: 'Dòng 2, 3, 4 trong sheet Ví dụ để trống Tên & Mô tả; chỉ điền SKU và Màu/Size.',
      },
      {
        section: '3. Sản phẩm đơn (1 biến thể duy nhất)',
        rule: 'Chỉ cần điền 1 dòng duy nhất với Mã tham chiếu riêng biệt và điền đầy đủ cả thông tin cha lẫn SKU/giá bán.',
        example: 'Xem ví dụ BALO-CHONG-NUOC trong sheet "Ví dụ điền mẫu".',
      },
      {
        section: '4. Số dòng & Tự động bỏ qua dòng trống',
        rule: 'Mặc định template tạo sẵn 100 dòng trống đã format chuẩn viền, dropdown và prefill category. Người bán KHÔNG cần tự tính hay điền hết 100 dòng. Các dòng trống không điền sẽ được worker tự động bỏ qua an toàn.',
        example:
          'Điền 8 dòng dữ liệu, 92 dòng còn lại để trống: hệ thống xử lý chính xác 8 dòng, không báo lỗi.',
      },
      {
        section: '5. Định dạng Tên Danh Mục Thân Thiện',
        rule: 'Hệ thống hỗ trợ hiển thị danh mục dạng "Tên Danh Mục [ID]". Người bán có thể chọn từ dropdown hoặc điền trực tiếp.',
        example: 'Thời Trang Nam [01912f20-0000-7000-8000-000000000001]',
      },
      {
        section: '6. Bổ sung SKU cho sản phẩm đã có',
        rule: 'Điền mã ID (UUID) hoặc slug của sản phẩm đã có vào cột "Mã tham chiếu sản phẩm (*)". Hệ thống sẽ tự động gán thêm các SKU mới vào sản phẩm đó.',
        example: '01912f30-0000-7000-8000-000000000001 hoặc ao-polo-nam-1234',
      },
      {
        section: '7. Quy tắc SKU & Tiền tệ VND',
        rule: 'Mỗi dòng đại diện cho 1 SKU. Giá bán và Giá niêm yết là số nguyên dương VND >= 1.000. Mã SKU người bán phải là duy nhất trên toàn shop.',
        example: '250000, 350000. Không điền 250.000đ hay ký tự $',
      },
      {
        section: '8. Giới hạn hệ thống',
        rule: 'Mỗi tệp nạp tối đa 100 sản phẩm (SPU), tối đa 200 dòng SKU, dung lượng tệp <= 2MB.',
        example: 'Tất cả sản phẩm mới tạo đều ở trạng thái DRAFT an toàn.',
      },
    ];

    instructions.forEach((item) => {
      sheetGuide.addRow(item);
    });

    sheetGuide.addRow({ section: '', rule: '', example: '' });

    const catHeaderRow = sheetGuide.addRow({
      section: '--- DANH SÁCH DANH MỤC THAM KHẢO ---',
      rule: 'Tên & Mã danh mục (category_id UUID)',
      example: 'Đường dẫn phân cấp',
    });
    catHeaderRow.font = { bold: true, color: { argb: 'FF1F497D' } };

    try {
      const { items: categories } = await this.categoryRepository.findAllPaginated(
        { status: CategoryStatus.ACTIVE },
        1,
        100,
      );

      categories.forEach((cat: CategoryDocument) => {
        sheetGuide.addRow({
          section: `${cat.name} [${cat._id}]`,
          rule: cat._id,
          example: cat.path,
        });
      });
    } catch {
      // Graceful fallback
    }
  }
}
