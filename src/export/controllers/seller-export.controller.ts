import { Controller, ForbiddenException, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { ExportService } from '../services/export.service';
import { ExportProductsDto } from '../dto/export-products.dto';
import { ExportResponseDto } from '../dto/export-response.dto';

@Controller('seller/products')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerExportController {
  constructor(private readonly exportService: ExportService) {}

  @Get('export')
  async exportProducts(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Query() query: ExportProductsDto,
  ): Promise<ExportResponseDto> {
    const actorShopScope = shopScope || actor?.shopScope;
    if (!actorShopScope) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Yêu cầu phạm vi cửa hàng (shop scope).',
      });
    }

    return this.exportService.exportProducts(actorShopScope, query);
  }
}
