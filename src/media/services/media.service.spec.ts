import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { MediaService } from './media.service';
import { ProductRepositoryPort } from '../../product/repositories/product.repository.interface';
import { SkuRepositoryPort } from '../../sku/repositories/sku.repository.interface';
import { ProductMediaRepositoryPort } from '../repositories/product-media.repository.interface';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { TransactionRunner } from '../../database/transaction.runner';
import { ClientSession } from 'mongoose';
import { ProductDocument } from '../../database/schemas/product.schema';
import { SkuDocument } from '../../database/schemas/sku.schema';
import {
  MediaScope,
  MediaStatus,
  ProductMediaDocument,
} from '../../database/schemas/product-media.schema';
import { UploadUrlDto } from '../dtos/upload-url.dto';
import { CompleteUploadDto } from '../dtos/complete-upload.dto';

type MockType<T> = {
  [P in keyof T]?: jest.Mock;
};

describe('MediaService', () => {
  let service: MediaService;
  let mockProductRepo: MockType<ProductRepositoryPort>;
  let mockSkuRepo: MockType<SkuRepositoryPort>;
  let mockMediaRepo: MockType<ProductMediaRepositoryPort>;
  let mockStorageService: MockType<S3StorageService>;
  let mockTransactionRunner: MockType<TransactionRunner>;

  const shopId = '01912f20-7a1b-7c12-9c55-8b1c34a6d920';
  const otherShopId = '01912f20-7a1b-7c12-9c55-8b1c34a6d999';
  const productId = '01912f20-7a1b-7c12-9c55-8b1c34a6d921';
  const skuId = '01912f20-7a1b-7c12-9c55-8b1c34a6d922';
  const actorUserId = '01912f20-7a1b-7c12-9c55-8b1c34a6d923';
  const validSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const mockProduct = {
    _id: productId,
    shop_id: shopId,
    title: 'Test SPU',
    status: 'DRAFT',
  } as unknown as ProductDocument;

  beforeEach(async () => {
    mockProductRepo = {
      findById: jest.fn().mockResolvedValue(mockProduct),
    };

    mockSkuRepo = {
      findById: jest.fn().mockResolvedValue({
        _id: skuId,
        product_id: productId,
        shop_id: shopId,
      } as unknown as SkuDocument),
    };

    mockMediaRepo = {
      create: jest
        .fn()
        .mockImplementation((doc) => Promise.resolve(doc as unknown as ProductMediaDocument)),
      findByProductId: jest.fn().mockResolvedValue([]),
      findByProductIdAndMediaId: jest.fn(),
      countActiveImages: jest.fn().mockResolvedValue(0),
      countActiveVideos: jest.fn().mockResolvedValue(0),
      unsetOtherCovers: jest.fn().mockResolvedValue(undefined),
      updateStatus: jest.fn().mockResolvedValue(undefined),
    };

    mockStorageService = {
      generatePresignedUploadUrl: jest.fn().mockResolvedValue({
        uploadUrl: 'http://localhost:9000/test-bucket/products/upload-signed',
        expiresAt: new Date(Date.now() + 600000),
      }),
      verifyObjectUploaded: jest.fn().mockResolvedValue({
        verified: true,
        actualSize: 1024,
        etag: 'mock-etag',
      }),
      getPublicUrl: jest.fn((key: string) => `http://localhost:9000/test-bucket/${key}`),
    };

    mockTransactionRunner = {
      execute: jest
        .fn()
        .mockImplementation(async (work: (session: ClientSession) => Promise<unknown>) =>
          work({} as ClientSession),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MediaService,
        { provide: 'ProductRepositoryPort', useValue: mockProductRepo },
        { provide: 'SkuRepositoryPort', useValue: mockSkuRepo },
        { provide: 'ProductMediaRepositoryPort', useValue: mockMediaRepo },
        { provide: S3StorageService, useValue: mockStorageService },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
      ],
    }).compile();

    service = module.get<MediaService>(MediaService);
  });

  describe('requestUploadUrl', () => {
    const validImageDto: UploadUrlDto = {
      content_type: 'image/webp',
      size_bytes: 524288,
      sha256: validSha256,
      is_cover: true,
      scope: MediaScope.SPU,
    };

    it('should generate a presigned upload URL and create a product_media record', async () => {
      const result = await service.requestUploadUrl(shopId, productId, actorUserId, validImageDto);

      expect(result).toBeDefined();
      expect(result.media_id).toBeDefined();
      expect(result.object_key).toContain(`products/shop-${shopId}/product-${productId}/media-`);
      expect(result.object_key).toMatch(/\.webp$/);
      expect(result.upload_url).toBeDefined();
      expect(result.status).toBe(MediaStatus.UPLOADING);

      expect(mockMediaRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          product_id: productId,
          content_type: 'image/webp',
          size_bytes: 524288,
          status: MediaStatus.UPLOADING,
          is_cover: true,
          uploaded_by: actorUserId,
        }),
      );
    });

    it('should reject when product does not exist (404)', async () => {
      mockProductRepo.findById!.mockResolvedValueOnce(null);

      await expect(
        service.requestUploadUrl(shopId, 'non-existent', actorUserId, validImageDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject with 403 when product belongs to another shop (IDOR defense)', async () => {
      await expect(
        service.requestUploadUrl(otherShopId, productId, actorUserId, validImageDto),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject with 400 when sku_id does not belong to product', async () => {
      mockSkuRepo.findById!.mockResolvedValueOnce({
        _id: 'other-sku',
        product_id: 'other-product-id',
      } as unknown as SkuDocument);

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, {
          ...validImageDto,
          sku_id: 'other-sku',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should enforce image quota limit of 12 images (409 Conflict)', async () => {
      mockMediaRepo.countActiveImages!.mockResolvedValueOnce(12);

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, validImageDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should enforce video quota limit of 3 videos (409 Conflict)', async () => {
      mockMediaRepo.countActiveVideos!.mockResolvedValueOnce(3);

      const videoDto: UploadUrlDto = {
        content_type: 'video/mp4',
        size_bytes: 10485760,
        sha256: validSha256,
      };

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, videoDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should reject unsupported content_type (400 Bad Request)', async () => {
      const invalidDto: UploadUrlDto = {
        content_type: 'application/pdf',
        size_bytes: 1024,
        sha256: validSha256,
      };

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, invalidDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject image exceeding 20 MiB limit (400 Bad Request)', async () => {
      const oversizedImageDto: UploadUrlDto = {
        content_type: 'image/jpeg',
        size_bytes: 20 * 1024 * 1024 + 1,
        sha256: validSha256,
      };

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, oversizedImageDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject video exceeding 200 MiB limit (400 Bad Request)', async () => {
      const oversizedVideoDto: UploadUrlDto = {
        content_type: 'video/mp4',
        size_bytes: 200 * 1024 * 1024 + 1,
        sha256: validSha256,
      };

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, oversizedVideoDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject invalid sha256 checksum format (400 Bad Request)', async () => {
      const invalidShaDto: UploadUrlDto = {
        content_type: 'image/png',
        size_bytes: 1024,
        sha256: 'not-a-valid-sha256',
      };

      await expect(
        service.requestUploadUrl(shopId, productId, actorUserId, invalidShaDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('completeUpload', () => {
    const mediaId = '01912f20-7a1b-7c12-9c55-8b1c34a6d930';
    const objectKey = `products/shop-${shopId}/product-${productId}/media-${mediaId}.webp`;

    const existingMedia = {
      _id: mediaId,
      product_id: productId,
      object_key: objectKey,
      sha256: validSha256,
      size_bytes: 1024,
      is_cover: true,
      status: MediaStatus.UPLOADING,
    } as ProductMediaDocument;

    const completeDto: CompleteUploadDto = {
      media_id: mediaId,
      object_key: objectKey,
      sha256: validSha256,
    };

    it('should complete upload, replace other covers when is_cover is true, and mark READY', async () => {
      mockMediaRepo.findByProductIdAndMediaId!.mockResolvedValueOnce(existingMedia);

      const result = await service.completeUpload(shopId, productId, actorUserId, completeDto);

      expect(result).toBeDefined();
      expect(result.media_id).toBe(mediaId);
      expect(result.status).toBe(MediaStatus.READY);
      expect(result.url).toContain(objectKey);

      expect(mockStorageService.verifyObjectUploaded).toHaveBeenCalledWith(
        objectKey,
        validSha256,
        1024,
      );
      expect(mockMediaRepo.unsetOtherCovers).toHaveBeenCalledWith(
        productId,
        mediaId,
        expect.anything(),
      );
      expect(mockMediaRepo.updateStatus).toHaveBeenCalledWith(
        mediaId,
        productId,
        MediaStatus.READY,
        undefined,
        expect.anything(),
      );
    });

    it('should reject if media is not found (404)', async () => {
      mockMediaRepo.findByProductIdAndMediaId!.mockResolvedValueOnce(null);

      await expect(
        service.completeUpload(shopId, productId, actorUserId, completeDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should reject if object_key or sha256 mismatch (400)', async () => {
      mockMediaRepo.findByProductIdAndMediaId!.mockResolvedValueOnce(existingMedia);

      await expect(
        service.completeUpload(shopId, productId, actorUserId, {
          ...completeDto,
          object_key: 'wrong-key',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if storage verification fails (400)', async () => {
      mockMediaRepo.findByProductIdAndMediaId!.mockResolvedValueOnce(existingMedia);
      mockStorageService.verifyObjectUploaded!.mockResolvedValueOnce({ verified: false });

      await expect(
        service.completeUpload(shopId, productId, actorUserId, completeDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('listMedia', () => {
    it('should return all non-deleted media with resolved URLs', async () => {
      const mockItems = [
        {
          _id: 'media-1',
          product_id: productId,
          object_key: 'key-1.jpg',
          content_type: 'image/jpeg',
          size_bytes: 1000,
          sha256: validSha256,
          sort_order: 0,
          is_cover: true,
          status: MediaStatus.READY,
        },
      ] as unknown as ProductMediaDocument[];

      mockMediaRepo.findByProductId!.mockResolvedValueOnce(mockItems);

      const result = await service.listMedia(shopId, productId);

      expect(result).toHaveLength(1);
      expect(result[0].media_id).toBe('media-1');
      expect(result[0].url).toContain('key-1.jpg');
    });

    it('should reject listMedia when product belongs to another shop (IDOR)', async () => {
      await expect(service.listMedia(otherShopId, productId)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('deleteMedia', () => {
    it('should mark media as DELETED and unset cover', async () => {
      mockMediaRepo.findByProductIdAndMediaId!.mockResolvedValueOnce({
        _id: 'media-1',
        product_id: productId,
      } as unknown as ProductMediaDocument);

      const result = await service.deleteMedia(shopId, productId, 'media-1');

      expect(result).toEqual({ success: true });
      expect(mockMediaRepo.updateStatus).toHaveBeenCalledWith(
        'media-1',
        productId,
        MediaStatus.DELETED,
        { is_cover: false },
      );
    });

    it('should throw 404 when media to delete is not found', async () => {
      mockMediaRepo.findByProductIdAndMediaId!.mockResolvedValueOnce(null);

      await expect(service.deleteMedia(shopId, productId, 'nonexistent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
