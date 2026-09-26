import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { ShopSnapshot, ShopSnapshotDocument } from '../../database/schemas/shop-snapshot.schema';

export const SHOP_SNAPSHOT_REPOSITORY_PORT = 'ShopSnapshotRepositoryPort';

export interface ShopSnapshotRepositoryPort extends BaseRepository<ShopSnapshotDocument> {
  findByShopId(shopId: string, session?: ClientSession): Promise<ShopSnapshotDocument | null>;
  upsertSnapshot(
    snapshot: Partial<ShopSnapshot>,
    session?: ClientSession,
  ): Promise<ShopSnapshotDocument>;
}
