import { ClientSession, FilterQuery } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import {
  ProductMedia,
  ProductMediaDocument,
  MediaStatus,
} from '../../database/schemas/product-media.schema';

export interface ProductMediaRepositoryPort extends BaseRepository<ProductMediaDocument> {
  findByProductId(productId: string, session?: ClientSession): Promise<ProductMediaDocument[]>;
  findActiveByProductId(
    productId: string,
    session?: ClientSession,
  ): Promise<ProductMediaDocument[]>;
  findByProductIdAndMediaId(
    productId: string,
    mediaId: string,
    session?: ClientSession,
  ): Promise<ProductMediaDocument | null>;
  countActiveByProductId(
    productId: string,
    filter?: FilterQuery<ProductMediaDocument>,
    session?: ClientSession,
  ): Promise<number>;
  countActiveImages(productId: string, session?: ClientSession): Promise<number>;
  countActiveVideos(productId: string, session?: ClientSession): Promise<number>;
  unsetOtherCovers(
    productId: string,
    excludeMediaId: string,
    session?: ClientSession,
  ): Promise<void>;
  updateStatus(
    mediaId: string,
    productId: string,
    status: MediaStatus,
    extraUpdates?: Partial<ProductMedia>,
    session?: ClientSession,
  ): Promise<ProductMediaDocument | null>;
}

export type IProductMediaRepository = ProductMediaRepositoryPort;
