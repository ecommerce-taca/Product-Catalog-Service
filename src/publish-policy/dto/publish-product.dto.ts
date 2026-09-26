import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class PublishProductDto {
  @IsNotEmpty({ message: 'version không được để trống' })
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version tối thiểu là 1' })
  @Type(() => Number)
  version: number;
}

export class UnpublishProductDto {
  @IsNotEmpty({ message: 'version không được để trống' })
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version tối thiểu là 1' })
  @Type(() => Number)
  version: number;

  @IsOptional()
  @IsString({ message: 'reason phải là chuỗi ký tự' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500, { message: 'reason tối đa 500 ký tự' })
  reason?: string;
}

export class ArchiveProductDto {
  @IsNotEmpty({ message: 'version không được để trống' })
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version tối thiểu là 1' })
  @Type(() => Number)
  version: number;

  @IsOptional()
  @IsString({ message: 'reason phải là chuỗi ký tự' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500, { message: 'reason tối đa 500 ký tự' })
  reason?: string;
}
