import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { v7 as uuidv7 } from 'uuid';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { Sku, SkuDocument } from '../../database/schemas/sku.schema';
import { SkuRepositoryPort } from './sku.repository.interface';

@Injectable()
export class SkuRepository
  extends MongooseBaseRepository<SkuDocument>
  implements SkuRepositoryPort
{
  constructor(
    @InjectModel(Sku.name)
    model: Model<SkuDocument>,
  ) {
    super(model);
  }

  async findByProductId(productId: string, session?: ClientSession): Promise<SkuDocument[]> {
    const query = this.model.find({ product_id: productId }).sort({ created_at: 1 });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findBySellerSku(
    shopId: string,
    sellerSku: string,
    session?: ClientSession,
  ): Promise<SkuDocument | null> {
    const query = this.model.findOne({ shop_id: shopId, seller_sku: sellerSku });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findBySellerSkus(
    shopId: string,
    sellerSkus: string[],
    session?: ClientSession,
  ): Promise<SkuDocument[]> {
    if (!sellerSkus || sellerSkus.length === 0) {
      return [];
    }
    const query = this.model.find({
      shop_id: shopId,
      seller_sku: { $in: sellerSkus },
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async countBySellerSku(
    shopId: string,
    sellerSku: string,
    excludeSkuId?: string,
    session?: ClientSession,
  ): Promise<number> {
    const filter: Record<string, unknown> = {
      shop_id: shopId,
      seller_sku: sellerSku,
    };
    if (excludeSkuId) {
      filter._id = { $ne: excludeSkuId };
    }
    const query = this.model.countDocuments(filter);
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async bulkUpsert(skus: Partial<SkuDocument>[], session?: ClientSession): Promise<void> {
    if (!skus || skus.length === 0) {
      return;
    }

    const operations = skus.map((sku) => {
      const updateDoc = { ...sku };
      const idToSet = updateDoc._id || uuidv7();
      delete updateDoc._id;

      const filter: Record<string, unknown> = sku._id
        ? { _id: sku._id, product_id: sku.product_id, shop_id: sku.shop_id }
        : { product_id: sku.product_id, variant_key: sku.variant_key, shop_id: sku.shop_id };

      return {
        updateOne: {
          filter,
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
