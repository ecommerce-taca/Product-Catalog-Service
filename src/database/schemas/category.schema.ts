import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type CategoryDocument = Category & Document<string>;

export enum CategoryStatus {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

export const CATEGORY_SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CATEGORY_PATH_REGEX = /^(\/[0-9a-f-]{36})+$/;

@Schema({
  collection: 'categories',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Category {
  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  _id: string;

  @Prop({
    type: String,
    default: null,
    validate: {
      validator: (v: string | null) => v === null || UUIDV7_REGEX.test(v),
      message: 'parent_id must be a valid UUIDv7 or null',
    },
  })
  parent_id: string | null;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 120,
  })
  name: string;

  @Prop({
    type: String,
    required: true,
    maxlength: 160,
    match: CATEGORY_SLUG_REGEX,
  })
  slug: string;

  @Prop({
    type: String,
    required: true,
    match: CATEGORY_PATH_REGEX,
  })
  path: string;

  @Prop({
    type: Number,
    required: true,
    default: 1,
    min: 1,
    max: 5,
  })
  depth: number;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(CategoryStatus),
    default: CategoryStatus.ACTIVE,
  })
  status: CategoryStatus;

  @Prop({
    type: Number,
    required: true,
    default: 0,
    min: 0,
  })
  sort_order: number;

  @Prop({
    type: Number,
    default: null,
    min: 0,
    max: 10000,
  })
  tax_rate_bps: number | null;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: () => BigInt(1),
    required: true,
  })
  version: bigint;

  created_at: Date;
  updated_at: Date;
}

export const CategorySchema = SchemaFactory.createForClass(Category);

CategorySchema.virtual('category_id').get(function () {
  return this._id;
});

CategorySchema.index({ slug: 1 }, { unique: true, name: 'idx_categories_slug_unique' });
CategorySchema.index(
  { parent_id: 1, name: 1 },
  { unique: true, name: 'idx_categories_parent_name' },
);
CategorySchema.index(
  { parent_id: 1, status: 1, sort_order: 1 },
  { name: 'idx_categories_parent_nav' },
);
CategorySchema.index({ path: 1 }, { name: 'idx_categories_path' });
