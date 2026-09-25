import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type ProductMediaDocument = ProductMedia & Document<string>;

export enum MediaScope {
  SPU = 'SPU',
  SKU = 'SKU',
}

export enum MediaStatus {
  UPLOADING = 'UPLOADING',
  SCANNING = 'SCANNING',
  READY = 'READY',
  REJECTED = 'REJECTED',
  DELETED = 'DELETED',
}

@Schema({
  collection: 'product_media',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class ProductMedia {
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
    default: null,
    validate: {
      validator: (v: string | null) => v === null || UUIDV7_REGEX.test(v),
      message: 'sku_id must be a valid UUIDv7 or null',
    },
  })
  sku_id: string | null;

  @Prop({
    type: String,
    enum: Object.values(MediaScope),
    default: MediaScope.SPU,
    required: true,
  })
  scope: MediaScope;

  @Prop({
    type: String,
    required: true,
    trim: true,
  })
  object_key: string;

  @Prop({
    type: String,
    required: true,
    enum: ['image/jpeg', 'image/png', 'image/webp', 'video/mp4'],
  })
  content_type: string;

  @Prop({
    type: Number,
    required: true,
    min: 1,
  })
  size_bytes: number;

  @Prop({
    type: String,
    required: true,
    match: /^[0-9a-fA-F]{64}$/,
  })
  sha256: string;

  @Prop({
    type: Number,
    default: 0,
    min: 0,
  })
  sort_order: number;

  @Prop({
    type: Boolean,
    default: false,
  })
  is_cover: boolean;

  @Prop({
    type: String,
    enum: Object.values(MediaStatus),
    default: MediaStatus.UPLOADING,
    required: true,
  })
  status: MediaStatus;

  @Prop({
    type: String,
    required: true,
  })
  uploaded_by: string;

  created_at: Date;
  updated_at: Date;
}

export const ProductMediaSchema = SchemaFactory.createForClass(ProductMedia);

ProductMediaSchema.virtual('media_id').get(function () {
  return this._id;
});

// Indexes
ProductMediaSchema.index(
  { product_id: 1, scope: 1, status: 1, sort_order: 1 },
  { name: 'idx_product_media_scope_status_sort' },
);

ProductMediaSchema.index(
  { object_key: 1 },
  { unique: true, name: 'idx_product_media_object_key_unique' },
);

ProductMediaSchema.index(
  { product_id: 1, sha256: 1 },
  { name: 'idx_product_media_product_sha256' },
);

ProductMediaSchema.index(
  { product_id: 1 },
  {
    unique: true,
    partialFilterExpression: { is_cover: true, status: MediaStatus.READY },
    name: 'idx_product_media_cover_ready_unique',
  },
);
