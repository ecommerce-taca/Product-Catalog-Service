import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FilterQuery } from 'mongoose';
import { ProductDocument, ProductStatus } from '../../database/schemas/product.schema';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../../projections/repositories/shop-snapshot.repository.interface';
import { ProductCategoryRepositoryPort } from '../../category/repositories/product-category.repository.interface';
import { CategoryService } from '../../category/services/category.service';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { SkuStatus } from '../../database/schemas/sku.schema';
import { ProductMediaRepositoryPort } from '../../media/repositories/product-media.repository.interface';
import { MediaStatus } from '../../database/schemas/product-media.schema';
import {
  INVENTORY_PROJECTION_REPOSITORY_PORT,
  InventoryProjectionRepositoryPort,
} from '../../projections/repositories/inventory-projection.repository.interface';
import { AttributeDefinitionRepositoryPort } from '../../attribute/repositories/attribute-definition.repository.interface';
import { AttributeScopeType } from '../../database/schemas/attribute-definition.schema';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { ProductSortOption, QueryProductsDto } from '../dto/query-products.dto';
import {
  PaginatedProductsResponseDto,
  ProductCardDto,
  StockDisplayStatus,
} from '../dto/product-response.dto';
import {
  AttributeItemDto,
  ProductDetailDto,
  ProductDetailMediaDto,
  SkuDetailDto,
  SkuStockDisplayDto,
} from '../dto/product-detail-response.dto';

@Injectable()
export class CatalogQueryService {
  constructor(
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
    @Inject(SHOP_SNAPSHOT_REPOSITORY_PORT)
    private readonly shopSnapshotRepository: ShopSnapshotRepositoryPort,
    @Inject('ProductCategoryRepositoryPort')
    private readonly productCategoryRepository: ProductCategoryRepositoryPort,
    @Inject('SkuRepositoryPort')
    private readonly skuRepository: SkuRepositoryPort,
    @Inject('ProductMediaRepositoryPort')
    private readonly mediaRepository: ProductMediaRepositoryPort,
    @Inject(INVENTORY_PROJECTION_REPOSITORY_PORT)
    private readonly inventoryProjectionRepository: InventoryProjectionRepositoryPort,
    @Inject('AttributeDefinitionRepositoryPort')
    private readonly attributeDefinitionRepository: AttributeDefinitionRepositoryPort,
    private readonly categoryService: CategoryService,
    private readonly s3StorageService: S3StorageService,
  ) {}

