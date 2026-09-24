import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { SkuDocument } from '../../database/schemas/sku.schema';

export interface SkuRepositoryPort extends BaseRepository<SkuDocument> {
  findByProductId(productId: string, session?: ClientSession): Promise<SkuDocument[]>;
  findBySellerSku(
    shopId: string,
    sellerSku: string,
    session?: ClientSession,
  ): Promise<SkuDocument | null>;
  findBySellerSkus(
    shopId: string,
    sellerSkus: string[],
    session?: ClientSession,
  ): Promise<SkuDocument[]>;
  countBySellerSku(
    shopId: string,
    sellerSku: string,
    excludeSkuId?: string,
    session?: ClientSession,
  ): Promise<number>;
  bulkUpsert(skus: Partial<SkuDocument>[], session?: ClientSession): Promise<void>;
}
