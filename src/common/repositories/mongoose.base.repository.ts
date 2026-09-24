import { ClientSession, Document, FilterQuery, Model, QueryOptions, UpdateQuery } from 'mongoose';
import { BaseRepository } from './base.repository.interface';

export abstract class MongooseBaseRepository<
  T extends Document<unknown>,
> implements BaseRepository<T> {
  constructor(protected readonly model: Model<T>) {}

  async findById(id: string, session?: ClientSession): Promise<T | null> {
    const query = this.model.findById(id);
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findOne(filter: FilterQuery<T>, session?: ClientSession): Promise<T | null> {
    const query = this.model.findOne(filter);
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async find(
    filter: FilterQuery<T>,
    options?: QueryOptions,
    session?: ClientSession,
  ): Promise<T[]> {
    const query = this.model.find(filter, null, options);
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async create(doc: Partial<T>, session?: ClientSession): Promise<T> {
    if (session) {
      const created = await this.model.create([doc], { session });
      return created[0];
    }
    const instance = new this.model(doc);
    return instance.save() as Promise<T>;
  }

  async update(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    session?: ClientSession,
  ): Promise<T | null> {
    const query = this.model.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async delete(filter: FilterQuery<T>, session?: ClientSession): Promise<boolean> {
    const query = this.model.deleteOne(filter);
    if (session) {
      query.session(session);
    }
    const result = await query.exec();
    return result.deletedCount > 0;
  }

  async count(filter?: FilterQuery<T>, session?: ClientSession): Promise<number> {
    const query = this.model.countDocuments(filter || {});
    if (session) {
      query.session(session);
    }
    return query.exec();
  }
}
