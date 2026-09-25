import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { MediaService } from '../services/media.service';
import { UploadUrlDto } from '../dtos/upload-url.dto';
import { CompleteUploadDto } from '../dtos/complete-upload.dto';
import {
  CompleteUploadResponseDto,
  ProductMediaItemDto,
  UploadUrlResponseDto,
} from '../dtos/media-response.dto';

@Controller('seller/products/:productId/media')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerMediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post('upload-url')
  @HttpCode(HttpStatus.CREATED)
  async requestUploadUrl(
    @Param('productId') productId: string,
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Body() dto: UploadUrlDto,
  ): Promise<UploadUrlResponseDto> {
    const actorShopScope = shopScope || actor?.shopScope || '';
    return this.mediaService.requestUploadUrl(actorShopScope, productId, actor?.userId || '', dto);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  async completeUpload(
    @Param('productId') productId: string,
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    const actorShopScope = shopScope || actor?.shopScope || '';
    return this.mediaService.completeUpload(actorShopScope, productId, actor?.userId || '', dto);
  }

  @Get()
  async listMedia(
    @Param('productId') productId: string,
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
  ): Promise<ProductMediaItemDto[]> {
    const actorShopScope = shopScope || actor?.shopScope || '';
    return this.mediaService.listMedia(actorShopScope, productId);
  }

  @Delete(':mediaId')
  async deleteMedia(
    @Param('productId') productId: string,
    @Param('mediaId') mediaId: string,
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
  ): Promise<{ success: boolean }> {
    const actorShopScope = shopScope || actor?.shopScope || '';
    return this.mediaService.deleteMedia(actorShopScope, productId, mediaId, actor?.userId || '');
  }
}
