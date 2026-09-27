import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { UUIDV7_REGEX } from '../../database/base.schema';
import { SkuStatus } from '../../database/schemas/sku.schema';

export class SkuItemDto {
  @IsOptional()
  @IsString()
  @Matches(UUIDV7_REGEX, {
    message: 'sku_id must be a valid UUIDv7',
  })
  sku_id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  seller_sku: string;

  @IsObject()
  @IsNotEmpty()
  attributes: Record<string, string | number | boolean>;

  @IsOptional()
  @IsInt({ message: 'Giá tiền phải là số nguyên' })
  @Min(1, { message: 'Giá tiền không được nhỏ hơn 1' })
  @Max(999999999999, { message: 'Giá tiền không được lớn hơn 999999999999' })
  price_override?: number | null;

  @IsOptional()
  @IsEnum(SkuStatus)
  status?: SkuStatus;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_ids?: string[];
}
