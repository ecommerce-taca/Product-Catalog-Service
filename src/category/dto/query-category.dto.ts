import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { CategoryStatus } from '../../database/schemas/category.schema';

export class QueryCategoryDto {
  @IsOptional()
  @IsEnum(CategoryStatus, {
    message: 'status phải là ACTIVE, INACTIVE hoặc ARCHIVED',
  })
  status?: CategoryStatus;

  @IsOptional()
  @IsString()
  parent_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'page phải là số nguyên' })
  @Min(1, { message: 'page phải lớn hơn hoặc bằng 1' })
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'size phải là số nguyên' })
  @Min(1, { message: 'size phải lớn hơn hoặc bằng 1' })
  @Max(100, { message: 'size không được vượt quá 100' })
  size?: number = 20;
}
