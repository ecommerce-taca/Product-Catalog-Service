import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { CategoryDocument, CategoryStatus } from '../../database/schemas/category.schema';
import {
  AttributeDefinitionDocument,
  AttributeDefinitionStatus,
  AttributeScopeType,
  AttributeType,
} from '../../database/schemas/attribute-definition.schema';
import { CategoryRepositoryPort } from '../../category/repositories/category.repository.interface';
import { AttributeDefinitionRepositoryPort } from '../../attribute/repositories/attribute-definition.repository.interface';

@Injectable()
export class ExcelTemplateService {
  constructor(
    @Inject('CategoryRepositoryPort')
    private readonly categoryRepository: CategoryRepositoryPort,
    @Inject('AttributeDefinitionRepositoryPort')
    private readonly attributeDefinitionRepository: AttributeDefinitionRepositoryPort,
  ) {}

  /**
   * Generates a dynamic Excel workbook template for bulk product import.
   * If categoryId is supplied, validates that category is ACTIVE and attaches its dynamic attributes.
   * Sheet 1: "Sản phẩm & Biến thể" (Fixed SPU/SKU columns + dynamic attribute columns with enum dropdowns).
   * Sheet 2: "Hướng dẫn & Danh mục" (Import rules, VND price rules, and active category references).
   */
  async generateTemplate(categoryId?: string): Promise<Buffer> {
    let attributeDefinitions: AttributeDefinitionDocument[] = [];

    if (categoryId) {
      const category = await this.categoryRepository.findById(categoryId);
      if (!category || category.status !== CategoryStatus.ACTIVE) {
        throw new BadRequestException({
          code: 'PRODUCT_CATEGORY_INVALID',
          message: `Danh mục '${categoryId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
        });
      }

      attributeDefinitions = await this.attributeDefinitionRepository.findByScope(
        AttributeScopeType.CATEGORY,
        categoryId,
        AttributeDefinitionStatus.ACTIVE,
      );
    }

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Taca Ecommerce';
    workbook.created = new Date();
    workbook.modified = new Date();

    // -------------------------------------------------------------
    // SHEET 1: "Sản phẩm & Biến thể"
    // -------------------------------------------------------------
    const sheet1 = workbook.addWorksheet('Sản phẩm & Biến thể', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    // 6 SPU columns + 4 SKU columns
    const columns: Array<{ header: string; key: string; width: number }> = [
      { header: 'Mã tham chiếu sản phẩm (*)', key: 'product_ref_id', width: 28 },
      { header: 'Tên sản phẩm (*)', key: 'title', width: 32 },
      { header: 'Mã danh mục (*)', key: 'category_id', width: 38 },
      { header: 'Mô tả sản phẩm (*)', key: 'description', width: 40 },
      { header: 'Thương hiệu', key: 'brand', width: 20 },
      { header: 'Danh sách URL ảnh (cách nhau dấu phẩy)', key: 'image_urls', width: 42 },
      { header: 'Mã SKU người bán (*)', key: 'seller_sku', width: 26 },
      { header: 'Giá bán VND (*)', key: 'price', width: 20 },
      { header: 'Giá niêm yết gốc VND', key: 'original_price', width: 22 },
      { header: 'Mã vạch', key: 'barcode', width: 20 },
    ];

    // Dynamic attribute columns
    for (const def of attributeDefinitions) {
      const label = def.label || def.key;
      columns.push({
        header: label,
        key: `attr_${def.key}`,
        width: Math.max(label.length + 6, 20),
      });
    }

    sheet1.columns = columns;

    // Style Header Row
    const headerRow = sheet1.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
      cell.font = {
        name: 'Calibri',
        size: 11,
        bold: true,
        color: { argb: 'FF000000' },
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9E1F2' }, // Soft blue
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'medium', color: { argb: 'FF4682B4' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
    });

    // Configure Data Validation dropdown list for ENUM attributes (rows 2 to 201)
    attributeDefinitions.forEach((def, index) => {
      if (
        def.type === AttributeType.ENUM &&
        Array.isArray(def.allowed_values) &&
        def.allowed_values.length > 0
      ) {
        const colIndex = 11 + index; // Fixed columns: 1..10, dynamic columns start at 11
        const formulae = [`"${def.allowed_values.join(',')}"`];
        for (let r = 2; r <= 201; r++) {
          sheet1.getCell(r, colIndex).dataValidation = {
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

    // Configure number formats for price columns (columns 8 and 9)
    for (let r = 2; r <= 201; r++) {
      sheet1.getCell(r, 8).numFmt = '#,##0';
      sheet1.getCell(r, 9).numFmt = '#,##0';
    }

    // -------------------------------------------------------------
    // SHEET 2: "Hướng dẫn & Danh mục"
    // -------------------------------------------------------------
    const sheet2 = workbook.addWorksheet('Hướng dẫn & Danh mục', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet2.columns = [
      { header: 'Mục / Trường dữ liệu', key: 'section', width: 35 },
      { header: 'Quy tắc & Hướng dẫn chi tiết', key: 'rule', width: 55 },
      { header: 'Ví dụ minh họa / Ghi chú', key: 'example', width: 45 },
    ];

    // Header style for Sheet 2
    const sheet2Header = sheet2.getRow(1);
    sheet2Header.height = 30;
    sheet2Header.eachCell((cell) => {
      cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF000000' } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFD9E1F2' },
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'medium', color: { argb: 'FF4682B4' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
    });

    // Instructions Content
    const instructions = [
      {
        section: '1. Quy tắc gom nhóm SPU - SKU',
        rule: 'Sử dụng "Mã tham chiếu sản phẩm (*)" (product_ref_id) để nhóm các dòng SKU vào cùng 1 sản phẩm cha (SPU).',
        example: 'Ví dụ: Cùng điền "AO-THUN-NAM-01" cho 3 dòng SKU biến thể.',
      },
      {
        section: '2. Dòng SPU cha (Dòng 1)',
        rule: 'Dòng đầu tiên của mỗi nhóm product_ref_id bắt buộc điền đầy đủ thông tin cha: Tên sản phẩm, Mã danh mục, Mô tả sản phẩm, Thương hiệu, Danh sách URL ảnh.',
        example:
          'Các dòng tiếp theo của cùng product_ref_id có thể để trống các cột cha, hệ thống sẽ tự động kế thừa.',
      },
      {
        section: '3. Quy tắc SKU & Biến thể',
        rule: 'Mỗi dòng đại diện cho một SKU. Bắt buộc có: Mã SKU người bán (duy nhất trong shop), Giá bán VND (*).',
        example: 'SKU-DO-M, SKU-DO-L...',
      },
      {
        section: '4. Định dạng tiền tệ VND',
        rule: 'Giá bán và Giá niêm yết là số nguyên dương VND >= 1.000 (không chứa chữ cái hoặc ký hiệu tiền tệ).',
        example: 'Hợp lệ: 150000, 200000. Không hợp lệ: 150.000đ, $10.',
      },
      {
        section: '5. Danh sách URL ảnh',
        rule: 'Điền các URL ảnh công khai (bắt đầu bằng http:// hoặc https://), phân tách nhau bởi dấu phẩy (,). Ảnh đầu tiên sẽ là ảnh đại diện.',
        example: 'https://example.com/img1.jpg,https://example.com/img2.jpg',
      },
      {
        section: '6. Thuộc tính động / Dropdown',
        rule: 'Với các thuộc tính lựa chọn (ENUM), vui lòng bấm vào ô để chọn giá trị từ dropdown list hiển thị sẵn.',
        example: 'Ví dụ chọn: Đỏ, Xanh, Đen...',
      },
      {
        section: '7. Giới hạn hệ thống',
        rule: 'Mỗi tệp nạp tối đa 100 sản phẩm (SPU), tối đa 200 dòng SKU, kích thước tệp tối đa 2MB.',
        example: 'Tất cả sản phẩm nhập thành công đều ở trạng thái DRAFT.',
      },
    ];

    instructions.forEach((item) => {
      sheet2.addRow(item);
    });

    // Add empty separator row
    sheet2.addRow({});

    // Add Category References Section Header
    const catHeaderRow = sheet2.addRow({
      section: '--- DANH SÁCH DANH MỤC THAM KHẢO ---',
      rule: 'Mã danh mục (category_id UUID)',
      example: 'Đường dẫn phân cấp',
    });
    catHeaderRow.font = { bold: true, color: { argb: 'FF1F497D' } };

    // Query active categories for reference
    try {
      const { items: categories } = await this.categoryRepository.findAllPaginated(
        { status: CategoryStatus.ACTIVE },
        1,
        100,
      );

      categories.forEach((cat: CategoryDocument) => {
        sheet2.addRow({
          section: cat.name,
          rule: cat._id,
          example: cat.path,
        });
      });
    } catch {
      // Graceful fallback if categories cannot be read during template generation
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
