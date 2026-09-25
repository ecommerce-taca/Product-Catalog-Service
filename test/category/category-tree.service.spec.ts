import { Test, TestingModule } from '@nestjs/testing';
import {
  CategoryTreeItem,
  CategoryTreeService,
} from '../../src/category/services/category-tree.service';

describe('CategoryTreeService', () => {
  let service: CategoryTreeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoryTreeService],
    }).compile();

    service = module.get<CategoryTreeService>(CategoryTreeService);
  });

  describe('buildTree', () => {
    it('should build an empty tree when given an empty list', () => {
      const result = service.buildTree([]);
      expect(result).toEqual([]);
    });

    it('should build a nested category tree from flat list', () => {
      const flatCategories: CategoryTreeItem[] = [
        {
          _id: 'root-1',
          parent_id: null,
          name: 'Điện tử',
          slug: 'dien-tu',
          path: '/root-1',
          depth: 1,
          tax_rate_bps: 1000,
          sort_order: 1,
        },
        {
          _id: 'child-1',
          parent_id: 'root-1',
          name: 'Điện thoại',
          slug: 'dien-thoai',
          path: '/root-1/child-1',
          depth: 2,
          tax_rate_bps: null,
          sort_order: 1,
        },
        {
          _id: 'child-2',
          parent_id: 'root-1',
          name: 'Máy tính bảng',
          slug: 'may-tinh-bang',
          path: '/root-1/child-2',
          depth: 2,
          tax_rate_bps: 800,
          sort_order: 2,
        },
        {
          _id: 'grandchild-1',
          parent_id: 'child-1',
          name: 'Phụ kiện điện thoại',
          slug: 'phu-kien-dien-thoai',
          path: '/root-1/child-1/grandchild-1',
          depth: 3,
          tax_rate_bps: null,
          sort_order: 1,
        },
        {
          _id: 'root-2',
          parent_id: null,
          name: 'Thời trang',
          slug: 'thoi-trang',
          path: '/root-2',
          depth: 1,
          tax_rate_bps: 500,
          sort_order: 2,
        },
      ];

      const tree = service.buildTree(flatCategories);

      expect(tree).toHaveLength(2);
      expect(tree[0].category_id).toBe('root-1');
      expect(tree[0].name).toBe('Điện tử');
      expect(tree[0].children).toHaveLength(2);

      const phoneChild = tree[0].children.find((c) => c.category_id === 'child-1');
      expect(phoneChild).toBeDefined();
      expect(phoneChild?.children).toHaveLength(1);
      expect(phoneChild?.children[0].category_id).toBe('grandchild-1');

      const tabletChild = tree[0].children.find((c) => c.category_id === 'child-2');
      expect(tabletChild).toBeDefined();
      expect(tabletChild?.children).toHaveLength(0);

      expect(tree[1].category_id).toBe('root-2');
      expect(tree[1].children).toHaveLength(0);
    });

    it('should preserve sort_order among siblings', () => {
      const items: CategoryTreeItem[] = [
        {
          _id: 'r1',
          parent_id: null,
          name: 'Root 1',
          slug: 'root-1',
          path: '/r1',
          depth: 1,
          tax_rate_bps: 1000,
          sort_order: 10,
        },
        {
          _id: 'c1',
          parent_id: 'r1',
          name: 'Child A',
          slug: 'child-a',
          path: '/r1/c1',
          depth: 2,
          tax_rate_bps: null,
          sort_order: 20,
        },
        {
          _id: 'c2',
          parent_id: 'r1',
          name: 'Child B',
          slug: 'child-b',
          path: '/r1/c2',
          depth: 2,
          tax_rate_bps: null,
          sort_order: 5,
        },
      ];

      // Sort items before passing to buildTree (as repository find does)
      items.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));

      const tree = service.buildTree(items);
      expect(tree[0].children[0].category_id).toBe('c2');
      expect(tree[0].children[1].category_id).toBe('c1');
    });

    it('should not promote orphan nodes to root when parent is missing from nodeMap (S-1)', () => {
      const flatCategories: CategoryTreeItem[] = [
        {
          _id: 'root-1',
          parent_id: null,
          name: 'Điện tử',
          slug: 'dien-tu',
          path: '/root-1',
          depth: 1,
          tax_rate_bps: 1000,
        },
        {
          _id: 'orphan-1',
          parent_id: 'inactive-parent',
          name: 'Node mồ côi',
          slug: 'node-mo-coi',
          path: '/inactive-parent/orphan-1',
          depth: 2,
          tax_rate_bps: null,
        },
      ];

      const tree = service.buildTree(flatCategories);

      expect(tree).toHaveLength(1);
      expect(tree[0].category_id).toBe('root-1');
      expect(tree.find((node) => node.category_id === 'orphan-1')).toBeUndefined();
    });
  });

  describe('resolveEffectiveTaxRateFromList', () => {
    const categories: CategoryTreeItem[] = [
      {
        _id: 'root-1',
        parent_id: null,
        name: 'Root',
        slug: 'root',
        path: '/root-1',
        depth: 1,
        tax_rate_bps: 1000,
      },
      {
        _id: 'child-1',
        parent_id: 'root-1',
        name: 'Child 1',
        slug: 'child-1',
        path: '/root-1/child-1',
        depth: 2,
        tax_rate_bps: null,
      },
      {
        _id: 'child-2',
        parent_id: 'root-1',
        name: 'Child 2',
        slug: 'child-2',
        path: '/root-1/child-2',
        depth: 2,
        tax_rate_bps: 500,
      },
      {
        _id: 'grandchild-1',
        parent_id: 'child-1',
        name: 'Grandchild 1',
        slug: 'grandchild-1',
        path: '/root-1/child-1/grandchild-1',
        depth: 3,
        tax_rate_bps: null,
      },
    ];

    it('should return own tax_rate_bps if non-null', () => {
      const rate = service.resolveEffectiveTaxRateFromList('child-2', categories);
      expect(rate).toBe(500);
    });

    it('should inherit tax_rate_bps from direct parent if own is null', () => {
      const rate = service.resolveEffectiveTaxRateFromList('child-1', categories);
      expect(rate).toBe(1000);
    });

    it('should inherit tax_rate_bps from ancestor root if both child and grandchild are null', () => {
      const rate = service.resolveEffectiveTaxRateFromList('grandchild-1', categories);
      expect(rate).toBe(1000);
    });

    it('should return null if category does not exist in the list', () => {
      const rate = service.resolveEffectiveTaxRateFromList('non-existent', categories);
      expect(rate).toBeNull();
    });
  });
});
