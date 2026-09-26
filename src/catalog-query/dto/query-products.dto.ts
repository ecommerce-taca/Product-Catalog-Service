import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum ProductSortOption {
  NEWEST = 'newest',
  PRICE_ASC = 'price_asc',
  PRICE_DESC = 'price_desc',
}

export class QueryProductsDto {
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
  @IsString({ message: 'category_id phải là chuỗi' })
  category_id?: string;

  @IsOptional()
  @IsString({ message: 'shop_id phải là chuỗi' })
  shop_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'min_price phải là số nguyên không âm' })
  @Min(0, { message: 'min_price phải là số nguyên không âm' })
  min_price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'max_price phải là số nguyên không âm' })
  @Min(0, { message: 'max_price phải là số nguyên không âm' })
  max_price?: number;

  @IsOptional()
  @IsEnum(ProductSortOption, { message: 'sort phải là newest, price_asc hoặc price_desc' })
  sort?: ProductSortOption;

  @IsOptional()
  @IsString({ message: 'product_ids phải là chuỗi' })
  product_ids?: string;
}
