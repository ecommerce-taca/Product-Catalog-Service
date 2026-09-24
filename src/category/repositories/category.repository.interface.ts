import { ClientSession, FilterQuery } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { CategoryDocument } from '../../database/schemas/category.schema';

export interface CategoryRepositoryPort extends BaseRepository<CategoryDocument> {
  findBySlug(slug: string, session?: ClientSession): Promise<CategoryDocument | null>;
  findChildren(
    parentId: string | null,
    status?: string,
    session?: ClientSession,
  ): Promise<CategoryDocument[]>;
  findDescendantsByPath(pathPrefix: string, session?: ClientSession): Promise<CategoryDocument[]>;
  updateSubtreePath(
    oldPrefix: string,
    newPrefix: string,
    depthDelta: number,
    session?: ClientSession,
  ): Promise<number>;
  findAllPaginated(
    filter: FilterQuery<CategoryDocument>,
    page: number,
    size: number,
    session?: ClientSession,
  ): Promise<{ items: CategoryDocument[]; total: number }>;
}
