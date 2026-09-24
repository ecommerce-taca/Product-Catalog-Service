import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  AttributeDefinition,
  AttributeDisplayAs,
  AttributeType,
} from '../../database/schemas/attribute-definition.schema';

export interface AttributeDefinitionLike {
  key: string;
  label?: string;
  type: AttributeType | string;
  is_variant_dimension?: boolean;
  allowed_values?: string[];
  unit?: string | null;
  display_as?: AttributeDisplayAs | string;
  value_meta?: Record<string, unknown> | null;
}

export interface CanonicalResult {
  canonicalAttributes: Record<string, string | number | boolean>;
  variantKey: string;
}

@Injectable()
export class VariantResolver {
  /**
   * Validates attributes against definitions and produces a canonical variant_key.
   * LLD §2.4 Canonicalization:
   * 1. Sort keys by Unicode code point
   * 2. Format values: string trim, boolean lowercase, number canonical decimal
   * 3. Serialize key=value
   * 4. Join with '|'
   */
  validateAndCanonicalize(
    attributes: Record<string, string | number | boolean>,
    definitions: AttributeDefinitionLike[] | AttributeDefinition[],
  ): CanonicalResult {
    if (!attributes || typeof attributes !== 'object') {
      throw new BadRequestException({
        code: 'PRODUCT_ATTRIBUTE_INVALID',
        message: 'Thuộc tính SKU phải là một đối tượng hợp lệ.',
      });
    }

    const defMap = new Map<string, AttributeDefinitionLike>();
    for (const def of definitions) {
      defMap.set(def.key, def);
    }

    // 1. All passed attributes must exist in definitions
    const canonicalAttributes: Record<string, string | number | boolean> = {};

    for (const [key, val] of Object.entries(attributes)) {
      const def = defMap.get(key);
      if (!def) {
        throw new BadRequestException({
          code: 'PRODUCT_ATTRIBUTE_INVALID',
          message: `Thuộc tính '${key}' không được khai báo trong danh mục thuộc tính sản phẩm.`,
        });
      }

      canonicalAttributes[key] = this.validateAndNormalizeValue(key, val, def);
    }

    // 2. All variant dimensions must be present in attributes
    for (const def of definitions) {
      if (def.is_variant_dimension && !(def.key in canonicalAttributes)) {
        throw new BadRequestException({
          code: 'PRODUCT_ATTRIBUTE_INVALID',
          message: `Thiếu giá trị cho thuộc tính biến thể bắt buộc: '${def.key}'.`,
        });
      }
    }

    // 3. Extract only variant dimensions for variant_key
    const variantKeys = Object.keys(canonicalAttributes).filter(
      (k) => defMap.get(k)?.is_variant_dimension,
    );

    // 4. Sort keys according to Unicode code point
    variantKeys.sort();

    // 5. Serialize key=value and join with '|'
    const segments = variantKeys.map((key) => {
      const value = canonicalAttributes[key];
      const serializedValue = this.serializeCanonicalValue(value);
      return `${key}=${serializedValue}`;
    });

    const variantKey = segments.join('|');

    return {
      canonicalAttributes,
      variantKey,
    };
  }

  /**
   * Detects duplicate variant keys or seller SKUs within a batch.
   * Throws ConflictException with PRODUCT_SKU_DUPLICATE code if duplicate found.
   */
  detectDuplicates(skus: Array<{ variant_key: string; seller_sku?: string }>): void {
    const seenVariantKeys = new Set<string>();
    const seenSellerSkus = new Set<string>();

    for (const sku of skus) {
      if (seenVariantKeys.has(sku.variant_key)) {
        throw new ConflictException({
          code: 'PRODUCT_SKU_DUPLICATE',
          message: `Trùng lặp tổ hợp biến thể variant_key: '${sku.variant_key}'.`,
        });
      }
      seenVariantKeys.add(sku.variant_key);

      if (sku.seller_sku) {
        const normalizedSellerSku = sku.seller_sku.trim().toLowerCase();
        if (seenSellerSkus.has(normalizedSellerSku)) {
          throw new ConflictException({
            code: 'PRODUCT_SKU_DUPLICATE',
            message: `Trùng lặp mã seller_sku trong danh sách: '${sku.seller_sku}'.`,
          });
        }
        seenSellerSkus.add(normalizedSellerSku);
      }
    }
  }

  private validateAndNormalizeValue(
    key: string,
    val: unknown,
    def: AttributeDefinitionLike,
  ): string | number | boolean {
    switch (def.type) {
      case AttributeType.STRING: {
        if (typeof val !== 'string') {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Giá trị của thuộc tính '${key}' phải là chuỗi (STRING).`,
          });
        }
        const trimmed = val.trim();
        if (trimmed.length === 0) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Giá trị của thuộc tính '${key}' không được để trống.`,
          });
        }
        return trimmed;
      }

      case AttributeType.NUMBER: {
        if (typeof val !== 'number' || !Number.isFinite(val) || Number.isNaN(val)) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Giá trị của thuộc tính '${key}' phải là số hợp lệ (NUMBER).`,
          });
        }
        return val;
      }

      case AttributeType.BOOLEAN: {
        if (typeof val !== 'boolean') {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Giá trị của thuộc tính '${key}' phải là boolean (BOOLEAN).`,
          });
        }
        return val;
      }

      case AttributeType.ENUM: {
        if (typeof val !== 'string') {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Giá trị của thuộc tính '${key}' phải là chuỗi (ENUM).`,
          });
        }
        const trimmed = val.trim();
        const allowed = def.allowed_values || [];
        if (!allowed.includes(trimmed)) {
          throw new BadRequestException({
            code: 'PRODUCT_ATTRIBUTE_INVALID',
            message: `Giá trị '${val}' của thuộc tính '${key}' không nằm trong danh sách cho phép [${allowed.join(', ')}].`,
          });
        }
        return trimmed;
      }

      default:
        throw new BadRequestException({
          code: 'PRODUCT_ATTRIBUTE_INVALID',
          message: `Loại thuộc tính không hỗ trợ: '${def.type}'.`,
        });
    }
  }

  private serializeCanonicalValue(value: string | number | boolean): string {
    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }
    if (typeof value === 'number') {
      // Use toPrecision(12) converted back to Number to avoid float binary drift, then to String
      return Number(value.toPrecision(12)).toString();
    }
    const str = String(value).trim();
    return str.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/=/g, '\\=');
  }
}
