import { ClientSession, FilterQuery, QueryOptions, UpdateQuery } from 'mongoose';

export interface BaseRepository<T> {
  findById(id: string, session?: ClientSession): Promise<T | null>;
  findOne(filter: FilterQuery<T>, session?: ClientSession): Promise<T | null>;
  find(filter: FilterQuery<T>, options?: QueryOptions, session?: ClientSession): Promise<T[]>;
  create(doc: Partial<T>, session?: ClientSession): Promise<T>;
  update(
    filter: FilterQuery<T>,
    update: UpdateQuery<T>,
    session?: ClientSession,
  ): Promise<T | null>;
  delete(filter: FilterQuery<T>, session?: ClientSession): Promise<boolean>;
  count(filter?: FilterQuery<T>, session?: ClientSession): Promise<number>;
}
