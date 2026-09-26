import { Module, forwardRef } from '@nestjs/common';
import { ProductModule } from '../product/product.module';
import { CategoryModule } from '../category/category.module';
import { SkuModule } from '../sku/sku.module';
import { MediaModule } from '../media/media.module';
import { AttributeModule } from '../attribute/attribute.module';
import { ProjectionsModule } from '../projections/projections.module';
import { OutboxModule } from '../outbox/outbox.module';
import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { PublishPolicyService } from './services/publish-policy.service';
import { SellerPublishController } from './controllers/seller-publish.controller';

@Module({
  imports: [
    forwardRef(() => ProductModule),
    CategoryModule,
    forwardRef(() => SkuModule),
    forwardRef(() => MediaModule),
    AttributeModule,
    ProjectionsModule,
    OutboxModule,
    AuditModule,
    DatabaseModule,
  ],
  controllers: [SellerPublishController],
  providers: [PublishPolicyService],
  exports: [PublishPolicyService],
})
export class PublishPolicyModule {}
