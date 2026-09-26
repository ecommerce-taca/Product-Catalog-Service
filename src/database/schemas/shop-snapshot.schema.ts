import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type ShopSnapshotDocument = ShopSnapshot & Document<string>;

export enum ShopStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  SUSPENDED = 'SUSPENDED',
  DELETED = 'DELETED',
}

export enum KycStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  NEEDS_INFO = 'NEEDS_INFO',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
}

@Schema({
  collection: 'shop_snapshots',
  timestamps: false,
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class ShopSnapshot {
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
    unique: true,
  })
  shop_id: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 150,
  })
  name: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
  })
  slug: string;

  @Prop({
    type: String,
    default: null,
  })
  logo_url: string | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ShopStatus),
    default: ShopStatus.ACTIVE,
  })
  shop_status: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(KycStatus),
    default: KycStatus.PENDING,
  })
  kyc_status: string;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    required: true,
  })
  source_version: bigint;

  @Prop({
    type: String,
    required: true,
  })
  source_event_id: string;

  @Prop({
    type: Date,
    required: true,
    default: () => new Date(),
  })
  updated_at: Date;
}

export const ShopSnapshotSchema = SchemaFactory.createForClass(ShopSnapshot);

// Indexes matching Database Design §4
ShopSnapshotSchema.index(
  { shop_id: 1 },
  { unique: true, name: 'idx_shop_snapshots_shop_id_unique' },
);

ShopSnapshotSchema.index(
  { shop_status: 1, kyc_status: 1 },
  { name: 'idx_shop_snapshots_status_kyc' },
);
