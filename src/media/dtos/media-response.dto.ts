export class UploadUrlResponseDto {
  media_id: string;
  object_key: string;
  upload_url: string;
  expires_at: string;
  status: string;
}

export class CompleteUploadResponseDto {
  media_id: string;
  status: string;
  url: string;
}

export class ProductMediaItemDto {
  media_id: string;
  product_id: string;
  sku_id: string | null;
  scope: string;
  object_key: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  sort_order: number;
  is_cover: boolean;
  status: string;
  url: string;
  uploaded_by: string;
  created_at: Date;
  updated_at: Date;
}
