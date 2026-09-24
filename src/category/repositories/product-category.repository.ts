import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
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
}
