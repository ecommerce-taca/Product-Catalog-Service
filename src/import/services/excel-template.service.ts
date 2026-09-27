import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
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
import { S3StorageService } from '../../integrations/storage/s3-storage.service';

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
  ) {}

  /**
   * Retrieves an existing Excel template from MinIO S3 via Presigned Download URL.
   * If the template does not exist on MinIO yet, initializes and uploads it once.
   */
  async getOrInitTemplate(categoryId?: string): Promise<TemplatePresignedResult> {
    if (categoryId) {
      const category = await this.categoryRepository.findById(categoryId);
      if (!category || category.status !== CategoryStatus.ACTIVE) {
        throw new BadRequestException({
          code: 'PRODUCT_CATEGORY_INVALID',
          message: `Danh mục '${categoryId}' không tồn tại hoặc không ở trạng thái ACTIVE.`,
        });
      }
    }

    const filename = `product_import_template_${categoryId || 'default'}.xlsx`;
    const s3Key = `templates/${filename}`;

    // 1. Check if template already exists on MinIO
    const check = await this.storageService.verifyObjectUploaded(s3Key);

    // 2. Initialize and upload if not yet present
    if (!check.verified) {
      this.logger.log(
        `Template '${s3Key}' not found on MinIO. Initializing clean template buffer...`,
      );
      const buffer = await this.generateTemplate(categoryId);
      await this.storageService.uploadBuffer(
        s3Key,
        buffer,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        `attachment; filename="${filename}"`,
      );
      this.logger.log(`Template '${s3Key}' successfully initialized and uploaded to MinIO.`);
    }

    // 3. Generate presigned download URL (TTL 1 hour)
    const presigned = await this.storageService.generatePresignedDownloadUrl(s3Key, 3600);

    return {
      downloadUrl: presigned.downloadUrl,
      filename,
      expiresAt: presigned.expiresAt,
    };
  }

  /**
   * Generates a dynamic Excel workbook template for bulk product import.
   * If categoryId is supplied, validates that category is ACTIVE and attaches its dynamic attributes.
   * Sheet 1: "Sản phẩm & Biến thể" (Fixed SPU/SKU columns + dynamic attribute columns with enum dropdowns).
   * Sheet 2: "Ví dụ điền mẫu" (Pre-filled realistic examples for SPU multi-SKU variants and single products).
   * Sheet 3: "Hướng dẫn & Danh mục" (Import rules, VND price rules, and active category references).
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
    sheet1.getColumn(8).numFmt = '#,##0';
    sheet1.getColumn(9).numFmt = '#,##0';

    // -------------------------------------------------------------
    // SHEET 2: "Ví dụ điền mẫu" (Tab mẫu tham khảo trực quan cho Người bán)
    // -------------------------------------------------------------
    const sheetExample = workbook.addWorksheet('Ví dụ điền mẫu', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheetExample.columns = columns.map((col) => ({ ...col }));

    const exampleHeaderRow = sheetExample.getRow(1);
    exampleHeaderRow.height = 30;
    exampleHeaderRow.eachCell((cell) => {
      cell.font = {
        name: 'Calibri',
        size: 11,
        bold: true,
        color: { argb: 'FF000000' },
      };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE2EFDA' }, // Soft green to distinguish as sample/reference
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: 'center',
        wrapText: true,
      };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        left: { style: 'thin', color: { argb: 'FFB0C4DE' } },
        bottom: { style: 'medium', color: { argb: 'FF548235' } },
        right: { style: 'thin', color: { argb: 'FFB0C4DE' } },
      };
    });

    // Configure number formats for price columns (columns 8 and 9)
    sheetExample.getColumn(8).numFmt = '#,##0';
    sheetExample.getColumn(9).numFmt = '#,##0';

    const sampleCatId = categoryId || '01912f20-0000-7000-8000-000000000001';

    const sampleRow1: Record<string, any> = {
      product_ref_id: 'AO-THUN-NAM-01',
      title: 'Áo Thun Nam Cổ Tròn Cotton 100% Co Giãn Thoáng Mát',
      category_id: sampleCatId,
      description:
        'Chất liệu 100% cotton cao cấp, thấm hút mồ hôi tối đa, thoáng khí, giữ form chuẩn sau nhiều lần giặt.',
      brand: 'Taca Fashion',
      image_urls:
        'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=800,https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?w=800',
      seller_sku: 'AT-NAM-DEN-M',
      price: 150000,
      original_price: 220000,
      barcode: '8938500101011',
    };

    const sampleRow2: Record<string, any> = {
      product_ref_id: 'AO-THUN-NAM-01',
      title: '', // để trống: hệ thống tự động kế thừa từ dòng đầu tiên của AO-THUN-NAM-01
      category_id: '',
      description: '',
      brand: '',
      image_urls: '',
      seller_sku: 'AT-NAM-DEN-L',
      price: 150000,
      original_price: 220000,
      barcode: '8938500101012',
    };

    const sampleRow3: Record<string, any> = {
      product_ref_id: 'AO-THUN-NAM-01',
      title: '',
      category_id: '',
      description: '',
      brand: '',
      image_urls: 'https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?w=800',
      seller_sku: 'AT-NAM-TRANG-XL',
      price: 165000,
      original_price: 240000,
      barcode: '8938500101013',
    };

    const sampleRow4: Record<string, any> = {
      product_ref_id: 'BALO-LAPTOP-02',
      title: 'Balo Laptop Chống Nước 15.6 inch Đa Năng Có Cổng Sạc USB',
      category_id: sampleCatId,
      description:
        'Vải Oxford chống thấm nước chuyên dụng, ngăn chống sốc laptop 15.6 inch, thiết kế công sở hiện đại.',
      brand: 'Taca Urban',
      image_urls: 'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?w=800',
      seller_sku: 'BALO-LAPTOP-DEN',
      price: 350000,
      original_price: 490000,
      barcode: '8938500202022',
    };

    if (attributeDefinitions.length > 0) {
      attributeDefinitions.forEach((def) => {
        const val1 = def.allowed_values?.[0] || 'Mẫu 1';
        const val2 = def.allowed_values?.[1] || def.allowed_values?.[0] || 'Mẫu 2';
        const val3 = def.allowed_values?.[2] || def.allowed_values?.[0] || 'Mẫu 3';
        sampleRow1[`attr_${def.key}`] = val1;
        sampleRow2[`attr_${def.key}`] = val2;
        sampleRow3[`attr_${def.key}`] = val3;
        sampleRow4[`attr_${def.key}`] = val1;
      });
    }

    [sampleRow1, sampleRow2, sampleRow3, sampleRow4].forEach((rowObj) => {
      const addedRow = sheetExample.addRow(rowObj);
      addedRow.height = 22;
      addedRow.eachCell((cell) => {
        cell.font = { name: 'Calibri', size: 10 };
        cell.alignment = { vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          left: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } },
          right: { style: 'thin', color: { argb: 'FFE0E0E0' } },
        };
      });
    });

    // -------------------------------------------------------------
    // SHEET 3: "Hướng dẫn & Danh mục"
    // -------------------------------------------------------------
    const sheet2 = workbook.addWorksheet('Hướng dẫn & Danh mục', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    sheet2.columns = [
      { header: 'Mục / Trường dữ liệu', key: 'section', width: 35 },
      { header: 'Quy tắc & Hướng dẫn chi tiết', key: 'rule', width: 55 },
      { header: 'Ví dụ minh họa / Ghi chú', key: 'example', width: 45 },
    ];

    // Header style for Sheet 3
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
        section: '★ Mẫu ví dụ minh họa',
        rule: 'Vui lòng xem tab sheet "Ví dụ điền mẫu" kế bên để xem trực quan cách điền dữ liệu thực tế cho sản phẩm có biến thể và sản phẩm đơn.',
        example: 'Xem tab "Ví dụ điền mẫu"',
      },
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
    sheet2.addRow({ section: '', rule: '', example: '' });

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
