import {
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Inject,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { SkipEnvelope } from '../../common/decorators/skip-envelope.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { ShopStatus } from '../../database/schemas/shop-snapshot.schema';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../../projections/repositories/shop-snapshot.repository.interface';
import { ExcelTemplateService } from '../services/excel-template.service';
import { ImportTemplateQueryDto } from '../dto/import-template-query.dto';

@Controller('seller/products/import')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerImportController {
  constructor(
    private readonly excelTemplateService: ExcelTemplateService,
    @Inject(SHOP_SNAPSHOT_REPOSITORY_PORT)
    private readonly shopSnapshotRepository: ShopSnapshotRepositoryPort,
  ) {}

  /**
   * Downloads an Excel template (.xlsx) for bulk product import.
   * If category_id is provided, dynamic attributes with dropdown validation are attached.
   * Enforces shop status check: SUSPENDED shops are rejected with 403 PRODUCT_SHOP_SUSPENDED (BR-IM-01).
   */
  @Get('template')
  @SkipEnvelope()
  async downloadTemplate(
    @Query() query: ImportTemplateQueryDto,
    @ShopScope() shopScope: string,
    @Actor() actor: ActorContext,
    @Res() res: Response,
  ): Promise<void> {
    const actorShopScope = shopScope || actor?.shopScope;
    if (!actorShopScope) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    const shopSnapshot = await this.shopSnapshotRepository.findByShopId(actorShopScope);
    if (
      shopSnapshot &&
      (shopSnapshot.shop_status === ShopStatus.SUSPENDED ||
        shopSnapshot.shop_status === ('SUSPENDED' as ShopStatus))
    ) {
      throw new ForbiddenException({
        code: 'PRODUCT_SHOP_SUSPENDED',
        message: 'Gian hàng đang bị tạm ngưng hoạt động (SUSPENDED).',
      });
    }

    const buffer = await this.excelTemplateService.generateTemplate(query.category_id);
    const filename = `product_import_template_${query.category_id || 'default'}.xlsx`;

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });

    res.status(HttpStatus.OK).send(buffer);
  }
}
