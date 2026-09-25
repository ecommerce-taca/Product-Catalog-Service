import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UUIDV7_REGEX } from '../../database/base.schema';
import { MediaScope } from '../../database/schemas/product-media.schema';

export const ALLOWED_MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
] as const;

export type AllowedMediaContentType = (typeof ALLOWED_MEDIA_CONTENT_TYPES)[number];

export const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MiB = 20,971,520
export const MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024; // 200 MiB = 209,715,200

export class UploadUrlDto {
  @IsOptional()
  @IsEnum(MediaScope, {
    message: 'scope phải là SPU hoặc SKU',
  })
  scope?: MediaScope;

  @IsOptional()
  @Matches(UUIDV7_REGEX, {
    message: 'sku_id phải là định dạng UUIDv7 hợp lệ',
  })
  sku_id?: string | null;

  @IsNotEmpty({ message: 'content_type không được để trống' })
  @IsString({ message: 'content_type phải là chuỗi ký tự' })
  @IsIn(ALLOWED_MEDIA_CONTENT_TYPES, {
    message: 'content_type chỉ hỗ trợ image/jpeg, image/png, image/webp, video/mp4',
  })
  content_type: string;

  @IsNotEmpty({ message: 'size_bytes không được để trống' })
  @Type(() => Number)
  @IsInt({ message: 'size_bytes phải là số nguyên' })
  @Min(1, { message: 'size_bytes phải lớn hơn 0' })
  @Max(MAX_VIDEO_SIZE_BYTES, {
    message: `size_bytes không được vượt quá ${MAX_VIDEO_SIZE_BYTES} bytes (200 MiB)`,
  })
  size_bytes: number;

  @IsNotEmpty({ message: 'sha256 không được để trống' })
  @IsString({ message: 'sha256 phải là chuỗi ký tự' })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'sha256 phải gồm đúng 64 ký tự hex',
  })
  sha256: string;

  @IsOptional()
  @IsBoolean({ message: 'is_cover phải là kiểu boolean' })
  is_cover?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sort_order phải là số nguyên' })
  @Min(0, { message: 'sort_order không được âm' })
  sort_order?: number;
}
