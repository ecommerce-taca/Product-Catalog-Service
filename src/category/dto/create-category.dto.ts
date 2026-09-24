import { Transform, Type } from 'class-transformer';
import {
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
import { CATEGORY_SLUG_REGEX } from '../../database/schemas/category.schema';

export class CreateCategoryDto {
  @IsString()
  @IsNotEmpty({ message: 'Tên danh mục không được để trống' })
  @MaxLength(120, { message: 'Tên danh mục tối đa 120 ký tự' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  name: string;

  @IsString()
  @IsNotEmpty({ message: 'Slug không được để trống' })
  @MaxLength(160, { message: 'Slug tối đa 160 ký tự' })
  @Matches(CATEGORY_SLUG_REGEX, {
    message: 'Slug phải ở dạng chữ thường, số, phân tách bởi dấu gạch ngang đơn',
  })
  slug: string;

  @IsOptional()
  @Matches(UUIDV7_REGEX, {
    message: 'parent_id phải là định dạng UUIDv7 hợp lệ',
  })
  parent_id?: string | null;

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
