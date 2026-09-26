import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { ShopSnapshotRepository } from '../../src/projections/repositories/shop-snapshot.repository';
import {
  KycStatus,
  ShopSnapshot,
  ShopSnapshotDocument,
  ShopStatus,
} from '../../src/database/schemas/shop-snapshot.schema';

describe('ShopSnapshotRepository', () => {
  let repository: ShopSnapshotRepository;
  let mockModel: jest.Mocked<Model<ShopSnapshotDocument>>;
  let mockSession: ClientSession;

  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';

  beforeEach(async () => {
    mockSession = {} as ClientSession;

    mockModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    } as unknown as jest.Mocked<Model<ShopSnapshotDocument>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ShopSnapshotRepository,
        {
          provide: getModelToken(ShopSnapshot.name),
          useValue: mockModel,
        },
      ],
    }).compile();

    repository = module.get<ShopSnapshotRepository>(ShopSnapshotRepository);
  });

  describe('findByShopId', () => {
    it('should query by shop_id and return document', async () => {
      const mockResult = { _id: mockShopId, shop_id: mockShopId, name: 'Shop Test' };
      const execMock = jest.fn().mockResolvedValue(mockResult);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOne as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.findByShopId(mockShopId, mockSession);

      expect(mockModel.findOne).toHaveBeenCalledWith({ shop_id: mockShopId });
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockResult);
    });

    it('should return null if shop_id not found without session', async () => {
      const execMock = jest.fn().mockResolvedValue(null);
      (mockModel.findOne as jest.Mock).mockReturnValue({ exec: execMock });

      const result = await repository.findByShopId(mockShopId);

      expect(mockModel.findOne).toHaveBeenCalledWith({ shop_id: mockShopId });
      expect(result).toBeNull();
    });
  });

  describe('upsertSnapshot', () => {
    it('should call findOneAndUpdate with upsert: true', async () => {
      const snapshotData: Partial<ShopSnapshot> = {
        shop_id: mockShopId,
        name: 'Cool Shop',
        slug: 'cool-shop',
        shop_status: ShopStatus.ACTIVE,
        kyc_status: KycStatus.APPROVED,
        source_version: BigInt(2),
        source_event_id: 'evt-001',
        updated_at: new Date(),
      };

      const mockSaved = { ...snapshotData, _id: mockShopId };
      const execMock = jest.fn().mockResolvedValue(mockSaved);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOneAndUpdate as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.upsertSnapshot(snapshotData, mockSession);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { shop_id: mockShopId },
        {
          $set: {
            ...snapshotData,
            _id: mockShopId,
            shop_id: mockShopId,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockSaved);
    });

    it('should throw an error if shop_id and _id are missing', async () => {
      await expect(repository.upsertSnapshot({ name: 'Invalid' })).rejects.toThrow(
        'shop_id is required for upsertSnapshot',
      );
    });
  });
});
