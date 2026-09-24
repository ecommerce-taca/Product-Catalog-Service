import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { DatabaseConfig } from '../config/database.config';
import { TransactionRunner } from './transaction.runner';
import { OutboxEvent, OutboxEventSchema } from './schemas/outbox-event.schema';
import { CatalogAudit, CatalogAuditSchema } from './schemas/catalog-audit.schema';
import {
  AttributeDefinition,
  AttributeDefinitionSchema,
} from './schemas/attribute-definition.schema';
import { Category, CategorySchema } from './schemas/category.schema';
import { ProductCategory, ProductCategorySchema } from './schemas/product-category.schema';

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const dbConfig = configService.get<DatabaseConfig>('database');
        if (!dbConfig) {
          throw new Error('Database configuration not found');
        }
        return {
          uri: dbConfig.uri,
          ...dbConfig.options,
        };
      },
    }),
    MongooseModule.forFeature([
      { name: OutboxEvent.name, schema: OutboxEventSchema },
      { name: CatalogAudit.name, schema: CatalogAuditSchema },
      { name: Category.name, schema: CategorySchema },
      { name: ProductCategory.name, schema: ProductCategorySchema },
      { name: AttributeDefinition.name, schema: AttributeDefinitionSchema },
    ]),
  ],
  providers: [TransactionRunner],
  exports: [MongooseModule, TransactionRunner],
})
export class DatabaseModule {}
