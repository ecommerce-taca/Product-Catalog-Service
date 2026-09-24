import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type SkuDocument = Sku & Document<string>;

export enum SkuStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  ARCHIVED = 'ARCHIVED',
}

@Schema({
  collection: 'skus',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class Sku {
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
  shop_id: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  })
  seller_sku: string;

  @Prop({
    type: Object,
    required: true,
  })
  attributes: Record<string, string | number | boolean>;

  @Prop({
    type: String,
    required: true,
    default: '',
  })
  variant_key: string;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: null,
    validate: {
      validator: (v: bigint | null) => {
        if (v === null || v === undefined) return true;
        const num = Number(v);
        return num >= 1 && num <= 999999999999;
      },
      message: 'price_override must be between 1 and 999,999,999,999 VND or null',
    },
  })
  price_override: bigint | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(SkuStatus),
    default: SkuStatus.ACTIVE,
  })
  status: SkuStatus;

  @Prop({
    type: [String],
    default: [],
  })
  media_ids: string[];

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: () => BigInt(1),
    required: true,
  })
  version: bigint;

  created_at: Date;
  updated_at: Date;
}

export const SkuSchema = SchemaFactory.createForClass(Sku);

SkuSchema.virtual('sku_id').get(function () {
  return this._id;
});

SkuSchema.index(
  { product_id: 1, variant_key: 1 },
  { unique: true, name: 'idx_skus_product_variant_key_unique' },
);

SkuSchema.index(
  { shop_id: 1, seller_sku: 1 },
  { unique: true, name: 'idx_skus_shop_seller_sku_unique' },
);

SkuSchema.index({ product_id: 1, status: 1 }, { name: 'idx_skus_product_status' });
