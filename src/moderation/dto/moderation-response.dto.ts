export interface BlockProductResponseDto {
  product_id: string;
  status: string; // 'BLOCKED'
  blocked_at: Date | string;
  version: number;
}

export interface UnblockProductResponseDto {
  product_id: string;
  status: string; // 'INACTIVE'
  next_status: string; // 'INACTIVE'
  version: number;
}

export interface PaginatedAuditsResponseDto {
  data: unknown[];
  meta: {
    page: number;
    size: number;
    total: number;
    total_pages: number;
  };
}

export interface AdminProductListItemDto {
  product_id: string;
  title: string;
  shop_id: string;
  status: string;
  category_id: string | null;
  updated_at: Date | string;
}

export interface PaginatedAdminProductsResponseDto {
  data: AdminProductListItemDto[];
  meta: {
    page: number;
    size: number;
    total: number;
    total_pages: number;
  };
}

export interface AdminProductDetailDto {
  product_id: string;
  title?: string;
  status: string;
  shop_id?: string;
  shop_projection?: {
    shop_id: string;
    status: string;
    kyc_status: string;
  } | null;
  audit_summary?: Array<{
    action: string;
    actor: string;
    occurred_at: Date | string;
  }>;
  stock_display?: {
    status: string;
    as_of: Date | string | null;
  } | null;
  block_reason?: string | null;
  version?: number;
}
