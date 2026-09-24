import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Category, CategorySchema } from '../database/schemas/category.schema';
import {
  ProductCategory,
  ProductCategorySchema,
} from '../database/schemas/product-category.schema';
import { CategoryController } from './controllers/category.controller';
import { AdminCategoryController } from './controllers/admin-category.controller';
import { CategoryService } from './services/category.service';
import { CategoryTreeService } from './services/category-tree.service';
import { CategoryRepository } from './repositories/category.repository';
import { ProductCategoryRepository } from './repositories/product-category.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Category.name, schema: CategorySchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
    ]),
  ],
  controllers: [CategoryController, AdminCategoryController],
  providers: [
    CategoryService,
    CategoryTreeService,
    CategoryRepository,
    ProductCategoryRepository,
    {
      provide: 'CategoryRepositoryPort',
      useClass: CategoryRepository,
    },
    {
      provide: 'ProductCategoryRepositoryPort',
      useClass: ProductCategoryRepository,
    },
  ],
  exports: [
    CategoryService,
    CategoryTreeService,
    CategoryRepository,
    ProductCategoryRepository,
    'CategoryRepositoryPort',
    'ProductCategoryRepositoryPort',
  ],
})
export class CategoryModule {}
