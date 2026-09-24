import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ATTRIBUTE_KEY_REGEX,
  AttributeDisplayAs,
  AttributeType,
} from '../../database/schemas/attribute-definition.schema';

export class AttributeDefinitionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(ATTRIBUTE_KEY_REGEX, {
    message: 'key must match ^[a-z0-9_]+$',
  })
  key: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;

  @IsEnum(AttributeType)
  type: AttributeType;

  @IsBoolean()
  is_variant_dimension: boolean;

  @ValidateIf((o) => o.type === AttributeType.ENUM)
  @IsArray()
  @IsNotEmpty({ message: 'allowed_values is required when type is ENUM' })
  @IsString({ each: true })
  @ArrayUnique({ message: 'allowed_values must not contain duplicate values' })
  allowed_values?: string[];

  @IsOptional()
  @IsString()
  unit?: string | null;

  @IsOptional()
  @IsEnum(AttributeDisplayAs)
  display_as?: AttributeDisplayAs;

  @IsOptional()
  value_meta?: Record<string, { swatch_hex?: string; swatch_media_id?: string }> | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sort_order?: number;
}
