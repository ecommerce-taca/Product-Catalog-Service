import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ProductMedia, ProductMediaSchema } from '../database/schemas/product-media.schema';
import { ProductMediaRepository } from './repositories/product-media.repository';
import { MediaService } from './services/media.service';
import { SellerMediaController } from './controllers/seller-media.controller';
import { StorageModule } from '../integrations/storage/storage.module';
import { ProductModule } from '../product/product.module';
import { SkuModule } from '../sku/sku.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ProductMedia.name, schema: ProductMediaSchema }]),
    StorageModule,
    ProductModule,
    SkuModule,
    DatabaseModule,
  ],
  controllers: [SellerMediaController],
  providers: [
    ProductMediaRepository,
    {
      provide: 'ProductMediaRepositoryPort',
      useClass: ProductMediaRepository,
    },
    MediaService,
  ],
  exports: [ProductMediaRepository, 'ProductMediaRepositoryPort', MediaService],
})
export class MediaModule {}
