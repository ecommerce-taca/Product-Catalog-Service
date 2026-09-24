import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { SkuService } from '../services/sku.service';
import { UpdateProductSkusDto } from '../dto/update-product-skus.dto';
import { SkuResponseDto } from '../dto/sku-response.dto';

@Controller('seller/products')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerSkuController {
  constructor(private readonly skuService: SkuService) {}

  @Put(':productId/skus')
  async updateProductSkus(
    @Param('productId') productId: string,
    @ShopScope() shopScope: string,
    @Body() dto: UpdateProductSkusDto,
  ): Promise<SkuResponseDto[]> {
    return this.skuService.updateProductSkus(productId, shopScope, dto);
  }

  @Get(':productId/skus')
  async getProductSkus(
    @Param('productId') productId: string,
    @ShopScope() shopScope: string,
  ): Promise<SkuResponseDto[]> {
    return this.skuService.getSkusByProductId(productId, shopScope);
  }
}
