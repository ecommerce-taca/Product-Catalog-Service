import { Prop, Schema } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';

export const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Schema({
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  toJSON: {
    virtuals: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret.__v;
      return ret;
    },
  },
  toObject: {
    virtuals: true,
    transform: (_doc, ret: Record<string, unknown>) => {
      delete ret.__v;
      return ret;
    },
  },
})
export abstract class BaseDocument extends Document<string> {
  @Prop({
    type: String,
    required: true,
    match: UUIDV7_REGEX,
  })
  declare _id: string;

  @Prop({
    type: MongooseSchema.Types.BigInt,
    default: () => BigInt(1),
    required: true,
  })
  version: bigint;

  created_at: Date;
  updated_at: Date;
}
