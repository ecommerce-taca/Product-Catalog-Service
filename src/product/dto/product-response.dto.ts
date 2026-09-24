import { ProductPriceSummary, ProductStatus } from '../../database/schemas/product.schema';

export class CreateProductResponseDto {
  product_id: string;
  shop_id: string;
  status: ProductStatus | string;
  version: number | bigint;
}

export class SellerProductListItemDto {
  product_id: string;
  title: string;
  slug: string;
  status: ProductStatus | string;
  primary_category_id: string | null;
  price_summary: ProductPriceSummary | null;
  sku_count: number;
  cover_media: { media_id: string; url: string } | null;
  updated_at: Date | string;
}

export class PaginatedSellerProductsDto {
  data: SellerProductListItemDto[];
  meta: {
    page: number;
    size: number;
    total: number;
    total_pages: number;
  };
}

export class UpdateProductResponseDto {
  product_id: string;
  shop_id: string;
  status: ProductStatus | string;
  version: number | bigint;
  title: string;
  slug: string;
  price_summary: ProductPriceSummary | null;
  updated_at: Date | string;
}

export class AssignCategoriesResponseDto {
  product_id: string;
  primary_category_id: string;
  secondary_category_ids: string[];
  version: number | bigint;
}
