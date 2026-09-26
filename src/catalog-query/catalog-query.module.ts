import { Module } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { CategoryModule } from '../category/category.module';
import { SkuModule } from '../sku/sku.module';
import { MediaModule } from '../media/media.module';
import { ProjectionsModule } from '../projections/projections.module';
import { AttributeModule } from '../attribute/attribute.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { CatalogQueryService } from './services/catalog-query.service';
import { ProductController } from './controllers/product.controller';

@Module({
  imports: [
    ProductModule,
    CategoryModule,
    SkuModule,
    MediaModule,
    ProjectionsModule,
    AttributeModule,
    StorageModule,
  ],
  controllers: [ProductController],
  providers: [CatalogQueryService],
  exports: [CatalogQueryService],
})
export class CatalogQueryModule {}
