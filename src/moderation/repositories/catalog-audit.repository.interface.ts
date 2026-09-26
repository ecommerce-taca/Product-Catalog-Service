import { ClientSession, FilterQuery } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { CatalogAudit, CatalogAuditDocument } from '../../database/schemas/catalog-audit.schema';

export const CATALOG_AUDIT_REPOSITORY_PORT = 'CatalogAuditRepositoryPort';

export interface CatalogAuditRepositoryPort extends BaseRepository<CatalogAuditDocument> {
  record(audit: Partial<CatalogAudit>, session?: ClientSession): Promise<CatalogAuditDocument>;
  findAudits(
    filter: FilterQuery<CatalogAuditDocument>,
    page?: number,
    size?: number,
    session?: ClientSession,
  ): Promise<{ items: CatalogAuditDocument[]; total: number }>;
}
