import { Test, TestingModule } from '@nestjs/testing';
import { AdminModerationController } from '../../src/moderation/controllers/admin-moderation.controller';
import { ModerationService } from '../../src/moderation/services/moderation.service';
import { ActorContext } from '../../src/common/context/actor-context.interface';

describe('AdminModerationController', () => {
  let controller: AdminModerationController;

  const mockModerationService = {
    blockProduct: jest.fn(),
    unblockProduct: jest.fn(),
    getAudits: jest.fn(),
  };

  const actor: ActorContext = {
    userId: '01912f30-7a1b-7c12-9c55-8b1c34a6d001',
    roles: ['CATALOG_ADMIN'],
    permissions: [],
    isAuthenticated: true,
  };
  const productId = '01912f31-7a1b-7c12-9c55-8b1c34a6d003';

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminModerationController],
      providers: [
        {
          provide: ModerationService,
          useValue: mockModerationService,
        },
      ],
    }).compile();

    controller = module.get<AdminModerationController>(AdminModerationController);
  });

  it('should call moderationService.blockProduct', async () => {
    const expected = {
      product_id: productId,
      status: 'BLOCKED',
      blocked_at: new Date(),
      version: 9,
    };
    mockModerationService.blockProduct.mockResolvedValue(expected);

    const result = await controller.blockProduct(actor, productId, {
      version: 8,
      reason: 'Vi phạm chính sách',
    });
    expect(result).toBe(expected);
    expect(mockModerationService.blockProduct).toHaveBeenCalledWith(actor.userId, productId, {
      version: 8,
      reason: 'Vi phạm chính sách',
    });
  });

  it('should call moderationService.unblockProduct', async () => {
    const expected = {
      product_id: productId,
      status: 'INACTIVE',
      next_status: 'INACTIVE',
      version: 10,
    };
    mockModerationService.unblockProduct.mockResolvedValue(expected);

    const result = await controller.unblockProduct(actor, productId, {
      version: 9,
      reason: 'Đã giải trình',
    });
    expect(result).toBe(expected);
    expect(mockModerationService.unblockProduct).toHaveBeenCalledWith(actor.userId, productId, {
      version: 9,
      reason: 'Đã giải trình',
    });
  });

  it('should call moderationService.getAudits', async () => {
    const expected = {
      data: [{ _id: 'audit-01', action: 'BLOCK' }],
      meta: { page: 1, size: 20, total: 1, total_pages: 1 },
    };
    mockModerationService.getAudits.mockResolvedValue(expected);

    const query = { target_id: productId, page: 1, size: 20 };
    const result = await controller.getAudits(query);
    expect(result).toBe(expected);
    expect(mockModerationService.getAudits).toHaveBeenCalledWith(query);
  });
});
