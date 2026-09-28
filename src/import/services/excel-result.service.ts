import { Inject, Injectable, Logger } from '@nestjs/common';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import * as ExcelJS from 'exceljs';
import { Readable } from 'stream';

import { ImportJobDocument } from '../../database/schemas/import-job.schema';
import { S3StorageService } from '../../integrations/storage/s3-storage.service';
import { ImportJobRepositoryPort } from '../repositories/import-job.repository.interface';
import { ExcelFormulaSanitizer } from '../utils/excel-formula-sanitizer.util';

export interface PresignedResultFile {
  downloadUrl: string;
  s3Key: string;
  expiresAt: Date;
}

@Injectable()
export class ExcelResultService {
  private readonly logger = new Logger(ExcelResultService.name);

  constructor(
    private readonly storageService: S3StorageService,
    @Inject('ImportJobRepositoryPort')
    private readonly importJobRepo: ImportJobRepositoryPort,
  ) {}

  /**
   * Generates an Excel buffer containing original rows annotated with error status
   * and error reasons, or a fallback error summary workbook if the original file is unavailable.
   * Applies ExcelFormulaSanitizer (CWE-1236, Lesson L-07) to 100% of text cells.
   */
  async generateResultBuffer(job: ImportJobDocument): Promise<Buffer> {
    if (job.file_url) {
      try {
        const originalBuffer = await this.downloadOriginalFile(job.file_url);
        if (originalBuffer) {
          return await this.generateAnnotatedOriginalBuffer(originalBuffer, job);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Could not process original Excel file for job ${job._id}: ${msg}. Falling back to clean summary sheet.`,
        );
      }
    }

    return this.generateFallbackBuffer(job);
  }

  /**
   * Generates the result Excel buffer, uploads it to S3, updates job.result_file_url,
   * and returns presigned download URL valid for 30 minutes (1800s).
   */
  async generateAndUploadResultFile(job: ImportJobDocument): Promise<PresignedResultFile> {
    const buffer = await this.generateResultBuffer(job);
    const s3Key = `imports/shop-${job.shop_id}/${job._id}-errors.xlsx`;

    await this.storageService.uploadBuffer(
      s3Key,
      buffer,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    const presigned = await this.storageService.generatePresignedDownloadUrl(s3Key, 1800);

    job.result_file_url = s3Key;
    if (typeof job.save === 'function') {
      await job.save();
    } else {
      await this.importJobRepo.update({ _id: job._id }, { result_file_url: s3Key });
    }

    return {
      downloadUrl: presigned.downloadUrl,
      s3Key,
      expiresAt: presigned.expiresAt,
    };
  }

  private async downloadOriginalFile(fileUrl: string): Promise<Buffer | null> {
    try {
      if (typeof this.storageService.downloadBuffer === 'function') {
        return await this.storageService.downloadBuffer(fileUrl);
      }
      const cleanKey = fileUrl.replace(/^\//, '');
      const command = new GetObjectCommand({
        Bucket: this.storageService.bucket,
        Key: cleanKey,
      });
      const response = await this.storageService.s3Client.send(command);
      const stream = response.Body as Readable;

      return new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to download original file from S3: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async generateAnnotatedOriginalBuffer(
    originalBuffer: Buffer,
    job: ImportJobDocument,
  ): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(originalBuffer as any);

    const IGNORE_SHEET_REGEX = /hướng dẫn|ví dụ|guide|example/i;
    const dataSheets = (workbook.worksheets || []).filter(
      (ws) => !IGNORE_SHEET_REGEX.test(ws.name),
    );

    if (dataSheets.length === 0) {
      return this.generateFallbackBuffer(job);
    }

    // Group errors by sheet_name:row_index and fallback row_index
    const sheetErrorMap = new Map<string, Array<{ errorCode: string; errorMessage: string }>>();
    const fallbackRowErrorMap = new Map<
      number,
      Array<{ errorCode: string; errorMessage: string }>
    >();

    if (job.error_summary && job.error_summary.length > 0) {
      for (const err of job.error_summary) {
        const item = {
          errorCode: err.error_code || '',
          errorMessage: err.error_message || '',
        };
        if (err.sheet_name) {
          const key = `${err.sheet_name.toLowerCase()}:${err.row_index}`;
          const list = sheetErrorMap.get(key) || [];
          list.push(item);
          sheetErrorMap.set(key, list);
        }
        const fallbackList = fallbackRowErrorMap.get(err.row_index) || [];
        fallbackList.push(item);
        fallbackRowErrorMap.set(err.row_index, fallbackList);
      }
    }

    // Annotate every data sheet
    for (const worksheet of dataSheets) {
      const headerRow = worksheet.getRow(1);
      const colMap = this.mapHeaderColumns(headerRow);
      let lastCol = headerRow.actualCellCount || headerRow.cellCount;
      if (lastCol <= 0) {
        lastCol = 10;
      }

      const statusCol = lastCol + 1;
      const errorCol = lastCol + 2;

      const statusHeaderCell = headerRow.getCell(statusCol);
      statusHeaderCell.value = 'Trạng thái xử lý (Import Status)';
      statusHeaderCell.font = { bold: true };
      statusHeaderCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFD8A8' }, // light orange
      };

      const errorHeaderCell = headerRow.getCell(errorCol);
      errorHeaderCell.value = 'Lý do lỗi (Error Reason)';
      errorHeaderCell.font = { bold: true };
      errorHeaderCell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFFFC7CE' }, // light red
      };
      headerRow.commit();

      // Traverse rows starting from row 2
      for (let r = 2; r <= worksheet.rowCount; r++) {
        const row = worksheet.getRow(r);
        if (!row.hasValues) continue;

        // Skip empty template/format rows (B-UX-01 / B-LR-02)
        if (this.isRowEmpty(row, colMap)) {
          continue;
        }

        const sheetKey = `${worksheet.name.toLowerCase()}:${r}`;
        const rowErrors =
          sheetErrorMap.get(sheetKey) ||
          (dataSheets.length === 1 ? fallbackRowErrorMap.get(r) : undefined);
        const statusCell = row.getCell(statusCol);
        const errorCell = row.getCell(errorCol);

        if (rowErrors && rowErrors.length > 0) {
          const isAllWarnings = rowErrors.every((err) => this.isWarningError(err));
          const combinedMessage = ExcelFormulaSanitizer.sanitize(
            rowErrors.map((e) => e.errorMessage).join('; '),
          );

          if (isAllWarnings) {
            // BUG-03: Warnings are non-fatal -> SUCCESS WITH WARNING
            statusCell.value = 'THÀNH CÔNG (CÓ CẢNH BÁO)';
            errorCell.value = combinedMessage;

            const lightYellowFill: ExcelJS.Fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFFEB9C' }, // light yellow
            };
            statusCell.fill = lightYellowFill;
            errorCell.fill = lightYellowFill;
            statusCell.font = { color: { argb: 'FF9C5700' } }; // dark orange
            errorCell.font = { color: { argb: 'FF9C5700' } };
          } else {
            // Fatal errors -> FAILED
            statusCell.value = 'THẤT BẠI (FAILED)';
            errorCell.value = combinedMessage;

            const lightRedFill: ExcelJS.Fill = {
              type: 'pattern',
              pattern: 'solid',
              fgColor: { argb: 'FFFFC7CE' }, // light red
            };
            statusCell.fill = lightRedFill;
            errorCell.fill = lightRedFill;
            statusCell.font = { color: { argb: 'FF9C0006' } }; // dark red
            errorCell.font = { color: { argb: 'FF9C0006' } };
          }
        } else {
          statusCell.value = 'THÀNH CÔNG (SUCCESS)';
          errorCell.value = 'Đã tạo DRAFT';
        }
        row.commit();
      }

      // Sanitize 100% of cells against Formula Injection (CWE-1236 / L-07 / SEC-FORMULA-01)
      worksheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell((cell) => {
          if (cell.value !== null && cell.value !== undefined) {
            // Neutralize formula objects
            if (
              cell.type === ExcelJS.ValueType.Formula ||
              (typeof cell.value === 'object' && 'formula' in (cell.value as any))
            ) {
              const rawFormula = (cell.value as any)?.formula || (cell as any).formula;
              const res = (cell.value as any)?.result ?? '';
              cell.value = ExcelFormulaSanitizer.sanitize(String(res || rawFormula));
            } else if (typeof cell.value === 'string') {
              cell.value = ExcelFormulaSanitizer.sanitize(cell.value);
            } else if (typeof cell.value === 'object' && 'text' in cell.value) {
              (cell.value as any).text = ExcelFormulaSanitizer.sanitize((cell.value as any).text);
            }
          }
        });
        row.commit();
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  /**
   * Helper to check if a row is an empty template row (B-UX-01 / B-LR-02).
   * Checks 4 core business columns: title, seller_sku, product_ref_id, price.
   * If all 4 are empty/whitespace/undefined (even if category has prefilled text),
   * returns true so the row can be skipped without labeling as SUCCESS or FAILED.
   */
  isRowEmpty(row: ExcelJS.Row, colMap?: Map<string, number>): boolean {
    if (!row || !row.hasValues) return true;

    const map =
      colMap ||
      (row.worksheet ? this.mapHeaderColumns(row.worksheet.getRow(1)) : new Map<string, number>());

    const getCellVal = (key: string): string => {
      const colIdx = map.get(key);
      if (colIdx !== undefined) {
        return this.getCellValueAsString(row.getCell(colIdx)).trim();
      }
      try {
        const cell = row.getCell(key);
        return this.getCellValueAsString(cell).trim();
      } catch {
        return '';
      }
    };

    const titleVal = getCellVal('title');
    const skuVal = getCellVal('seller_sku');
    const refIdVal = getCellVal('product_ref_id');
    const priceVal = getCellVal('price');

    return (
      titleVal.length === 0 && skuVal.length === 0 && refIdVal.length === 0 && priceVal.length === 0
    );
  }

  /**
   * Helper to distinguish non-fatal warnings from fatal errors (BUG-03).
   * Identifies 'WARNING:', 'CẢNH BÁO:', or 'MEDIA_DOWNLOAD_FAILED'.
   */
  isWarningError(
    err:
      | string
      | {
          error_code?: string;
          error_message?: string;
          errorCode?: string;
          errorMessage?: string;
        },
  ): boolean {
    if (!err) return false;
    let text = '';
    if (typeof err === 'string') {
      text = err;
    } else {
      const code = err.error_code || err.errorCode || '';
      const msg = err.error_message || err.errorMessage || '';
      text = `${code} ${msg}`;
    }
    const upper = text.toUpperCase();
    return (
      upper.includes('WARNING:') ||
      upper.includes('CẢNH BÁO:') ||
      upper.includes('MEDIA_DOWNLOAD_FAILED')
    );
  }

  mapHeaderColumns(headerRow?: ExcelJS.Row): Map<string, number> {
    const colMap = new Map<string, number>();
    if (!headerRow) return colMap;

    headerRow.eachCell((cell, colNumber) => {
      const headerText = this.getCellValueAsString(cell).trim();
      const lower = headerText.toLowerCase();

      if (lower.includes('tham chiếu') || lower.includes('product_ref_id') || lower === 'ref_id') {
        colMap.set('product_ref_id', colNumber);
      } else if (lower.includes('tên sản phẩm') || lower.includes('title')) {
        colMap.set('title', colNumber);
      } else if (lower.includes('mã danh mục') || lower.includes('category_id')) {
        colMap.set('category_id', colNumber);
      } else if (lower.includes('mã sku') || lower.includes('seller_sku') || lower === 'sku') {
        colMap.set('seller_sku', colNumber);
      } else if (
        (lower.includes('giá bán') || lower.includes('price')) &&
        !lower.includes('niêm yết') &&
        !lower.includes('gốc') &&
        !lower.includes('original')
      ) {
        colMap.set('price', colNumber);
      }
    });

    return colMap;
  }

  getCellValueAsString(cell: ExcelJS.Cell | null | undefined): string {
    if (!cell || cell.value === null || cell.value === undefined) return '';
    if (typeof cell.value === 'object') {
      if ('richText' in cell.value && Array.isArray((cell.value as any).richText)) {
        return (cell.value as any).richText.map((t: any) => t.text).join('');
      }
      if ('text' in cell.value) {
        return String((cell.value as any).text);
      }
      if ('result' in cell.value) {
        return String((cell.value as any).result);
      }
    }
    return String(cell.value);
  }

  private async generateFallbackBuffer(job: ImportJobDocument): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Báo cáo kết quả');

    // BUG-04: Include Tên Sheet (sheet_name) for multi-sheet error reporting
    sheet.columns = [
      { header: 'Tên Sheet', key: 'sheet_name', width: 22 },
      { header: 'Dòng', key: 'row_index', width: 10 },
      { header: 'Mã tham chiếu (product_ref_id)', key: 'product_ref_id', width: 28 },
      { header: 'Mã SKU (seller_sku)', key: 'seller_sku', width: 24 },
      { header: 'Mã lỗi (error_code)', key: 'error_code', width: 30 },
      { header: 'Chi tiết lỗi (error_message)', key: 'error_message', width: 50 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFC7CE' },
    };
    headerRow.commit();

    if (job.error_summary && job.error_summary.length > 0) {
      for (const err of job.error_summary) {
        const addedRow = sheet.addRow({
          sheet_name: ExcelFormulaSanitizer.sanitize(err.sheet_name || ''),
          row_index: err.row_index,
          product_ref_id: ExcelFormulaSanitizer.sanitize(err.product_ref_id),
          seller_sku: ExcelFormulaSanitizer.sanitize(err.seller_sku || ''),
          error_code: ExcelFormulaSanitizer.sanitize(err.error_code),
          error_message: ExcelFormulaSanitizer.sanitize(err.error_message),
        });
        addedRow.eachCell((cell) => {
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE2DD' },
          };
        });
        addedRow.commit();
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
