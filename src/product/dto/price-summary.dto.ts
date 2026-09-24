import { Equals, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class PriceSummaryDto {
  @IsNotEmpty({ message: 'base_price không được để trống' })
  @IsInt({ message: 'base_price phải là số nguyên' })
  @Min(1, { message: 'base_price tối thiểu là 1' })
  @Max(999999999999, { message: 'base_price vượt quá giới hạn tối đa' })
  @Type(() => Number)
  base_price: number;

  @IsNotEmpty({ message: 'sale_price không được để trống' })
  @IsInt({ message: 'sale_price phải là số nguyên' })
  @Min(1, { message: 'sale_price tối thiểu là 1' })
  @Max(999999999999, { message: 'sale_price vượt quá giới hạn tối đa' })
  @Type(() => Number)
  sale_price: number;

  @IsOptional()
  @IsString()
  @Equals('VND', { message: "currency phải là 'VND'" })
  currency?: string = 'VND';
}
