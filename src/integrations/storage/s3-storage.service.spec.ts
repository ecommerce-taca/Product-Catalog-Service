import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3StorageService } from './s3-storage.service';

describe('S3StorageService', () => {
  let service: S3StorageService;
  let mockSend: jest.Mock;

  const mockConfig: Record<string, unknown> = {
    region: 'ap-southeast-1',
    accessKeyId: 'test-key-id',
    secretAccessKey: 'test-secret-key',
    bucket: 'test-bucket',
    endpoint: 'http://localhost:9000',
    forcePathStyle: true,
    signedUrlTtl: 600,
    publicBaseUrl: undefined,
  };

  beforeEach(async () => {
    mockSend = jest.fn();
    jest.spyOn(S3Client.prototype, 'send').mockImplementation(mockSend);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        S3StorageService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'storage') return mockConfig;
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<S3StorageService>(S3StorageService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('generatePresignedUploadUrl', () => {
    it('should generate valid AWS SigV4 presigned PUT URL with required query parameters', async () => {
      const objectKey = 'products/shop-1/product-1/media-1.webp';
      const contentType = 'image/webp';
      const sizeBytes = 1024;

      const result = await service.generatePresignedUploadUrl(objectKey, contentType, sizeBytes);

      expect(result).toBeDefined();
      expect(result.uploadUrl).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);

      const parsedUrl = new URL(result.uploadUrl);
      expect(parsedUrl.pathname).toContain('/test-bucket/products/shop-1/product-1/media-1.webp');
      expect(parsedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(parsedUrl.searchParams.get('X-Amz-Credential')).toContain('test-key-id');
      expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe('600');
      expect(parsedUrl.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(parsedUrl.searchParams.get('X-Amz-Signature')).toBeDefined();
      expect(parsedUrl.searchParams.get('X-Amz-Signature')?.length).toBe(64);
    });

    it('should set expiresAt according to configured signedUrlTtl', async () => {
      const before = Date.now();
      const result = await service.generatePresignedUploadUrl('key.jpg', 'image/jpeg', 500);
      const after = Date.now();

      const expectedMin = before + 600 * 1000;
      const expectedMax = after + 600 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
    });
  });

  describe('verifyObjectUploaded', () => {
    it('should return verified: true when HEAD request succeeds with matching size and sha256', async () => {
      const sha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
      mockSend.mockResolvedValueOnce({
        ContentLength: 1024,
        ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
        Metadata: { sha256 },
      });

      const result = await service.verifyObjectUploaded('test.webp', sha256, 1024);

      expect(result.verified).toBe(true);
      expect(result.actualSize).toBe(1024);
      expect(result.etag).toBe('d41d8cd98f00b204e9800998ecf8427e');
      expect(mockSend).toHaveBeenCalledWith(expect.any(HeadObjectCommand));
    });

    it('should return verified: false when size does not match expected size', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 2048,
        ETag: '"etag-123"',
      });

      const result = await service.verifyObjectUploaded('test.webp', undefined, 1024);

      expect(result.verified).toBe(false);
      expect(result.actualSize).toBe(2048);
    });

    it('should return verified: false when sha256 metadata does not match', async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 1024,
        Metadata: { sha256: 'different-sha256' },
      });

      const result = await service.verifyObjectUploaded('test.webp', 'expected-sha256', 1024);

      expect(result.verified).toBe(false);
    });

    it('should return verified: false when HEAD object throws NotFound or NoSuchKey', async () => {
      const notFoundError = new Error('NotFound');
      notFoundError.name = 'NotFound';
      mockSend.mockRejectedValueOnce(notFoundError);

      const result = await service.verifyObjectUploaded('nonexistent.webp');

      expect(result.verified).toBe(false);
    });
  });

  describe('getPublicUrl', () => {
    it('should return path-style URL when forcePathStyle is true', () => {
      const url = service.getPublicUrl('products/shop-1/product-1/media-1.webp');
      expect(url).toBe('http://localhost:9000/test-bucket/products/shop-1/product-1/media-1.webp');
    });

    it('should return custom CDN URL if publicBaseUrl is configured', async () => {
      const customModule = await Test.createTestingModule({
        providers: [
          S3StorageService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn(() => ({
                ...mockConfig,
                publicBaseUrl: 'https://cdn.example.com',
              })),
            },
          },
        ],
      }).compile();

      const customService = customModule.get<S3StorageService>(S3StorageService);
      const url = customService.getPublicUrl('products/shop-1/product-1/media-1.webp');
      expect(url).toBe('https://cdn.example.com/products/shop-1/product-1/media-1.webp');
    });
  });

  describe('generatePresignedDownloadUrl', () => {
    it('should generate valid AWS SigV4 presigned GET URL with 1800s default TTL', async () => {
      const objectKey = 'exports/products-shop-1-12345.xlsx';
      const result = await service.generatePresignedDownloadUrl(objectKey);

      expect(result).toBeDefined();
      expect(result.downloadUrl).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);

      const parsedUrl = new URL(result.downloadUrl);
      expect(parsedUrl.pathname).toContain('/test-bucket/exports/products-shop-1-12345.xlsx');
      expect(parsedUrl.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(parsedUrl.searchParams.get('X-Amz-Credential')).toContain('test-key-id');
      expect(parsedUrl.searchParams.get('X-Amz-Expires')).toBe('1800');
      expect(parsedUrl.searchParams.get('X-Amz-Signature')).toBeDefined();
      expect(parsedUrl.searchParams.get('X-Amz-Signature')?.length).toBe(64);
    });

    it('should support custom ttlSeconds', async () => {
      const objectKey = 'exports/products-shop-1-12345.csv';
      const before = Date.now();
      const result = await service.generatePresignedDownloadUrl(objectKey, 900);
      const after = Date.now();

      const expectedMin = before + 900 * 1000;
      const expectedMax = after + 900 * 1000;
      expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
      expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
    });
  });

  describe('uploadBuffer', () => {
    it('should send PutObjectCommand with correct parameters', async () => {
      mockSend.mockResolvedValueOnce({});
      const buffer = Buffer.from('test content');
      await service.uploadBuffer('exports/test.csv', buffer, 'text/csv');

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Key: 'exports/test.csv',
            Body: buffer,
            ContentType: 'text/csv',
          }),
        }),
      );
    });
  });
});
