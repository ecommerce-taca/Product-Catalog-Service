import { registerAs } from '@nestjs/config';

export interface StorageConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint?: string;
  forcePathStyle: boolean;
  signedUrlTtl: number;
  publicBaseUrl?: string;
  /** Số lần HEAD khi xác nhận upload (storage có thể chưa thấy object ngay sau PUT) */
  verifyAttempts?: number;
  /** Độ trễ cơ sở giữa các lần HEAD, tăng tuyến tính theo lần thử */
  verifyRetryDelayMs?: number;
}

export default registerAs('storage', (): StorageConfig => ({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
  bucket: process.env.AWS_S3_BUCKET || 'taca-product-media-prod',
  endpoint: process.env.AWS_S3_ENDPOINT || 'http://localhost:9000',
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE !== 'false',
  signedUrlTtl: parseInt(process.env.MEDIA_SIGNED_URL_TTL || '600', 10),
  publicBaseUrl: process.env.CDN_BASE_URL || process.env.AWS_S3_PUBLIC_URL,
  verifyAttempts: parseInt(process.env.MEDIA_VERIFY_ATTEMPTS || '4', 10),
  verifyRetryDelayMs: parseInt(process.env.MEDIA_VERIFY_RETRY_DELAY_MS || '500', 10),
}));
