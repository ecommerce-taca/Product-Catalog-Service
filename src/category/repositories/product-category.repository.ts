import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import {
  ProductCategory,
  ProductCategoryDocument,
} from '../../database/schemas/product-category.schema';
import { ProductCategoryRepositoryPort } from './product-category.repository.interface';

@Injectable()
export class ProductCategoryRepository
  extends MongooseBaseRepository<ProductCategoryDocument>
  implements ProductCategoryRepositoryPort
{
  constructor(
    @InjectModel(ProductCategory.name)
    productCategoryModel: Model<ProductCategoryDocument>,
  ) {
    super(productCategoryModel);
  }

  async countByCategoryId(categoryId: string, session?: ClientSession): Promise<number> {
    return this.count({ category_id: categoryId }, session);
  }

  async findByProductId(
    productId: string,
    session?: ClientSession,
  ): Promise<ProductCategoryDocument[]> {
    return this.find({ product_id: productId }, undefined, session);
  }

  async deleteByProductId(productId: string, session?: ClientSession): Promise<boolean> {
    return this.delete({ product_id: productId }, session);
  }

  async replaceProductCategories(
    productId: string,
    assignments: { category_id: string; is_primary: boolean; assigned_by: string }[],
    session?: ClientSession,
  ): Promise<ProductCategoryDocument[]> {
    await this.model.deleteMany({ product_id: productId }, { session });
    if (!assignments || assignments.length === 0) {
      return [];
    }
    const docs = assignments.map((a) => ({
      _id: uuidv7(),
      product_id: productId,
      category_id: a.category_id,
      is_primary: a.is_primary,
      assigned_at: new Date(),
      assigned_by: a.assigned_by,
    }));
    return (await this.model.insertMany(docs, { session })) as ProductCategoryDocument[];
  }
}
