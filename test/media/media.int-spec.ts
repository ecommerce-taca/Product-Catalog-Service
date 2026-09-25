import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus, INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import request from 'supertest';
import { FilterQuery } from 'mongoose';
import { SellerMediaController } from '../../src/media/controllers/seller-media.controller';
import { MediaService } from '../../src/media/services/media.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';
import { ResponseEnvelopeInterceptor } from '../../src/common/interceptors/response-envelope.interceptor';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import {
  MediaScope,
  MediaStatus,
  ProductMedia,
  ProductMediaDocument,
} from '../../src/database/schemas/product-media.schema';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuDocument } from '../../src/database/schemas/sku.schema';
import { ProductMediaRepositoryPort } from '../../src/media/repositories/product-media.repository.interface';
import { ProductRepositoryPort } from '../../src/product/repositories/product.repository.interface';
import { SkuRepositoryPort } from '../../src/sku/repositories/sku.repository.interface';

// --- In-Memory Repositories & Test Doubles ---

class InMemoryProductRepository implements Partial<ProductRepositoryPort> {
  private products = new Map<string, ProductDocument>();

  set(product: ProductDocument): void {
    this.products.set(product._id.toString(), product);
  }

  async findById(id: string): Promise<ProductDocument | null> {
    return this.products.get(id) || null;
  }

  clear(): void {
    this.products.clear();
  }
}

class InMemorySkuRepository implements Partial<SkuRepositoryPort> {
  private skus = new Map<string, SkuDocument>();

  set(sku: SkuDocument): void {
    this.skus.set(sku._id.toString(), sku);
  }

  async findById(id: string): Promise<SkuDocument | null> {
    return this.skus.get(id) || null;
  }

  clear(): void {
    this.skus.clear();
  }
}

class InMemoryProductMediaRepository implements ProductMediaRepositoryPort {
  private items = new Map<string, ProductMediaDocument>();

  set(media: ProductMediaDocument): void {
    this.items.set(media._id.toString(), media);
  }

  async create(doc: Partial<ProductMediaDocument>): Promise<ProductMediaDocument> {
    const rawDoc = doc as Record<string, unknown>;
    const created = {
      ...doc,
      created_at: (rawDoc.created_at as Date) || new Date(),
      updated_at: (rawDoc.updated_at as Date) || new Date(),
    } as ProductMediaDocument;
    this.items.set(created._id.toString(), created);
    return created;
  }

  async findById(id: string): Promise<ProductMediaDocument | null> {
    return this.items.get(id) || null;
  }

  async findByProductId(productId: string): Promise<ProductMediaDocument[]> {
    return Array.from(this.items.values())
      .filter((m) => m.product_id === productId && m.status !== MediaStatus.DELETED)
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) {
          return a.sort_order - b.sort_order;
        }
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      });
  }

  async findByProductIdAndMediaId(
    productId: string,
    mediaId: string,
  ): Promise<ProductMediaDocument | null> {
    const item = this.items.get(mediaId);
    if (item && item.product_id === productId) {
      return item;
    }
    return null;
  }

  async countActiveByProductId(
    productId: string,
    filter?: FilterQuery<ProductMediaDocument>,
  ): Promise<number> {
    let list = Array.from(this.items.values()).filter(
      (m) => m.product_id === productId && m.status !== MediaStatus.DELETED,
    );
    if (filter?.content_type) {
      if (typeof filter.content_type === 'string') {
        list = list.filter((m) => m.content_type === filter.content_type);
      } else if (filter.content_type.$in) {
        list = list.filter((m) => filter.content_type.$in.includes(m.content_type));
      }
    }
    return list.length;
  }

  async countActiveImages(productId: string): Promise<number> {
    return this.countActiveByProductId(productId, {
      content_type: { $in: ['image/jpeg', 'image/png', 'image/webp'] },
    } as FilterQuery<ProductMediaDocument>);
  }

  async countActiveVideos(productId: string): Promise<number> {
    return this.countActiveByProductId(productId, {
      content_type: 'video/mp4',
    } as FilterQuery<ProductMediaDocument>);
  }

  async unsetOtherCovers(productId: string, excludeMediaId: string): Promise<void> {
    for (const item of this.items.values()) {
      if (
        item.product_id === productId &&
        item._id.toString() !== excludeMediaId &&
        item.is_cover
      ) {
        item.is_cover = false;
      }
    }
  }

  async updateStatus(
    mediaId: string,
    productId: string,
    status: MediaStatus,
    extraUpdates?: Partial<ProductMedia>,
  ): Promise<ProductMediaDocument | null> {
    const item = await this.findByProductIdAndMediaId(productId, mediaId);
    if (!item) return null;
    item.status = status;
    if (extraUpdates) {
      Object.assign(item, extraUpdates);
    }
    item.updated_at = new Date();
    return item;
  }

  clear(): void {
    this.items.clear();
  }

  // BaseRepository stubs
  async count(_filter?: FilterQuery<ProductMediaDocument>): Promise<number> {
    return this.items.size;
  }
  async update(): Promise<ProductMediaDocument | null> {
    return null;
  }
  async delete(): Promise<boolean> {
    return true;
  }
  async find(): Promise<ProductMediaDocument[]> {
    return Array.from(this.items.values());
  }
  async findOne(): Promise<ProductMediaDocument | null> {
    return null;
  }
}

