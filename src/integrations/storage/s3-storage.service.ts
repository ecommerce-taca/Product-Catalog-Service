import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';
import { StorageConfig } from '../../config/storage.config';

export interface PresignedUploadResult {
  uploadUrl: string;
  expiresAt: Date;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  expiresAt: Date;
}

export interface VerifyObjectResult {
  verified: boolean;
  actualSize?: number;
  etag?: string;
}

@Injectable()
export class S3StorageService {
  private readonly logger = new Logger(S3StorageService.name);
  readonly s3Client: S3Client;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint?: string;
  readonly forcePathStyle: boolean;
  readonly signedUrlTtl: number;
  readonly publicBaseUrl?: string;

  constructor(private readonly configService: ConfigService) {
    const config = this.configService.get<StorageConfig>('storage');
    this.region = config?.region || process.env.AWS_REGION || 'ap-southeast-1';
    this.bucket = config?.bucket || process.env.AWS_S3_BUCKET || 'taca-product-media-prod';
    this.accessKeyId = config?.accessKeyId || process.env.AWS_ACCESS_KEY_ID || 'minioadmin';
    this.secretAccessKey =
      config?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || 'minioadmin';
    this.endpoint = config?.endpoint || process.env.AWS_S3_ENDPOINT || 'http://localhost:9000';
    this.forcePathStyle = config?.forcePathStyle ?? process.env.AWS_S3_FORCE_PATH_STYLE === 'true';
    this.signedUrlTtl =
      config?.signedUrlTtl || parseInt(process.env.MEDIA_SIGNED_URL_TTL || '600', 10);
    this.publicBaseUrl =
      config?.publicBaseUrl || process.env.CDN_BASE_URL || process.env.AWS_S3_PUBLIC_URL;

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.accessKeyId,
        secretAccessKey: this.secretAccessKey,
      },
      endpoint: this.endpoint,
      forcePathStyle: this.forcePathStyle,
    });
  }

  /**
   * Generates an AWS SigV4 Presigned PUT URL for direct client upload to S3/MinIO.
   * TTL defaults to 600s (10 minutes).
   */
  async generatePresignedUploadUrl(
    objectKey: string,
    _contentType: string,
    _sizeBytes: number,
  ): Promise<PresignedUploadResult> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const ttlSeconds = this.signedUrlTtl;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const cleanKey = objectKey.replace(/^\//, '');
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    let endpointUrl = this.endpoint || 'https://s3.amazonaws.com';
    if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
      endpointUrl = `https://${endpointUrl}`;
    }
    const urlObj = new URL(endpointUrl);
    const host = urlObj.host;

    let canonicalUri: string;
    if (this.forcePathStyle) {
      canonicalUri = `/${this.bucket}/${cleanKey.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      canonicalUri = `/${cleanKey.split('/').map(encodeURIComponent).join('/')}`;
    }

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': ttlSeconds.toString(),
      'X-Amz-SignedHeaders': 'host',
    };

    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${dateStamp}/${this.region}/s3/aws4_request`,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signingKey = this.getSignatureKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const uploadUrl = `${urlObj.origin}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

    return {
      uploadUrl,
      expiresAt,
    };
  }

  /**
   * Generates an AWS SigV4 Presigned GET URL for downloading objects directly from S3/MinIO.
   * TTL defaults to 1800s (30 minutes).
   */
  async generatePresignedDownloadUrl(
    objectKey: string,
    ttlSeconds = 1800,
  ): Promise<PresignedDownloadResult> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.substring(0, 8);
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const cleanKey = objectKey.replace(/^\//, '');
    const credential = `${this.accessKeyId}/${dateStamp}/${this.region}/s3/aws4_request`;

    let endpointUrl = this.endpoint || 'https://s3.amazonaws.com';
    if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
      endpointUrl = `https://${endpointUrl}`;
    }
    const urlObj = new URL(endpointUrl);
    const host = urlObj.host;

    let canonicalUri: string;
    if (this.forcePathStyle) {
      canonicalUri = `/${this.bucket}/${cleanKey.split('/').map(encodeURIComponent).join('/')}`;
    } else {
      canonicalUri = `/${cleanKey.split('/').map(encodeURIComponent).join('/')}`;
    }

    const queryParams: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': credential,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': ttlSeconds.toString(),
      'X-Amz-SignedHeaders': 'host',
    };

    const canonicalQueryString = Object.keys(queryParams)
      .sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(queryParams[k])}`)
      .join('&');

    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      `${dateStamp}/${this.region}/s3/aws4_request`,
      crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signingKey = this.getSignatureKey(this.secretAccessKey, dateStamp, this.region, 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const downloadUrl = `${urlObj.origin}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;

    return {
      downloadUrl,
      expiresAt,
    };
  }

  /**
   * Uploads an in-memory buffer directly to S3/MinIO bucket.
   */
  async uploadBuffer(objectKey: string, buffer: Buffer, contentType: string): Promise<void> {
    const cleanKey = objectKey.replace(/^\//, '');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: cleanKey,
      Body: buffer,
      ContentType: contentType,
    });
    await this.s3Client.send(command);
  }

  /**
   * Verifies that the object was successfully uploaded to S3/MinIO via HEAD request.
   */
  async verifyObjectUploaded(
    objectKey: string,
    expectedSha256?: string,
    expectedSize?: number,
  ): Promise<VerifyObjectResult> {
    try {
      const cleanKey = objectKey.replace(/^\//, '');
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: cleanKey,
      });
      const response = await this.s3Client.send(command);
      const actualSize = response.ContentLength ?? 0;
      const etag = response.ETag?.replace(/"/g, '') ?? '';

      if (expectedSize !== undefined && actualSize !== expectedSize) {
        this.logger.warn(
          `Object size mismatch for key=${cleanKey}: expected=${expectedSize}, actual=${actualSize}`,
        );
        return { verified: false, actualSize, etag };
      }

      const metaSha256 = response.Metadata?.['sha256'] || response.Metadata?.['sha-256'];
      if (
        expectedSha256 &&
        metaSha256 &&
        metaSha256.toLowerCase() !== expectedSha256.toLowerCase()
      ) {
        this.logger.warn(
          `Object SHA-256 mismatch for key=${cleanKey}: expected=${expectedSha256}, actual=${metaSha256}`,
        );
        return { verified: false, actualSize, etag };
      }

      return { verified: true, actualSize, etag };
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to verify object upload for key=${objectKey}: ${errMsg}`);
      return { verified: false };
    }
  }

  /**
   * Resolves the public accessible URL for a given object key.
   */
  getPublicUrl(objectKey: string): string {
    const cleanKey = objectKey.replace(/^\//, '');
    if (this.publicBaseUrl) {
      return `${this.publicBaseUrl.replace(/\/$/, '')}/${cleanKey}`;
    }

    let endpointUrl = this.endpoint || 'https://s3.amazonaws.com';
    if (!endpointUrl.startsWith('http://') && !endpointUrl.startsWith('https://')) {
      endpointUrl = `https://${endpointUrl}`;
    }
    const cleanEndpoint = endpointUrl.replace(/\/$/, '');

    if (this.forcePathStyle) {
      return `${cleanEndpoint}/${this.bucket}/${cleanKey}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${cleanKey}`;
  }

  private getSignatureKey(
    key: string,
    dateStamp: string,
    regionName: string,
    serviceName: string,
  ): Buffer {
    const kDate = crypto
      .createHmac('sha256', 'AWS4' + key)
      .update(dateStamp)
      .digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(regionName).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(serviceName).digest();
    const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
    return kSigning;
  }
}
