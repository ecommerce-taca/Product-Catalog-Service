import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { Category, CategoryDocument } from '../../database/schemas/category.schema';
import { CategoryRepositoryPort } from './category.repository.interface';

@Injectable()
export class CategoryRepository
  extends MongooseBaseRepository<CategoryDocument>
  implements CategoryRepositoryPort
{
  constructor(
    @InjectModel(Category.name)
    categoryModel: Model<CategoryDocument>,
  ) {
    super(categoryModel);
  }

  async findByIdOrCode(
    idOrCode: string,
    session?: ClientSession,
  ): Promise<CategoryDocument | null> {
    if (!idOrCode || !idOrCode.trim()) {
      return null;
    }
    const trimmed = idOrCode.trim();
    const query = this.model.findOne({
      $or: [{ _id: trimmed }, { category_code: trimmed.toUpperCase() }],
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findByCodes(codes: string[], session?: ClientSession): Promise<CategoryDocument[]> {
    if (!codes || codes.length === 0) {
      return [];
    }
    const upperCodes = codes
      .map((c) => (c ? c.trim().toUpperCase() : ''))
      .filter((c) => c.length > 0);
    if (upperCodes.length === 0) {
      return [];
    }
    const query = this.model.find({ category_code: { $in: upperCodes } });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findBySlug(slug: string, session?: ClientSession): Promise<CategoryDocument | null> {
    return this.findOne({ slug }, session);
  }

  async findChildren(
    parentId: string | null,
    status?: string,
    session?: ClientSession,
  ): Promise<CategoryDocument[]> {
    const filter: FilterQuery<CategoryDocument> = { parent_id: parentId };
    if (status) {
      filter.status = status;
    }
    const query = this.model.find(filter).sort({ sort_order: 1, created_at: 1 });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findDescendantsByPath(
    pathPrefix: string,
    session?: ClientSession,
  ): Promise<CategoryDocument[]> {
    const escapedPrefix = pathPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const query = this.model
      .find({ path: { $regex: `^${escapedPrefix}` } })
      .sort({ depth: 1, sort_order: 1 });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async updateSubtreePath(
    oldPrefix: string,
    newPrefix: string,
    depthDelta: number,
    session?: ClientSession,
  ): Promise<number> {
    const escapedPrefix = oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const result = await this.model.updateMany(
      { path: { $regex: `^${escapedPrefix}` } },
      [
        {
          $set: {
            path: {
              $concat: [
                newPrefix,
                {
                  $substrCP: [
                    '$path',
                    oldPrefix.length,
                    { $subtract: [{ $strLenCP: '$path' }, oldPrefix.length] },
                  ],
                },
              ],
            },
            depth: { $add: ['$depth', depthDelta] },
          },
        },
      ],
      { session },
    );
    return result.modifiedCount;
  }

  async findAllPaginated(
    filter: FilterQuery<CategoryDocument>,
    page: number,
    size: number,
    session?: ClientSession,
  ): Promise<{ items: CategoryDocument[]; total: number }> {
    const skip = (page - 1) * size;
    const query = this.model
      .find(filter)
      .sort({ sort_order: 1, created_at: 1 })
      .skip(skip)
      .limit(size);
    const countQuery = this.model.countDocuments(filter);

    if (session) {
      query.session(session);
      countQuery.session(session);
    }

    const [items, total] = await Promise.all([query.exec(), countQuery.exec()]);
    return { items, total };
  }
}
