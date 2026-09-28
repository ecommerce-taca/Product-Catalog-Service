import { MediaDownloadService } from '../../src/import/services/media-download.service';
import { S3StorageService } from '../../src/integrations/storage/s3-storage.service';

describe('MediaDownloadService (SF-1 Anti-SSRF Redirect Protection)', () => {
  let service: MediaDownloadService;
  let mockS3StorageService: jest.Mocked<S3StorageService>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockS3StorageService = {
      uploadBuffer: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<S3StorageService>;

    service = new MediaDownloadService(mockS3StorageService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('should block redirect responses (3xx) when redirect is manual (SF-1, D-01)', async () => {
    const mockResponse = {
      status: 301,
      statusText: 'Moved Permanently',
      type: 'basic',
      ok: false,
      headers: new Headers({
        location: 'http://169.254.169.254/latest/meta-data/',
      }),
    } as unknown as Response;

    const fetchMock = jest.fn().mockResolvedValue(mockResponse);
    global.fetch = fetchMock;

    await expect(
      service.downloadAndUploadImage('https://example.com/redirect-to-ssrf.jpg', 'prod-123'),
    ).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_FAILED',
      message:
        'Không thể tải ảnh: URL chuyển hướng (Redirect) không được hỗ trợ để đảm bảo an toàn bảo mật.',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/redirect-to-ssrf.jpg',
      expect.objectContaining({
        redirect: 'manual',
      }),
    );
    expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
  });

  it('should block opaqueredirect responses when redirect is manual', async () => {
    const mockResponse = {
      status: 0,
      statusText: '',
      type: 'opaqueredirect',
      ok: false,
      headers: new Headers(),
    } as unknown as Response;

    const fetchMock = jest.fn().mockResolvedValue(mockResponse);
    global.fetch = fetchMock;

    await expect(
      service.downloadAndUploadImage('https://example.com/redirect.jpg', 'prod-123'),
    ).rejects.toMatchObject({
      code: 'MEDIA_DOWNLOAD_FAILED',
      message:
        'Không thể tải ảnh: URL chuyển hướng (Redirect) không được hỗ trợ để đảm bảo an toàn bảo mật.',
    });
  });

  it('should block SSRF URLs immediately before fetching', async () => {
    await expect(
      service.downloadAndUploadImage('http://169.254.169.254/latest/meta-data/', 'prod-123'),
    ).rejects.toMatchObject({
      code: 'MEDIA_INVALID_URL_BLOCKED',
    });

    await expect(
      service.downloadAndUploadImage('http://localhost:8080/secret.png', 'prod-123'),
    ).rejects.toMatchObject({
      code: 'MEDIA_INVALID_URL_BLOCKED',
    });
  });

  describe('B-SEC-01 Unbounded Buffer DoS Protection & Streaming', () => {
    function createMockStream(chunks: Uint8Array[], onCancel?: jest.Mock) {
      let index = 0;
      const cancelMock = onCancel || jest.fn().mockResolvedValue(undefined);
      return {
        cancel: cancelMock,
        getReader: () => ({
          read: jest.fn().mockImplementation(async () => {
            if (index < chunks.length) {
              return { done: false, value: chunks[index++] };
            }
            return { done: true, value: undefined };
          }),
          cancel: cancelMock,
        }),
      };
    }

    it('should reject immediately if content-length header exceeds 5MB', async () => {
      const cancelMock = jest.fn().mockResolvedValue(undefined);
      const mockStream = createMockStream([], cancelMock);

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({
          'content-type': 'image/jpeg',
          'content-length': (6 * 1024 * 1024).toString(), // 6MB
        }),
        body: mockStream,
      } as unknown as Response;

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      await expect(
        service.downloadAndUploadImage('https://cdn.example.com/oversized.jpg', 'prod-123'),
      ).rejects.toMatchObject({
        code: 'MEDIA_DOWNLOAD_FAILED',
        message: expect.stringContaining('vượt quá giới hạn 5MB'),
      });

      expect(cancelMock).toHaveBeenCalled();
      expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it('should abort stream and cancel reader immediately if chunk reading exceeds 5MB', async () => {
      const cancelMock = jest.fn().mockResolvedValue(undefined);
      const chunk3MB = new Uint8Array(3 * 1024 * 1024);
      // Two 3MB chunks = 6MB total > 5MB
      const mockStream = createMockStream([chunk3MB, chunk3MB], cancelMock);

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({
          'content-type': 'image/jpeg',
        }),
        body: mockStream,
      } as unknown as Response;

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      await expect(
        service.downloadAndUploadImage('https://cdn.example.com/stream-bomb.jpg', 'prod-123'),
      ).rejects.toMatchObject({
        code: 'MEDIA_DOWNLOAD_FAILED',
        message: expect.stringContaining('vượt quá giới hạn 5MB'),
      });

      expect(cancelMock).toHaveBeenCalled();
      expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it('should reject when stream body is empty (0 bytes)', async () => {
      const mockStream = createMockStream([]);

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({
          'content-type': 'image/jpeg',
        }),
        body: mockStream,
      } as unknown as Response;

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      await expect(
        service.downloadAndUploadImage('https://cdn.example.com/empty.jpg', 'prod-123'),
      ).rejects.toMatchObject({
        code: 'MEDIA_DOWNLOAD_FAILED',
        message: 'Tệp hình ảnh rỗng (0 bytes)',
      });
      expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it('should reject when response body is missing (null)', async () => {
      const mockResponse = {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({
          'content-type': 'image/jpeg',
        }),
        body: null,
      } as unknown as Response;

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      await expect(
        service.downloadAndUploadImage('https://cdn.example.com/nobody.jpg', 'prod-123'),
      ).rejects.toMatchObject({
        code: 'MEDIA_DOWNLOAD_FAILED',
        message: 'Tệp hình ảnh rỗng (0 bytes)',
      });
      expect(mockS3StorageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it('should successfully download valid image chunk-by-chunk and upload to S3', async () => {
      const chunk1 = new TextEncoder().encode('fake-image-part-1-');
      const chunk2 = new TextEncoder().encode('fake-image-part-2');
      const expectedTotalLength = chunk1.length + chunk2.length;
      const mockStream = createMockStream([chunk1, chunk2]);

      const mockResponse = {
        status: 200,
        statusText: 'OK',
        ok: true,
        headers: new Headers({
          'content-type': 'image/jpeg',
        }),
        body: mockStream,
      } as unknown as Response;

      global.fetch = jest.fn().mockResolvedValue(mockResponse);

      const result = await service.downloadAndUploadImage(
        'https://cdn.example.com/images/valid.jpg',
        'prod-456',
      );

      expect(result).toBeDefined();
      expect(result.contentType).toBe('image/jpeg');
      expect(result.sizeBytes).toBe(expectedTotalLength);
      expect(result.objectKey).toContain('products/prod-456/images/');
      expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
        result.objectKey,
        expect.any(Buffer),
        'image/jpeg',
      );

      const uploadedBuffer = (mockS3StorageService.uploadBuffer as jest.Mock).mock.calls[0][1];
      expect(uploadedBuffer.toString()).toBe('fake-image-part-1-fake-image-part-2');
    });
  });
});