  /**
   * List public active products with filtering, sorting, pagination, and data hydration.
   * Query uses MongoDB Read Preference 'primaryPreferred' (Decision D2).
   */
  async listProducts(query: QueryProductsDto): Promise<PaginatedProductsResponseDto> {
    const page = query.page !== undefined ? Number(query.page) : 1;
    const size = query.size !== undefined ? Number(query.size) : 20;

    if (!Number.isInteger(page) || page < 1) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'page phải là số nguyên lớn hơn hoặc bằng 1.',
      });
    }

    if (!Number.isInteger(size) || size < 1 || size > 100) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'size phải là số nguyên từ 1 đến 100.',
      });
    }

    if (query.min_price !== undefined) {
      const minP = Number(query.min_price);
      if (!Number.isInteger(minP) || minP < 0) {
        throw new BadRequestException({
          code: 'PRODUCT_INVALID_INPUT',
          message: 'min_price phải là số nguyên không âm.',
        });
      }
    }

    if (query.max_price !== undefined) {
      const maxP = Number(query.max_price);
      if (!Number.isInteger(maxP) || maxP < 0) {
        throw new BadRequestException({
          code: 'PRODUCT_INVALID_INPUT',
          message: 'max_price phải là số nguyên không âm.',
        });
      }
    }

    if (
      query.min_price !== undefined &&
      query.max_price !== undefined &&
      Number(query.min_price) > Number(query.max_price)
    ) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'min_price không được lớn hơn max_price.',
      });
    }

    // 1. Batch Hydration via product_ids (Max 100 IDs)
    if (query.product_ids !== undefined) {
      const rawIds = query.product_ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);

      if (rawIds.length > 100) {
        throw new BadRequestException({
          code: 'PRODUCT_INVALID_INPUT',
          message: 'Số lượng product_ids tối đa là 100.',
        });
      }

      if (rawIds.length === 0) {
        return {
          data: [],
          meta: {
            page,
            size,
            total: 0,
            total_pages: 0,
          },
        };
      }

      const filter: FilterQuery<ProductDocument> = {
        _id: { $in: rawIds },
        status: ProductStatus.ACTIVE,
        archived_at: null,
      };

      const products = await this.productRepository.find(filter, {
        readPreference: 'primaryPreferred',
      });

      // Preserve caller order of product_ids and omit non-active / non-existent gracefully
      products.sort((a, b) => {
        const idxA = rawIds.indexOf(String(a._id));
        const idxB = rawIds.indexOf(String(b._id));
        return idxA - idxB;
      });

      const total = products.length;
      const totalPages = Math.ceil(total / size) || (total === 0 ? 0 : 1);
      const skip = (page - 1) * size;
      const pagedProducts = products.slice(skip, skip + size);

      const items = await this.batchHydrateProductCards(pagedProducts);

      return {
        data: items,
        meta: {
          page,
          size,
          total,
          total_pages: totalPages,
        },
      };
    }

    // 2. Standard Public Listing
    const filter: FilterQuery<ProductDocument> = {
      status: ProductStatus.ACTIVE,
      archived_at: null,
    };

    if (query.shop_id) {
      filter.shop_id = query.shop_id;
    }

    if (query.category_id) {
      const catAssignments = await this.productCategoryRepository.find({
        category_id: query.category_id,
      });
      const assignedProductIds = catAssignments.map((a) => a.product_id);
      filter.$or = [
        { primary_category_id: query.category_id },
        { _id: { $in: assignedProductIds } },
      ];
    }

    if (query.min_price !== undefined || query.max_price !== undefined) {
      const priceFilter: Record<string, bigint> = {};
      if (query.min_price !== undefined) {
        priceFilter.$gte = BigInt(query.min_price);
      }
      if (query.max_price !== undefined) {
        priceFilter.$lte = BigInt(query.max_price);
      }
      filter['price_summary.sale_price'] = priceFilter;
    }

    let sortOption: Record<string, 1 | -1> = { created_at: -1 };
    if (query.sort === ProductSortOption.PRICE_ASC) {
      sortOption = { 'price_summary.sale_price': 1 };
    } else if (query.sort === ProductSortOption.PRICE_DESC) {
      sortOption = { 'price_summary.sale_price': -1 };
    } else if (query.sort === ProductSortOption.NEWEST) {
      sortOption = { created_at: -1 };
    }

    const skip = (page - 1) * size;
    const [rawItems, total] = await Promise.all([
      this.productRepository.find(filter, {
        sort: sortOption,
        skip,
        limit: size,
        readPreference: 'primaryPreferred',
      }),
      this.productRepository.count(filter),
    ]);

    const totalPages = Math.ceil(total / size) || (total === 0 ? 0 : 1);
    const items = await this.batchHydrateProductCards(rawItems);

    return {
      data: items,
      meta: {
        page,
        size,
        total,
        total_pages: totalPages,
      },
    };
  }

  /**
   * Retrieves full product detail (PDP) for public view.
   * Throws 404 PRODUCT_NOT_FOUND if not found or not in ACTIVE status.
   */
  async getProductDetail(productId: string): Promise<ProductDetailDto> {
    const product = await this.productRepository.findById(productId);

    if (!product || product.status !== ProductStatus.ACTIVE || product.archived_at) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy sản phẩm.',
      });
    }

    const [shopSnapshot, taxRateBps, definitions, mediaList, skus, inventoryProjections] =
      await Promise.all([
        this.shopSnapshotRepository.findByShopId(product.shop_id),
        product.primary_category_id
          ? this.categoryService
              .resolveEffectiveTaxRate(product.primary_category_id)
              .catch(() => null)
          : Promise.resolve(null),
        this.attributeDefinitionRepository.findByScope(AttributeScopeType.PRODUCT, productId),
        this.mediaRepository.findByProductId(productId),
        this.skuRepository.findByProductId(productId),
        this.inventoryProjectionRepository.findByProductId(productId),
      ]);

    const shop = shopSnapshot
      ? {
          shop_id: shopSnapshot.shop_id,
          name: shopSnapshot.name,
          slug: shopSnapshot.slug,
          logo_url: shopSnapshot.logo_url ?? null,
        }
      : {
          shop_id: product.shop_id,
          name: '',
          slug: '',
          logo_url: null,
        };

    // Filter media: READY only, cover first, then sort_order, then created_at
    const readyMedia = mediaList
      .filter((m) => m.status === MediaStatus.READY)
      .sort((a, b) => {
        if (a.is_cover && !b.is_cover) return -1;
        if (!a.is_cover && b.is_cover) return 1;
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });

    const mediaDtos: ProductDetailMediaDto[] = readyMedia.map((m) => ({
      media_id: String(m._id),
      url: this.s3StorageService.getPublicUrl(m.object_key),
      content_type: m.content_type,
      is_cover: m.is_cover,
      sort_order: m.sort_order ?? 0,
    }));

    // Active SKUs only
    const activeSkus = skus.filter((s) => s.status === SkuStatus.ACTIVE);

    const skuDtos: SkuDetailDto[] = activeSkus.map((sku) => {
      const projection = inventoryProjections.find((p) => p.sku_id === sku._id);

      const price = sku.price_override
        ? {
            base_price: Number(sku.price_override),
            sale_price: Number(sku.price_override),
            currency: 'VND',
          }
        : {
            base_price: Number(product.price_summary?.base_price ?? 0),
            sale_price: Number(product.price_summary?.sale_price ?? 0),
            currency: product.price_summary?.currency || 'VND',
          };

      let stockDisplay: SkuStockDisplayDto;
      if (projection) {
        let status = projection.stock_status;
        const asOfDate = projection.as_of ? new Date(projection.as_of) : null;
        if (
          projection.stock_status === 'STALE' ||
          (projection as any).status === 'STALE' ||
          (asOfDate && Date.now() - asOfDate.getTime() > 60000)
        ) {
          status = 'STALE' as any;
        }

        stockDisplay = {
          status,
          available_qty_snapshot: Number(projection.available_qty_snapshot ?? 0),
          as_of: asOfDate ? asOfDate.toISOString() : null,
        };
      } else {
        stockDisplay = {
          status: 'UNKNOWN',
          available_qty_snapshot: 0,
          as_of: null,
        };
      }

      return {
        sku_id: String(sku._id),
        seller_sku: sku.seller_sku,
        attributes: sku.attributes || {},
        price,
        stock_display: stockDisplay,
      };
    });

    // Attribute definitions mapped with collected distinct values
    const attributeDtos: AttributeItemDto[] = definitions.map((def) => {
      let values: (string | number | boolean)[] = [];
      if (def.allowed_values && def.allowed_values.length > 0) {
        values = def.allowed_values;
      } else {
        const valueSet = new Set<string | number | boolean>();
        for (const sku of activeSkus) {
          const val = sku.attributes?.[def.key];
          if (val !== undefined && val !== null) {
            valueSet.add(val);
          }
        }
        values = Array.from(valueSet);
      }

      return {
        key: def.key,
        label: def.label,
        type: def.type,
        values,
      };
    });

    const price = {
      base_price: Number(product.price_summary?.base_price ?? 0),
      sale_price: Number(product.price_summary?.sale_price ?? 0),
      currency: product.price_summary?.currency || 'VND',
    };

    const ratingSummary = {
      avg: product.rating_summary?.avg ?? null,
      count: product.rating_summary?.count ?? 0,
    };

    return {
      product_id: String(product._id),
      status: product.status,
      title: product.title,
      slug: product.slug,
      description: product.description,
      brand: product.brand,
      shop,
      primary_category_id: product.primary_category_id,
      tax_rate_bps: taxRateBps,
      price,
      rating_summary: ratingSummary,
      attributes: attributeDtos,
      skus: skuDtos,
      media: mediaDtos,
    };
  }

  /**
   * Lists products belonging to a specific shop.
   * Throws 403 PRODUCT_SHOP_SUSPENDED if the shop is SUSPENDED.
   */
  async listShopProducts(
    shopId: string,
    query: QueryProductsDto,
  ): Promise<PaginatedProductsResponseDto> {
    const shopSnapshot = await this.shopSnapshotRepository.findByShopId(shopId);
    if (shopSnapshot && shopSnapshot.shop_status === 'SUSPENDED') {
      throw new ForbiddenException({
        code: 'PRODUCT_SHOP_SUSPENDED',
        message: 'Cửa hàng đang bị tạm ngưng hoạt động.',
      });
    }

    return this.listProducts({
      ...query,
      shop_id: shopId,
    });
  }

  /**
   * Batch hydrates a list of products in parallel, eliminating N+1 queries.
   * Performs exactly 4 batch queries/lookups:
   * 1. Shop snapshots for unique shopIds
   * 2. Active media for productIds
   * 3. Inventory projections for productIds
   * 4. Deduplicated effective tax rates for unique categoryIds
   */
  private async batchHydrateProductCards(products: ProductDocument[]): Promise<ProductCardDto[]> {
    if (!products || products.length === 0) {
      return [];
    }

    const productIds = products.map((p) => String(p._id));
    const shopIds = Array.from(new Set(products.map((p) => p.shop_id).filter(Boolean)));
    const primaryCategoryIds = Array.from(
      new Set(products.map((p) => p.primary_category_id).filter(Boolean)),
    ) as string[];

    const [shopSnapshots, mediaList, projections, taxRateEntries] = await Promise.all([
      shopIds.length > 0
        ? typeof this.shopSnapshotRepository.findByShopIds === 'function'
          ? this.shopSnapshotRepository.findByShopIds(shopIds)
          : typeof this.shopSnapshotRepository.find === 'function'
            ? this.shopSnapshotRepository.find({ shop_id: { $in: shopIds } })
            : Promise.all(shopIds.map((id) => this.shopSnapshotRepository.findByShopId(id))).then(
                (res) => res.filter(Boolean),
              )
        : Promise.resolve([]),

      productIds.length > 0
        ? typeof this.mediaRepository.findByProductIds === 'function'
          ? this.mediaRepository.findByProductIds(productIds)
          : typeof this.mediaRepository.find === 'function'
            ? this.mediaRepository.find({
                product_id: { $in: productIds },
                status: { $ne: MediaStatus.DELETED },
              })
            : Promise.all(productIds.map((id) => this.mediaRepository.findByProductId(id))).then(
                (res) => res.flat(),
              )
        : Promise.resolve([]),

      productIds.length > 0
        ? typeof this.inventoryProjectionRepository.findByProductIds === 'function'
          ? this.inventoryProjectionRepository.findByProductIds(productIds)
          : typeof this.inventoryProjectionRepository.find === 'function'
            ? this.inventoryProjectionRepository.find({ product_id: { $in: productIds } })
            : Promise.all(
                productIds.map((id) => this.inventoryProjectionRepository.findByProductId(id)),
              ).then((res) => res.flat())
        : Promise.resolve([]),

      Promise.all(
        primaryCategoryIds.map(async (catId) => {
          const rate = await this.categoryService.resolveEffectiveTaxRate(catId).catch(() => null);
          return [catId, rate] as const;
        }),
      ),
    ]);

    const shopMap = new Map<string, any>();
    for (const s of shopSnapshots || []) {
      if (s && s.shop_id) {
        shopMap.set(s.shop_id, s);
      }
    }

    const mediaMap = new Map<string, any[]>();
    for (const m of mediaList || []) {
      if (m && m.product_id) {
        const list = mediaMap.get(m.product_id) || [];
        list.push(m);
        mediaMap.set(m.product_id, list);
      }
    }

    const projectionMap = new Map<string, any[]>();
    for (const p of projections || []) {
      if (p && p.product_id) {
        const list = projectionMap.get(p.product_id) || [];
        list.push(p);
        projectionMap.set(p.product_id, list);
      }
    }

    const taxRateMap = new Map<string, number | null>(taxRateEntries);

    return products.map((product) => {
      const productId = String(product._id);
      const shopSnapshot = shopMap.get(product.shop_id);
      const shop = shopSnapshot
        ? {
            shop_id: shopSnapshot.shop_id,
            name: shopSnapshot.name,
            slug: shopSnapshot.slug,
            logo_url: shopSnapshot.logo_url ?? null,
          }
        : {
            shop_id: product.shop_id,
            name: '',
            slug: '',
            logo_url: null,
          };

      const pMedias = mediaMap.get(productId) || [];
      const readyMedia = pMedias
        .filter((m) => m.status === MediaStatus.READY)
        .sort((a, b) => {
          if (a.is_cover && !b.is_cover) return -1;
          if (!a.is_cover && b.is_cover) return 1;
          if (a.sort_order !== b.sort_order) return (a.sort_order ?? 0) - (b.sort_order ?? 0);
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });

      const coverMediaItem = readyMedia.find((m) => m.is_cover) || readyMedia[0] || null;
      const coverMedia = coverMediaItem
        ? {
            media_id: String(coverMediaItem._id),
            url: this.s3StorageService.getPublicUrl(coverMediaItem.object_key),
            content_type: coverMediaItem.content_type,
          }
        : null;

      const pProjections = projectionMap.get(productId) || [];
      let stockDisplayStatus: StockDisplayStatus = 'UNKNOWN';
      let latestAsOf: string | null = null;

      if (pProjections.length > 0) {
        const now = Date.now();
        let totalAvailable = 0;
        let hasStale = false;
        let hasLowStock = false;
        let allOutOfStock = true;

        for (const proj of pProjections) {
          const asOfDate = proj.as_of ? new Date(proj.as_of) : null;
          if (asOfDate) {
            if (!latestAsOf || asOfDate.toISOString() > latestAsOf) {
              latestAsOf = asOfDate.toISOString();
            }
            if (now - asOfDate.getTime() > 60000) {
              hasStale = true;
            }
          }

          if (proj.stock_status === 'STALE' || (proj as any).status === 'STALE') {
            hasStale = true;
          }

          const qty = Number(proj.available_qty_snapshot ?? 0);
          totalAvailable += qty;

          if (proj.stock_status !== 'OUT_OF_STOCK' && qty > 0) {
            allOutOfStock = false;
          }

          if (proj.stock_status === 'LOW_STOCK') {
            hasLowStock = true;
          }
        }

        if (hasStale) {
          stockDisplayStatus = 'STALE';
        } else if (allOutOfStock || totalAvailable === 0) {
          stockDisplayStatus = 'OUT_OF_STOCK';
        } else if (totalAvailable <= 5 || hasLowStock) {
          stockDisplayStatus = 'LOW_STOCK';
        } else {
          stockDisplayStatus = 'IN_STOCK';
        }
      }

      const taxRateBps = product.primary_category_id
        ? (taxRateMap.get(product.primary_category_id) ?? null)
        : null;

      const price = {
        base_price: Number(product.price_summary?.base_price ?? 0),
        sale_price: Number(product.price_summary?.sale_price ?? 0),
        currency: product.price_summary?.currency || 'VND',
      };

      const ratingSummary = {
        avg: product.rating_summary?.avg ?? null,
        count: product.rating_summary?.count ?? 0,
      };

      return {
        product_id: productId,
        shop,
        primary_category_id: product.primary_category_id,
        tax_rate_bps: taxRateBps,
        title: product.title,
        slug: product.slug,
        price,
        cover_media: coverMedia,
        rating_summary: ratingSummary,
        stock_display: {
          status: stockDisplayStatus,
          as_of: latestAsOf,
        },
      };
    });
  }
}
