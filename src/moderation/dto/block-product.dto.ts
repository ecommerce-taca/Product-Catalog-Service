import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class BlockProductDto {
  @IsNotEmpty({ message: 'version không được để trống' })
  @IsInt({ message: 'version phải là số nguyên' })
  @Min(1, { message: 'version tối thiểu là 1' })
  @Type(() => Number)
  version: number;

  @IsNotEmpty({ message: 'Lý do khóa sản phẩm (reason) không được để trống' })
  @IsString({ message: 'reason phải là chuỗi ký tự' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500, { message: 'reason tối đa 500 ký tự' })
  reason: string;
}
