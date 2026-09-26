import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model, UpdateQuery } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import {
  ImportJob,
  ImportJobDocument,
  ImportJobStatus,
} from '../../database/schemas/import-job.schema';
import { ImportJobRepositoryPort } from './import-job.repository.interface';

// Export alias MongoBaseRepository for architectural convention compatibility
export { MongooseBaseRepository as MongoBaseRepository };

@Injectable()
export class MongoImportJobRepository
  extends MongooseBaseRepository<ImportJobDocument>
  implements ImportJobRepositoryPort
{
  constructor(
    @InjectModel(ImportJob.name)
    model: Model<ImportJobDocument>,
  ) {
    super(model);
  }

  async findActiveJobByShop(
    shopId: string,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null> {
    const query = this.model.findOne({
      shop_id: shopId,
      status: { $in: [ImportJobStatus.PENDING, ImportJobStatus.PROCESSING] },
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async claimNextPendingJob(
    leaseDurationMs = 120_000,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + leaseDurationMs);

    const query = this.model.findOneAndUpdate(
      { status: ImportJobStatus.PENDING },
      {
        $set: {
          status: ImportJobStatus.PROCESSING,
          started_at: now,
          locked_until: lockedUntil,
        },
      },
      {
        sort: { created_at: 1 },
        new: true,
        runValidators: true,
      },
    );
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async reclaimStaleJobs(now: Date = new Date(), session?: ClientSession): Promise<number> {
    const filter: FilterQuery<ImportJobDocument> = {
      status: ImportJobStatus.PROCESSING,
      locked_until: { $lte: now },
    };

    const update: UpdateQuery<ImportJobDocument> = {
      $set: {
        status: ImportJobStatus.FAILED,
        completed_at: now,
      },
      $push: {
        error_summary: {
          row_index: 0,
          product_ref_id: 'SYSTEM',
          error_code: 'PRODUCT_IMPORT_WORKER_TIMEOUT',
          error_message: 'Tiến trình xử lý bị quá hạn (worker heartbeat timeout)',
        },
      },
    };

    const query = this.model.updateMany(filter, update);
    if (session) {
      query.session(session);
    }
    const result = await query.exec();
    return result.modifiedCount;
  }

  async findByShopAndId(
    shopId: string,
    jobId: string,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null> {
    const query = this.model.findOne({
      _id: jobId,
      shop_id: shopId,
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async updateHeartbeat(
    jobId: string,
    leaseDurationMs = 120_000,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null> {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + leaseDurationMs);

    const query = this.model.findOneAndUpdate(
      { _id: jobId, status: ImportJobStatus.PROCESSING },
      {
        $set: {
          locked_until: lockedUntil,
        },
      },
      {
        new: true,
        runValidators: true,
      },
    );
    if (session) {
      query.session(session);
    }
    return query.exec();
  }
}

export { MongoImportJobRepository as ImportJobRepository };
