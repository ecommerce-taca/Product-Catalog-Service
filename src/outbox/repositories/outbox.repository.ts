import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { OutboxEvent, OutboxEventDocument } from '../../database/schemas/outbox-event.schema';
import { OutboxRepositoryPort } from './outbox.repository.interface';

@Injectable()
export class OutboxRepository
  extends MongooseBaseRepository<OutboxEventDocument>
  implements OutboxRepositoryPort
{
  constructor(
    @InjectModel(OutboxEvent.name)
    outboxModel: Model<OutboxEventDocument>,
  ) {
    super(outboxModel);
  }

  async saveEvent(
    event: Partial<OutboxEvent>,
    session?: ClientSession,
  ): Promise<OutboxEventDocument> {
    return this.create(event, session);
  }
}
