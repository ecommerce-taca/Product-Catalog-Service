import { ClientSession, FilterQuery, QueryOptions, UpdateQuery } from 'mongoose';
import { CatalogAudit, CatalogAuditDocument } from '../../database/schemas/catalog-audit.schema';
import { BaseRepository } from '../../common/repositories/base.repository.interface';

export abstract class CatalogAuditRepositoryPort implements BaseRepository<CatalogAuditDocument> {
  abstract findById(id: string, session?: ClientSession): Promise<CatalogAuditDocument | null>;
  abstract findOne(
    filter: FilterQuery<CatalogAuditDocument>,
    session?: ClientSession,
  ): Promise<CatalogAuditDocument | null>;
  abstract find(
    filter: FilterQuery<CatalogAuditDocument>,
    options?: QueryOptions,
    session?: ClientSession,
  ): Promise<CatalogAuditDocument[]>;
  abstract create(
    doc: Partial<CatalogAudit>,
    session?: ClientSession,
  ): Promise<CatalogAuditDocument>;
  abstract update(
    filter: FilterQuery<CatalogAuditDocument>,
    update: UpdateQuery<CatalogAuditDocument>,
    session?: ClientSession,
  ): Promise<CatalogAuditDocument | null>;
  abstract delete(
    filter: FilterQuery<CatalogAuditDocument>,
    session?: ClientSession,
  ): Promise<boolean>;
  abstract count(
    filter?: FilterQuery<CatalogAuditDocument>,
    session?: ClientSession,
  ): Promise<number>;
  abstract record(
    audit: Partial<CatalogAudit>,
    session?: ClientSession,
  ): Promise<CatalogAuditDocument>;
}
