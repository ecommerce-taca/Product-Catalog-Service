import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CatalogAudit, CatalogAuditSchema } from '../database/schemas/catalog-audit.schema';
import { ProductModule } from '../product/product.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DatabaseModule } from '../database/database.module';
import { CatalogAuditRepository } from './repositories/catalog-audit.repository';
import { CATALOG_AUDIT_REPOSITORY_PORT } from './repositories/catalog-audit.repository.interface';
import { ModerationService } from './services/moderation.service';
import { AdminModerationController } from './controllers/admin-moderation.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: CatalogAudit.name, schema: CatalogAuditSchema }]),
    forwardRef(() => ProductModule),
    OutboxModule,
    DatabaseModule,
  ],
  controllers: [AdminModerationController],
  providers: [
    CatalogAuditRepository,
    {
      provide: CATALOG_AUDIT_REPOSITORY_PORT,
      useClass: CatalogAuditRepository,
    },
    ModerationService,
  ],
  exports: [CatalogAuditRepository, CATALOG_AUDIT_REPOSITORY_PORT, ModerationService],
})
export class ModerationModule {}
