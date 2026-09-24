import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AttributeDefinition,
  AttributeDefinitionSchema,
} from '../database/schemas/attribute-definition.schema';
import { AttributeDefinitionRepository } from './repositories/attribute-definition.repository';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AttributeDefinition.name, schema: AttributeDefinitionSchema },
    ]),
  ],
  providers: [
    AttributeDefinitionRepository,
    {
      provide: 'AttributeDefinitionRepositoryPort',
      useClass: AttributeDefinitionRepository,
    },
  ],
  exports: [AttributeDefinitionRepository, 'AttributeDefinitionRepositoryPort'],
})
export class AttributeModule {}
