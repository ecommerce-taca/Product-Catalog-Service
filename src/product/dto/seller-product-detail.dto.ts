import { ProductPriceSummary, ProductStatus } from '../../database/schemas/product.schema';

export interface SkuDetailItem {
  sku_id: string;
  seller_sku: string;
  attributes: Record<string, unknown>;
  price_override: number | bigint | null;
  status: string;
}

export interface AttributeDefinitionDetailItem {
  key: string;
  label: string;
  type: string;
  is_variant_dimension: boolean;
  allowed_values?: string[];
  display_as?: string | null;
  unit?: string | null;
}

export interface MediaDetailItem {
  media_id: string;
  url: string;
  status: string;
  is_cover: boolean;
}

export interface ShopProjectionDetailItem {
  shop_id: string;
  status: string;
  kyc_status: string;
}

export class SellerProductDetailDto {
  product_id: string;
  status: ProductStatus | string;
  version: number | bigint;
  title: string;
  slug: string;
  description: string | null;
  brand: string | null;
  price_summary: ProductPriceSummary | null;
  attribute_definitions: AttributeDefinitionDetailItem[];
  skus: SkuDetailItem[];
  categories: {
    primary_category_id: string | null;
    secondary_category_ids: string[];
  };
  media: MediaDetailItem[];
  shop_projection: ShopProjectionDetailItem;
  block_reason: string | null;
}
