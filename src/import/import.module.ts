import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImportJob, ImportJobSchema } from '../database/schemas/import-job.schema';
import { DatabaseModule } from '../database/database.module';
import { CategoryModule } from '../category/category.module';
import { AttributeModule } from '../attribute/attribute.module';
import { ProjectionsModule } from '../projections/projections.module';
import { ProductModule } from '../product/product.module';
import { SkuModule } from '../sku/sku.module';
import { MediaModule } from '../media/media.module';
import { OutboxModule } from '../outbox/outbox.module';
import { StorageModule } from '../integrations/storage/storage.module';

import { MongoImportJobRepository } from './repositories/import-job.repository';
import { ExcelTemplateService } from './services/excel-template.service';
import { MediaDownloadService } from './services/media-download.service';
import { ImportWorkerService } from './services/import-worker.service';
import { ExcelResultService } from './services/excel-result.service';
import { SellerImportController } from './controllers/seller-import.controller';

export const IMPORT_JOB_REPOSITORY_PORT = 'IMPORT_JOB_REPOSITORY_PORT';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ImportJob.name, schema: ImportJobSchema }]),
    DatabaseModule,
    CategoryModule,
    AttributeModule,
    ProjectionsModule,
    StorageModule,
    OutboxModule,
    forwardRef(() => ProductModule),
    forwardRef(() => SkuModule),
    forwardRef(() => MediaModule),
  ],
  controllers: [SellerImportController],
  providers: [
    MongoImportJobRepository,
    ExcelTemplateService,
    MediaDownloadService,
    ImportWorkerService,
    ExcelResultService,
    {
      provide: IMPORT_JOB_REPOSITORY_PORT,
      useClass: MongoImportJobRepository,
    },
    {
      provide: 'ImportJobRepositoryPort',
      useClass: MongoImportJobRepository,
    },
  ],
  exports: [
    MongooseModule,
    MongoImportJobRepository,
    ExcelTemplateService,
    MediaDownloadService,
    ImportWorkerService,
    ExcelResultService,
    IMPORT_JOB_REPOSITORY_PORT,
    'ImportJobRepositoryPort',
  ],
})
export class ImportModule {}
