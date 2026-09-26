import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Query,
  forwardRef,
} from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { ProductService } from '../services/product.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { QueryProductDto } from '../dto/query-product.dto';
import { AssignCategoriesDto } from '../dto/assign-categories.dto';
import {
  AssignCategoriesResponseDto,
  CreateProductResponseDto,
  PaginatedSellerProductsDto,
  UpdateProductResponseDto,
} from '../dto/product-response.dto';
import { SellerProductDetailDto } from '../dto/seller-product-detail.dto';
import { ExportService } from '../../export/services/export.service';
import { ExportProductsDto } from '../../export/dto/export-products.dto';
import { ExportResponseDto } from '../../export/dto/export-response.dto';

@Controller('seller/products')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerProductController {
  constructor(
    private readonly productService: ProductService,
    @Optional()
    @Inject(forwardRef(() => ExportService))
    private readonly exportService?: ExportService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createProduct(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Body() dto: CreateProductDto,
  ): Promise<CreateProductResponseDto> {
    return this.productService.createProduct(actor?.userId, shopScope, dto);
  }

  @Get()
  async getSellerProducts(
    @ShopScope() shopScope: string,
    @Query() query: QueryProductDto,
  ): Promise<PaginatedSellerProductsDto> {
    return this.productService.getSellerProducts(shopScope, query);
  }

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

    if (!this.exportService) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Export service is not available.',
      });
    }

    return this.exportService.exportProducts(actorShopScope, query);
  }

  @Get(':productId')
  async getSellerProductDetail(
    @ShopScope() shopScope: string,
    @Param('productId') productId: string,
  ): Promise<SellerProductDetailDto> {
    return this.productService.getSellerProductDetail(shopScope, productId);
  }

  @Patch(':productId')
  async updateProduct(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Param('productId') productId: string,
    @Body() dto: UpdateProductDto,
  ): Promise<UpdateProductResponseDto> {
    return this.productService.updateProduct(actor?.userId, shopScope, productId, dto);
  }

  @Put(':productId/categories')
  async assignCategories(
    @Actor() actor: ActorContext,
    @ShopScope() shopScope: string,
    @Param('productId') productId: string,
    @Body() dto: AssignCategoriesDto,
  ): Promise<AssignCategoriesResponseDto> {
    return this.productService.assignCategories(actor?.userId, shopScope, productId, dto);
  }
}
