import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { Product, ProductDocument } from '../../database/schemas/product.schema';
import { QueryProductDto } from '../dto/query-product.dto';

export interface ProductRepositoryPort extends BaseRepository<ProductDocument> {
  findByShopAndSlug(
    shopId: string,
    slug: string,
    session?: ClientSession,
  ): Promise<ProductDocument | null>;

  findByShopAndId(
    shopId: string,
    productId: string,
    session?: ClientSession,
  ): Promise<ProductDocument | null>;

  findSellerProducts(
    shopId: string,
    query: QueryProductDto,
    session?: ClientSession,
  ): Promise<{ items: ProductDocument[]; total: number }>;

  atomicCasUpdate(
    productId: string,
    shopId: string,
    expectedVersion: number | bigint,
    updateData: Partial<Product> | Record<string, unknown>,
    session?: ClientSession,
  ): Promise<ProductDocument | null>;
}
