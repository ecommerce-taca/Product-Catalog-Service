import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type InventoryProjectionDocument = InventoryProjection & Document<string>;

export enum InventoryStockStatus {
  UNKNOWN = 'UNKNOWN',
  IN_STOCK = 'IN_STOCK',
  LOW_STOCK = 'LOW_STOCK',
  OUT_OF_STOCK = 'OUT_OF_STOCK',
  STALE = 'STALE',
}

export const LOW_STOCK_THRESHOLD = 5;
export const INVENTORY_SNAPSHOT_STALE_AFTER_SECONDS = 60;

@Schema({
  collection: 'inventory_projections',
  timestamps: false,
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class InventoryProjection {
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
  sku_id: string;

  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  product_id: string;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    required: true,
    default: () => BigInt(0),
    min: 0,
  })
  available_qty_snapshot: bigint;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: null,
  })
  reserved_qty_snapshot: bigint | null;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: null,
  })
  committed_qty_snapshot: bigint | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(InventoryStockStatus),
    default: InventoryStockStatus.UNKNOWN,
  })
  stock_status: string;

  @Prop({
    type: Date,
    required: true,
  })
  as_of: Date;

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

export const InventoryProjectionSchema = SchemaFactory.createForClass(InventoryProjection);

// Indexes matching Database Design §4
InventoryProjectionSchema.index({ sku_id: 1 }, { unique: true, name: 'idx_inv_proj_sku_id' });

InventoryProjectionSchema.index(
  { product_id: 1, stock_status: 1 },
  { name: 'idx_inv_proj_product_stock' },
);
