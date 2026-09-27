import { ClientSession } from 'mongoose';
import { BaseRepository } from '../../common/repositories/base.repository.interface';
import { ImportJobDocument } from '../../database/schemas/import-job.schema';

export interface ImportJobRepositoryPort extends BaseRepository<ImportJobDocument> {
  /**
   * Tìm tác vụ đang hoạt động (PENDING hoặc PROCESSING) của gian hàng.
   * Dùng để kiểm tra giới hạn 1 job active / shop (Tenant Throttle - BR-IM-06).
   */
  findActiveJobByShop(shopId: string, session?: ClientSession): Promise<ImportJobDocument | null>;

  /**
   * Atomic claim tác vụ PENDING cũ nhất (FIFO), chuyển sang PROCESSING và cấp lease.
   */
  claimNextPendingJob(
    leaseDurationMs?: number,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null>;

  /**
   * Quét và phục hồi các tác vụ PROCESSING bị treo quá hạn locked_until (zombie jobs),
   * chuyển trạng thái sang FAILED để giải phóng shop.
   */
  reclaimStaleJobs(now?: Date, session?: ClientSession): Promise<number>;

  /**
   * Tra cứu tác vụ theo shop_id và jobId để đảm bảo kiểm tra Zero-Trust IDOR.
   */
  findByShopAndId(
    shopId: string,
    jobId: string,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null>;

  /**
   * Gia hạn heartbeat lease cho tác vụ đang xử lý.
   */
  updateHeartbeat(
    jobId: string,
    leaseDurationMs?: number,
    session?: ClientSession,
  ): Promise<ImportJobDocument | null>;
}
