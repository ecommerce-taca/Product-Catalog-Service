import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type OutboxEventDocument = OutboxEvent & Document<string>;

export enum AggregateType {
  PRODUCT = 'PRODUCT',
  SKU = 'SKU',
  CATEGORY = 'CATEGORY',
  SHOP_PROJECTION = 'SHOP_PROJECTION',
}

@Schema({
  collection: 'outbox_events',
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class OutboxEvent {
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
  event_id: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(AggregateType),
  })
  aggregate_type: string;

  @Prop({
    type: String,
    required: true,
  })
  aggregate_id: string;

  @Prop({
    type: String,
    required: true,
  })
  event_type: string;

  @Prop({
    type: Number,
    required: true,
    default: 1,
  })
  schema_version: number;

  @Prop({
    type: MongooseSchema.Types.Mixed,
    required: true,
  })
  payload: Record<string, unknown>;

  @Prop({
    type: Date,
    required: true,
    default: () => new Date(),
  })
  occurred_at: Date;

  // 4 transport fields for Debezium MongoDB Outbox Event Router
  @Prop({
    type: String,
    required: true,
  })
  topic: string;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    required: true,
  })
  version: bigint;

  @Prop({
    type: String,
    default: null,
  })
  actor_user_id: string | null;

  @Prop({
    type: String,
    default: null,
  })
  traceparent: string | null;
}

export const OutboxEventSchema = SchemaFactory.createForClass(OutboxEvent);

// Indexes specified in Database Design §4 (idx_outbox_events_*)
OutboxEventSchema.index({ event_id: 1 }, { unique: true, name: 'idx_outbox_events_event_id' });
OutboxEventSchema.index(
  { aggregate_type: 1, aggregate_id: 1, occurred_at: 1 },
  { name: 'idx_outbox_events_replay' },
);
OutboxEventSchema.index(
  { occurred_at: 1 },
  { expireAfterSeconds: 1209600, name: 'idx_outbox_events_ttl' },
);
