import { Test, TestingModule } from '@nestjs/testing';

jest.mock('sanitize-html', () => {
  return jest.fn().mockImplementation((input: string) => input);
});

import { SellerProductController } from '../../src/product/controllers/seller-product.controller';
import { ProductService } from '../../src/product/services/product.service';
import { ProductStatus } from '../../src/database/schemas/product.schema';
import { ActorContext } from '../../src/common/context/actor-context.interface';

describe('SellerProductController', () => {
  let controller: SellerProductController;

  const mockProductService = {
    createProduct: jest.fn(),
    getSellerProducts: jest.fn(),
    getSellerProductDetail: jest.fn(),
    updateProduct: jest.fn(),
    assignCategories: jest.fn(),
  };

  const actor: ActorContext = {
    userId: '01912f30-7a1b-7c12-9c55-8b1c34a6d001',
    roles: ['SELLER'],
    permissions: [],
    shopScope: '01912f30-7a1b-7c12-9c55-8b1c34a6d002',
    isAuthenticated: true,
  };

  const shopScope = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerProductController],
      providers: [
        {
          provide: ProductService,
          useValue: mockProductService,
        },
      ],
    }).compile();

    controller = module.get<SellerProductController>(SellerProductController);
  });

  it('should create product via POST /seller/products', async () => {
    const dto = {
      title: 'Áo khoác',
      slug: 'ao-khoac',
    };
    mockProductService.createProduct.mockResolvedValue({
      product_id: 'prod-01',
      shop_id: shopScope,
      status: ProductStatus.DRAFT,
      version: 1,
    });

    const result = await controller.createProduct(actor, shopScope, dto);

    expect(result.product_id).toBe('prod-01');
    expect(mockProductService.createProduct).toHaveBeenCalledWith(actor.userId, shopScope, dto);
  });

  it('should get seller products list via GET /seller/products', async () => {
    const query = { page: 1, size: 20 };
    mockProductService.getSellerProducts.mockResolvedValue({
      data: [],
      meta: { page: 1, size: 20, total: 0, total_pages: 1 },
    });

    const result = await controller.getSellerProducts(shopScope, query);

    expect(result.data).toEqual([]);
    expect(mockProductService.getSellerProducts).toHaveBeenCalledWith(shopScope, query);
  });

  it('should get product detail via GET /seller/products/:productId', async () => {
    mockProductService.getSellerProductDetail.mockResolvedValue({
      product_id: 'prod-01',
      status: ProductStatus.DRAFT,
    });

    const result = await controller.getSellerProductDetail(shopScope, 'prod-01');

    expect(result.product_id).toBe('prod-01');
    expect(mockProductService.getSellerProductDetail).toHaveBeenCalledWith(shopScope, 'prod-01');
  });

  it('should update product via PATCH /seller/products/:productId', async () => {
    const dto = { version: 1, title: 'Tên mới' };
    mockProductService.updateProduct.mockResolvedValue({
      product_id: 'prod-01',
      version: 2,
    });

    const result = await controller.updateProduct(actor, shopScope, 'prod-01', dto);

    expect(result.product_id).toBe('prod-01');
    expect(mockProductService.updateProduct).toHaveBeenCalledWith(
      actor.userId,
      shopScope,
      'prod-01',
      dto,
    );
  });

  it('should assign categories via PUT /seller/products/:productId/categories', async () => {
    const dto = {
      version: 2,
      primary_category_id: 'cat-01',
      secondary_category_ids: ['cat-02'],
    };
    mockProductService.assignCategories.mockResolvedValue({
      product_id: 'prod-01',
      primary_category_id: 'cat-01',
      secondary_category_ids: ['cat-02'],
      version: 3,
    });

    const result = await controller.assignCategories(actor, shopScope, 'prod-01', dto);

    expect(result.product_id).toBe('prod-01');
    expect(mockProductService.assignCategories).toHaveBeenCalledWith(
      actor.userId,
      shopScope,
      'prod-01',
      dto,
    );
  });
});
