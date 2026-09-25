import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
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
    @Actor() actor?: ActorContext,
  ): Promise<SkuResponseDto[]> {
    const actorShopScope = shopScope || actor?.shopScope || '';
    if (actor?.userId) {
      return this.skuService.updateProductSkus(productId, actorShopScope, dto, actor.userId);
    }
    return this.skuService.updateProductSkus(productId, actorShopScope, dto);
  }

  @Get(':productId/skus')
  async getProductSkus(
    @Param('productId') productId: string,
    @ShopScope() shopScope: string,
  ): Promise<SkuResponseDto[]> {
    return this.skuService.getSkusByProductId(productId, shopScope);
  }
}
