import { ProductPriceDto, RatingSummaryDto, ShopCardDto } from './product-response.dto';

export interface AttributeItemDto {
  key: string;
  label: string;
  type: string;
  values: (string | number | boolean)[];
}

export interface SkuStockDisplayDto {
  status: string;
  available_qty_snapshot: number;
  as_of: string | null;
}

export interface SkuDetailDto {
  sku_id: string;
  seller_sku: string;
  attributes: Record<string, string | number | boolean>;
  price: ProductPriceDto;
  stock_display: SkuStockDisplayDto;
}

export interface ProductDetailMediaDto {
  media_id: string;
  url: string;
  content_type: string;
  is_cover: boolean;
  sort_order: number;
}

export class ProductDetailDto {
  product_id: string;
  status: string;
  title: string;
  slug: string;
  description: string | null;
  brand: string | null;
  shop: ShopCardDto;
  primary_category_id: string | null;
  tax_rate_bps: number | null;
  price: ProductPriceDto;
  rating_summary: RatingSummaryDto;
  attributes: AttributeItemDto[];
  skus: SkuDetailDto[];
  media: ProductDetailMediaDto[];
}
