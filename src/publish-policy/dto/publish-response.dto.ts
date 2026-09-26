export interface StockDisplayDto {
  status: string;
  as_of: Date | string | null;
}

export interface PublishResponseDto {
  product_id: string;
  status: string;
  published_at: Date | string;
  version: number;
  stock_display: StockDisplayDto;
}

export interface UnpublishResponseDto {
  product_id: string;
  status: string;
  version: number;
}

export interface ArchiveResponseDto {
  product_id: string;
  status: string;
  version: number;
}
