import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { MongoImportJobRepository } from '../../src/import/repositories/import-job.repository';
import {
  ImportJob,
  ImportJobDocument,
  ImportJobStatus,
} from '../../src/database/schemas/import-job.schema';

describe('MongoImportJobRepository', () => {
  let repository: MongoImportJobRepository;
  let mockModel: jest.Mocked<Model<ImportJobDocument>>;
  let mockSession: ClientSession;

  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';
  const mockJobId = '01912f70-7a1b-7c12-9c55-8b1c34a6d921';
  const mockActorUserId = '01912f10-7a1b-7c12-9c55-8b1c34a6d922';

  beforeEach(async () => {
    mockSession = {} as ClientSession;

    mockModel = {
      findById: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateMany: jest.fn(),
      deleteOne: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    } as unknown as jest.Mocked<Model<ImportJobDocument>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MongoImportJobRepository,
        {
          provide: getModelToken(ImportJob.name),
          useValue: mockModel,
        },
      ],
    }).compile();

    repository = module.get<MongoImportJobRepository>(MongoImportJobRepository);
  });

  describe('findActiveJobByShop', () => {
    it('should query active jobs with status PENDING or active PROCESSING lease and return document', async () => {
      const mockJob = {
        _id: mockJobId,
        shop_id: mockShopId,
        status: ImportJobStatus.PROCESSING,
      };
      const execMock = jest.fn().mockResolvedValue(mockJob);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      const sortMock = jest.fn().mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });
      (mockModel.findOne as jest.Mock).mockReturnValue({
        sort: sortMock,
      });

      const result = await repository.findActiveJobByShop(mockShopId, mockSession);

      expect(mockModel.findOne).toHaveBeenCalledWith({
        shop_id: mockShopId,
        $or: [
          { status: ImportJobStatus.PENDING },
          {
            status: ImportJobStatus.PROCESSING,
            $or: [{ locked_until: null }, { locked_until: { $gt: expect.any(Date) } }],
          },
        ],
      });
      expect(sortMock).toHaveBeenCalledWith({ created_at: -1 });
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockJob);
    });

    it('should return null when no active job exists for shop', async () => {
      const execMock = jest.fn().mockResolvedValue(null);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      const sortMock = jest.fn().mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });
      (mockModel.findOne as jest.Mock).mockReturnValue({
        sort: sortMock,
      });

      const result = await repository.findActiveJobByShop(mockShopId);

      expect(mockModel.findOne).toHaveBeenCalledWith({
        shop_id: mockShopId,
        $or: [
          { status: ImportJobStatus.PENDING },
          {
            status: ImportJobStatus.PROCESSING,
            $or: [{ locked_until: null }, { locked_until: { $gt: expect.any(Date) } }],
          },
        ],
      });
      expect(sortMock).toHaveBeenCalledWith({ created_at: -1 });
      expect(result).toBeNull();
    });
  });

  describe('claimNextPendingJob', () => {
    it('should atomically claim the oldest PENDING job with 2-minute lease', async () => {
      const mockClaimed = {
        _id: mockJobId,
        shop_id: mockShopId,
        status: ImportJobStatus.PROCESSING,
        locked_until: new Date(Date.now() + 120_000),
      };
      const execMock = jest.fn().mockResolvedValue(mockClaimed);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOneAndUpdate as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.claimNextPendingJob(120_000, mockSession);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { status: ImportJobStatus.PENDING },
        expect.objectContaining({
          $set: expect.objectContaining({
            status: ImportJobStatus.PROCESSING,
            started_at: expect.any(Date),
            locked_until: expect.any(Date),
          }),
        }),
        {
          sort: { created_at: 1 },
          new: true,
          runValidators: true,
        },
      );
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockClaimed);
    });

    it('should return null if no PENDING job exists to claim', async () => {
      const execMock = jest.fn().mockResolvedValue(null);
      (mockModel.findOneAndUpdate as jest.Mock).mockReturnValue({ exec: execMock });

      const result = await repository.claimNextPendingJob();

      expect(result).toBeNull();
    });
  });

  describe('reclaimStaleJobs', () => {
    it('should mark stale PROCESSING jobs as FAILED and append timeout error summary', async () => {
      const execMock = jest.fn().mockResolvedValue({ modifiedCount: 2 });
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.updateMany as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const fixedNow = new Date('2026-09-26T12:00:00Z');
      const count = await repository.reclaimStaleJobs(fixedNow, mockSession);

      expect(mockModel.updateMany).toHaveBeenCalledWith(
        {
          status: ImportJobStatus.PROCESSING,
          locked_until: { $lte: fixedNow },
        },
        expect.objectContaining({
          $set: {
            status: ImportJobStatus.FAILED,
            completed_at: fixedNow,
          },
          $push: {
            error_summary: {
              row_index: 0,
              product_ref_id: 'SYSTEM',
              error_code: 'PRODUCT_IMPORT_WORKER_TIMEOUT',
              error_message: 'Tiến trình xử lý bị quá hạn (worker heartbeat timeout)',
            },
          },
        }),
      );
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(count).toBe(2);
    });
  });

  describe('findByShopAndId', () => {
    it('should find job matching both _id and shop_id for Zero-Trust IDOR protection', async () => {
      const mockJob = {
        _id: mockJobId,
        shop_id: mockShopId,
        status: ImportJobStatus.COMPLETED,
      };
      const execMock = jest.fn().mockResolvedValue(mockJob);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOne as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.findByShopAndId(mockShopId, mockJobId, mockSession);

      expect(mockModel.findOne).toHaveBeenCalledWith({
        _id: mockJobId,
        shop_id: mockShopId,
      });
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockJob);
    });
  });

  describe('updateHeartbeat', () => {
    it('should extend locked_until for active PROCESSING job', async () => {
      const mockUpdated = {
        _id: mockJobId,
        status: ImportJobStatus.PROCESSING,
        locked_until: new Date(Date.now() + 120_000),
      };
      const execMock = jest.fn().mockResolvedValue(mockUpdated);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOneAndUpdate as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.updateHeartbeat(mockJobId, 120_000, mockSession);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: mockJobId, status: ImportJobStatus.PROCESSING },
        expect.objectContaining({
          $set: expect.objectContaining({
            locked_until: expect.any(Date),
          }),
        }),
        { new: true, runValidators: true },
      );
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockUpdated);
    });
  });

  describe('inherited BaseRepository methods', () => {
    it('findById should query by id', async () => {
      const mockJob = { _id: mockJobId };
      const execMock = jest.fn().mockResolvedValue(mockJob);
      (mockModel.findById as jest.Mock).mockReturnValue({ exec: execMock });

      const result = await repository.findById(mockJobId);

      expect(mockModel.findById).toHaveBeenCalledWith(mockJobId);
      expect(result).toEqual(mockJob);
    });

    it('create should persist a new job document', async () => {
      const newJob = {
        _id: mockJobId,
        shop_id: mockShopId,
        actor_user_id: mockActorUserId,
        status: ImportJobStatus.PENDING,
        file_url: 's3://bucket/test.xlsx',
      };
      (mockModel.create as jest.Mock).mockResolvedValue([newJob]);

      const result = await repository.create(newJob, mockSession);

      expect(mockModel.create).toHaveBeenCalledWith([newJob], { session: mockSession });
      expect(result).toEqual(newJob);
    });

    it('count should count matching documents', async () => {
      const execMock = jest.fn().mockResolvedValue(3);
      (mockModel.countDocuments as jest.Mock).mockReturnValue({ exec: execMock });

      const count = await repository.count({ shop_id: mockShopId });

      expect(mockModel.countDocuments).toHaveBeenCalledWith({ shop_id: mockShopId });
      expect(count).toBe(3);
    });
  });
});
