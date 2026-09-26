export interface ShopCardDto {
  shop_id: string;
  name: string;
  slug: string;
  logo_url: string | null;
}

export interface ProductPriceDto {
  base_price: number;
  sale_price: number;
  currency: string;
}

export interface CoverMediaDto {
  media_id: string;
  url: string;
  content_type: string;
}

export interface RatingSummaryDto {
  avg: number | null;
  count: number;
}

export type StockDisplayStatus = 'IN_STOCK' | 'LOW_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN' | 'STALE';

export interface StockDisplayDto {
  status: StockDisplayStatus;
  as_of?: string | null;
}

export class ProductCardDto {
  product_id: string;
  shop: ShopCardDto;
  primary_category_id: string | null;
  tax_rate_bps: number | null;
  title: string;
  slug: string;
  price: ProductPriceDto;
  cover_media: CoverMediaDto | null;
  rating_summary: RatingSummaryDto;
  stock_display: StockDisplayDto;
}

export class PaginatedProductsResponseDto {
  data: ProductCardDto[];
  meta: {
    page: number;
    size: number;
    total: number;
    total_pages: number;
    request_id?: string;
    as_of?: string;
  };
}
