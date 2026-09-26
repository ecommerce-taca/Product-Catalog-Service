import { Module } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { SkuModule } from '../sku/sku.module';
import { CategoryModule } from '../category/category.module';
import { StorageModule } from '../integrations/storage/storage.module';
import { ExportService } from './services/export.service';
import { SellerExportController } from './controllers/seller-export.controller';

@Module({
  imports: [ProductModule, SkuModule, CategoryModule, StorageModule],
  controllers: [SellerExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
