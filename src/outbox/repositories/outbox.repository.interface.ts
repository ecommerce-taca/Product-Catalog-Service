import { ClientSession, FilterQuery, QueryOptions, UpdateQuery } from 'mongoose';
import { OutboxEvent, OutboxEventDocument } from '../../database/schemas/outbox-event.schema';
import { BaseRepository } from '../../common/repositories/base.repository.interface';

export abstract class OutboxRepositoryPort implements BaseRepository<OutboxEventDocument> {
  abstract findById(id: string, session?: ClientSession): Promise<OutboxEventDocument | null>;
  abstract findOne(
    filter: FilterQuery<OutboxEventDocument>,
    session?: ClientSession,
  ): Promise<OutboxEventDocument | null>;
  abstract find(
    filter: FilterQuery<OutboxEventDocument>,
    options?: QueryOptions,
    session?: ClientSession,
  ): Promise<OutboxEventDocument[]>;
  abstract create(doc: Partial<OutboxEvent>, session?: ClientSession): Promise<OutboxEventDocument>;
  abstract update(
    filter: FilterQuery<OutboxEventDocument>,
    update: UpdateQuery<OutboxEventDocument>,
    session?: ClientSession,
  ): Promise<OutboxEventDocument | null>;
  abstract delete(
    filter: FilterQuery<OutboxEventDocument>,
    session?: ClientSession,
  ): Promise<boolean>;
  abstract count(
    filter?: FilterQuery<OutboxEventDocument>,
    session?: ClientSession,
  ): Promise<number>;
  abstract saveEvent(
    event: Partial<OutboxEvent>,
    session?: ClientSession,
  ): Promise<OutboxEventDocument>;
}
