import { Test, TestingModule } from '@nestjs/testing';
import { SellerPublishController } from '../../src/publish-policy/controllers/seller-publish.controller';
import { PublishPolicyService } from '../../src/publish-policy/services/publish-policy.service';
import { ActorContext } from '../../src/common/context/actor-context.interface';

describe('SellerPublishController', () => {
  let controller: SellerPublishController;

  const mockPublishPolicyService = {
    publish: jest.fn(),
    unpublish: jest.fn(),
    archive: jest.fn(),
  };

  const actor: ActorContext = {
    userId: '01912f30-7a1b-7c12-9c55-8b1c34a6d001',
    roles: ['SELLER'],
    permissions: [],
    shopScope: '01912f30-7a1b-7c12-9c55-8b1c34a6d002',
    isAuthenticated: true,
  };
  const shopScope = '01912f30-7a1b-7c12-9c55-8b1c34a6d002';
  const productId = '01912f31-7a1b-7c12-9c55-8b1c34a6d003';

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerPublishController],
      providers: [
        {
          provide: PublishPolicyService,
          useValue: mockPublishPolicyService,
        },
      ],
    }).compile();

    controller = module.get<SellerPublishController>(SellerPublishController);
  });

  it('should call publishPolicyService.publish', async () => {
    const expected = {
      product_id: productId,
      status: 'ACTIVE',
      published_at: new Date(),
      version: 2,
      stock_display: { status: 'IN_STOCK', as_of: new Date() },
    };
    mockPublishPolicyService.publish.mockResolvedValue(expected);

    const result = await controller.publish(actor, shopScope, productId, { version: 1 });
    expect(result).toBe(expected);
    expect(mockPublishPolicyService.publish).toHaveBeenCalledWith(
      actor.userId,
      shopScope,
      productId,
      { version: 1 },
    );
  });

  it('should call publishPolicyService.unpublish', async () => {
    const expected = {
      product_id: productId,
      status: 'INACTIVE',
      version: 3,
    };
    mockPublishPolicyService.unpublish.mockResolvedValue(expected);

    const result = await controller.unpublish(actor, shopScope, productId, {
      version: 2,
      reason: 'Bảo trì',
    });
    expect(result).toBe(expected);
    expect(mockPublishPolicyService.unpublish).toHaveBeenCalledWith(
      actor.userId,
      shopScope,
      productId,
      { version: 2, reason: 'Bảo trì' },
    );
  });

  it('should call publishPolicyService.archive', async () => {
    const expected = {
      product_id: productId,
      status: 'ARCHIVED',
      version: 4,
    };
    mockPublishPolicyService.archive.mockResolvedValue(expected);

    const result = await controller.archive(actor, shopScope, productId, {
      version: 3,
      reason: 'Ngừng kinh doanh',
    });
    expect(result).toBe(expected);
    expect(mockPublishPolicyService.archive).toHaveBeenCalledWith(
      actor.userId,
      shopScope,
      productId,
      { version: 3, reason: 'Ngừng kinh doanh' },
    );
  });
});
