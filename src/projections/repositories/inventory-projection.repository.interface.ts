import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import {
  InventoryProjection,
  InventoryProjectionDocument,
} from '../../database/schemas/inventory-projection.schema';

export const INVENTORY_PROJECTION_REPOSITORY_PORT = 'InventoryProjectionRepositoryPort';

export interface InventoryProjectionRepositoryPort extends BaseRepository<InventoryProjectionDocument> {
  findBySkuId(skuId: string, session?: ClientSession): Promise<InventoryProjectionDocument | null>;
  findByProductId(
    productId: string,
    session?: ClientSession,
  ): Promise<InventoryProjectionDocument[]>;
  upsertProjection(
    projection: Partial<InventoryProjection>,
    session?: ClientSession,
  ): Promise<InventoryProjectionDocument>;
}
