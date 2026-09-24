import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { CatalogAudit, CatalogAuditDocument } from '../../database/schemas/catalog-audit.schema';
import { CatalogAuditRepositoryPort } from './audit.repository.interface';

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
}
