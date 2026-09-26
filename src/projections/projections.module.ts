import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ShopSnapshot, ShopSnapshotSchema } from '../database/schemas/shop-snapshot.schema';
import {
  InventoryProjection,
  InventoryProjectionSchema,
} from '../database/schemas/inventory-projection.schema';
import { ShopSnapshotRepository } from './repositories/shop-snapshot.repository';
import { SHOP_SNAPSHOT_REPOSITORY_PORT } from './repositories/shop-snapshot.repository.interface';
import { InventoryProjectionRepository } from './repositories/inventory-projection.repository';
import { INVENTORY_PROJECTION_REPOSITORY_PORT } from './repositories/inventory-projection.repository.interface';
import { ShopProjectionService } from './services/shop-projection.service';
import { InventoryProjectionService } from './services/inventory-projection.service';
import { ShopProjectionConsumer } from './consumers/shop-projection.consumer';
import { InventoryProjectionConsumer } from './consumers/inventory-projection.consumer';
import { RatingSummaryConsumer } from './consumers/rating-summary.consumer';
import { OutboxModule } from '../outbox/outbox.module';
import { ProductModule } from '../product/product.module';
import { KafkaModule } from '../integrations/kafka/kafka.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: ShopSnapshot.name, schema: ShopSnapshotSchema },
      { name: InventoryProjection.name, schema: InventoryProjectionSchema },
    ]),
    OutboxModule,
    forwardRef(() => ProductModule),
    KafkaModule,
  ],
  providers: [
    ShopSnapshotRepository,
    {
      provide: SHOP_SNAPSHOT_REPOSITORY_PORT,
      useClass: ShopSnapshotRepository,
    },
    InventoryProjectionRepository,
    {
      provide: INVENTORY_PROJECTION_REPOSITORY_PORT,
      useClass: InventoryProjectionRepository,
    },
    ShopProjectionService,
    InventoryProjectionService,
    ShopProjectionConsumer,
    InventoryProjectionConsumer,
    RatingSummaryConsumer,
  ],
  exports: [
    ShopSnapshotRepository,
    SHOP_SNAPSHOT_REPOSITORY_PORT,
    InventoryProjectionRepository,
    INVENTORY_PROJECTION_REPOSITORY_PORT,
    ShopProjectionService,
    InventoryProjectionService,
    ShopProjectionConsumer,
    InventoryProjectionConsumer,
    RatingSummaryConsumer,
  ],
})
export class ProjectionsModule {}
