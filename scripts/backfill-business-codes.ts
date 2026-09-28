import * as crypto from 'crypto';
import mongoose, { Model } from 'mongoose';
import {
  Category,
  CategorySchema,
  CATEGORY_CODE_REGEX,
} from '../src/database/schemas/category.schema';
import { Product, ProductSchema, PRODUCT_CODE_REGEX } from '../src/database/schemas/product.schema';

/**
 * Generates a valid, idempotent, unique Category business code matching CATEGORY_CODE_REGEX.
 */
export function generateCategoryCode(
  slugOrName: string,
  existingCodes: Set<string>,
  idFallback = '',
): string {
  const sanitized = (slugOrName || '')
    .toUpperCase()
    .replace(/-/g, '_')
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  let base = '';
  if (sanitized.length >= 3) {
    base = sanitized.startsWith('CAT')
      ? sanitized.substring(0, 24)
      : `CAT_${sanitized.substring(0, 20)}`;
  } else {
    const rawId = (idFallback || '').replace(/-/g, '').substring(0, 8).toUpperCase();
    base = `CAT_${rawId || crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  let candidate = base;
  let counter = 1;
  while (existingCodes.has(candidate) || !CATEGORY_CODE_REGEX.test(candidate)) {
    const suffix = `_${counter}`;
    const truncatedBase = base.substring(0, 32 - suffix.length);
    candidate = `${truncatedBase}${suffix}`;
    counter++;
  }

  existingCodes.add(candidate);
  return candidate;
}

/**
 * Generates a valid, idempotent, unique Product business code matching PRODUCT_CODE_REGEX.
 */
export function generateProductCode(existingCodesForShop: Set<string>): string {
  let candidate = '';
  do {
    const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
    candidate = `PRD_${randomHex}`;
  } while (existingCodesForShop.has(candidate) || !PRODUCT_CODE_REGEX.test(candidate));

  existingCodesForShop.add(candidate);
  return candidate;
}

export interface BackfillResult {
  categoriesTotal: number;
  categoriesUpdated: number;
  productsTotal: number;
  productsUpdated: number;
}

/**
 * Backfill missing category_code and product_code in MongoDB.
 * Ensures full idempotency and uniqueness constraints.
 */
export async function backfillBusinessCodes(mongoUri?: string): Promise<BackfillResult> {
  const uri =
    mongoUri ||
    process.env.MONGODB_URI ||
    'mongodb://localhost:27017/product_catalog?replicaSet=rs0&directConnection=true';

  const shouldDisconnect = mongoose.connection.readyState === 0;
  if (shouldDisconnect) {
    await mongoose.connect(uri);
  }

  try {
    const CategoryModel: Model<Category> =
      mongoose.models.Category || mongoose.model<Category>('Category', CategorySchema);
    const ProductModel: Model<Product> =
      mongoose.models.Product || mongoose.model<Product>('Product', ProductSchema);

    // 1. Backfill Categories
    const allCategories = await CategoryModel.find(
      {},
      { _id: 1, slug: 1, name: 1, category_code: 1 },
    ).lean();
    const existingCategoryCodes = new Set<string>();

    for (const cat of allCategories) {
      if (cat.category_code) {
        existingCategoryCodes.add(cat.category_code);
      }
    }

    const categoriesToUpdate = allCategories.filter((c) => !c.category_code);
    let categoriesUpdated = 0;

    if (categoriesToUpdate.length > 0) {
      const categoryBulkOps = categoriesToUpdate.map((cat) => {
        const code = generateCategoryCode(
          cat.slug || cat.name || '',
          existingCategoryCodes,
          cat._id,
        );
        return {
          updateOne: {
            filter: { _id: cat._id, category_code: null },
            update: { $set: { category_code: code } },
          },
        };
      });

      const catWriteResult = await CategoryModel.bulkWrite(categoryBulkOps);
      categoriesUpdated = catWriteResult.modifiedCount || 0;
    }

    // 2. Backfill Products
    const allProducts = await ProductModel.find({}, { _id: 1, shop_id: 1, product_code: 1 }).lean();
    const existingProductCodesByShop = new Map<string, Set<string>>();

    for (const prod of allProducts) {
      if (!existingProductCodesByShop.has(prod.shop_id)) {
        existingProductCodesByShop.set(prod.shop_id, new Set<string>());
      }
      if (prod.product_code) {
        existingProductCodesByShop.get(prod.shop_id)!.add(prod.product_code);
      }
    }

    const productsToUpdate = allProducts.filter((p) => !p.product_code);
    let productsUpdated = 0;

    if (productsToUpdate.length > 0) {
      const productBulkOps = productsToUpdate.map((prod) => {
        if (!existingProductCodesByShop.has(prod.shop_id)) {
          existingProductCodesByShop.set(prod.shop_id, new Set<string>());
        }
        const shopCodes = existingProductCodesByShop.get(prod.shop_id)!;
        const code = generateProductCode(shopCodes);
        return {
          updateOne: {
            filter: { _id: prod._id, product_code: null },
            update: { $set: { product_code: code } },
          },
        };
      });

      const prodWriteResult = await ProductModel.bulkWrite(productBulkOps);
      productsUpdated = prodWriteResult.modifiedCount || 0;
    }

    return {
      categoriesTotal: allCategories.length,
      categoriesUpdated,
      productsTotal: allProducts.length,
      productsUpdated,
    };
  } finally {
    if (shouldDisconnect) {
      await mongoose.disconnect();
    }
  }
}

// Standalone execution
if (require.main === module) {
  backfillBusinessCodes()
    .then((result) => {
      // eslint-disable-next-line no-console
      console.log('Backfill business codes finished successfully:', result);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('Backfill business codes failed:', err);
      process.exit(1);
    });
}
