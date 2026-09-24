import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { ProductCategoryDocument } from '../../database/schemas/product-category.schema';

export interface ProductCategoryRepositoryPort extends BaseRepository<ProductCategoryDocument> {
  countByCategoryId(categoryId: string, session?: ClientSession): Promise<number>;
  findByProductId(productId: string, session?: ClientSession): Promise<ProductCategoryDocument[]>;
  deleteByProductId(productId: string, session?: ClientSession): Promise<boolean>;
  replaceProductCategories(
    productId: string,
    assignments: { category_id: string; is_primary: boolean; assigned_by: string }[],
    session?: ClientSession,
  ): Promise<ProductCategoryDocument[]>;
}
