import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Sku, SkuSchema } from '../database/schemas/sku.schema';
import { Product, ProductSchema } from '../database/schemas/product.schema';
import { AttributeModule } from '../attribute/attribute.module';
import { SkuRepository } from './repositories/sku.repository';
import { VariantResolver } from './services/variant-resolver.service';
import { SkuService } from './services/sku.service';
import { SellerSkuController } from './controllers/seller-sku.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Sku.name, schema: SkuSchema },
      { name: Product.name, schema: ProductSchema },
    ]),
    AttributeModule,
  ],
  controllers: [SellerSkuController],
  providers: [
    SkuRepository,
    {
      provide: 'SkuRepositoryPort',
      useClass: SkuRepository,
    },
    VariantResolver,
    SkuService,
  ],
  exports: [SkuRepository, 'SkuRepositoryPort', VariantResolver, SkuService],
})
export class SkuModule {}
