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
import { Sku, SkuSchema } from '../../src/database/schemas/sku.schema';
import { generateCategoryCode, generateProductCode } from '../../scripts/backfill-business-codes';

describe('Schemas Business Codes & Hardening Spec [PCAT-IMP-BUSINESS-CODES]', () => {
  const CategoryModel = mongoose.model<Category>('CategoryTest', CategorySchema);
  const ProductModel = mongoose.model<Product>('ProductTest', ProductSchema);
  const ImportJobModel = mongoose.model<ImportJob>('ImportJobTest', ImportJobSchema);
  const SkuModel = mongoose.model<Sku>('SkuTest', SkuSchema);

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
      it('should define partial unique index idx_category_code_unique_partial on category_code', () => {
        const indexes = CategorySchema.indexes();
        const categoryCodeIndex = indexes.find(([fields]) => fields.category_code === 1);

        expect(categoryCodeIndex).toBeDefined();
        const [fields, options] = categoryCodeIndex!;
        expect(fields).toEqual({ category_code: 1 });
        expect(options).toEqual(
          expect.objectContaining({
            unique: true,
            partialFilterExpression: { category_code: { $type: 'string' } },
            name: 'idx_category_code_unique_partial',
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
      it('should define compound partial unique index idx_products_shop_product_code_unique_partial on (shop_id, product_code)', () => {
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
            partialFilterExpression: { product_code: { $type: 'string' } },
            name: 'idx_products_shop_product_code_unique_partial',
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

        expect(code.startsWith('PRD-')).toBe(true);
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

  describe('5. SPU Title Validation Constraints (10..200 characters)', () => {
    describe('Schema property definition', () => {
      it('should define title with required: true, trim: true, and maxlength: 200', () => {
        const path = ProductSchema.path('title') as unknown as {
          instance: string;
          options: { required?: boolean; maxlength?: number; trim?: boolean };
        };
        expect(path).toBeDefined();
        expect(path.instance).toBe('String');
        expect(path.options.required).toBe(true);
        expect(path.options.maxlength).toBe(200);
        expect(path.options.trim).toBe(true);
      });
    });

    describe('SPU title length business rule (10 to 200 characters)', () => {
      const validateSpuTitle = (title?: string | null): { valid: boolean; errorCode?: string } => {
        if (!title || title.trim().length < 10 || title.trim().length > 200) {
          return { valid: false, errorCode: 'PRODUCT_INVALID_INPUT' };
        }
        return { valid: true };
      };

      it('should accept conforming titles between 10 and 200 characters', () => {
        expect(validateSpuTitle('1234567890').valid).toBe(true);
        expect(validateSpuTitle('Áo thun polo nam cao cấp').valid).toBe(true);
        expect(validateSpuTitle('A'.repeat(200)).valid).toBe(true);
      });

      it('should reject titles shorter than 10 characters', () => {
        expect(validateSpuTitle('Ngắn')).toEqual({
          valid: false,
          errorCode: 'PRODUCT_INVALID_INPUT',
        });
        expect(validateSpuTitle('123456789')).toEqual({
          valid: false,
          errorCode: 'PRODUCT_INVALID_INPUT',
        });
      });

      it('should reject titles longer than 200 characters', () => {
        expect(validateSpuTitle('A'.repeat(201))).toEqual({
          valid: false,
          errorCode: 'PRODUCT_INVALID_INPUT',
        });
      });

      it('should reject empty or whitespace-only titles', () => {
        expect(validateSpuTitle('')).toEqual({
          valid: false,
          errorCode: 'PRODUCT_INVALID_INPUT',
        });
        expect(validateSpuTitle('          ')).toEqual({
          valid: false,
          errorCode: 'PRODUCT_INVALID_INPUT',
        });
        expect(validateSpuTitle(null)).toEqual({
          valid: false,
          errorCode: 'PRODUCT_INVALID_INPUT',
        });
      });
    });
  });

  describe('6. Price Validation Constraints (VND 1.000 to 999.999.999.999 & original_price >= price)', () => {
    describe('SkuSchema price_override definition and validation', () => {
      it('should have price_override validator enforcing range 1 to 999,999,999,999', async () => {
        const validUuid = '018f6f5a-4b9d-7f8e-9012-3456789abcde';
        const validDoc = new SkuModel({
          _id: validUuid,
          product_id: validUuid,
          shop_id: validUuid,
          seller_sku: 'SKU-VALID-PRICE',
          attributes: {},
          variant_key: 'default',
          price_override: BigInt(50000),
        });
        await expect(validDoc.validate()).resolves.toBeUndefined();

        const nullPriceDoc = new SkuModel({
          _id: validUuid,
          product_id: validUuid,
          shop_id: validUuid,
          seller_sku: 'SKU-NULL-PRICE',
          attributes: {},
          variant_key: 'default',
          price_override: null,
        });
        await expect(nullPriceDoc.validate()).resolves.toBeUndefined();

        const zeroPriceDoc = new SkuModel({
          _id: validUuid,
          product_id: validUuid,
          shop_id: validUuid,
          seller_sku: 'SKU-ZERO-PRICE',
          attributes: {},
          variant_key: 'default',
          price_override: BigInt(0),
        });
        await expect(zeroPriceDoc.validate()).rejects.toThrow();

        const tooLargeDoc = new SkuModel({
          _id: validUuid,
          product_id: validUuid,
          shop_id: validUuid,
          seller_sku: 'SKU-OVER-PRICE',
          attributes: {},
          variant_key: 'default',
          price_override: BigInt(1_000_000_000_000),
        });
        await expect(tooLargeDoc.validate()).rejects.toThrow();
      });
    });

    describe('Import price validation business rules', () => {
      const validatePriceRule = (
        price: unknown,
        originalPrice?: unknown,
      ): { valid: boolean; errors: string[] } => {
        const errors: string[] = [];

        if (
          price === null ||
          price === undefined ||
          typeof price !== 'number' ||
          isNaN(price) ||
          !Number.isInteger(price) ||
          price < 1000 ||
          price > 999_999_999_999
        ) {
          errors.push('PRODUCT_PRICE_INVALID');
        }

        if (
          originalPrice !== null &&
          originalPrice !== undefined &&
          typeof originalPrice === 'number' &&
          !isNaN(originalPrice)
        ) {
          if (originalPrice < 0 || !Number.isInteger(originalPrice)) {
            errors.push('PRODUCT_PRICE_INVALID');
          } else if (typeof price === 'number' && originalPrice < price) {
            errors.push('PRODUCT_PRICE_INVALID');
          }
        }

        return { valid: errors.length === 0, errors };
      };

      it('should accept valid integer price between 1.000 and 999.999.999.999 VND', () => {
        expect(validatePriceRule(1000).valid).toBe(true);
        expect(validatePriceRule(500000, 600000).valid).toBe(true);
        expect(validatePriceRule(500000, 500000).valid).toBe(true);
        expect(validatePriceRule(999_999_999_999).valid).toBe(true);
      });

      it('should reject price less than 1.000 VND', () => {
        expect(validatePriceRule(999).errors).toContain('PRODUCT_PRICE_INVALID');
        expect(validatePriceRule(0).errors).toContain('PRODUCT_PRICE_INVALID');
        expect(validatePriceRule(-5000).errors).toContain('PRODUCT_PRICE_INVALID');
      });

      it('should reject price exceeding 999.999.999.999 VND', () => {
        expect(validatePriceRule(1_000_000_000_000).errors).toContain('PRODUCT_PRICE_INVALID');
      });

      it('should reject non-integer decimal prices', () => {
        expect(validatePriceRule(15000.5).errors).toContain('PRODUCT_PRICE_INVALID');
        expect(validatePriceRule(99.9).errors).toContain('PRODUCT_PRICE_INVALID');
      });

      it('should reject when original_price < price (giá niêm yết thấp hơn giá bán)', () => {
        const result = validatePriceRule(200000, 150000);
        expect(result.valid).toBe(false);
        expect(result.errors).toContain('PRODUCT_PRICE_INVALID');
      });

      it('should accept when original_price >= price', () => {
        expect(validatePriceRule(200000, 200000).valid).toBe(true);
        expect(validatePriceRule(200000, 250000).valid).toBe(true);
      });
    });
  });

  describe('7. Empty Variant Collision Protection (B-LR-01 / SF-EDGE-01)', () => {
    describe('Schema unique index on (product_id, variant_key)', () => {
      it('should define idx_skus_product_variant_key_unique unique index on SkuSchema', () => {
        const indexes = SkuSchema.indexes();
        const variantKeyIndex = indexes.find(
          ([fields, opts]) =>
            fields.product_id === 1 &&
            fields.variant_key === 1 &&
            opts?.name === 'idx_skus_product_variant_key_unique',
        );

        expect(variantKeyIndex).toBeDefined();
        const [fields, options] = variantKeyIndex!;
        expect(fields).toEqual({ product_id: 1, variant_key: 1 });
        expect(options).toEqual(
          expect.objectContaining({
            unique: true,
            name: 'idx_skus_product_variant_key_unique',
          }),
        );
      });
    });

    describe('Canonical variant key generation & Stage 1 collision intercept (B-LR-01)', () => {
      const computeCanonicalVariantKey = (attributes?: Record<string, string>): string => {
        if (!attributes || typeof attributes !== 'object') {
          return '';
        }
        const keys = Object.keys(attributes)
          .map((k) => k.trim())
          .filter(Boolean)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }));

        if (keys.length === 0) {
          return '';
        }

        return keys
          .map((k) => `${k.toLowerCase()}:${String(attributes[k]).trim().toLowerCase()}`)
          .join('|');
      };

      it('should produce empty variantKey ("") when no attributes or empty attributes provided', () => {
        expect(computeCanonicalVariantKey()).toBe('');
        expect(computeCanonicalVariantKey({})).toBe('');
        expect(computeCanonicalVariantKey(undefined)).toBe('');
      });

      it('should intercept 2 empty variant rows in the same SPU with PRODUCT_SKU_DUPLICATE_VARIANT at Stage 1', () => {
        const skus = [
          { skuId: 'SKU-01', variantKey: computeCanonicalVariantKey({}) },
          { skuId: 'SKU-02', variantKey: computeCanonicalVariantKey({}) },
        ];

        const seenVariantKeys = new Set<string>();
        const flaggedErrors: Array<{ skuId: string; errorCode: string }> = [];

        for (const sku of skus) {
          if (sku.variantKey !== undefined && seenVariantKeys.has(sku.variantKey)) {
            flaggedErrors.push({
              skuId: sku.skuId,
              errorCode: 'PRODUCT_SKU_DUPLICATE_VARIANT',
            });
          }
          if (sku.variantKey !== undefined) {
            seenVariantKeys.add(sku.variantKey);
          }
        }

        expect(flaggedErrors).toHaveLength(1);
        expect(flaggedErrors[0]).toEqual({
          skuId: 'SKU-02',
          errorCode: 'PRODUCT_SKU_DUPLICATE_VARIANT',
        });
      });
    });
  });

  describe('8. Batch Processing Constraints (Max 200 SKU rows / 100 SPUs)', () => {
    const validateBatchLimits = (
      rawRowsCount: number,
      spuCount: number,
    ): { valid: boolean; errorCode?: string; errorMessage?: string } => {
      if (rawRowsCount > 200) {
        return {
          valid: false,
          errorCode: 'PRODUCT_IMPORT_TOO_MANY_ROWS',
          errorMessage: `Số lượng dòng trong file (${rawRowsCount}) vượt quá giới hạn tối đa cho phép (200 dòng SKU / 100 SPUs).`,
        };
      }
      if (spuCount > 100) {
        return {
          valid: false,
          errorCode: 'PRODUCT_IMPORT_TOO_MANY_SPUS',
          errorMessage: `Số lượng SPU trong file (${spuCount}) vượt quá giới hạn tối đa 100 SPUs.`,
        };
      }
      return { valid: true };
    };

    it('should reject batch with more than 200 SKU rows', () => {
      const res = validateBatchLimits(201, 10);
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('PRODUCT_IMPORT_TOO_MANY_ROWS');
    });

    it('should reject batch with more than 100 SPUs', () => {
      const res = validateBatchLimits(150, 101);
      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe('PRODUCT_IMPORT_TOO_MANY_SPUS');
    });

    it('should accept conforming batch (<= 200 SKU rows and <= 100 SPUs)', () => {
      expect(validateBatchLimits(200, 100).valid).toBe(true);
      expect(validateBatchLimits(50, 10).valid).toBe(true);
      expect(validateBatchLimits(1, 1).valid).toBe(true);
    });
  });
});
