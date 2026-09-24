import { ArrayMaxSize, IsArray, IsInt, IsNotEmpty, IsOptional, IsUUID, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AssignCategoriesDto {
  @IsNotEmpty({ message: 'version không được để trống' })
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version tối thiểu là 1' })
  @Type(() => Number)
  version: number;

  @IsNotEmpty({ message: 'primary_category_id không được để trống' })
  @IsUUID(undefined, { message: 'primary_category_id phải là định dạng UUID hợp lệ' })
  primary_category_id: string;

  @IsOptional()
  @IsArray({ message: 'secondary_category_ids phải là mảng' })
  @ArrayMaxSize(2, { message: 'secondary_category_ids tối đa 2 danh mục phụ' })
  @IsUUID(undefined, { each: true, message: 'Mỗi secondary category id phải là UUID hợp lệ' })
  secondary_category_ids?: string[] = [];
}
