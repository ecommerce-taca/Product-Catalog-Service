import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SellerExportController } from '../../src/export/controllers/seller-export.controller';
import { ExportService } from '../../src/export/services/export.service';
import { ExportFormat, ExportProductsDto } from '../../src/export/dto/export-products.dto';
import { ExportResponseDto } from '../../src/export/dto/export-response.dto';
import { ActorContext } from '../../src/common/context/actor-context.interface';

describe('SellerExportController', () => {
  let controller: SellerExportController;
  let service: ExportService;

  const mockExportService = {
    exportProducts: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerExportController],
      providers: [
        {
          provide: ExportService,
          useValue: mockExportService,
        },
      ],
    }).compile();

    controller = module.get<SellerExportController>(SellerExportController);
    service = module.get<ExportService>(ExportService);
  });

  describe('exportProducts', () => {
    it('should delegate to ExportService with actorShopScope', async () => {
      const actor: ActorContext = {
        userId: 'user-01',
        roles: ['SELLER'],
        permissions: [],
        shopScope: 'shop-01',
        isAuthenticated: true,
      };
      const query: ExportProductsDto = { format: ExportFormat.CSV };
      const expectedResponse: ExportResponseDto = {
        export_url: 'https://storage.example/signed.csv',
        format: 'csv',
        row_count: 10,
        generated_at: '2026-08-30T09:00:00Z',
        expires_at: '2026-08-30T09:30:00Z',
      };
      mockExportService.exportProducts.mockResolvedValue(expectedResponse);

      const result = await controller.exportProducts(actor, 'shop-01', query);

      expect(result).toBe(expectedResponse);
      expect(service.exportProducts).toHaveBeenCalledWith('shop-01', query);
    });

    it('should fallback to actor.shopScope if shopScope param is empty', async () => {
      const actor: ActorContext = {
        userId: 'user-01',
        roles: ['SELLER'],
        permissions: [],
        shopScope: 'shop-01',
        isAuthenticated: true,
      };
      const query: ExportProductsDto = { format: ExportFormat.CSV };
      mockExportService.exportProducts.mockResolvedValue({} as ExportResponseDto);

      await controller.exportProducts(actor, '', query);

      expect(service.exportProducts).toHaveBeenCalledWith('shop-01', query);
    });

    it('should throw 403 PRODUCT_FORBIDDEN when no shopScope is present', async () => {
      const actor: ActorContext = {
        userId: 'user-01',
        roles: ['SELLER'],
        permissions: [],
        shopScope: undefined,
        isAuthenticated: true,
      };
      const query: ExportProductsDto = {};

      await expect(controller.exportProducts(actor, '', query)).rejects.toThrow(ForbiddenException);
    });
  });
});
