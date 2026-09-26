import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ClientSession, Model } from 'mongoose';
import { InventoryProjectionRepository } from '../../src/projections/repositories/inventory-projection.repository';
import {
  InventoryProjection,
  InventoryProjectionDocument,
  InventoryStockStatus,
} from '../../src/database/schemas/inventory-projection.schema';

describe('InventoryProjectionRepository', () => {
  let repository: InventoryProjectionRepository;
  let mockModel: jest.Mocked<Model<InventoryProjectionDocument>>;
  let mockSession: ClientSession;

  const mockSkuId = '01912f33-7a1b-7c12-9c55-8b1c34a6d923';
  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';

  beforeEach(async () => {
    mockSession = {} as ClientSession;

    mockModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      findOneAndUpdate: jest.fn(),
    } as unknown as jest.Mocked<Model<InventoryProjectionDocument>>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryProjectionRepository,
        {
          provide: getModelToken(InventoryProjection.name),
          useValue: mockModel,
        },
      ],
    }).compile();

    repository = module.get<InventoryProjectionRepository>(InventoryProjectionRepository);
  });

  describe('findBySkuId', () => {
    it('should query by sku_id and return document', async () => {
      const mockResult = { _id: mockSkuId, sku_id: mockSkuId, product_id: mockProductId };
      const execMock = jest.fn().mockResolvedValue(mockResult);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOne as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.findBySkuId(mockSkuId, mockSession);

      expect(mockModel.findOne).toHaveBeenCalledWith({ sku_id: mockSkuId });
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockResult);
    });

    it('should return null if sku_id not found', async () => {
      const execMock = jest.fn().mockResolvedValue(null);
      (mockModel.findOne as jest.Mock).mockReturnValue({ exec: execMock });

      const result = await repository.findBySkuId(mockSkuId);

      expect(mockModel.findOne).toHaveBeenCalledWith({ sku_id: mockSkuId });
      expect(result).toBeNull();
    });
  });

  describe('findByProductId', () => {
    it('should return list of projections for product_id', async () => {
      const mockList = [{ _id: mockSkuId, sku_id: mockSkuId, product_id: mockProductId }];
      const execMock = jest.fn().mockResolvedValue(mockList);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.find as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.findByProductId(mockProductId, mockSession);

      expect(mockModel.find).toHaveBeenCalledWith({ product_id: mockProductId });
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockList);
    });
  });

  describe('upsertProjection', () => {
    it('should call findOneAndUpdate with upsert: true', async () => {
      const projectionData: Partial<InventoryProjection> = {
        sku_id: mockSkuId,
        product_id: mockProductId,
        available_qty_snapshot: BigInt(10),
        reserved_qty_snapshot: BigInt(2),
        committed_qty_snapshot: BigInt(0),
        stock_status: InventoryStockStatus.IN_STOCK,
        as_of: new Date(),
        source_version: BigInt(5),
        source_event_id: 'inv-evt-01',
      };

      const mockSaved = { ...projectionData, _id: mockSkuId };
      const execMock = jest.fn().mockResolvedValue(mockSaved);
      const sessionMock = jest.fn().mockReturnValue({ exec: execMock });
      (mockModel.findOneAndUpdate as jest.Mock).mockReturnValue({
        session: sessionMock,
        exec: execMock,
      });

      const result = await repository.upsertProjection(projectionData, mockSession);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { sku_id: mockSkuId },
        {
          $set: {
            ...projectionData,
            _id: mockSkuId,
            sku_id: mockSkuId,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
      expect(sessionMock).toHaveBeenCalledWith(mockSession);
      expect(result).toEqual(mockSaved);
    });

    it('should throw an error if sku_id is missing', async () => {
      await expect(repository.upsertProjection({ product_id: mockProductId })).rejects.toThrow(
        'sku_id is required for upsertProjection',
      );
    });
  });
});