describe('MediaModule Integration Tests [PCAT-B05]', () => {
  let app: INestApplication;
  let inMemoryProductRepo: InMemoryProductRepository;
  let inMemorySkuRepo: InMemorySkuRepository;
  let inMemoryMediaRepo: InMemoryProductMediaRepository;

  const mockStorageService = {
    generatePresignedUploadUrl: jest.fn().mockImplementation(async (objectKey: string) => ({
      uploadUrl: `https://storage.example.com/${objectKey}?X-Amz-Signature=mockSig123`,
      expiresAt: new Date(Date.now() + 600000),
    })),
    verifyObjectUploaded: jest.fn().mockImplementation(async () => ({
      verified: true,
      actualSize: 1024,
      etag: 'mock-etag',
    })),
    getPublicUrl: jest
      .fn()
      .mockImplementation(
        (objectKey: string) => `https://cdn.example.com/${objectKey.replace(/^\//, '')}`,
      ),
  };

  const mockTransactionRunner = {
    execute: jest
      .fn()
      .mockImplementation(async <T>(work: (session: unknown) => Promise<T>): Promise<T> =>
        work({}),
      ),
  };

  // Common Test Fixtures
  const shopId = '01912f20-7a1b-7c12-9c55-8b1c34a6d920';
  const otherShopId = '01912f20-7a1b-7c12-9c55-8b1c34a6d999';
  const productId = '01912f20-7a1b-7c12-9c55-8b1c34a6d921';
  const otherProductId = '01912f20-7a1b-7c12-9c55-8b1c34a6d922';
  const skuId = '01912f20-7a1b-7c12-9c55-8b1c34a6d923';
  const otherSkuId = '01912f20-7a1b-7c12-9c55-8b1c34a6d924';
  const userId = '01912f20-7a1b-7c12-9c55-8b1c34a6d925';

  const validSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  const defaultHeaders = {
    'x-user-id': userId,
    'x-user-roles': 'SELLER',
    'x-user-permissions': 'catalog:product:write,catalog:product:read',
    'x-user-shop-scope': shopId,
  };

  beforeAll(async () => {
    inMemoryProductRepo = new InMemoryProductRepository();
    inMemorySkuRepo = new InMemorySkuRepository();
    inMemoryMediaRepo = new InMemoryProductMediaRepository();

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SellerMediaController],
      providers: [
        MediaService,
        { provide: 'ProductRepositoryPort', useValue: inMemoryProductRepo },
        { provide: 'SkuRepositoryPort', useValue: inMemorySkuRepo },
        { provide: 'ProductMediaRepositoryPort', useValue: inMemoryMediaRepo },
        { provide: S3StorageService, useValue: mockStorageService },
        { provide: TransactionRunner, useValue: mockTransactionRunner },
        Reflector,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new ActorContextGuard(reflector));
    app.useGlobalInterceptors(new ResponseEnvelopeInterceptor(reflector));
    app.useGlobalFilters(new GlobalExceptionFilter());

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    inMemoryProductRepo.clear();
    inMemorySkuRepo.clear();
    inMemoryMediaRepo.clear();
    jest.clearAllMocks();

    // Default Seed Data
    inMemoryProductRepo.set({
      _id: productId,
      shop_id: shopId,
      title: 'Áo thun nam Taca',
      status: 'DRAFT',
    } as unknown as ProductDocument);

    inMemoryProductRepo.set({
      _id: otherProductId,
      shop_id: otherShopId,
      title: 'Sản phẩm của Shop khác',
      status: 'ACTIVE',
    } as unknown as ProductDocument);

    inMemorySkuRepo.set({
      _id: skuId,
      product_id: productId,
      shop_id: shopId,
    } as unknown as SkuDocument);

    inMemorySkuRepo.set({
      _id: otherSkuId,
      product_id: otherProductId,
      shop_id: otherShopId,
    } as unknown as SkuDocument);
  });

  // =========================================================================
  // 1. PC-API-036: POST /seller/products/:productId/media/upload-url
  // =========================================================================
  describe('PC-API-036: POST /seller/products/:productId/media/upload-url', () => {
    it('1.1 should generate signed upload URL for valid JPEG image (<= 20 MiB)', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 5 * 1024 * 1024, // 5 MiB
        sha256: validSha256,
        scope: MediaScope.SPU,
        is_cover: true,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.data).toBeDefined();
      expect(res.body.data.media_id).toBeDefined();
      expect(res.body.data.status).toBe(MediaStatus.UPLOADING);
      expect(res.body.data.upload_url).toContain('https://storage.example.com/');
      expect(res.body.data.object_key).toBe(
        `products/shop-${shopId}/product-${productId}/media-${res.body.data.media_id}.jpg`,
      );
      expect(res.body.data.expires_at).toBeDefined();

      // Verify persisted in repository
      const saved = await inMemoryMediaRepo.findById(res.body.data.media_id);
      expect(saved).toBeDefined();
      expect(saved?.status).toBe(MediaStatus.UPLOADING);
      expect(saved?.is_cover).toBe(true);
      expect(saved?.content_type).toBe('image/jpeg');
    });

    it('1.2 should generate signed upload URL for valid PNG image', async () => {
      const payload = {
        content_type: 'image/png',
        size_bytes: 2 * 1024 * 1024,
        sha256: validSha256,
        scope: MediaScope.SPU,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.data.object_key).toMatch(/\.png$/);
    });

    it('1.3 should generate signed upload URL for valid WebP image', async () => {
      const payload = {
        content_type: 'image/webp',
        size_bytes: 1024 * 1024,
        sha256: validSha256,
        scope: MediaScope.SPU,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.data.object_key).toMatch(/\.webp$/);
    });

    it('1.4 should generate signed upload URL for valid MP4 video (<= 200 MiB)', async () => {
      const payload = {
        content_type: 'video/mp4',
        size_bytes: 150 * 1024 * 1024, // 150 MiB
        sha256: validSha256,
        scope: MediaScope.SPU,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CREATED);
      expect(res.body.data.status).toBe(MediaStatus.UPLOADING);
      expect(res.body.data.object_key).toMatch(/\.mp4$/);
    });

    it('1.5 should accept valid sku_id belonging to the product', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024 * 1024,
        sha256: validSha256,
        scope: MediaScope.SKU,
        sku_id: skuId,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CREATED);
      const saved = await inMemoryMediaRepo.findById(res.body.data.media_id);
      expect(saved?.sku_id).toBe(skuId);
      expect(saved?.scope).toBe(MediaScope.SKU);
    });

    it('1.6 should reject when sku_id belongs to another product (400 PRODUCT_SKU_INVALID)', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024 * 1024,
        sha256: validSha256,
        sku_id: otherSkuId, // Belongs to otherProductId
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_SKU_INVALID');
    });

    it('1.7 should reject invalid content-type e.g. application/pdf (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'application/pdf',
        size_bytes: 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.8 should reject invalid content-type e.g. text/plain (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'text/plain',
        size_bytes: 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.9 should reject image exceeding 20 MiB (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 20 * 1024 * 1024 + 1, // 20 MiB + 1 byte
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.10 should reject image with size_bytes <= 0 (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'image/png',
        size_bytes: 0,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.11 should reject video exceeding 200 MiB (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'video/mp4',
        size_bytes: 200 * 1024 * 1024 + 1, // 200 MiB + 1 byte
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.12 should reject sha256 with insufficient length (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: 'aabbcc', // short sha256
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.13 should reject sha256 with non-hex characters (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: 'z'.repeat(64), // Non-hex characters
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.14 should reject 13th image upload when 12 images already exist (409 PRODUCT_MEDIA_LIMIT_EXCEEDED)', async () => {
      // Seed 12 active images
      for (let i = 0; i < 12; i++) {
        await inMemoryMediaRepo.create({
          _id: `img-seed-${i}`,
          product_id: productId,
          content_type: 'image/jpeg',
          size_bytes: 1024,
          sha256: validSha256,
          status: MediaStatus.READY,
          is_cover: i === 0,
        });
      }

      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_LIMIT_EXCEEDED');
    });

    it('1.15 should reject 4th video upload when 3 videos already exist (409 PRODUCT_MEDIA_LIMIT_EXCEEDED)', async () => {
      // Seed 3 active videos
      for (let i = 0; i < 3; i++) {
        await inMemoryMediaRepo.create({
          _id: `vid-seed-${i}`,
          product_id: productId,
          content_type: 'video/mp4',
          size_bytes: 1024 * 1024,
          sha256: validSha256,
          status: MediaStatus.READY,
        });
      }

      const payload = {
        content_type: 'video/mp4',
        size_bytes: 1024 * 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_LIMIT_EXCEEDED');
    });

    it('1.16 [IDOR Boundary] should reject upload when product belongs to another shop (403 Forbidden)', async () => {
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
      };

      // Seller belongs to otherShopId attempting to upload to productId (belongs to shopId)
      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set({
          ...defaultHeaders,
          'x-user-shop-scope': otherShopId,
        })
        .send(payload);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('1.17 should return 404 when product does not exist (404 PRODUCT_NOT_FOUND)', async () => {
      const nonExistentProductId = '01912f20-7a1b-7c12-9c55-8b1c34a6d000';
      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${nonExistentProductId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('1.18 should reject video when is_cover is true (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        content_type: 'video/mp4',
        size_bytes: 10 * 1024 * 1024,
        sha256: validSha256,
        is_cover: true,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('1.19 should reject upload-url when product is ARCHIVED (409 PRODUCT_ARCHIVED)', async () => {
      inMemoryProductRepo.set({
        _id: productId,
        shop_id: shopId,
        title: 'Archived SPU',
        status: ProductStatus.ARCHIVED,
      } as unknown as ProductDocument);

      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_ARCHIVED');
    });

    it('1.20 should reject upload-url when product is BLOCKED (409 PRODUCT_BLOCKED)', async () => {
      inMemoryProductRepo.set({
        _id: productId,
        shop_id: shopId,
        title: 'Blocked SPU',
        status: ProductStatus.BLOCKED,
      } as unknown as ProductDocument);

      const payload = {
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_BLOCKED');
    });
  });

  // =========================================================================
  // 2. PC-API-038: POST /seller/products/:productId/media/complete
  // =========================================================================
  describe('PC-API-038: POST /seller/products/:productId/media/complete', () => {
    const mediaId = '01912f20-7a1b-7c12-9c55-8b1c34a6d930';
    const objectKey = `products/shop-${shopId}/product-${productId}/media-${mediaId}.webp`;

    beforeEach(async () => {
      await inMemoryMediaRepo.create({
        _id: mediaId,
        product_id: productId,
        object_key: objectKey,
        content_type: 'image/webp',
        size_bytes: 1024,
        sha256: validSha256,
        status: MediaStatus.UPLOADING,
        is_cover: false,
      });
    });

    it('2.1 should complete media upload successfully and transition to READY', async () => {
      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.data.media_id).toBe(mediaId);
      expect(res.body.data.status).toBe(MediaStatus.READY);
      expect(res.body.data.url).toBe(`https://cdn.example.com/${objectKey}`);

      const updated = await inMemoryMediaRepo.findById(mediaId);
      expect(updated?.status).toBe(MediaStatus.READY);
    });

    it('2.2 should unset other covers when completing media with is_cover = true (at most 1 cover READY)', async () => {
      const coverMediaId1 = '01912f20-7a1b-7c12-9c55-8b1c34a6d931';
      const coverMediaId2 = '01912f20-7a1b-7c12-9c55-8b1c34a6d932';

      // Seed first ready cover
      await inMemoryMediaRepo.create({
        _id: coverMediaId1,
        product_id: productId,
        object_key: `products/shop-${shopId}/product-${productId}/media-${coverMediaId1}.jpg`,
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
        status: MediaStatus.READY,
        is_cover: true,
      });

      // Seed second media as UPLOADING with is_cover = true
      await inMemoryMediaRepo.create({
        _id: coverMediaId2,
        product_id: productId,
        object_key: `products/shop-${shopId}/product-${productId}/media-${coverMediaId2}.jpg`,
        content_type: 'image/jpeg',
        size_bytes: 2048,
        sha256: validSha256,
        status: MediaStatus.UPLOADING,
        is_cover: true,
      });

      // Complete coverMediaId2
      const payload = {
        media_id: coverMediaId2,
        object_key: `products/shop-${shopId}/product-${productId}/media-${coverMediaId2}.jpg`,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.data.status).toBe(MediaStatus.READY);

      // Verify media 1 had is_cover unset to false
      const media1 = await inMemoryMediaRepo.findById(coverMediaId1);
      const media2 = await inMemoryMediaRepo.findById(coverMediaId2);

      expect(media1?.is_cover).toBe(false);
      expect(media2?.is_cover).toBe(true);
      expect(media2?.status).toBe(MediaStatus.READY);

      // Verify invariant: Exactly 1 READY cover exists for this product
      const activeMedia = await inMemoryMediaRepo.findByProductId(productId);
      const readyCovers = activeMedia.filter((m) => m.status === MediaStatus.READY && m.is_cover);
      expect(readyCovers.length).toBe(1);
      expect(readyCovers[0]._id).toBe(coverMediaId2);
    });

    it('2.3 should reject complete when media_id does not exist (404 PRODUCT_MEDIA_NOT_FOUND)', async () => {
      const nonExistentMediaId = '01912f20-7a1b-7c12-9c55-8b1c34a6d000';
      const payload = {
        media_id: nonExistentMediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_NOT_FOUND');
    });

    it('2.4 should reject complete when object_key does not match (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        media_id: mediaId,
        object_key: 'products/shop-other/product-other/media-wrong.webp',
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('2.5 should reject complete when sha256 checksum does not match (400 PRODUCT_MEDIA_INVALID)', async () => {
      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: 'f'.repeat(64), // Mismatched sha256
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('2.6 should reject complete when object not uploaded to S3 (verifyObjectUploaded returns false)', async () => {
      mockStorageService.verifyObjectUploaded.mockResolvedValueOnce({
        verified: false,
      });

      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');

      // Verify status remains UPLOADING (not READY)
      const unchanged = await inMemoryMediaRepo.findById(mediaId);
      expect(unchanged?.status).toBe(MediaStatus.UPLOADING);
    });

    it('2.7 [IDOR Boundary] should reject complete when product belongs to another shop (403 Forbidden)', async () => {
      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set({
          ...defaultHeaders,
          'x-user-shop-scope': otherShopId,
        })
        .send(payload);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('2.8 should return 404 when product does not exist on complete', async () => {
      const nonExistentProductId = '01912f20-7a1b-7c12-9c55-8b1c34a6d000';
      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${nonExistentProductId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('2.9 should reject complete when media status is not UPLOADING (400 PRODUCT_MEDIA_INVALID)', async () => {
      // Set media status to READY
      await inMemoryMediaRepo.updateStatus(mediaId, productId, MediaStatus.READY);

      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_INVALID');
    });

    it('2.10 should reject complete when product is ARCHIVED (409 PRODUCT_ARCHIVED)', async () => {
      inMemoryProductRepo.set({
        _id: productId,
        shop_id: shopId,
        title: 'Archived SPU',
        status: ProductStatus.ARCHIVED,
      } as unknown as ProductDocument);

      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_ARCHIVED');
    });

    it('2.11 should reject complete when product is BLOCKED (409 PRODUCT_BLOCKED)', async () => {
      inMemoryProductRepo.set({
        _id: productId,
        shop_id: shopId,
        title: 'Blocked SPU',
        status: ProductStatus.BLOCKED,
      } as unknown as ProductDocument);

      const payload = {
        media_id: mediaId,
        object_key: objectKey,
        sha256: validSha256,
      };

      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/complete`)
        .set(defaultHeaders)
        .send(payload);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_BLOCKED');
    });
  });

  // =========================================================================
  // 3. GET /seller/products/:productId/media: Listing Media
  // =========================================================================
  describe('GET /seller/products/:productId/media: Listing Media', () => {
    beforeEach(async () => {
      // Seed 3 active media items with different sort_order
      await inMemoryMediaRepo.create({
        _id: 'media-order-2',
        product_id: productId,
        object_key: 'key-2.jpg',
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
        sort_order: 2,
        is_cover: false,
        status: MediaStatus.READY,
        uploaded_by: userId,
        created_at: new Date('2026-09-25T01:00:00Z'),
      });

      await inMemoryMediaRepo.create({
        _id: 'media-order-0',
        product_id: productId,
        object_key: 'key-0.jpg',
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
        sort_order: 0,
        is_cover: true,
        status: MediaStatus.READY,
        uploaded_by: userId,
        created_at: new Date('2026-09-25T02:00:00Z'),
      });

      await inMemoryMediaRepo.create({
        _id: 'media-order-1',
        product_id: productId,
        object_key: 'key-1.jpg',
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
        sort_order: 1,
        is_cover: false,
        status: MediaStatus.READY,
        uploaded_by: userId,
        created_at: new Date('2026-09-25T03:00:00Z'),
      });

      // Seed 1 DELETED media item (should be filtered out)
      await inMemoryMediaRepo.create({
        _id: 'media-deleted',
        product_id: productId,
        object_key: 'key-deleted.jpg',
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
        sort_order: 0,
        is_cover: false,
        status: MediaStatus.DELETED,
        uploaded_by: userId,
        created_at: new Date('2026-09-25T04:00:00Z'),
      });
    });

    it('3.1 should list media sorted by sort_order ascending, excluding DELETED', async () => {
      const res = await request(app.getHttpServer())
        .get(`/seller/products/${productId}/media`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.OK);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBe(3);

      // Verify sort order
      expect(res.body.data[0].media_id).toBe('media-order-0');
      expect(res.body.data[0].sort_order).toBe(0);
      expect(res.body.data[0].is_cover).toBe(true);

      expect(res.body.data[1].media_id).toBe('media-order-1');
      expect(res.body.data[1].sort_order).toBe(1);

      expect(res.body.data[2].media_id).toBe('media-order-2');
      expect(res.body.data[2].sort_order).toBe(2);

      // Verify DELETED item is NOT included
      const ids = res.body.data.map((item: { media_id: string }) => item.media_id);
      expect(ids).not.toContain('media-deleted');
    });

    it('3.2 [IDOR Boundary] should reject listing when product belongs to another shop (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/seller/products/${productId}/media`)
        .set({
          ...defaultHeaders,
          'x-user-shop-scope': otherShopId,
        });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('3.3 should return 404 when product does not exist', async () => {
      const nonExistentProductId = '01912f20-7a1b-7c12-9c55-8b1c34a6d000';
      const res = await request(app.getHttpServer())
        .get(`/seller/products/${nonExistentProductId}/media`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });
  });

  // =========================================================================
  // 4. DELETE /seller/products/:productId/media/:mediaId: Soft Delete
  // =========================================================================
  describe('DELETE /seller/products/:productId/media/:mediaId: Soft Delete', () => {
    const mediaId = '01912f20-7a1b-7c12-9c55-8b1c34a6d940';

    beforeEach(async () => {
      await inMemoryMediaRepo.create({
        _id: mediaId,
        product_id: productId,
        object_key: `products/shop-${shopId}/product-${productId}/media-${mediaId}.jpg`,
        content_type: 'image/jpeg',
        size_bytes: 1024,
        sha256: validSha256,
        status: MediaStatus.READY,
        is_cover: true,
      });
    });

    it('4.1 should soft-delete media by marking DELETED and unsetting cover', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/seller/products/${productId}/media/${mediaId}`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.data.success).toBe(true);

      const deleted = await inMemoryMediaRepo.findById(mediaId);
      expect(deleted?.status).toBe(MediaStatus.DELETED);
      expect(deleted?.is_cover).toBe(false);

      // Verify subsequent listMedia excludes the deleted item
      const listRes = await request(app.getHttpServer())
        .get(`/seller/products/${productId}/media`)
        .set(defaultHeaders);

      expect(listRes.body.data.length).toBe(0);
    });

    it('4.2 should return 404 when media_id does not exist (404 PRODUCT_MEDIA_NOT_FOUND)', async () => {
      const nonExistentMediaId = '01912f20-7a1b-7c12-9c55-8b1c34a6d000';
      const res = await request(app.getHttpServer())
        .delete(`/seller/products/${productId}/media/${nonExistentMediaId}`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(res.body.error.code).toBe('PRODUCT_MEDIA_NOT_FOUND');
    });

    it('4.3 [IDOR Boundary] should reject delete when product belongs to another shop (403 Forbidden)', async () => {
      const res = await request(app.getHttpServer())
        .delete(`/seller/products/${productId}/media/${mediaId}`)
        .set({
          ...defaultHeaders,
          'x-user-shop-scope': otherShopId,
        });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('4.4 should return 404 when product does not exist on delete', async () => {
      const nonExistentProductId = '01912f20-7a1b-7c12-9c55-8b1c34a6d000';
      const res = await request(app.getHttpServer())
        .delete(`/seller/products/${nonExistentProductId}/media/${mediaId}`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
      expect(res.body.error.code).toBe('PRODUCT_NOT_FOUND');
    });

    it('4.5 should reject delete when product is ARCHIVED (409 PRODUCT_ARCHIVED)', async () => {
      inMemoryProductRepo.set({
        _id: productId,
        shop_id: shopId,
        title: 'Archived SPU',
        status: ProductStatus.ARCHIVED,
      } as unknown as ProductDocument);

      const res = await request(app.getHttpServer())
        .delete(`/seller/products/${productId}/media/${mediaId}`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_ARCHIVED');
    });

    it('4.6 should reject delete when product is BLOCKED (409 PRODUCT_BLOCKED)', async () => {
      inMemoryProductRepo.set({
        _id: productId,
        shop_id: shopId,
        title: 'Blocked SPU',
        status: ProductStatus.BLOCKED,
      } as unknown as ProductDocument);

      const res = await request(app.getHttpServer())
        .delete(`/seller/products/${productId}/media/${mediaId}`)
        .set(defaultHeaders);

      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.error.code).toBe('PRODUCT_BLOCKED');
    });
  });

  // =========================================================================
  // 5. Security & Zero-Trust Authentication Boundaries
  // =========================================================================
  describe('Zero-Trust Authentication & Permissions Boundaries', () => {
    it('5.1 should reject unauthenticated requests without headers (401 UNAUTHORIZED)', async () => {
      const res = await request(app.getHttpServer()).get(`/seller/products/${productId}/media`);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('5.2 should reject requests with non-SELLER role e.g. BUYER (403 PRODUCT_FORBIDDEN)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/seller/products/${productId}/media`)
        .set({
          'x-user-id': userId,
          'x-user-roles': 'BUYER',
          'x-user-shop-scope': shopId,
        });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });

    it('5.3 should reject requests lacking required permission (403 PRODUCT_FORBIDDEN)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/seller/products/${productId}/media/upload-url`)
        .set({
          'x-user-id': userId,
          'x-user-roles': 'SELLER',
          'x-user-permissions': 'catalog:product:read', // Missing catalog:product:write
          'x-user-shop-scope': shopId,
        })
        .send({
          content_type: 'image/jpeg',
          size_bytes: 1024,
          sha256: validSha256,
        });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(res.body.error.code).toBe('PRODUCT_FORBIDDEN');
    });

    it('5.4 should allow access for user with SELLER_STAFF role', async () => {
      const res = await request(app.getHttpServer())
        .get(`/seller/products/${productId}/media`)
        .set({
          'x-user-id': userId,
          'x-user-roles': 'SELLER_STAFF',
          'x-user-permissions': 'catalog:product:read',
          'x-user-shop-scope': shopId,
        });

      expect(res.status).toBe(HttpStatus.OK);
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });
});
