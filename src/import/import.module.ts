import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ImportJob, ImportJobSchema } from '../database/schemas/import-job.schema';
import { DatabaseModule } from '../database/database.module';
import { MongoImportJobRepository } from './repositories/import-job.repository';

export const IMPORT_JOB_REPOSITORY_PORT = 'IMPORT_JOB_REPOSITORY_PORT';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ImportJob.name, schema: ImportJobSchema }]),
    DatabaseModule,
  ],
  providers: [
    MongoImportJobRepository,
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
    IMPORT_JOB_REPOSITORY_PORT,
    'ImportJobRepositoryPort',
  ],
})
export class ImportModule {}
