import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PriceSummaryDto } from './price-summary.dto';

export class UpdateProductDto {
  @IsNotEmpty({ message: 'version không được để trống' })
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version tối thiểu là 1' })
  @Type(() => Number)
  version: number;

  @IsOptional()
  @IsString({ message: 'title phải là chuỗi ký tự' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(200, { message: 'title tối đa 200 ký tự' })
  title?: string;

  @IsOptional()
  @IsString({ message: 'slug phải là chuỗi ký tự' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'slug phải ở dạng lowercase-hyphen (chỉ chứa chữ thường, số, gạch ngang ở giữa)',
  })
  @MaxLength(160, { message: 'slug tối đa 160 ký tự' })
  slug?: string;

  @IsOptional()
  @IsString({ message: 'description phải là chuỗi ký tự' })
  @MaxLength(100000, { message: 'description tối đa 100.000 ký tự' })
  description?: string | null;

  @IsOptional()
  @IsString({ message: 'brand phải là chuỗi ký tự' })
  @MaxLength(100, { message: 'brand tối đa 100 ký tự' })
  brand?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => PriceSummaryDto)
  price_summary?: PriceSummaryDto | null;
}
