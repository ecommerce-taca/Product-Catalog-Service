import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import storageConfig from './config/storage.config';
import { DatabaseModule } from './database/database.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { CategoryModule } from './category/category.module';
import { AttributeModule } from './attribute/attribute.module';
import { SkuModule } from './sku/sku.module';
import { ProductModule } from './product/product.module';
import { StorageModule } from './integrations/storage/storage.module';
import { MediaModule } from './media/media.module';
import { KafkaModule } from './integrations/kafka/kafka.module';
import { ProjectionsModule } from './projections/projections.module';
import { PublishPolicyModule } from './publish-policy/publish-policy.module';
import { ModerationModule } from './moderation/moderation.module';
import { TraceContextMiddleware } from './common/middleware/trace-context.middleware';
import { ActorContextGuard } from './common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, storageConfig],
    }),
    DatabaseModule,
    OutboxModule,
    AuditModule,
    HealthModule,
    CategoryModule,
    AttributeModule,
    SkuModule,
    ProductModule,
    StorageModule,
    MediaModule,
    KafkaModule,
    ProjectionsModule,
    PublishPolicyModule,
    ModerationModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ActorContextGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseEnvelopeInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceContextMiddleware).forRoutes('*');
  }
}
