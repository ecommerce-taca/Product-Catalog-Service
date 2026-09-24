import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, FilterQuery, Model, UpdateQuery } from 'mongoose';
import { MongooseBaseRepository } from '../../common/repositories/mongoose.base.repository';
import { Product, ProductDocument } from '../../database/schemas/product.schema';
import { ProductRepositoryPort } from './product.repository.interface';
import { QueryProductDto } from '../dto/query-product.dto';

@Injectable()
export class ProductRepository
  extends MongooseBaseRepository<ProductDocument>
  implements ProductRepositoryPort
{
  constructor(
    @InjectModel(Product.name)
    model: Model<ProductDocument>,
  ) {
    super(model);
  }

  async findByShopAndSlug(
    shopId: string,
    slug: string,
    session?: ClientSession,
  ): Promise<ProductDocument | null> {
    const query = this.model.findOne({ shop_id: shopId, slug });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findByShopAndId(
    shopId: string,
    productId: string,
    session?: ClientSession,
  ): Promise<ProductDocument | null> {
    const query = this.model.findOne({ _id: productId, shop_id: shopId });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }

  async findSellerProducts(
    shopId: string,
    query: QueryProductDto,
    session?: ClientSession,
  ): Promise<{ items: ProductDocument[]; total: number }> {
    const filter: FilterQuery<ProductDocument> = { shop_id: shopId };

    if (query.status) {
      filter.status = query.status;
    }

    if (query.q && query.q.trim()) {
      const escaped = query.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const searchRegex = new RegExp(escaped, 'i');
      filter.$or = [{ title: searchRegex }, { slug: searchRegex }];
    }

    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const size = query.size && query.size > 0 ? Math.min(Number(query.size), 100) : 20;
    const skip = (page - 1) * size;

    let sortOption: Record<string, 1 | -1> = { updated_at: -1 };
    if (query.sort) {
      if (query.sort === 'created_at:asc' || query.sort === 'created_at') {
        sortOption = { created_at: 1 };
      } else if (query.sort === 'created_at:desc' || query.sort === '-created_at') {
        sortOption = { created_at: -1 };
      } else if (query.sort === 'title:asc' || query.sort === 'title') {
        sortOption = { title: 1 };
      } else if (query.sort === 'title:desc' || query.sort === '-title') {
        sortOption = { title: -1 };
      } else if (query.sort === 'updated_at:asc') {
        sortOption = { updated_at: 1 };
      }
    }

    const findQuery = this.model.find(filter).sort(sortOption).skip(skip).limit(size);
    const countQuery = this.model.countDocuments(filter);

    if (session) {
      findQuery.session(session);
      countQuery.session(session);
    }

    const [items, total] = await Promise.all([findQuery.exec(), countQuery.exec()]);
    return { items, total };
  }

  async atomicCasUpdate(
    productId: string,
    shopId: string,
    expectedVersion: number | bigint,
    updateData: Partial<Product> | Record<string, unknown>,
    session?: ClientSession,
  ): Promise<ProductDocument | null> {
    const filter: FilterQuery<ProductDocument> = {
      _id: productId,
      shop_id: shopId,
      version: BigInt(expectedVersion),
    };

    const nextVersion = BigInt(expectedVersion) + BigInt(1);
    let update: UpdateQuery<ProductDocument>;

    const hasOperator = Object.keys(updateData).some((k) => k.startsWith('$'));
    if (hasOperator) {
      update = { ...(updateData as UpdateQuery<ProductDocument>) };
      update.$set = {
        ...(update.$set || {}),
        version: nextVersion,
      };
    } else {
      update = {
        $set: {
          ...updateData,
          version: nextVersion,
        },
      };
    }

    const query = this.model.findOneAndUpdate(filter, update, {
      new: true,
      runValidators: true,
    });
    if (session) {
      query.session(session);
    }
    return query.exec();
  }
}
