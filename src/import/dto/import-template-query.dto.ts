import { IsOptional, IsUUID } from 'class-validator';

export class ImportTemplateQueryDto {
  @IsOptional()
  @IsUUID(undefined, { message: 'category_id phải là định dạng UUID hợp lệ' })
  category_id?: string;
}
