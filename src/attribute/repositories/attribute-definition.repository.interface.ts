import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import {
  AttributeDefinitionDocument,
  AttributeScopeType,
} from '../../database/schemas/attribute-definition.schema';

export interface AttributeDefinitionRepositoryPort extends BaseRepository<AttributeDefinitionDocument> {
  findByScope(
    scopeType: AttributeScopeType | string,
    scopeId: string,
    status?: string,
    session?: ClientSession,
  ): Promise<AttributeDefinitionDocument[]>;

  deleteByScope(
    scopeType: AttributeScopeType | string,
    scopeId: string,
    session?: ClientSession,
  ): Promise<number>;

  bulkUpsert(
    definitions: Partial<AttributeDefinitionDocument>[],
    session?: ClientSession,
  ): Promise<void>;
}
