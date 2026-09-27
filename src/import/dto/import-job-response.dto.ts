import { ImportJobDocument, ImportJobStatus } from '../../database/schemas/import-job.schema';

export class ImportErrorSummaryItemDto {
  row_index: number;
  product_ref_id: string;
  seller_sku?: string;
  error_code: string;
  error_message: string;
}

export class ImportJobCreatedResponseDto {
  job_id: string;
  status: ImportJobStatus | string;
  message?: string;
  total_rows?: number | null;
  created_at?: Date | string;
}

export class ImportJobResponseDto {
  job_id: string;
  status: ImportJobStatus | string;
  total_rows: number | null;
  processed_rows: number;
  success_count: number;
  error_count: number;
  started_at?: Date | string | null;
  completed_at?: Date | string | null;
  created_at: Date | string;
  updated_at?: Date | string;
  error_summary?: ImportErrorSummaryItemDto[];

  static fromDocument(doc: ImportJobDocument): ImportJobResponseDto {
    return {
      job_id: doc._id || (doc as unknown as { job_id: string }).job_id,
      status: doc.status,
      total_rows: doc.total_rows ?? null,
      processed_rows: doc.processed_rows ?? 0,
      success_count: doc.success_count ?? 0,
      error_count: doc.error_count ?? 0,
      started_at: doc.started_at ? doc.started_at.toISOString() : null,
      completed_at: doc.completed_at ? doc.completed_at.toISOString() : null,
      created_at: doc.created_at ? doc.created_at.toISOString() : new Date().toISOString(),
      updated_at: doc.updated_at ? doc.updated_at.toISOString() : undefined,
      error_summary: doc.error_summary?.map((err) => ({
        row_index: err.row_index,
        product_ref_id: err.product_ref_id,
        seller_sku: err.seller_sku,
        error_code: err.error_code,
        error_message: err.error_message,
      })),
    };
  }
}

export class ImportJobResultResponseDto {
  job_id: string;
  result_file_url: string;
  total_rows: number;
  success_count: number;
  error_count: number;
  expires_at: Date | string;
}
