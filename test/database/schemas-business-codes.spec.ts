import mongoose from 'mongoose';
import {
  Category,
  CategorySchema,
  CATEGORY_CODE_REGEX,
} from '../../src/database/schemas/category.schema';
import {
  Product,
  ProductSchema,
  PRODUCT_CODE_REGEX,
} from '../../src/database/schemas/product.schema';
import {
  ImportJob,
  ImportJobSchema,
  ImportJobStatus,
} from '../../src/database/schemas/import-job.schema';
import { generateCategoryCode, generateProductCode } from '../../scripts/backfill-business-codes';

describe('Schemas Business Codes & Hardening Spec [PCAT-IMP-BUSINESS-CODES]', () => {
  const CategoryModel = mongoose.model<Category>('CategoryTest', CategorySchema);
  const ProductModel = mongoose.model<Product>('ProductTest', ProductSchema);
  const ImportJobModel = mongoose.model<ImportJob>('ImportJobTest', ImportJobSchema);

  describe('1. Category Schema & Business Codes', () => {
    describe('CATEGORY_CODE_REGEX', () => {
      it('should validate conforming category codes (3 to 32 chars, uppercase, digits, _, -)', () => {
        const validCodes = [
          'CAT',
          'CAT-1001',
          'CAT_1001',
          '1001',
          'ELECTRONICS',
          'FASHION_MEN_SHIRTS',
          'A'.repeat(32),
        ];

        for (const code of validCodes) {
          expect(CATEGORY_CODE_REGEX.test(code)).toBe(true);
        }
      });

      it('should reject non-conforming category codes', () => {
        const invalidCodes = [
          'CA', // < 3 chars
          'A'.repeat(33), // > 32 chars
          'cat-1001', // lowercase
          'CAT 1001', // spaces
          'CAT.1001', // dot not allowed
          'CAT#1001', // special char #
          '',
        ];

        for (const code of invalidCodes) {
          expect(CATEGORY_CODE_REGEX.test(code)).toBe(false);
        }
      });
    });

    describe('Schema property definition', () => {
      it('should have category_code defined with trim, uppercase, and default null', () => {
        const path = CategorySchema.path('category_code') as unknown as {
          instance: string;
          options: { trim?: boolean; uppercase?: boolean; default?: unknown };
        };
        expect(path).toBeDefined();
        expect(path.instance).toBe('String');
        expect(path.options.trim).toBe(true);
        expect(path.options.uppercase).toBe(true);
        expect(path.options.default).toBeNull();
      });
    });

    describe('Schema indexes', () => {
      it('should define sparse unique index idx_category_code_unique_sparse on category_code', () => {
        const indexes = CategorySchema.indexes();
        const categoryCodeIndex = indexes.find(([fields]) => fields.category_code === 1);

        expect(categoryCodeIndex).toBeDefined();
        const [fields, options] = categoryCodeIndex!;
        expect(fields).toEqual({ category_code: 1 });
        expect(options).toEqual(
          expect.objectContaining({
            unique: true,
            sparse: true,
            name: 'idx_category_code_unique_sparse',
          }),
        );
      });
    });

    describe('Document validation', () => {
      const validUuid = '018f6f5a-4b9d-7f8e-9012-3456789abcde';

      it('should allow valid category_code', async () => {
        const doc = new CategoryModel({
          _id: validUuid,
          name: 'Điện thoại',
          slug: 'dien-thoai',
          path: `/${validUuid}`,
          category_code: 'CAT-1001',
          depth: 1,
          sort_order: 1,
        });

        await expect(doc.validate()).resolves.toBeUndefined();
        expect(doc.category_code).toBe('CAT-1001');
      });

      it('should trim and uppercase category_code automatically', async () => {
        const doc = new CategoryModel({
          _id: validUuid,
          name: 'Thời trang',
          slug: 'thoi-trang',
          path: `/${validUuid}`,
          category_code: '  cat_fashion  ',
          depth: 1,
          sort_order: 1,
        });

        expect(doc.category_code).toBe('CAT_FASHION');
        await expect(doc.validate()).resolves.toBeUndefined();
      });

      it('should allow null category_code by default', async () => {
        const doc = new CategoryModel({
          _id: validUuid,
          name: 'Gia dụng',
          slug: 'gia-dung',
          path: `/${validUuid}`,
          depth: 1,
          sort_order: 1,
        });

        expect(doc.category_code).toBeNull();
        await expect(doc.validate()).resolves.toBeUndefined();
      });

      it('should reject invalid category_code', async () => {
        const doc = new CategoryModel({
          _id: validUuid,
          name: 'Gia dụng',
          slug: 'gia-dung',
          path: `/${validUuid}`,
          category_code: 'AB', // < 3 chars
          depth: 1,
          sort_order: 1,
        });

        await expect(doc.validate()).rejects.toThrow();
      });
    });
  });

  describe('2. Product Schema & Business Codes', () => {
    describe('PRODUCT_CODE_REGEX', () => {
      it('should validate conforming product codes (6 to 32 chars, uppercase, digits, _, -)', () => {
        const validCodes = [
          'PRD123',
          'PRD-8K2N9X',
          'PRD_8K2N9X',
          '123456',
          'PROD-TEST-CODE-001',
          'A'.repeat(32),
        ];

        for (const code of validCodes) {
          expect(PRODUCT_CODE_REGEX.test(code)).toBe(true);
        }
      });

      it('should reject non-conforming product codes', () => {
        const invalidCodes = [
          'PRD12', // < 6 chars
          'A'.repeat(33), // > 32 chars
          'prd-123456', // lowercase
          'PRD 123456', // spaces
          'PRD@123456', // special char @
          '',
        ];

        for (const code of invalidCodes) {
          expect(PRODUCT_CODE_REGEX.test(code)).toBe(false);
        }
      });
    });

    describe('Schema property definition', () => {
      it('should have product_code defined with trim, uppercase, and default null', () => {
        const path = ProductSchema.path('product_code') as unknown as {
          instance: string;
          options: { trim?: boolean; uppercase?: boolean; default?: unknown };
        };
        expect(path).toBeDefined();
        expect(path.instance).toBe('String');
        expect(path.options.trim).toBe(true);
        expect(path.options.uppercase).toBe(true);
        expect(path.options.default).toBeNull();
      });
    });

    describe('Schema indexes', () => {
      it('should define compound sparse unique index idx_products_shop_product_code_unique_sparse on (shop_id, product_code)', () => {
        const indexes = ProductSchema.indexes();
        const productCodeIndex = indexes.find(
          ([fields]) => fields.shop_id === 1 && fields.product_code === 1,
        );

        expect(productCodeIndex).toBeDefined();
        const [fields, options] = productCodeIndex!;
        expect(fields).toEqual({ shop_id: 1, product_code: 1 });
        expect(options).toEqual(
          expect.objectContaining({
            unique: true,
            sparse: true,
            name: 'idx_products_shop_product_code_unique_sparse',
          }),
        );
      });
    });

    describe('Document validation', () => {
      const validUuid = '018f6f5a-4b9d-7f8e-9012-3456789abcde';
      const validShopId = '018f6f5a-4b9d-7f8e-9012-3456789abcdf';

      it('should allow valid product_code', async () => {
        const doc = new ProductModel({
          _id: validUuid,
          shop_id: validShopId,
          title: 'iPhone 15 Pro Max',
          slug: 'iphone-15-pro-max',
          product_code: 'PRD-8K2N9X',
        });

        await expect(doc.validate()).resolves.toBeUndefined();
        expect(doc.product_code).toBe('PRD-8K2N9X');
      });

      it('should trim and uppercase product_code automatically', async () => {
        const doc = new ProductModel({
          _id: validUuid,
          shop_id: validShopId,
          title: 'Samsung Galaxy S24',
          slug: 'samsung-galaxy-s24',
          product_code: '  prd_galaxy_s24  ',
        });

        expect(doc.product_code).toBe('PRD_GALAXY_S24');
        await expect(doc.validate()).resolves.toBeUndefined();
      });

      it('should allow null product_code by default', async () => {
        const doc = new ProductModel({
          _id: validUuid,
          shop_id: validShopId,
          title: 'Áo Thun Nam',
          slug: 'ao-thun-nam',
        });

        expect(doc.product_code).toBeNull();
        await expect(doc.validate()).resolves.toBeUndefined();
      });

      it('should reject invalid product_code', async () => {
        const doc = new ProductModel({
          _id: validUuid,
          shop_id: validShopId,
          title: 'Áo Thun Nam',
          slug: 'ao-thun-nam',
          product_code: 'SHORT', // 5 chars, < 6
        });

        await expect(doc.validate()).rejects.toThrow();
      });
    });
  });

  describe('3. ImportJob Schema & Active Job Partial Unique Index [B-DB-03 / SF-ARCH-03]', () => {
    describe('Schema indexes', () => {
      it('should define partial unique index idx_import_jobs_active_shop_unique on shop_id where status is PENDING or PROCESSING', () => {
        const indexes = ImportJobSchema.indexes();
        const activeShopIndex = indexes.find(
          ([fields, opts]) =>
            fields.shop_id === 1 && opts?.name === 'idx_import_jobs_active_shop_unique',
        );

        expect(activeShopIndex).toBeDefined();
        const [fields, options] = activeShopIndex!;
        expect(fields).toEqual({ shop_id: 1 });
        expect(options).toEqual(
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { status: { $in: ['PENDING', 'PROCESSING'] } },
            name: 'idx_import_jobs_active_shop_unique',
          }),
        );
      });
    });

    describe('category_id validation with business code support', () => {
      const validUuid = '018f6f5a-4b9d-7f8e-9012-3456789abcde';
      const validShopId = '018f6f5a-4b9d-7f8e-9012-3456789abcdf';
      const validUserId = '018f6f5a-4b9d-7f8e-9012-3456789abcd0';

      it('should accept valid UUIDv7 for category_id', async () => {
        const job = new ImportJobModel({
          _id: validUuid,
          shop_id: validShopId,
          actor_user_id: validUserId,
          file_url: 'https://storage.example.com/import.xlsx',
          category_id: '018f6f5a-4b9d-7f8e-9012-3456789abcd1',
          status: ImportJobStatus.PENDING,
        });

        await expect(job.validate()).resolves.toBeUndefined();
      });

      it('should accept valid category_code for category_id', async () => {
        const job = new ImportJobModel({
          _id: validUuid,
          shop_id: validShopId,
          actor_user_id: validUserId,
          file_url: 'https://storage.example.com/import.xlsx',
          category_id: 'CAT-1001',
          status: ImportJobStatus.PENDING,
        });

        await expect(job.validate()).resolves.toBeUndefined();
      });

      it('should accept null or undefined category_id', async () => {
        const job = new ImportJobModel({
          _id: validUuid,
          shop_id: validShopId,
          actor_user_id: validUserId,
          file_url: 'https://storage.example.com/import.xlsx',
          category_id: null,
          status: ImportJobStatus.PENDING,
        });

        await expect(job.validate()).resolves.toBeUndefined();
      });

      it('should reject malformed category_id', async () => {
        const job = new ImportJobModel({
          _id: validUuid,
          shop_id: validShopId,
          actor_user_id: validUserId,
          file_url: 'https://storage.example.com/import.xlsx',
          category_id: 'invalid-pattern!!@@',
          status: ImportJobStatus.PENDING,
        });

        await expect(job.validate()).rejects.toThrow();
      });
    });
  });

  describe('4. Backfill Generator Helpers', () => {
    describe('generateCategoryCode', () => {
      it('should generate valid code from slug and handle collisions', () => {
        const existingCodes = new Set<string>();
        const code1 = generateCategoryCode('dien-thoai', existingCodes);
        expect(code1).toBe('CAT_DIEN_THOAI');
        expect(CATEGORY_CODE_REGEX.test(code1)).toBe(true);

        const code2 = generateCategoryCode('dien-thoai', existingCodes);
        expect(code2).toBe('CAT_DIEN_THOAI_1');
        expect(CATEGORY_CODE_REGEX.test(code2)).toBe(true);

        const code3 = generateCategoryCode('dien-thoai', existingCodes);
        expect(code3).toBe('CAT_DIEN_THOAI_2');
        expect(CATEGORY_CODE_REGEX.test(code3)).toBe(true);
      });

      it('should handle short or empty slugs with fallback', () => {
        const existingCodes = new Set<string>();
        const code = generateCategoryCode(
          '',
          existingCodes,
          '018f6f5a-4b9d-7f8e-9012-3456789abcde',
        );
        expect(code.startsWith('CAT_018F6F5A')).toBe(true);
        expect(CATEGORY_CODE_REGEX.test(code)).toBe(true);
      });
    });

    describe('generateProductCode', () => {
      it('should generate valid product code conforming to PRODUCT_CODE_REGEX', () => {
        const existingCodes = new Set<string>();
        const code = generateProductCode(existingCodes);

        expect(code.startsWith('PRD_')).toBe(true);
        expect(code.length).toBeGreaterThanOrEqual(6);
        expect(code.length).toBeLessThanOrEqual(32);
        expect(PRODUCT_CODE_REGEX.test(code)).toBe(true);
        expect(existingCodes.has(code)).toBe(true);
      });

      it('should generate unique codes without collision', () => {
        const existingCodes = new Set<string>();
        const count = 50;
        for (let i = 0; i < count; i++) {
          generateProductCode(existingCodes);
        }
        expect(existingCodes.size).toBe(count);
      });
    });
  });
});
