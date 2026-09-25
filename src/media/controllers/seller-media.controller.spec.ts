import { Test, TestingModule } from '@nestjs/testing';
import { SellerMediaController } from './seller-media.controller';
import { MediaService } from '../services/media.service';
import { ActorContext } from '../../common/context/actor-context.interface';
import { MediaScope } from '../../database/schemas/product-media.schema';
import { UploadUrlDto } from '../dtos/upload-url.dto';
import { CompleteUploadDto } from '../dtos/complete-upload.dto';

describe('SellerMediaController', () => {
  let controller: SellerMediaController;
  let mockMediaService: jest.Mocked<Partial<MediaService>>;

  const shopId = '01912f20-7a1b-7c12-9c55-8b1c34a6d920';
  const productId = '01912f20-7a1b-7c12-9c55-8b1c34a6d921';
  const mediaId = '01912f20-7a1b-7c12-9c55-8b1c34a6d922';
  const userId = '01912f20-7a1b-7c12-9c55-8b1c34a6d923';

  const mockActor: ActorContext = {
    userId,
    roles: ['SELLER'],
    permissions: ['catalog:product:write', 'catalog:product:read'],
    shopScope: shopId,
    isAuthenticated: true,
  };

  beforeEach(async () => {
    mockMediaService = {
      requestUploadUrl: jest.fn().mockResolvedValue({
        media_id: mediaId,
        object_key: `products/shop-${shopId}/product-${productId}/media-${mediaId}.webp`,
        upload_url: 'http://localhost:9000/signed-upload',
        expires_at: new Date().toISOString(),
        status: 'UPLOADING',
      }),
      completeUpload: jest.fn().mockResolvedValue({
        media_id: mediaId,
        status: 'READY',
        url: 'http://localhost:9000/media.webp',
      }),
      listMedia: jest.fn().mockResolvedValue([
        {
          media_id: mediaId,
          product_id: productId,
          sku_id: null,
          scope: 'SPU',
          object_key: 'key.webp',
          content_type: 'image/webp',
          size_bytes: 1024,
          sha256: 'abc',
          sort_order: 0,
          is_cover: true,
          status: 'READY',
          url: 'http://localhost:9000/media.webp',
          uploaded_by: userId,
          created_at: new Date(),
          updated_at: new Date(),
        },
      ]),
      deleteMedia: jest.fn().mockResolvedValue({ success: true }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerMediaController],
      providers: [
        {
          provide: MediaService,
          useValue: mockMediaService,
        },
      ],
    }).compile();

    controller = module.get<SellerMediaController>(SellerMediaController);
  });

  describe('requestUploadUrl', () => {
    it('should forward request to mediaService.requestUploadUrl with shopScope', async () => {
      const dto: UploadUrlDto = {
        content_type: 'image/webp',
        size_bytes: 1024,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        scope: MediaScope.SPU,
      };

      const result = await controller.requestUploadUrl(productId, mockActor, shopId, dto);

      expect(result).toBeDefined();
      expect(result.media_id).toBe(mediaId);
      expect(mockMediaService.requestUploadUrl).toHaveBeenCalledWith(
        shopId,
        productId,
        userId,
        dto,
      );
    });

    it('should fallback to actor.shopScope when shopScope param is empty', async () => {
      const dto: UploadUrlDto = {
        content_type: 'image/png',
        size_bytes: 2048,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      };

      await controller.requestUploadUrl(productId, mockActor, '', dto);

      expect(mockMediaService.requestUploadUrl).toHaveBeenCalledWith(
        shopId,
        productId,
        userId,
        dto,
      );
    });

    it('should forward request to mediaService when actor has SELLER_STAFF role', async () => {
      const staffActor: ActorContext = {
        userId,
        roles: ['SELLER_STAFF'],
        permissions: ['catalog:product:write'],
        shopScope: shopId,
        isAuthenticated: true,
      };
      const dto: UploadUrlDto = {
        content_type: 'image/webp',
        size_bytes: 1024,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        scope: MediaScope.SPU,
      };

      const result = await controller.requestUploadUrl(productId, staffActor, shopId, dto);

      expect(result).toBeDefined();
      expect(result.media_id).toBe(mediaId);
      expect(mockMediaService.requestUploadUrl).toHaveBeenCalledWith(
        shopId,
        productId,
        userId,
        dto,
      );
    });
  });

  describe('completeUpload', () => {
    it('should call mediaService.completeUpload', async () => {
      const dto: CompleteUploadDto = {
        media_id: mediaId,
        object_key: 'test-key',
        sha256: 'abc',
      };

      const result = await controller.completeUpload(productId, mockActor, shopId, dto);

      expect(result.status).toBe('READY');
      expect(mockMediaService.completeUpload).toHaveBeenCalledWith(shopId, productId, userId, dto);
    });
  });

  describe('listMedia', () => {
    it('should call mediaService.listMedia', async () => {
      const result = await controller.listMedia(productId, mockActor, shopId);

      expect(result).toHaveLength(1);
      expect(mockMediaService.listMedia).toHaveBeenCalledWith(shopId, productId);
    });
  });

  describe('deleteMedia', () => {
    it('should call mediaService.deleteMedia', async () => {
      const result = await controller.deleteMedia(productId, mediaId, mockActor, shopId);

      expect(result).toEqual({ success: true });
      expect(mockMediaService.deleteMedia).toHaveBeenCalledWith(shopId, productId, mediaId);
    });
  });
});
