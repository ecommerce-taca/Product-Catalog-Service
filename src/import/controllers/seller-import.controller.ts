import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

import { Roles } from '../../common/decorators/roles.decorator';
import { ShopScope } from '../../common/decorators/shop-scope.decorator';
import { Actor } from '../../common/decorators/actor.decorator';
import { SkipEnvelope } from '../../common/decorators/skip-envelope.decorator';
import { ActorContext } from '../../common/context/actor-context.interface';
import { ShopStatus } from '../../database/schemas/shop-snapshot.schema';
import { ImportJobStatus } from '../../database/schemas/import-job.schema';
import {
  SHOP_SNAPSHOT_REPOSITORY_PORT,
  ShopSnapshotRepositoryPort,
} from '../../projections/repositories/shop-snapshot.repository.interface';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';

import { ImportJobRepositoryPort } from '../repositories/import-job.repository.interface';
import { ExcelTemplateService } from '../services/excel-template.service';
import { ImportWorkerService } from '../services/import-worker.service';
import { ImportTemplateQueryDto } from '../dto/import-template-query.dto';
import { ImportJobCreatedResponseDto } from '../dto/import-job-response.dto';

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

export interface UploadedFilePayload {
  fieldname?: string;
  originalname?: string;
  encoding?: string;
  mimetype?: string;
  size?: number;
  buffer: Buffer;
}

@Controller('seller/products/import')
@Roles('SELLER', 'SELLER_STAFF')
export class SellerImportController {
  private readonly logger = new Logger(SellerImportController.name);

  constructor(
    private readonly excelTemplateService: ExcelTemplateService,
    @Inject(SHOP_SNAPSHOT_REPOSITORY_PORT)
    private readonly shopSnapshotRepository: ShopSnapshotRepositoryPort,
    @Inject('ImportJobRepositoryPort')
    private readonly importJobRepo: ImportJobRepositoryPort,
    private readonly importWorkerService: ImportWorkerService,
    private readonly storageService: S3StorageService,
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

  /**
   * Receives an Excel (.xlsx) file for bulk product import (FR-IM-02).
   * Validates file size (<= 2MB), MIME type, checks shop status (SUSPENDED -> 403),
   * checks concurrent active job (-> 409), uploads to S3, creates PENDING ImportJob,
   * triggers background worker, and returns 202 Accepted within < 500ms.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file'))
  async uploadImportFile(
    @UploadedFile() file: UploadedFilePayload,
    @ShopScope() shopScope: string,
    @Actor() actor: ActorContext,
  ): Promise<ImportJobCreatedResponseDto> {
    const actorShopScope = shopScope || actor?.shopScope;
    if (!actorShopScope) {
      throw new ForbiddenException({
        code: 'PRODUCT_FORBIDDEN',
        message: 'Bạn không có quyền thao tác. Thiếu thông tin gian hàng (shop scope).',
      });
    }

    // 1. Validate file presence
    if (!file || !file.buffer) {
      throw new BadRequestException({
        code: 'PRODUCT_IMPORT_FILE_TYPE_INVALID',
        message: 'Vui lòng chọn tệp Excel (.xlsx) để tải lên.',
      });
    }

    // 2. Validate file size (<= 2MB)
    const fileSize = file.size ?? file.buffer.length;
    if (fileSize > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException({
        code: 'PRODUCT_IMPORT_FILE_TOO_LARGE',
        message: 'Dung lượng tệp vượt quá giới hạn tối đa 2MB.',
      });
    }

    // 3. Validate file format / magic bytes
    const originalName = (file.originalname || '').toLowerCase();
    const isXlsxExt = originalName.endsWith('.xlsx');
    const isZipMagic =
      file.buffer.length >= 4 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b; // 'PK'

    if (!isXlsxExt || !isZipMagic) {
      throw new BadRequestException({
        code: 'PRODUCT_IMPORT_FILE_TYPE_INVALID',
        message: 'Định dạng tệp không hợp lệ. Chỉ chấp nhận tệp Excel (.xlsx).',
      });
    }

    // 4. Validate shop status (SUSPENDED -> 403 Forbidden - BR-IM-01)
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

    // 5. Tenant Throttle: Check active job (BR-IM-06, AC-IM-07)
    const activeJob = await this.importJobRepo.findActiveJobByShop(actorShopScope);
    if (activeJob) {
      throw new ConflictException({
        code: 'PRODUCT_IMPORT_JOB_RUNNING',
        message: 'Gian hàng đang có tiến trình nhập sản phẩm đang xử lý. Vui lòng chờ hoàn tất.',
      });
    }

    // 6. Upload file buffer to S3 storage
    const jobId = uuidv7();
    const s3Key = `imports/shop-${actorShopScope}/${jobId}.xlsx`;
    await this.storageService.uploadBuffer(
      s3Key,
      file.buffer,
      file.mimetype || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    // 7. Create PENDING job in MongoDB
    const job = await this.importJobRepo.create({
      _id: jobId,
      shop_id: actorShopScope,
      actor_user_id: actor?.userId || '01910000-0000-7000-8000-000000000000',
      status: ImportJobStatus.PENDING,
      file_url: s3Key,
      total_rows: null,
      processed_rows: 0,
      success_count: 0,
      error_count: 0,
      error_summary: [],
    });

    // 8. Trigger background worker asynchronously
    setImmediate(() => {
      this.importWorkerService.processJob(jobId).catch((err: unknown) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Background worker failed for job ${jobId}: ${errorMsg}`,
          (err as Error)?.stack,
        );
      });
    });

    // 9. Respond with 202 Accepted in < 500ms (NFR-IM-01, AC-IM-04)
    return {
      job_id: jobId,
      status: ImportJobStatus.PENDING,
      created_at: job.created_at || new Date(),
      message: 'Tác vụ nhập sản phẩm đã được tiếp nhận và đang xếp hàng xử lý.',
    };
  }
}
