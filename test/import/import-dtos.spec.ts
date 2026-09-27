import { validate } from 'class-validator';
import { ImportTemplateQueryDto } from '../../src/import/dto/import-template-query.dto';
import { ImportJobResponseDto } from '../../src/import/dto/import-job-response.dto';
import { ImportJobStatus, ImportJobDocument } from '../../src/database/schemas/import-job.schema';

describe('Import DTOs', () => {
  describe('ImportTemplateQueryDto', () => {
    it('should validate valid UUID category_id', async () => {
      const dto = new ImportTemplateQueryDto();
      dto.category_id = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';

      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should allow optional category_id when not provided', async () => {
      const dto = new ImportTemplateQueryDto();

      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should reject invalid UUID category_id', async () => {
      const dto = new ImportTemplateQueryDto();
      dto.category_id = 'invalid-uuid';

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.isUuid).toBeDefined();
    });
  });

  describe('ImportJobResponseDto', () => {
    it('should correctly transform ImportJobDocument to response DTO', () => {
      const now = new Date('2026-09-26T12:00:00.000Z');
      const mockDoc = {
        _id: '01912f70-7a1b-7c12-9c55-8b1c34a6d921',
        shop_id: '01912f30-7a1b-7c12-9c55-8b1c34a6d920',
        actor_user_id: '01912f10-7a1b-7c12-9c55-8b1c34a6d922',
        status: ImportJobStatus.PROCESSING,
        file_url: 's3://bucket/input.xlsx',
        total_rows: 100,
        processed_rows: 50,
        success_count: 45,
        error_count: 5,
        started_at: now,
        completed_at: null,
        created_at: now,
        updated_at: now,
        error_summary: [
          {
            row_index: 2,
            product_ref_id: 'REF-01',
            seller_sku: 'SKU-01',
            error_code: 'PRODUCT_SKU_DUPLICATE',
            error_message: 'Mã SKU đã tồn tại',
          },
        ],
      } as unknown as ImportJobDocument;

      const response = ImportJobResponseDto.fromDocument(mockDoc);

      expect(response.job_id).toBe('01912f70-7a1b-7c12-9c55-8b1c34a6d921');
      expect(response.status).toBe(ImportJobStatus.PROCESSING);
      expect(response.total_rows).toBe(100);
      expect(response.processed_rows).toBe(50);
      expect(response.success_count).toBe(45);
      expect(response.error_count).toBe(5);
      expect(response.started_at).toBe(now.toISOString());
      expect(response.completed_at).toBeNull();
      expect(response.error_summary).toHaveLength(1);
      expect(response.error_summary![0].error_code).toBe('PRODUCT_SKU_DUPLICATE');
    });
  });
});
