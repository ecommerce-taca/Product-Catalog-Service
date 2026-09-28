import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { v7 as uuidv7 } from 'uuid';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { isPrivateOrBlockedUrl, isPrivateOrBlockedUrlAsync } from '../utils/ssrf-validator.util';

export interface DownloadedMediaResult {
  mediaId: string;
  objectKey: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

const ALLOWED_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export const MAX_MEDIA_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

@Injectable()
export class MediaDownloadService {
  private readonly logger = new Logger(MediaDownloadService.name);

  constructor(private readonly s3StorageService: S3StorageService) {
    this.logger.debug('MediaDownloadService initialized');
  }

  /**
   * Downloads an image from a public URL with anti-SSRF checks, 3s timeout, 5MB limit,
   * calculates SHA-256 and streams/uploads it to S3 bucket.
   * Throws errors with code MEDIA_INVALID_URL_BLOCKED or MEDIA_DOWNLOAD_FAILED.
   */
  async downloadAndUploadImage(
    imageUrl: string,
    productId: string,
  ): Promise<DownloadedMediaResult> {
    const trimmedUrl = imageUrl.trim();

    // 1. SSRF prevention (Sync IP checks + Async DNS lookup - SEC-SSRF-01)
    if (isPrivateOrBlockedUrl(trimmedUrl) || (await isPrivateOrBlockedUrlAsync(trimmedUrl))) {
      const err = new Error('URL không an toàn hoặc trỏ về địa chỉ nội bộ');
      (err as unknown as { code: string }).code = 'MEDIA_INVALID_URL_BLOCKED';
      throw err;
    }

    // 2. Fetch with 3s timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(trimmedUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timeoutId);

      if ((response.status >= 300 && response.status < 400) || response.type === 'opaqueredirect') {
        const err = new Error(
          'Không thể tải ảnh: URL chuyển hướng (Redirect) không được hỗ trợ để đảm bảo an toàn bảo mật.',
        );
        (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
        throw err;
      }

      if (!response.ok) {
        const err = new Error(`HTTP ${response.status} (${response.statusText})`);
        (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
        throw err;
      }

      // 3. MIME-type validation
      const contentTypeHeader = (response.headers.get('content-type') || '')
        .toLowerCase()
        .split(';')[0]
        .trim();
      const extension = ALLOWED_MIME_TYPES[contentTypeHeader];
      if (!extension) {
        const err = new Error(`MIME type không được hỗ trợ: ${contentTypeHeader || 'unknown'}`);
        (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
        throw err;
      }

      // 4. Content-Length header pre-check (B-SEC-01)
      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!Number.isNaN(contentLength) && contentLength > MAX_MEDIA_SIZE_BYTES) {
          if (response.body) {
            await response.body.cancel();
          }
          const err = new Error(
            `Dung lượng hình ảnh vượt quá giới hạn 5MB (${contentLength} bytes)`,
          );
          (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
          throw err;
        }
      }

      // 5. Download stream chunk-by-chunk with cumulative size verification
      if (!response.body) {
        const err = new Error('Tệp hình ảnh rỗng (0 bytes)');
        (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
        throw err;
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          if (value) {
            totalBytes += value.length;
            if (totalBytes > MAX_MEDIA_SIZE_BYTES) {
              await reader.cancel();
              const err = new Error(
                `Dung lượng hình ảnh vượt quá giới hạn 5MB (${totalBytes} bytes)`,
              );
              (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
              throw err;
            }
            chunks.push(value);
          }
        }
      } catch (streamError: unknown) {
        const err = streamError as Error & { code?: string };
        if (err?.code === 'MEDIA_DOWNLOAD_FAILED') {
          throw err;
        }
        throw streamError;
      }

      const buffer = Buffer.concat(chunks);

      if (buffer.length === 0) {
        const err = new Error('Tệp hình ảnh rỗng (0 bytes)');
        (err as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
        throw err;
      }

      // 6. Hash calculation
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const mediaId = uuidv7();
      const objectKey = `products/${productId}/images/${mediaId}.${extension}`;

      // 6. Direct buffer upload to S3 bucket
      await this.s3StorageService.uploadBuffer(objectKey, buffer, contentTypeHeader);

      return {
        mediaId,
        objectKey,
        contentType: contentTypeHeader,
        sizeBytes: buffer.length,
        sha256,
      };
    } catch (error: unknown) {
      clearTimeout(timeoutId);
      const err = error as Error & { code?: string };
      if (err.name === 'AbortError') {
        const timeoutErr = new Error('Hết thời gian chờ tải hình ảnh (timeout 3s)');
        (timeoutErr as unknown as { code: string }).code = 'MEDIA_DOWNLOAD_FAILED';
        throw timeoutErr;
      }
      if (!err.code) {
        err.code = 'MEDIA_DOWNLOAD_FAILED';
      }
      throw err;
    }
  }
}
