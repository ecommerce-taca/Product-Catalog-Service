import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import {
  AttributeDefinition,
  AttributeDefinitionDocument,
  AttributeScopeType,
} from '../../database/schemas/attribute-definition.schema';
import { AttributeDefinitionRepositoryPort } from './attribute-definition.repository.interface';

@Injectable()
export class AttributeDefinitionRepository
  extends MongooseBaseRepository<AttributeDefinitionDocument>
  implements AttributeDefinitionRepositoryPort
{
  constructor(
    @InjectModel(AttributeDefinition.name)
    model: Model<AttributeDefinitionDocument>,
  ) {
    super(model);
  }

  async findByScope(
    scopeType: AttributeScopeType | string,
    scopeId: string,
    status?: string,
    session?: ClientSession,
  ): Promise<AttributeDefinitionDocument[]> {
    const filter: Record<string, unknown> = {
      scope_type: scopeType,
      scope_id: scopeId,
    };
    if (status) {
      filter.status = status;
    }
    const query = this.model.find(filter).sort({ sort_order: 1, created_at: 1 });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async deleteByScope(
    scopeType: AttributeScopeType | string,
    scopeId: string,
    session?: ClientSession,
  ): Promise<number> {
    const query = this.model.deleteMany({
      scope_type: scopeType,
      scope_id: scopeId,
    });
    if (session) {
      query.session(session);
    }
    const result = await query.exec();
    return result.deletedCount;
  }

  async bulkUpsert(
    definitions: Partial<AttributeDefinitionDocument>[],
    session?: ClientSession,
  ): Promise<void> {
    if (!definitions || definitions.length === 0) {
      return;
    }

    const operations = definitions.map((def) => {
      const updateDoc = { ...def };
      const idToSet = updateDoc._id || uuidv7();
      delete updateDoc._id;

      return {
        updateOne: {
          filter: {
            scope_type: def.scope_type,
            scope_id: def.scope_id,
            key: def.key,
          },
          update: {
            $set: { ...updateDoc, updated_at: new Date() },
            $setOnInsert: { _id: idToSet, created_at: new Date() },
          },
          upsert: true,
        },
      };
    });

    await this.model.bulkWrite(operations, { session });
  }
}
