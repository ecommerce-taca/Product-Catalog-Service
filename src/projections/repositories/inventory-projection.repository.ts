import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import {
  InventoryProjection,
  InventoryProjectionDocument,
} from '../../database/schemas/inventory-projection.schema';
import { InventoryProjectionRepositoryPort } from './inventory-projection.repository.interface';

@Injectable()
export class InventoryProjectionRepository
  extends MongooseBaseRepository<InventoryProjectionDocument>
  implements InventoryProjectionRepositoryPort
{
  constructor(
    @InjectModel(InventoryProjection.name)
    model: Model<InventoryProjectionDocument>,
  ) {
    super(model);
  }

  async findBySkuId(
    skuId: string,
    session?: ClientSession,
  ): Promise<InventoryProjectionDocument | null> {
    const query = this.model.findOne({ sku_id: skuId });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findByProductId(
    productId: string,
    session?: ClientSession,
  ): Promise<InventoryProjectionDocument[]> {
    const query = this.model.find({ product_id: productId });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findByProductIds(
    productIds: string[],
    session?: ClientSession,
  ): Promise<InventoryProjectionDocument[]> {
    if (!productIds || productIds.length === 0) return [];
    const query = this.model.find({ product_id: { $in: productIds } });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async upsertProjection(
    projection: Partial<InventoryProjection>,
    session?: ClientSession,
  ): Promise<InventoryProjectionDocument> {
    const skuId = projection.sku_id || projection._id;
    if (!skuId) {
      throw new Error('sku_id is required for upsertProjection');
    }

    const filter = { sku_id: skuId };
    const update = {
      $set: {
        ...projection,
        _id: skuId,
        sku_id: skuId,
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
    return result as InventoryProjectionDocument;
  }
}
