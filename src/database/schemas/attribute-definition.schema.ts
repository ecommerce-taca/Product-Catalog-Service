import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type AttributeDefinitionDocument = AttributeDefinition & Document<string>;

export enum AttributeScopeType {
  PRODUCT = 'PRODUCT',
  CATEGORY = 'CATEGORY',
}

export enum AttributeType {
  STRING = 'STRING',
  NUMBER = 'NUMBER',
  BOOLEAN = 'BOOLEAN',
  ENUM = 'ENUM',
}

export enum AttributeDisplayAs {
  PLAIN = 'PLAIN',
  COLOR_SWATCH = 'COLOR_SWATCH',
  IMAGE_THUMB = 'IMAGE_THUMB',
}

export enum AttributeDefinitionStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export const ATTRIBUTE_KEY_REGEX = /^[a-z0-9_]+$/;

@Schema({
  collection: 'attribute_definitions',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class AttributeDefinition {
  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  _id: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(AttributeScopeType),
  })
  scope_type: AttributeScopeType;

  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  scope_id: string;

  @Prop({
    type: String,
    required: true,
    maxlength: 64,
    match: ATTRIBUTE_KEY_REGEX,
  })
  key: string;

  @Prop({
    type: String,
    required: true,
    maxlength: 120,
    trim: true,
  })
  label: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(AttributeType),
  })
  type: AttributeType;

  @Prop({
    type: Boolean,
    required: true,
    default: false,
  })
  is_variant_dimension: boolean;

  @Prop({
    type: [String],
    default: [],
    validate: {
      validator: function (this: AttributeDefinition, val: string[]) {
        if (!Array.isArray(val)) return false;
        if (new Set(val).size !== val.length) return false;
        if (this.type === AttributeType.ENUM) {
          return val.length > 0 && val.length <= 200;
        }
        return val.length <= 200;
      },
      message:
        'allowed_values must contain unique items and be non-empty (<= 200 items) when type is ENUM',
    },
  })
  allowed_values: string[];

  @Prop({
    type: String,
    default: null,
  })
  unit: string | null;

  @Prop({
    type: String,
    enum: Object.values(AttributeDisplayAs),
    default: AttributeDisplayAs.PLAIN,
  })
  display_as: AttributeDisplayAs;

  @Prop({
    type: Object,
    default: null,
  })
  value_meta: Record<string, { swatch_hex?: string; swatch_media_id?: string }> | null;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
  })
  sort_order: number;

  @Prop({
    type: String,
    enum: Object.values(AttributeDefinitionStatus),
    default: AttributeDefinitionStatus.ACTIVE,
  })
  status: AttributeDefinitionStatus;

  created_at: Date;
  updated_at: Date;
}

export const AttributeDefinitionSchema = SchemaFactory.createForClass(AttributeDefinition);

AttributeDefinitionSchema.virtual('definition_id').get(function () {
  return this._id;
});

AttributeDefinitionSchema.index(
  { scope_type: 1, scope_id: 1, key: 1 },
  { unique: true, name: 'idx_attr_def_scope_key_unique' },
);

AttributeDefinitionSchema.index(
  { scope_type: 1, scope_id: 1, status: 1, sort_order: 1 },
  { name: 'idx_attr_def_scope_status_sort' },
);
