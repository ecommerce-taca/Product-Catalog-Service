import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, Min, ValidateNested } from 'class-validator';
import { AttributeDefinitionDto } from '../../attribute/dto/attribute-definition.dto';
import { SkuItemDto } from './sku-item.dto';

export class UpdateProductSkusDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsArray()
  @ArrayMaxSize(50, { message: 'Tối đa 50 attribute definitions trên mỗi sản phẩm.' })
  @ValidateNested({ each: true })
  @Type(() => AttributeDefinitionDto)
  attribute_definitions: AttributeDefinitionDto[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkuItemDto)
  skus: SkuItemDto[];
}
