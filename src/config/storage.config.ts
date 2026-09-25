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
}

export default registerAs('storage', (): StorageConfig => ({
  region: process.env.AWS_REGION || 'ap-southeast-1',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'minioadmin',
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin',
  bucket: process.env.AWS_S3_BUCKET || 'taca-product-media-prod',
  endpoint: process.env.AWS_S3_ENDPOINT || 'http://localhost:9000',
  forcePathStyle: process.env.AWS_S3_FORCE_PATH_STYLE === 'true',
  signedUrlTtl: parseInt(process.env.MEDIA_SIGNED_URL_TTL || '600', 10),
  publicBaseUrl: process.env.CDN_BASE_URL || process.env.AWS_S3_PUBLIC_URL,
}));
