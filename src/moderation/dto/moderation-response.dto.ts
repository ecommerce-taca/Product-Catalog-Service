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
