import { IsEnum, IsInt, IsISO8601, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ProductStatus } from '../../database/schemas/product.schema';

export class QueryAdminProductsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page phải là số nguyên' })
  @Min(1, { message: 'page tối thiểu là 1' })
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'size phải là số nguyên' })
  @Min(1, { message: 'size tối thiểu là 1' })
  @Max(100, { message: 'size tối đa là 100' })
  size?: number = 20;

  @IsOptional()
  @IsEnum(ProductStatus, { message: 'status không hợp lệ' })
  status?: ProductStatus;

  @IsOptional()
  @IsString()
  shop_id?: string;

  @IsOptional()
  @IsString()
  category_id?: string;

  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'updated_from phải là định dạng ISO8601' })
  updated_from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'updated_to phải là định dạng ISO8601' })
  updated_to?: string;
}
