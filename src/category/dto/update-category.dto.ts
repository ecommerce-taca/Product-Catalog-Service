import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UUIDV7_REGEX } from '../../database/base.schema';
import { CATEGORY_SLUG_REGEX, CategoryStatus } from '../../database/schemas/category.schema';

export class UpdateCategoryDto {
  @IsNotEmpty({ message: 'version là bắt buộc để kiểm soát concurrency' })
  @Type(() => Number)
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version phải lớn hơn hoặc bằng 1' })
  version: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Tên danh mục không được để trống nếu được truyền' })
  @MaxLength(120, { message: 'Tên danh mục tối đa 120 ký tự' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160, { message: 'Slug tối đa 160 ký tự' })
  @Matches(CATEGORY_SLUG_REGEX, {
    message: 'Slug phải ở dạng chữ thường, số, phân tách bởi dấu gạch ngang đơn',
  })
  slug?: string;

  @IsOptional()
  @Matches(UUIDV7_REGEX, {
    message: 'parent_id phải là định dạng UUIDv7 hợp lệ',
  })
  parent_id?: string | null;

  @IsOptional()
  @IsEnum(CategoryStatus, {
    message: 'status phải là ACTIVE, INACTIVE hoặc ARCHIVED',
  })
  status?: CategoryStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sort_order phải là số nguyên' })
  @Min(0, { message: 'sort_order phải lớn hơn hoặc bằng 0' })
  sort_order?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'tax_rate_bps phải là số nguyên' })
  @Min(0, { message: 'tax_rate_bps phải lớn hơn hoặc bằng 0' })
  @Max(10000, { message: 'tax_rate_bps không được vượt quá 10000' })
  tax_rate_bps?: number | null;
}
