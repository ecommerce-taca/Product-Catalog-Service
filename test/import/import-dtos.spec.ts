import 'reflect-metadata';
import { validate } from 'class-validator';
import {
  GenerateCustomTemplateDto,
  TemplateLayoutMode,
} from '../../src/import/dto/generate-custom-template.dto';
import { ImportJobResponseDto } from '../../src/import/dto/import-job-response.dto';
import { ImportJobStatus, ImportJobDocument } from '../../src/database/schemas/import-job.schema';

describe('Import DTOs', () => {
  describe('GenerateCustomTemplateDto', () => {
    it('should validate empty DTO successfully', async () => {
      const dto = new GenerateCustomTemplateDto();

      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should validate valid customized options', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.row_count = 50;
      dto.category_ids = ['01912f30-7a1b-7c12-9c55-8b1c34a6d920'];
      dto.product_ids = ['01912f30-7a1b-7c12-9c55-8b1c34a6d921'];
      dto.layout_mode = TemplateLayoutMode.MULTI_SHEET;

      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should reject row_count less than 5', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.row_count = 4;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.min).toBeDefined();
    });

    it('should reject row_count greater than 200', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.row_count = 201;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.max).toBeDefined();
    });

    it('should validate valid business codes in category_ids and product_ids', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.category_ids = ['CAT-1001', 'CAT_THOITRANG', '01912f30-7a1b-7c12-9c55-8b1c34a6d920'];
      dto.product_ids = ['PRD-8K2N9X', '01912f30-7a1b-7c12-9c55-8b1c34a6d921'];

      const errors = await validate(dto);
      expect(errors.length).toBe(0);
    });

    it('should reject invalid format in category_ids', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.category_ids = ['invalid@code!'];

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.matches).toBeDefined();
    });

    it('should reject invalid format in product_ids', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.product_ids = ['invalid code with spaces'];

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.matches).toBeDefined();
    });

    it('should reject invalid layout_mode', async () => {
      const dto = new GenerateCustomTemplateDto();
      dto.layout_mode = 'INVALID_MODE' as unknown as TemplateLayoutMode;

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].constraints?.isEnum).toBeDefined();
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
