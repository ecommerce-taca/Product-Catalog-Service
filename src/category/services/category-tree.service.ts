import { Injectable } from '@nestjs/common';
import { CategoryDocument } from '../../database/schemas/category.schema';
import { CategoryTreeNodeDto } from '../dto/category-response.dto';

export interface CategoryTreeItem {
  _id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  path: string;
  depth: number;
  tax_rate_bps: number | null;
  sort_order?: number;
}

@Injectable()
export class CategoryTreeService {
  /**
   * Constructs a nested hierarchical tree from a flat list of categories.
   * Preserves sort_order if the input list is sorted or sorts children by sort_order.
   */
  buildTree(categories: CategoryTreeItem[] | CategoryDocument[]): CategoryTreeNodeDto[] {
    const nodeMap = new Map<string, CategoryTreeNodeDto>();
    const parentMap = new Map<string, string | null>();

    // 1. Create tree node DTOs
    for (const cat of categories) {
      const id = String(cat._id);
      nodeMap.set(id, {
        category_id: id,
        name: cat.name,
        slug: cat.slug,
        path: cat.path,
        depth: cat.depth,
        tax_rate_bps: cat.tax_rate_bps ?? null,
        children: [],
      });
      parentMap.set(id, cat.parent_id ? String(cat.parent_id) : null);
    }

    const roots: CategoryTreeNodeDto[] = [];

    // 2. Link children to parents
    for (const cat of categories) {
      const id = String(cat._id);
      const node = nodeMap.get(id)!;
      const parentId = parentMap.get(id);

      const isRoot = !parentId || cat.depth === 1;

      if (isRoot) {
        roots.push(node);
      } else if (parentId && nodeMap.has(parentId)) {
        const parentNode = nodeMap.get(parentId)!;
        parentNode.children.push(node);
      }
      // Orphan nodes (has parentId != null and depth > 1, but parent is not in nodeMap)
      // are omitted from roots to maintain valid tree hierarchy.
    }

    return roots;
  }

  /**
   * Resolves effective tax rate (tax_rate_bps) by ascending parent nodes until non-null is found.
   */
  resolveEffectiveTaxRateFromList(
    targetCategoryId: string,
    categories: CategoryTreeItem[] | CategoryDocument[],
  ): number | null {
    const catMap = new Map<string, CategoryTreeItem | CategoryDocument>();
    for (const cat of categories) {
      catMap.set(String(cat._id), cat);
    }

    let current = catMap.get(targetCategoryId);
    while (current) {
      if (current.tax_rate_bps !== null && current.tax_rate_bps !== undefined) {
        return current.tax_rate_bps;
      }
      if (!current.parent_id) {
        break;
      }
      current = catMap.get(String(current.parent_id));
    }

    return null;
  }
}
