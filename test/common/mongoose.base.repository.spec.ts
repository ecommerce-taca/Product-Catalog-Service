import { ClientSession, Document, Model } from 'mongoose';
import { MongooseBaseRepository } from '../../src/common/repositories/mongoose.base.repository';

interface TestDoc extends Document<string> {
  name: string;
}

class TestRepository extends MongooseBaseRepository<TestDoc> {
  constructor(model: Model<TestDoc>) {
    super(model);
  }
}

describe('MongooseBaseRepository', () => {
  let repository: TestRepository;
  let mockModel: jest.Mocked<Model<TestDoc>>;
  let mockSession: Partial<ClientSession>;

  beforeEach(() => {
    mockSession = {};

    const mockQuery = {
      session: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue({ _id: 'test-id', name: 'Sample' }),
    };

    mockModel = {
      findById: jest.fn().mockReturnValue({ ...mockQuery }),
      findOne: jest.fn().mockReturnValue({ ...mockQuery }),
      find: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([{ _id: 'test-id', name: 'Sample' }]),
      }),
      findOneAndUpdate: jest.fn().mockReturnValue({ ...mockQuery }),
      deleteOne: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue({ deletedCount: 1 }),
      }),
      countDocuments: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(5),
      }),
      create: jest.fn().mockResolvedValue([{ _id: 'new-id', name: 'Created' }]),
    } as unknown as jest.Mocked<Model<TestDoc>>;

    repository = new TestRepository(mockModel);
  });

  it('findById should pass session to query when provided', async () => {
    const result = await repository.findById('test-id', mockSession as ClientSession);

    expect(mockModel.findById).toHaveBeenCalledWith('test-id');
    expect(result).toEqual({ _id: 'test-id', name: 'Sample' });
  });

  it('findOne should pass session to query when provided', async () => {
    const result = await repository.findOne({ name: 'Sample' }, mockSession as ClientSession);

    expect(mockModel.findOne).toHaveBeenCalledWith({ name: 'Sample' });
    expect(result).toEqual({ _id: 'test-id', name: 'Sample' });
  });

  it('create should call model.create when session is provided', async () => {
    const result = await repository.create({ name: 'Created' }, mockSession as ClientSession);

    expect(mockModel.create).toHaveBeenCalledWith([{ name: 'Created' }], {
      session: mockSession,
    });
    expect(result).toEqual({ _id: 'new-id', name: 'Created' });
  });

  it('delete should return true when deletedCount > 0', async () => {
    const result = await repository.delete({ _id: 'test-id' });

    expect(result).toBe(true);
  });

  it('count should return total documents', async () => {
    const result = await repository.count({});

    expect(result).toBe(5);
  });
});
