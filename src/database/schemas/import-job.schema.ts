import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { UUIDV7_REGEX } from '../base.schema';

export enum ImportJobStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Schema({ _id: false })
export class ImportErrorDetail {
  @Prop({ type: String, default: null })
  sheet_name?: string;

  @Prop({ type: Number, required: true })
  row_index: number;

  @Prop({ type: String, required: true })
  product_ref_id: string;

  @Prop({ type: String, default: null })
  seller_sku?: string;

  @Prop({ type: String, required: true })
  error_code: string;

  @Prop({ type: String, required: true })
  error_message: string;
}

export const ImportErrorDetailSchema = SchemaFactory.createForClass(ImportErrorDetail);

@Schema({
  collection: 'import_jobs',
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  versionKey: false,
  toJSON: { virtuals: true },
  toObject: { virtuals: true },
})
export class ImportJob {
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
    match: UUIDV7_REGEX,
  })
  actor_user_id: string;

  @Prop({
    type: String,
    default: null,
    validate: {
      validator: (v: string | null | undefined) =>
        v === null || v === undefined || UUIDV7_REGEX.test(v),
      message: 'category_id phải là định dạng UUIDv7 hợp lệ',
    },
  })
  category_id?: string | null;

  @Prop({
    type: String,
    required: true,
    enum: Object.values(ImportJobStatus),
    default: ImportJobStatus.PENDING,
  })
  status: ImportJobStatus;

  @Prop({
    type: String,
    required: true,
  })
  file_url: string;

  @Prop({
    type: String,
    default: null,
  })
  result_file_url?: string | null;

  @Prop({
    type: Number,
    default: null,
  })
  total_rows?: number | null;

  @Prop({
    type: Number,
    default: 0,
  })
  processed_rows: number;

  @Prop({
    type: Number,
    default: 0,
  })
  success_count: number;

  @Prop({
    type: Number,
    default: 0,
  })
  error_count: number;

  @Prop({
    type: [ImportErrorDetailSchema],
    default: [],
  })
  error_summary: ImportErrorDetail[];

  @Prop({
    type: Date,
    default: null,
  })
  locked_until?: Date | null;

  @Prop({
    type: Date,
    default: null,
  })
  started_at?: Date | null;

  @Prop({
    type: Date,
    default: null,
  })
  completed_at?: Date | null;

  created_at: Date;
  updated_at: Date;
}

export type ImportJobDocument = ImportJob & Document<string>;

export const ImportJobSchema = SchemaFactory.createForClass(ImportJob);

ImportJobSchema.virtual('job_id').get(function (this: ImportJobDocument) {
  return this._id;
});

ImportJobSchema.index({ shop_id: 1, created_at: -1 }, { name: 'idx_import_jobs_shop_created' });

ImportJobSchema.index({ shop_id: 1, status: 1 }, { name: 'idx_import_jobs_shop_status' });

ImportJobSchema.index(
  { created_at: 1 },
  { expireAfterSeconds: 604800, name: 'idx_import_jobs_ttl_7d' },
);
