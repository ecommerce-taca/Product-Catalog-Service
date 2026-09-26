import { IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { ProductStatus } from '../../database/schemas/product.schema';

export enum ExportFormat {
  CSV = 'csv',
  XLSX = 'xlsx',
}

export class ExportProductsDto {
  @IsOptional()
  @IsEnum(ProductStatus, { message: 'status không hợp lệ' })
  status?: ProductStatus;

  @IsOptional()
  @IsString({ message: 'q phải là chuỗi' })
  q?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'updated_from phải là định dạng ISO 8601' })
  updated_from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'updated_to phải là định dạng ISO 8601' })
  updated_to?: string;

  @IsOptional()
  @IsEnum(ExportFormat, { message: 'format phải là csv hoặc xlsx' })
  format?: ExportFormat = ExportFormat.CSV;
}
