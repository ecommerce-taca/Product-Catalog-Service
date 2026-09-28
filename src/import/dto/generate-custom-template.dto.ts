import { IsArray, IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum TemplateLayoutMode {
  MULTI_SHEET = 'MULTI_SHEET',
  SINGLE_SHEET = 'SINGLE_SHEET',
}

export class GenerateCustomTemplateDto {
  /**
   * Số dòng dữ liệu trống được tạo sẵn định dạng (viền bảng, dropdown, prefill category).
   * Trường này hoàn toàn TÙY CHỌN, mặc định là 100 dòng (hỗ trợ từ 5 đến 200 dòng).
   * Người bán KHÔNG cần phải tự tính toán hay nhập số dòng/số biến thể trước khi tải template.
   * Các dòng trống người bán không điền sẽ được worker tự động bỏ qua một cách an toàn khi nạp file.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'row_count phải là số nguyên' })
  @Min(5, { message: 'row_count tối thiểu là 5 dòng' })
  @Max(200, { message: 'row_count tối đa là 200 dòng' })
  row_count?: number;

  @IsOptional()
  @IsArray({ message: 'category_ids phải là một mảng chuỗi UUID' })
  @IsUUID(undefined, { each: true, message: 'Mỗi category_id phải là định dạng UUID hợp lệ' })
  category_ids?: string[];

  @IsOptional()
  @IsArray({ message: 'product_ids phải là một mảng chuỗi UUID' })
  @IsUUID(undefined, { each: true, message: 'Mỗi product_id phải là định dạng UUID hợp lệ' })
  product_ids?: string[];

  @IsOptional()
  @IsEnum(TemplateLayoutMode, { message: 'layout_mode phải là MULTI_SHEET hoặc SINGLE_SHEET' })
  layout_mode?: TemplateLayoutMode;
}
