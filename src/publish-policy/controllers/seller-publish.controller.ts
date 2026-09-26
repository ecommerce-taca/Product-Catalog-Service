import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { PublishPolicyService } from '../services/publish-policy.service';
import {
  ArchiveProductDto,
  PublishProductDto,
  UnpublishProductDto,
} from '../dto/publish-product.dto';
import {
  ArchiveResponseDto,
  PublishResponseDto,
  UnpublishResponseDto,
} from '../dto/publish-response.dto';

@Controller('seller/products')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerPublishController {
  constructor(private readonly publishPolicyService: PublishPolicyService) {}

  @Post(':productId/publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Param('productId') productId: string,
    @Body() dto: PublishProductDto,
  ): Promise<PublishResponseDto> {
    return this.publishPolicyService.publish(actor?.userId, shopScope, productId, dto);
  }

  @Post(':productId/unpublish')
  @HttpCode(HttpStatus.OK)
  async unpublish(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Param('productId') productId: string,
    @Body() dto: UnpublishProductDto,
  ): Promise<UnpublishResponseDto> {
    return this.publishPolicyService.unpublish(actor?.userId, shopScope, productId, dto);
  }

  @Post(':productId/archive')
  @HttpCode(HttpStatus.OK)
  async archive(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Param('productId') productId: string,
    @Body() dto: ArchiveProductDto,
  ): Promise<ArchiveResponseDto> {
    return this.publishPolicyService.archive(actor?.userId, shopScope, productId, dto);
  }
}
