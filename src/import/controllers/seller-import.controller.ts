import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

import { GenerateCustomTemplateDto } from '../dto/generate-custom-template.dto';

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
import { TraceContextStorage } from '../../common/context/trace-context.storage';

import { ImportJobRepositoryPort } from '../repositories/import-job.repository.interface';
import { ExcelTemplateService } from '../services/excel-template.service';
import { ImportWorkerService } from '../services/import-worker.service';
import { ExcelResultService } from '../services/excel-result.service';
import {
  ImportJobCreatedResponseDto,
  ImportJobResponseDto,
  ImportJobResultResponseDto,
} from '../dto/import-job-response.dto';

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    @Optional()
    private readonly excelResultService?: ExcelResultService,
  ) {}

  /**
   * Generates or retrieves an Excel template (.xlsx) for bulk product import (FR-IM-01).
   * Supports custom row count, layout mode, category filter, and product pre-population.
   * By default, returns a JSON envelope containing the Presigned Download URL.
   * If client explicitly requests binary stream (via Accept header), streams the file.
   * Enforces shop status check: SUSPENDED shops are rejected with 403 PRODUCT_SHOP_SUSPENDED (BR-IM-01).
   */
  /**
   * Generates an Excel template (.xlsx) for bulk product import (FR-IM-01) with custom filters.
   * By default, returns a JSON envelope containing the Presigned Download URL.
   * If client explicitly requests binary stream (via Accept header), streams the file.
   * Enforces shop status check: SUSPENDED shops are rejected with 403 PRODUCT_SHOP_SUSPENDED (BR-IM-01).
   */
  @Post('template')
  @SkipEnvelope()
  async downloadTemplate(
    @Body() dto: GenerateCustomTemplateDto,
    @ShopScope() shopScope: string,
    @Actor() actor: ActorContext,
    @Res() res: Response,
    @Req() req?: Request,
  ): Promise<void> {
    return this.handleTemplateDownload(dto, shopScope, actor, res, req);
  }

  /**
   * Backward-compatible GET endpoint for template download.
   */
  @Get('template')
  @SkipEnvelope()
  async downloadTemplateLegacy(
    @Query('category_id') categoryId: string,
    @ShopScope() shopScope: string,
    @Actor() actor: ActorContext,
    @Res() res: Response,
    @Req() req?: Request,
  ): Promise<void> {
    const dto = new GenerateCustomTemplateDto();
    if (categoryId) {
      dto.category_ids = [categoryId];
    }
    return this.handleTemplateDownload(dto, shopScope, actor, res, req);
  }

  private async handleTemplateDownload(
    dto: GenerateCustomTemplateDto = {},
    shopScope: string,
    actor: ActorContext,
    res: Response,
    req?: Request,
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

    const templateResult = await this.excelTemplateService.getOrInitTemplate(dto, actorShopScope);

    const acceptHeader = (req?.headers?.accept || '').toLowerCase();
    const wantsBinary =
      acceptHeader.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') ||
      acceptHeader.includes('application/octet-stream');

    if (wantsBinary) {
      const buffer = await this.excelTemplateService.generateTemplate(dto, actorShopScope);
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${templateResult.filename}"`,
        'Content-Length': buffer.length.toString(),
      });
      res.status(HttpStatus.OK).send(buffer);
      return;
    }

    const resultData = {
      download_url: templateResult.downloadUrl,
      filename: templateResult.filename,
      expires_at: templateResult.expiresAt,
    };

    const requestId =
      TraceContextStorage.getRequestId() || (req?.headers?.['x-request-id'] as string) || '';
    res.status(HttpStatus.OK).json({
      data: resultData,
      meta: {
        request_id: requestId,
        as_of: new Date().toISOString(),
      },
    });
  }

  /**
   * Receives an Excel (.xlsx) file for bulk product import (FR-IM-02).
   * Validates file size (<= 2MB), MIME type, checks shop status (SUSPENDED -> 403),
   * checks concurrent active job (-> 409), uploads to S3, creates PENDING ImportJob,
   * triggers background worker, and returns 202 Accepted within < 500ms.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_SIZE_BYTES } }))
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
    // Reclaim stale/zombie jobs whose lease expired before checking active jobs
    await this.importJobRepo.reclaimStaleJobs();

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

    // 7. Create PENDING job in MongoDB (with E11000 race-condition handling - B-DB-03 / SF-ARCH-03)
    let job;
    try {
      job = await this.importJobRepo.create({
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
    } catch (err: any) {
      try {
        await this.storageService.deleteObjects([s3Key]);
      } catch (cleanupErr: unknown) {
        this.logger.warn(`Failed to cleanup s3 file on error: ${cleanupErr}`);
      }

      if (
        err?.code === 11000 ||
        err?.message?.includes('11000') ||
        err?.message?.includes('idx_import_jobs_active_shop_unique') ||
        err?.message?.includes('idx_import_jobs_shop_active_unique')
      ) {
        throw new ConflictException({
          code: 'PRODUCT_IMPORT_JOB_RUNNING',
          message: 'Gian hàng đang có tiến trình nhập sản phẩm đang xử lý. Vui lòng chờ hoàn tất.',
        });
      }
      throw err;
    }

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

  /**
   * Tracks real-time progress of an import job (FR-IM-06, AC-IM-16, AC-IM-18).
   * Enforces Zero-Trust IDOR check: returns 404 PRODUCT_NOT_FOUND if job does not exist
   * or does not belong to the calling shop.
   */
  @Get('jobs/:jobId')
  async getJobProgress(
    @Param('jobId') jobId: string,
    @ShopScope() shopScope: string,
    @Actor() actor: ActorContext,
  ): Promise<ImportJobResponseDto> {
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

    if (!UUID_REGEX.test(jobId)) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'Mã tác vụ jobId không đúng định dạng UUID.',
      });
    }

    let job = this.importJobRepo.findByShopAndId
      ? await this.importJobRepo.findByShopAndId(actorShopScope, jobId)
      : await this.importJobRepo.findById(jobId);
    if (!job || job.shop_id !== actorShopScope) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy tác vụ.',
      });
    }

    // Auto-reclaim stale job on poll if worker heartbeat timeout or stuck PENDING (Review 5 SF-01)
    const now = new Date();
    const isStaleProcessing =
      job.status === ImportJobStatus.PROCESSING && job.locked_until && job.locked_until <= now;
    const isStalePending =
      job.status === ImportJobStatus.PENDING &&
      job.created_at &&
      now.getTime() - new Date(job.created_at).getTime() > 15 * 60 * 1000;

    if (isStaleProcessing || isStalePending) {
      if (typeof this.importJobRepo.reclaimStaleJobs === 'function') {
        await this.importJobRepo.reclaimStaleJobs(now);
      }
      const reloaded = this.importJobRepo.findByShopAndId
        ? await this.importJobRepo.findByShopAndId(actorShopScope, jobId)
        : await this.importJobRepo.findById(jobId);
      if (reloaded) {
        job = reloaded;
      }
    }

    return ImportJobResponseDto.fromDocument(job);
  }

  /**
   * Downloads error result report for an import job (FR-IM-06, AC-IM-17, AC-IM-18).
   * Zero-Trust IDOR check -> 404 NOT_FOUND.
   * Job must be COMPLETED or FAILED, and must have error_count > 0.
   * Content negotiation:
   * - If Accept header contains 'application/json': returns JSON with presigned download URL.
   * - Otherwise: streams binary .xlsx file directly as attachment.
   */
  @Get('jobs/:jobId/result')
  @SkipEnvelope()
  async getJobResult(
    @Param('jobId') jobId: string,
    @ShopScope() shopScope: string,
    @Actor() actor: ActorContext,
    @Req() req: Request,
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

    if (!UUID_REGEX.test(jobId)) {
      throw new BadRequestException({
        code: 'PRODUCT_INVALID_INPUT',
        message: 'Mã tác vụ jobId không đúng định dạng UUID.',
      });
    }

    const job = this.importJobRepo.findByShopAndId
      ? await this.importJobRepo.findByShopAndId(actorShopScope, jobId)
      : await this.importJobRepo.findById(jobId);
    if (!job || job.shop_id !== actorShopScope) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Không tìm thấy tác vụ.',
      });
    }

    if (job.status !== ImportJobStatus.COMPLETED && job.status !== ImportJobStatus.FAILED) {
      throw new BadRequestException({
        code: 'PRODUCT_IMPORT_JOB_NOT_FINISHED',
        message: 'Tác vụ đang được xử lý, chưa thể xuất báo cáo kết quả.',
      });
    }

    if (
      job.status !== ImportJobStatus.FAILED &&
      (job.error_count === 0 || !job.error_summary || job.error_summary.length === 0)
    ) {
      throw new BadRequestException({
        code: 'PRODUCT_IMPORT_NO_ERRORS',
        message: 'Tác vụ đã hoàn tất thành công 100%, không có dòng lỗi nào cần xuất báo cáo.',
      });
    }

    const acceptHeader = (req?.headers?.accept || '').toLowerCase();
    const wantsJson = acceptHeader.includes('application/json');

    if (wantsJson) {
      let downloadUrl: string;
      let expiresAt: Date | string;

      if (job.result_file_url) {
        const presigned = await this.storageService.generatePresignedDownloadUrl(
          job.result_file_url,
          1800,
        );
        downloadUrl = presigned.downloadUrl;
        expiresAt = presigned.expiresAt;
      } else if (this.excelResultService) {
        const uploadResult = await this.excelResultService.generateAndUploadResultFile(job);
        downloadUrl = uploadResult.downloadUrl;
        expiresAt = uploadResult.expiresAt;
      } else {
        const fallbackPresigned = await this.storageService.generatePresignedDownloadUrl(
          `imports/shop-${job.shop_id}/${job._id}-errors.xlsx`,
          1800,
        );
        downloadUrl = fallbackPresigned.downloadUrl;
        expiresAt = fallbackPresigned.expiresAt;
      }

      const resultDto: ImportJobResultResponseDto = {
        job_id: job._id,
        result_file_url: downloadUrl,
        total_rows: job.total_rows ?? 0,
        success_count: job.success_count ?? 0,
        error_count: job.error_count ?? 0,
        expires_at: expiresAt,
      };

      const requestId =
        TraceContextStorage.getRequestId() || (req?.headers?.['x-request-id'] as string) || '';

      res.status(HttpStatus.OK).json({
        data: resultDto,
        meta: {
          request_id: requestId,
          as_of: new Date().toISOString(),
        },
      });
      return;
    }

    // Direct binary download (.xlsx)
    if (!this.excelResultService) {
      throw new BadRequestException({
        code: 'PRODUCT_IMPORT_SERVICE_UNAVAILABLE',
        message: 'Dịch vụ xuất file Excel chưa sẵn sàng.',
      });
    }

    const buffer = await this.excelResultService.generateResultBuffer(job);
    const filename = `import_errors_${jobId}.xlsx`;

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    });

    res.status(HttpStatus.OK).send(buffer);
  }
}
