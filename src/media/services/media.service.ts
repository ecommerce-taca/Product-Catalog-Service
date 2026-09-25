import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { ProductMediaRepositoryPort } from '../repositories/product-media.repository.interface';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { TransactionRunner } from '../../database/transaction.runner';
import {
  MediaScope,
  MediaStatus,
  ProductMediaDocument,
} from '../../database/schemas/product-media.schema';
import { MAX_IMAGE_SIZE_BYTES, MAX_VIDEO_SIZE_BYTES, UploadUrlDto } from '../dtos/upload-url.dto';
import { CompleteUploadDto } from '../dtos/complete-upload.dto';
import {
  CompleteUploadResponseDto,
  ProductMediaItemDto,
  UploadUrlResponseDto,
} from '../dtos/media-response.dto';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4']);
const EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
};

const SHA256_REGEX = /^[0-9a-fA-F]{64}$/;

@Injectable()
export class MediaService {
  constructor(
    @Inject('ProductRepositoryPort')
    private readonly productRepository: ProductRepositoryPort,
    @Inject('SkuRepositoryPort')
    private readonly skuRepository: SkuRepositoryPort,
    @Inject('ProductMediaRepositoryPort')
    private readonly mediaRepository: ProductMediaRepositoryPort,
    private readonly storageService: S3StorageService,
    private readonly transactionRunner: TransactionRunner,
  ) {}

