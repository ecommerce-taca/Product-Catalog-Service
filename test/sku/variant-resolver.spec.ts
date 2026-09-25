import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  VariantResolver,
  AttributeDefinitionLike,
} from '../../src/sku/services/variant-resolver.service';
import {
  AttributeDisplayAs,
  AttributeType,
} from '../../src/database/schemas/attribute-definition.schema';

describe('VariantResolver', () => {
  let resolver: VariantResolver;

  beforeEach(() => {
    resolver = new VariantResolver();
  });

  describe('validateAndCanonicalize', () => {
    const definitions: AttributeDefinitionLike[] = [
      {
        key: 'material',
        label: 'Chất liệu',
        type: AttributeType.STRING,
        is_variant_dimension: true,
      },
      {
        key: 'color',
        label: 'Màu sắc',
        type: AttributeType.ENUM,
        is_variant_dimension: true,
        allowed_values: ['black', 'white', 'red'],
      },
      {
        key: 'size',
        label: 'Kích cỡ',
        type: AttributeType.ENUM,
        is_variant_dimension: true,
        allowed_values: ['S', 'M', 'L', 'XL'],
      },
      {
        key: 'capacity_liter',
        label: 'Dung tích',
        type: AttributeType.NUMBER,
        is_variant_dimension: true,
        unit: 'L',
      },
      {
        key: 'is_insulated',
        label: 'Cách nhiệt',
        type: AttributeType.BOOLEAN,
        is_variant_dimension: true,
      },
      {
        key: 'origin',
        label: 'Xuất xứ',
        type: AttributeType.STRING,
        is_variant_dimension: false, // Non-variant attribute
      },
    ];

    it('should correctly validate and canonicalize variant_key with sorted Unicode code points and canonical formats', () => {
      const attributes = {
        size: 'M',
        color: 'black',
        material: '  cotton  ',
        capacity_liter: 2.0,
        is_insulated: true,
        origin: 'Vietnam',
      };

      const result = resolver.validateAndCanonicalize(attributes, definitions);

      expect(result.canonicalAttributes).toEqual({
        size: 'M',
        color: 'black',
        material: 'cotton',
        capacity_liter: 2,
        is_insulated: true,
        origin: 'Vietnam',
      });

      // Keys in variant dimensions: capacity_liter, color, is_insulated, material, size
      // Sorted by Unicode code points:
      // 'capacity_liter' < 'color' < 'is_insulated' < 'material' < 'size'
      expect(result.variantKey).toBe(
        'capacity_liter=2|color=black|is_insulated=true|material=cotton|size=M',
      );
    });

    it('should format decimal number canonically and prevent float drift', () => {
      const defs: AttributeDefinitionLike[] = [
        {
          key: 'weight_kg',
          type: AttributeType.NUMBER,
          is_variant_dimension: true,
        },
      ];

      // Test integer, decimal, and float drift (0.1 + 0.2 = 0.30000000000000004)
      const res1 = resolver.validateAndCanonicalize({ weight_kg: 5.0 }, defs);
      expect(res1.variantKey).toBe('weight_kg=5');

      const res2 = resolver.validateAndCanonicalize({ weight_kg: 0.1 + 0.2 }, defs);
      expect(res2.variantKey).toBe('weight_kg=0.3');
    });

    it('should exclude non-variant dimensions from variant_key', () => {
      const defs: AttributeDefinitionLike[] = [
        {
          key: 'color',
          type: AttributeType.STRING,
          is_variant_dimension: true,
        },
        {
          key: 'description_note',
          type: AttributeType.STRING,
          is_variant_dimension: false,
        },
      ];

      const result = resolver.validateAndCanonicalize(
        { color: 'blue', description_note: 'extra info' },
        defs,
      );

      expect(result.variantKey).toBe('color=blue');
      expect(result.canonicalAttributes.description_note).toBe('extra info');
    });

    it('should return empty string variant_key if there are no variant dimensions', () => {
      const defs: AttributeDefinitionLike[] = [
        {
          key: 'note',
          type: AttributeType.STRING,
          is_variant_dimension: false,
        },
      ];

      const result = resolver.validateAndCanonicalize({ note: 'simple' }, defs);
      expect(result.variantKey).toBe('');
    });

    it('should throw BadRequestException (PRODUCT_ATTRIBUTE_INVALID) when attribute key is unknown', () => {
      const defs: AttributeDefinitionLike[] = [
        { key: 'color', type: AttributeType.STRING, is_variant_dimension: true },
      ];

      try {
        resolver.validateAndCanonicalize({ unknown_key: 'val' }, defs);
        fail('Expected error not thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = (err as BadRequestException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_ATTRIBUTE_INVALID');
      }
    });

    it('should throw BadRequestException (PRODUCT_ATTRIBUTE_INVALID) when a variant dimension is missing', () => {
      const defs: AttributeDefinitionLike[] = [
        { key: 'color', type: AttributeType.STRING, is_variant_dimension: true },
        { key: 'size', type: AttributeType.STRING, is_variant_dimension: true },
      ];

      try {
        resolver.validateAndCanonicalize({ color: 'red' }, defs);
        fail('Expected error not thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = (err as BadRequestException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_ATTRIBUTE_INVALID');
      }
    });

    it('should throw BadRequestException (PRODUCT_ATTRIBUTE_INVALID) when STRING is empty or not string', () => {
      const defs: AttributeDefinitionLike[] = [
        { key: 'title', type: AttributeType.STRING, is_variant_dimension: true },
      ];

      expect(() =>
        resolver.validateAndCanonicalize({ title: 123 as unknown as string }, defs),
      ).toThrow(BadRequestException);
      expect(() => resolver.validateAndCanonicalize({ title: '   ' }, defs)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException (PRODUCT_ATTRIBUTE_INVALID) when NUMBER is invalid or NaN', () => {
      const defs: AttributeDefinitionLike[] = [
        { key: 'weight', type: AttributeType.NUMBER, is_variant_dimension: true },
      ];

      expect(() =>
        resolver.validateAndCanonicalize({ weight: '123' as unknown as number }, defs),
      ).toThrow(BadRequestException);
      expect(() => resolver.validateAndCanonicalize({ weight: NaN }, defs)).toThrow(
        BadRequestException,
      );
      expect(() => resolver.validateAndCanonicalize({ weight: Infinity }, defs)).toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException (PRODUCT_ATTRIBUTE_INVALID) when BOOLEAN is not boolean', () => {
      const defs: AttributeDefinitionLike[] = [
        { key: 'waterproof', type: AttributeType.BOOLEAN, is_variant_dimension: true },
      ];

      expect(() =>
        resolver.validateAndCanonicalize({ waterproof: 'true' as unknown as boolean }, defs),
      ).toThrow(BadRequestException);
    });

    it('should throw BadRequestException (PRODUCT_ATTRIBUTE_INVALID) when ENUM value is not in allowed_values', () => {
      const defs: AttributeDefinitionLike[] = [
        {
          key: 'color',
          type: AttributeType.ENUM,
          allowed_values: ['black', 'white'],
          is_variant_dimension: true,
        },
      ];

      try {
        resolver.validateAndCanonicalize({ color: 'yellow' }, defs);
        fail('Expected error not thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestException);
        const res = (err as BadRequestException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_ATTRIBUTE_INVALID');
      }
    });

    it('PC-API-019b: display_as and value_meta should not alter variant_key', () => {
      const defsWithMeta: AttributeDefinitionLike[] = [
        {
          key: 'color',
          label: 'Màu sắc',
          type: AttributeType.ENUM,
          is_variant_dimension: true,
          allowed_values: ['red', 'blue'],
          display_as: AttributeDisplayAs.COLOR_SWATCH,
          value_meta: {
            red: { swatch_hex: '#FF0000' },
            blue: { swatch_hex: '#0000FF' },
          },
        },
      ];

      const resWithMeta = resolver.validateAndCanonicalize({ color: 'red' }, defsWithMeta);

      const defsPlain: AttributeDefinitionLike[] = [
        {
          key: 'color',
          label: 'Màu sắc',
          type: AttributeType.ENUM,
          is_variant_dimension: true,
          allowed_values: ['red', 'blue'],
        },
      ];

      const resPlain = resolver.validateAndCanonicalize({ color: 'red' }, defsPlain);

      expect(resWithMeta.variantKey).toBe(resPlain.variantKey);
      expect(resWithMeta.variantKey).toBe('color=red');
    });

    it('should properly escape special characters (\\, |, =) in attribute values', () => {
      const defs: AttributeDefinitionLike[] = [
        {
          key: 'model',
          label: 'Model',
          type: AttributeType.STRING,
          is_variant_dimension: true,
        },
        {
          key: 'size',
          label: 'Kích cỡ',
          type: AttributeType.STRING,
          is_variant_dimension: true,
        },
      ];

      const attributes = {
        model: 'A|B=C\\D',
        size: 'M|L',
      };

      const result = resolver.validateAndCanonicalize(attributes, defs);

      expect(result.variantKey).toBe('model=A\\|B\\=C\\\\D|size=M\\|L');
    });
  });

  describe('detectDuplicates', () => {
    it('should not throw when all variant keys and seller_skus are distinct', () => {
      const skus = [
        { variant_key: 'color=black|size=M', seller_sku: 'SKU-001' },
        { variant_key: 'color=black|size=L', seller_sku: 'SKU-002' },
        { variant_key: 'color=white|size=M', seller_sku: 'SKU-003' },
      ];

      expect(() => resolver.detectDuplicates(skus)).not.toThrow();
    });

    it('should throw ConflictException (PRODUCT_SKU_DUPLICATE) on duplicate variant_key', () => {
      const skus = [
        { variant_key: 'color=black|size=M', seller_sku: 'SKU-001' },
        { variant_key: 'color=black|size=M', seller_sku: 'SKU-002' },
      ];

      try {
        resolver.detectDuplicates(skus);
        fail('Expected conflict not thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_SKU_DUPLICATE');
      }
    });

    it('should throw ConflictException (PRODUCT_SKU_DUPLICATE) on duplicate seller_sku in batch', () => {
      const skus = [
        { variant_key: 'color=black|size=M', seller_sku: 'SKU-001' },
        { variant_key: 'color=white|size=M', seller_sku: 'sku-001' }, // case-insensitive match
      ];

      try {
        resolver.detectDuplicates(skus);
        fail('Expected conflict not thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_SKU_DUPLICATE');
      }
    });
  });
});
