import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CatalogAudit, CatalogAuditSchema } from '../database/schemas/catalog-audit.schema';
import { CatalogAuditRepositoryPort } from './repositories/audit.repository.interface';
import { CatalogAuditRepository } from './repositories/audit.repository';

@Module({
  imports: [MongooseModule.forFeature([{ name: CatalogAudit.name, schema: CatalogAuditSchema }])],
  providers: [
    {
      provide: CatalogAuditRepositoryPort,
      useClass: CatalogAuditRepository,
    },
  ],
  exports: [CatalogAuditRepositoryPort],
})
export class AuditModule {}