  /**
   * Request Presigned S3/MinIO upload URL for product media.
   * Performs IDOR checks, SKU validation, quota enforcement, and validates media limits.
   */
  async requestUploadUrl(
    shopId: string,
    productId: string,
    actorUserId: string,
    dto: UploadUrlDto,
  ): Promise<UploadUrlResponseDto> {
    if (!shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    // 1. Verify SPU exists and belongs to shopId (IDOR defense)
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'PRODUCT_NOT_FOUND',
      });
    }
    if (product.shop_id !== shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    // 2. If sku_id is provided, verify it belongs to this product
    if (dto.sku_id) {
      const sku = await this.skuRepository.findById(dto.sku_id);
      if (!sku || sku.product_id !== productId) {
        throw new BadRequestException({
          code: 'PRODUCT_SKU_INVALID',
          message: 'PRODUCT_SKU_INVALID',
        });
      }
    }

    // 3. Validate content-type and size limits
    const isImage = IMAGE_TYPES.has(dto.content_type);
    const isVideo = VIDEO_TYPES.has(dto.content_type);

    if (!isImage && !isVideo) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'PRODUCT_MEDIA_INVALID',
      });
    }

    if (isImage && (dto.size_bytes <= 0 || dto.size_bytes > MAX_IMAGE_SIZE_BYTES)) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'PRODUCT_MEDIA_INVALID',
      });
    }

    if (isVideo && (dto.size_bytes <= 0 || dto.size_bytes > MAX_VIDEO_SIZE_BYTES)) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'PRODUCT_MEDIA_INVALID',
      });
    }

    // 4. Validate sha256 checksum format
    if (!dto.sha256 || !SHA256_REGEX.test(dto.sha256)) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'PRODUCT_MEDIA_INVALID',
      });
    }

    // 5. Enforce Media Quota: max 12 images, max 3 videos (excluding DELETED)
    if (isImage) {
      const activeImages = await this.mediaRepository.countActiveImages(productId);
      if (activeImages >= 12) {
        throw new ConflictException({
          code: 'PRODUCT_MEDIA_LIMIT_EXCEEDED',
          message: 'PRODUCT_MEDIA_LIMIT_EXCEEDED',
        });
      }
    } else if (isVideo) {
      const activeVideos = await this.mediaRepository.countActiveVideos(productId);
      if (activeVideos >= 3) {
        throw new ConflictException({
          code: 'PRODUCT_MEDIA_LIMIT_EXCEEDED',
          message: 'PRODUCT_MEDIA_LIMIT_EXCEEDED',
        });
      }
    }

    // 6. Generate UUIDv7 mediaId, extension, and server-controlled object key
    const mediaId = uuidv7();
    const ext = EXTENSION_MAP[dto.content_type] || 'bin';
    const objectKey = `products/shop-${shopId}/product-${productId}/media-${mediaId}.${ext}`;

    // 7. Request presigned upload URL from storage integration
    const { uploadUrl, expiresAt } = await this.storageService.generatePresignedUploadUrl(
      objectKey,
      dto.content_type,
      dto.size_bytes,
    );

    // 8. Persist product_media record with UPLOADING status
    await this.mediaRepository.create({
      _id: mediaId,
      product_id: productId,
      sku_id: dto.sku_id || null,
      scope: dto.scope || (dto.sku_id ? MediaScope.SKU : MediaScope.SPU),
      object_key: objectKey,
      content_type: dto.content_type,
      size_bytes: dto.size_bytes,
      sha256: dto.sha256.toLowerCase(),
      sort_order: dto.sort_order ?? 0,
      is_cover: Boolean(dto.is_cover),
      status: MediaStatus.UPLOADING,
      uploaded_by: actorUserId,
    });

    return {
      media_id: mediaId,
      object_key: objectKey,
      upload_url: uploadUrl,
      expires_at: expiresAt.toISOString(),
      status: MediaStatus.UPLOADING,
    };
  }

  /**
   * Complete media upload after client directly uploads to S3/MinIO.
   * Verifies object exists in storage, checks metadata/checksum, and atomically marks READY.
   */
  async completeUpload(
    shopId: string,
    productId: string,
    _actorUserId: string,
    dto: CompleteUploadDto,
  ): Promise<CompleteUploadResponseDto> {
    if (!shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    // 1. Verify SPU ownership (IDOR defense)
    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'PRODUCT_NOT_FOUND',
      });
    }
    if (product.shop_id !== shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    // 2. Find product_media record
    const media = await this.mediaRepository.findByProductIdAndMediaId(productId, dto.media_id);
    if (!media) {
      throw new NotFoundException({
        code: 'PRODUCT_MEDIA_NOT_FOUND',
        message: 'PRODUCT_MEDIA_NOT_FOUND',
      });
    }

    // 3. Verify object_key and sha256 match
    if (
      media.object_key !== dto.object_key ||
      media.sha256.toLowerCase() !== dto.sha256.toLowerCase()
    ) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'PRODUCT_MEDIA_INVALID',
      });
    }

    // 4. Verify object in S3/MinIO
    const verification = await this.storageService.verifyObjectUploaded(
      media.object_key,
      media.sha256,
      media.size_bytes,
    );
    if (!verification.verified) {
      throw new BadRequestException({
        code: 'PRODUCT_MEDIA_INVALID',
        message: 'PRODUCT_MEDIA_INVALID',
      });
    }

    // 5. Atomic transaction: if cover is true, unset other covers and mark READY
    await this.transactionRunner.execute(async (session) => {
      if (media.is_cover) {
        await this.mediaRepository.unsetOtherCovers(productId, media._id, session);
      }
      await this.mediaRepository.updateStatus(
        media._id,
        productId,
        MediaStatus.READY,
        undefined,
        session,
      );
    });

    const publicUrl = this.storageService.getPublicUrl(media.object_key);

    return {
      media_id: media._id,
      status: MediaStatus.READY,
      url: publicUrl,
    };
  }

  /**
   * List non-deleted media for a product, sorted by sort_order.
   */
  async listMedia(shopId: string, productId: string): Promise<ProductMediaItemDto[]> {
    if (!shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'PRODUCT_NOT_FOUND',
      });
    }
    if (product.shop_id !== shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    const items = await this.mediaRepository.findByProductId(productId);
    return items.map((item) => this.mapToItemDto(item));
  }

  /**
   * Soft-delete media by setting status to DELETED and unsetting cover.
   */
  async deleteMedia(
    shopId: string,
    productId: string,
    mediaId: string,
  ): Promise<{ success: boolean }> {
    if (!shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    const product = await this.productRepository.findById(productId);
    if (!product) {
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'PRODUCT_NOT_FOUND',
      });
    }
    if (product.shop_id !== shopId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'FORBIDDEN',
      });
    }

    const media = await this.mediaRepository.findByProductIdAndMediaId(productId, mediaId);
    if (!media) {
      throw new NotFoundException({
        code: 'PRODUCT_MEDIA_NOT_FOUND',
        message: 'PRODUCT_MEDIA_NOT_FOUND',
      });
    }

    await this.mediaRepository.updateStatus(mediaId, productId, MediaStatus.DELETED, {
      is_cover: false,
    });

    return { success: true };
  }

  private mapToItemDto(item: ProductMediaDocument): ProductMediaItemDto {
    return {
      media_id: item._id,
      product_id: item.product_id,
      sku_id: item.sku_id,
      scope: item.scope,
      object_key: item.object_key,
      content_type: item.content_type,
      size_bytes: item.size_bytes,
      sha256: item.sha256,
      sort_order: item.sort_order,
      is_cover: item.is_cover,
      status: item.status,
      url: this.storageService.getPublicUrl(item.object_key),
      uploaded_by: item.uploaded_by,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
}
