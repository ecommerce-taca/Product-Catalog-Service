import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { ShopSnapshot, ShopSnapshotDocument } from '../../database/schemas/shop-snapshot.schema';
import { ShopSnapshotRepositoryPort } from './shop-snapshot.repository.interface';

@Injectable()
export class ShopSnapshotRepository
  extends MongooseBaseRepository<ShopSnapshotDocument>
  implements ShopSnapshotRepositoryPort
{
  constructor(
    @InjectModel(ShopSnapshot.name)
    model: Model<ShopSnapshotDocument>,
  ) {
    super(model);
  }

  async findByShopId(
    shopId: string,
    session?: ClientSession,
  ): Promise<ShopSnapshotDocument | null> {
    const query = this.model.findOne({ shop_id: shopId });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findByShopIds(shopIds: string[], session?: ClientSession): Promise<ShopSnapshotDocument[]> {
    if (!shopIds || shopIds.length === 0) return [];
    const query = this.model.find({ shop_id: { $in: shopIds } });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async upsertSnapshot(
    snapshot: Partial<ShopSnapshot>,
    session?: ClientSession,
  ): Promise<ShopSnapshotDocument> {
    const shopId = snapshot.shop_id || snapshot._id;
    if (!shopId) {
      throw new Error('shop_id is required for upsertSnapshot');
    }

    const filter = { shop_id: shopId };
    const update = {
      $set: {
        ...snapshot,
        _id: shopId,
        shop_id: shopId,
      },
    };

    const query = this.model.findOneAndUpdate(filter, update, {
      upsert: true,
      new: true,
      runValidators: true,
    });

    if (session) {
      query.session(session);
    }

    const result = await query.exec();
    return result as ShopSnapshotDocument;
  }
}
