import { Controller, Get, Param, Query } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { CatalogQueryService } from '../services/catalog-query.service';
import { QueryProductsDto } from '../dto/query-products.dto';
import { PaginatedProductsResponseDto } from '../dto/product-response.dto';
import { ProductDetailDto } from '../dto/product-detail-response.dto';

@Controller()
@Public()
export class ProductController {
  constructor(private readonly catalogQueryService: CatalogQueryService) {}

  @Get('products')
  async listProducts(@Query() query: QueryProductsDto): Promise<PaginatedProductsResponseDto> {
    return this.catalogQueryService.listProducts(query);
  }

  @Get('products/:productId')
  async getProductDetail(@Param('productId') productId: string): Promise<ProductDetailDto> {
    return this.catalogQueryService.getProductDetail(productId);
  }

  @Get('shops/:shopId/products')
  async listShopProducts(
    @Param('shopId') shopId: string,
    @Query() query: QueryProductsDto,
  ): Promise<PaginatedProductsResponseDto> {
    return this.catalogQueryService.listShopProducts(shopId, query);
  }
}
