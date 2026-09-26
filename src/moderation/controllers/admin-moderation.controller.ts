import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { ModerationService } from '../services/moderation.service';
import { BlockProductDto } from '../dto/block-product.dto';
import { UnblockProductDto } from '../dto/unblock-product.dto';
import { QueryAuditsDto } from '../dto/query-audits.dto';
import { QueryAdminProductsDto } from '../dto/query-admin-products.dto';
import {
  AdminProductDetailDto,
  BlockProductResponseDto,
  PaginatedAdminProductsResponseDto,
  PaginatedAuditsResponseDto,
  UnblockProductResponseDto,
} from '../dto/moderation-response.dto';

@Controller('admin/catalog')
@Roles('CATALOG_ADMIN', 'SUPER_ADMIN')
export class AdminModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('products')
  async getAdminProducts(
    @Query() query: QueryAdminProductsDto,
  ): Promise<PaginatedAdminProductsResponseDto> {
    return this.moderationService.getAdminProducts(query);
  }

  @Get('products/:productId')
  async getAdminProductDetail(
    @Param('productId') productId: string,
  ): Promise<AdminProductDetailDto> {
    return this.moderationService.getAdminProductDetail(productId);
  }

  @Post('products/:productId/block')
  @HttpCode(HttpStatus.OK)
  async blockProduct(
    @Actor() actor: ActorContext,
    @Param('productId') productId: string,
    @Body() dto: BlockProductDto,
  ): Promise<BlockProductResponseDto> {
    return this.moderationService.blockProduct(actor?.userId, productId, dto);
  }

  @Post('products/:productId/unblock')
  @HttpCode(HttpStatus.OK)
  async unblockProduct(
    @Actor() actor: ActorContext,
    @Param('productId') productId: string,
    @Body() dto: UnblockProductDto,
  ): Promise<UnblockProductResponseDto> {
    return this.moderationService.unblockProduct(actor?.userId, productId, dto);
  }

  @Get('audits')
  async getAudits(@Query() query: QueryAuditsDto): Promise<PaginatedAuditsResponseDto> {
    return this.moderationService.getAudits(query);
  }
}
