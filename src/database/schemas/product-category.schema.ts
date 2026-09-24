import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type ProductCategoryDocument = ProductCategory & Document<string>;

@Schema({
  collection: 'product_categories',
  timestamps: false,
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class ProductCategory {
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
  product_id: string;

  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  category_id: string;

  @Prop({
    type: Boolean,
    required: true,
    default: false,
  })
  is_primary: boolean;

  @Prop({
    type: Date,
    required: true,
    default: () => new Date(),
  })
  assigned_at: Date;

  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  assigned_by: string;
}

export const ProductCategorySchema = SchemaFactory.createForClass(ProductCategory);

ProductCategorySchema.index(
  { product_id: 1, category_id: 1 },
  { unique: true, name: 'idx_prod_cat_unique' },
);
ProductCategorySchema.index({ category_id: 1, product_id: 1 }, { name: 'idx_cat_prod_listing' });
ProductCategorySchema.index(
  { product_id: 1, is_primary: 1 },
  {
    unique: true,
    partialFilterExpression: { is_primary: true },
    name: 'idx_prod_cat_primary_unique',
  },
);
