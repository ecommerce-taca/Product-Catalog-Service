import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import {
  ProductMedia,
  ProductMediaDocument,
  MediaStatus,
} from '../../database/schemas/product-media.schema';
import { ProductMediaRepositoryPort } from './product-media.repository.interface';

@Injectable()
export class ProductMediaRepository
  extends MongooseBaseRepository<ProductMediaDocument>
  implements ProductMediaRepositoryPort
{
  constructor(
    @InjectModel(ProductMedia.name)
    model: Model<ProductMediaDocument>,
  ) {
    super(model);
  }

  async findByProductId(
    productId: string,
    session?: ClientSession,
  ): Promise<ProductMediaDocument[]> {
    const query = this.model
      .find({
        product_id: productId,
        status: { $ne: MediaStatus.DELETED },
      })
      .sort({ sort_order: 1, created_at: 1 });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findByProductIds(
    productIds: string[],
    session?: ClientSession,
  ): Promise<ProductMediaDocument[]> {
    if (!productIds || productIds.length === 0) return [];
    const query = this.model
      .find({
        product_id: { $in: productIds },
        status: { $ne: MediaStatus.DELETED },
      })
      .sort({ sort_order: 1, created_at: 1 });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findActiveByProductId(
    productId: string,
    session?: ClientSession,
  ): Promise<ProductMediaDocument[]> {
    return this.findByProductId(productId, session);
  }

  async findByProductIdAndMediaId(
    productId: string,
    mediaId: string,
    session?: ClientSession,
  ): Promise<ProductMediaDocument | null> {
    const query = this.model.findOne({ _id: mediaId, product_id: productId });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async countActiveByProductId(
    productId: string,
    filter?: FilterQuery<ProductMediaDocument>,
    session?: ClientSession,
  ): Promise<number> {
    const query = this.model.countDocuments({
      product_id: productId,
      status: { $ne: MediaStatus.DELETED },
      ...filter,
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async countActiveImages(productId: string, session?: ClientSession): Promise<number> {
    return this.countActiveByProductId(
      productId,
      { content_type: { $in: ['image/jpeg', 'image/png', 'image/webp'] } },
      session,
    );
  }

  async countActiveVideos(productId: string, session?: ClientSession): Promise<number> {
    return this.countActiveByProductId(productId, { content_type: 'video/mp4' }, session);
  }

  async unsetOtherCovers(
    productId: string,
    excludeMediaId: string,
    session?: ClientSession,
  ): Promise<void> {
    const query = this.model.updateMany(
      {
        product_id: productId,
        _id: { $ne: excludeMediaId },
        is_cover: true,
      },
      {
        $set: { is_cover: false },
      },
    );
    if (session) {
      query.session(session);
    }
    await query.exec();
  }

  async updateStatus(
    mediaId: string,
    productId: string,
    status: MediaStatus,
    extraUpdates?: Partial<ProductMedia>,
    session?: ClientSession,
  ): Promise<ProductMediaDocument | null> {
    const query = this.model.findOneAndUpdate(
      { _id: mediaId, product_id: productId },
      {
        $set: {
          status,
          ...extraUpdates,
        },
      },
      { new: true, runValidators: true },
    );
    if (session) {
      query.session(session);
    }
    return query.exec();
  }
}
