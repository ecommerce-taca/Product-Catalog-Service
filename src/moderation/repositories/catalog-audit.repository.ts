import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { CatalogAudit, CatalogAuditDocument } from '../../database/schemas/catalog-audit.schema';
import { CatalogAuditRepositoryPort } from './catalog-audit.repository.interface';

@Injectable()
export class CatalogAuditRepository
  extends MongooseBaseRepository<CatalogAuditDocument>
  implements CatalogAuditRepositoryPort
{
  constructor(
    @InjectModel(CatalogAudit.name)
    auditModel: Model<CatalogAuditDocument>,
  ) {
    super(auditModel);
  }

  async record(
    audit: Partial<CatalogAudit>,
    session?: ClientSession,
  ): Promise<CatalogAuditDocument> {
    return this.create(audit, session);
  }

  async findAudits(
    filter: FilterQuery<CatalogAuditDocument>,
    page = 1,
    size = 20,
    session?: ClientSession,
  ): Promise<{ items: CatalogAuditDocument[]; total: number }> {
    const validPage = Math.max(1, page);
    const validSize = Math.min(100, Math.max(1, size));
    const skip = (validPage - 1) * validSize;

    const findQuery = this.model.find(filter).sort({ occurred_at: -1 }).skip(skip).limit(validSize);
    const countQuery = this.model.countDocuments(filter);

    if (session) {
      findQuery.session(session);
      countQuery.session(session);
    }

    const [items, total] = await Promise.all([findQuery.exec(), countQuery.exec()]);
    return { items, total };
  }
}
