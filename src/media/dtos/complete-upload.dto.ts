import { IsNotEmpty, IsString, Matches } from 'class-validator';
import { UUIDV7_REGEX } from '../../database/base.schema';

export class CompleteUploadDto {
  @IsNotEmpty({ message: 'media_id không được để trống' })
  @Matches(UUIDV7_REGEX, {
    message: 'media_id phải là định dạng UUIDv7 hợp lệ',
  })
  media_id: string;

  @IsNotEmpty({ message: 'object_key không được để trống' })
  @IsString({ message: 'object_key phải là chuỗi ký tự' })
  object_key: string;

  @IsNotEmpty({ message: 'sha256 không được để trống' })
  @IsString({ message: 'sha256 phải là chuỗi ký tự' })
  @Matches(/^[0-9a-fA-F]{64}$/, {
    message: 'sha256 phải gồm đúng 64 ký tự hex',
  })
  sha256: string;
}
