import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ArchiveCategoryDto {
  @IsNotEmpty({ message: 'version là bắt buộc để kiểm soát concurrency' })
  @Type(() => Number)
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version phải lớn hơn hoặc bằng 1' })
  version: number;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Lý do lưu trữ tối đa 500 ký tự' })
  reason?: string;
}
