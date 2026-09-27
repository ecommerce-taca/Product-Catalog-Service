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

  it('should successfully download valid image and upload to S3', async () => {
    const rawBytes = new TextEncoder().encode('fake-image-bytes-content');
    const arrayBuffer = rawBytes.buffer;
    const mockResponse = {
      status: 200,
      statusText: 'OK',
      ok: true,
      headers: new Headers({
        'content-type': 'image/jpeg',
      }),
      arrayBuffer: jest.fn().mockResolvedValue(arrayBuffer),
    } as unknown as Response;

    global.fetch = jest.fn().mockResolvedValue(mockResponse);

    const result = await service.downloadAndUploadImage(
      'https://cdn.example.com/images/valid.jpg',
      'prod-456',
    );

    expect(result).toBeDefined();
    expect(result.contentType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(rawBytes.length);
    expect(result.objectKey).toContain('products/prod-456/images/');
    expect(mockS3StorageService.uploadBuffer).toHaveBeenCalledWith(
      result.objectKey,
      expect.any(Buffer),
      'image/jpeg',
    );
  });
});
