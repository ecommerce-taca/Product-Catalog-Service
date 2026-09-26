import { Test, TestingModule } from '@nestjs/testing';
import { ProductController } from '../../src/catalog-query/controllers/product.controller';
import { CatalogQueryService } from '../../src/catalog-query/services/catalog-query.service';
import { QueryProductsDto } from '../../src/catalog-query/dto/query-products.dto';
import { PaginatedProductsResponseDto } from '../../src/catalog-query/dto/product-response.dto';
import { ProductDetailDto } from '../../src/catalog-query/dto/product-detail-response.dto';

describe('ProductController', () => {
  let controller: ProductController;
  let service: CatalogQueryService;

  const mockCatalogQueryService = {
    listProducts: jest.fn(),
    getProductDetail: jest.fn(),
    listShopProducts: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProductController],
      providers: [
        {
          provide: CatalogQueryService,
          useValue: mockCatalogQueryService,
        },
      ],
    }).compile();

    controller = module.get<ProductController>(ProductController);
    service = module.get<CatalogQueryService>(CatalogQueryService);
  });

  describe('listProducts', () => {
    it('should delegate to CatalogQueryService.listProducts', async () => {
      const query: QueryProductsDto = { page: 1, size: 20 };
      const expected: PaginatedProductsResponseDto = {
        data: [],
        meta: { page: 1, size: 20, total: 0, total_pages: 0 },
      };
      mockCatalogQueryService.listProducts.mockResolvedValue(expected);

      const result = await controller.listProducts(query);
      expect(result).toBe(expected);
      expect(service.listProducts).toHaveBeenCalledWith(query);
    });
  });

  describe('getProductDetail', () => {
    it('should delegate to CatalogQueryService.getProductDetail', async () => {
      const expected = { product_id: 'p-1', title: 'Product 1' } as ProductDetailDto;
      mockCatalogQueryService.getProductDetail.mockResolvedValue(expected);

      const result = await controller.getProductDetail('p-1');
      expect(result).toBe(expected);
      expect(service.getProductDetail).toHaveBeenCalledWith('p-1');
    });
  });

  describe('listShopProducts', () => {
    it('should delegate to CatalogQueryService.listShopProducts', async () => {
      const query: QueryProductsDto = { page: 1, size: 10 };
      const expected: PaginatedProductsResponseDto = {
        data: [],
        meta: { page: 1, size: 10, total: 0, total_pages: 0 },
      };
      mockCatalogQueryService.listShopProducts.mockResolvedValue(expected);

      const result = await controller.listShopProducts('shop-1', query);
      expect(result).toBe(expected);
      expect(service.listShopProducts).toHaveBeenCalledWith('shop-1', query);
    });
  });
});
