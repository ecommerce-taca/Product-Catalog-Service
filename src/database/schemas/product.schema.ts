import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type ProductDocument = Product & Document<string>;

export enum ProductStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  BLOCKED = 'BLOCKED',
  ARCHIVED = 'ARCHIVED',
}

@Schema({ _id: false })
export class ProductPriceSummary {
  @Prop({ type: MongooseSchema.Types.BigInt, required: true })
  base_price: bigint;

  @Prop({ type: MongooseSchema.Types.BigInt, required: true })
  sale_price: bigint;

  @Prop({ type: String, default: 'VND', enum: ['VND'] })
  currency: string;
}

export const ProductPriceSummarySchema = SchemaFactory.createForClass(ProductPriceSummary);

@Schema({
  collection: 'products',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Product {
  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  _id: string;

  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  shop_id: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 200,
  })
  title: string;

  @Prop({
    type: String,
    required: true,
    maxlength: 160,
  })
  slug: string;

  @Prop({
    type: String,
    default: null,
    maxlength: 100000,
  })
  description: string | null;

  @Prop({
    type: String,
    default: null,
    maxlength: 100,
  })
  brand: string | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ProductStatus),
    default: ProductStatus.DRAFT,
  })
  status: ProductStatus;

  @Prop({ type: ProductPriceSummarySchema, default: null })
  price_summary?: ProductPriceSummary;

  @Prop({
    type: String,
    default: null,
  })
  primary_category_id: string | null;

  @Prop({
    type: Object,
    default: null,
  })
  shop_snapshot: Record<string, unknown> | null;

  @Prop({
    type: Object,
    default: null,
  })
  rating_summary: { avg: number | null; count: number; updated_at: Date | null } | null;

  @Prop({
    type: Date,
    default: null,
  })
  published_at: Date | null;

  @Prop({
    type: Date,
    default: null,
  })
  unpublished_at: Date | null;

  @Prop({
    type: Date,
    default: null,
  })
  archived_at: Date | null;

  @Prop({
    type: Date,
    default: null,
  })
  blocked_at: Date | null;

  @Prop({
    type: String,
    default: null,
  })
  block_reason: string | null;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: () => BigInt(1),
    required: true,
  })
  version: bigint;

  created_at: Date;
  updated_at: Date;
}

export const ProductSchema = SchemaFactory.createForClass(Product);

ProductSchema.virtual('product_id').get(function () {
  return this._id;
});

ProductSchema.index(
  { shop_id: 1, slug: 1 },
  { unique: true, name: 'idx_products_shop_slug_unique' },
);

ProductSchema.index({ shop_id: 1, status: 1 }, { name: 'idx_products_shop_status' });

ProductSchema.index({ status: 1 }, { name: 'idx_products_status' });

ProductSchema.index(
  { shop_id: 1, status: 1, updated_at: -1 },
  { name: 'idx_products_shop_status_updated' },
);

ProductSchema.index(
  { status: 1, primary_category_id: 1, published_at: -1 },
  { name: 'idx_products_category_published' },
);

ProductSchema.index(
  { shop_id: 1, status: 1, published_at: -1 },
  { name: 'idx_products_shop_published' },
);
