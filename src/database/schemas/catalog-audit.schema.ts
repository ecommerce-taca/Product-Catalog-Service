import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export type CatalogAuditDocument = CatalogAudit & Document<string>;

export enum AuditAction {
  CREATE = 'CREATE',
  UPDATE = 'UPDATE',
  PUBLISH = 'PUBLISH',
  UNPUBLISH = 'UNPUBLISH',
  ARCHIVE = 'ARCHIVE',
  BLOCK = 'BLOCK',
  UNBLOCK = 'UNBLOCK',
  CATEGORY_CHANGE = 'CATEGORY_CHANGE',
  MEDIA_CHANGE = 'MEDIA_CHANGE',
  SKU_CONFIGURED = 'SKU_CONFIGURED',
  MEDIA_UPLOADED = 'MEDIA_UPLOADED',
  MEDIA_DELETED = 'MEDIA_DELETED',
}

export enum AuditTargetType {
  PRODUCT = 'PRODUCT',
  SKU = 'SKU',
  CATEGORY = 'CATEGORY',
  MEDIA = 'MEDIA',
}

@Schema({
  collection: 'catalog_audits',
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class CatalogAudit {
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
  actor_user_id: string;

  @Prop({
    type: String,
    default: null,
  })
  shop_id: string | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(AuditAction),
  })
  action: string;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(AuditTargetType),
  })
  target_type: string;

  @Prop({
    type: String,
    required: true,
  })
  target_id: string;

  @Prop({
    type: String,
    default: null,
  })
  entity_type?: string | null;

  @Prop({
    type: String,
    default: null,
  })
  entity_id?: string | null;

  @Prop({
    type: MongooseSchema.Types.Mixed,
    default: null,
  })
  changes?: Record<string, unknown> | unknown;

  @Prop({
    type: String,
    maxlength: 500,
    default: null,
  })
  reason: string | null;

  @Prop({
    type: MongooseSchema.Types.Mixed,
    default: {},
  })
  metadata: Record<string, unknown>;

  @Prop({
    type: Date,
    required: true,
    default: () => new Date(),
  })
  occurred_at: Date;
}

export const CatalogAuditSchema = SchemaFactory.createForClass(CatalogAudit);

// Indexes specified in Database Design §4 (idx_audits_*)
CatalogAuditSchema.index(
  { target_type: 1, target_id: 1, occurred_at: -1 },
  { name: 'idx_audits_target' },
);
CatalogAuditSchema.index({ actor_user_id: 1, occurred_at: -1 }, { name: 'idx_audits_actor' });
