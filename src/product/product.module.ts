import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Product, ProductSchema } from '../database/schemas/product.schema';
import { CategoryModule } from '../category/category.module';
import { SkuModule } from '../sku/sku.module';
import { AttributeModule } from '../attribute/attribute.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DatabaseModule } from '../database/database.module';
import { MediaModule } from '../media/media.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { ProductRepository } from './repositories/product.repository';
import { ProductService } from './services/product.service';
import { SellerProductController } from './controllers/seller-product.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Product.name, schema: ProductSchema }]),
    CategoryModule,
    forwardRef(() => SkuModule),
    AttributeModule,
    OutboxModule,
    DatabaseModule,
    forwardRef(() => MediaModule),
    StorageModule,
  ],
  controllers: [SellerProductController],
  providers: [
    ProductRepository,
    {
      provide: 'ProductRepositoryPort',
      useClass: ProductRepository,
    },
    ProductService,
  ],
  exports: [ProductRepository, 'ProductRepositoryPort', ProductService],
})
export class ProductModule {}
