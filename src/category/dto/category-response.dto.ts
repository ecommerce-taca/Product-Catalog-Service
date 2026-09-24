export interface CategoryResponseDto {
  category_id: string;
  name: string;
  slug: string;
  parent_id: string | null;
  path: string;
  depth: number;
  status: string;
  sort_order: number;
  tax_rate_bps: number | null;
  version: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface CategoryTreeNodeDto {
  category_id: string;
  name: string;
  slug: string;
  path: string;
  depth: number;
  tax_rate_bps: number | null;
  children: CategoryTreeNodeDto[];
}
