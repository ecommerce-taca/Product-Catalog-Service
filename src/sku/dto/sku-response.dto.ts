export class SkuPriceDto {
  base_price: number;
  sale_price: number;
  currency: string;
}

export class SkuResponseDto {
  sku_id: string;
  product_id: string;
  shop_id: string;
  seller_sku: string;
  attributes: Record<string, string | number | boolean>;
  variant_key: string;
  price_override: number | null;
  price: SkuPriceDto;
  status: string;
  media_ids: string[];
  version: number;
  created_at?: Date | string;
  updated_at?: Date | string;
}
