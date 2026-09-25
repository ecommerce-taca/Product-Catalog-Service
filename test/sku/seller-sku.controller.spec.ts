import { Test, TestingModule } from '@nestjs/testing';
import { SellerSkuController } from '../../src/sku/controllers/seller-sku.controller';
import { SkuService } from '../../src/sku/services/sku.service';
import { UpdateProductSkusDto } from '../../src/sku/dto/update-product-skus.dto';
import { SkuResponseDto } from '../../src/sku/dto/sku-response.dto';
import { AttributeType } from '../../src/database/schemas/attribute-definition.schema';
import { SkuStatus } from '../../src/database/schemas/sku.schema';

describe('SellerSkuController', () => {
  let controller: SellerSkuController;
  let mockSkuService: jest.Mocked<SkuService>;

  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';
  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';

  const mockResponse: SkuResponseDto[] = [
    {
      sku_id: '01912f33-7a1b-7c12-9c55-8b1c34a6d923',
      product_id: mockProductId,
      shop_id: mockShopId,
      seller_sku: 'TEE-BLK-M',
      attributes: { color: 'black', size: 'M' },
      variant_key: 'color=black|size=M',
      price_override: null,
      price: {
        base_price: 299000,
        sale_price: 249000,
        currency: 'VND',
      },
      status: SkuStatus.ACTIVE,
      media_ids: [],
      version: 1,
    },
  ];

  beforeEach(async () => {
    mockSkuService = {
      updateProductSkus: jest.fn().mockResolvedValue(mockResponse),
      getSkusByProductId: jest.fn().mockResolvedValue(mockResponse),
    } as unknown as jest.Mocked<SkuService>;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SellerSkuController],
      providers: [
        {
          provide: SkuService,
          useValue: mockSkuService,
        },
      ],
    }).compile();

    controller = module.get<SellerSkuController>(SellerSkuController);
  });

  describe('updateProductSkus', () => {
    it('should delegate to skuService.updateProductSkus with correct arguments', async () => {
      const dto: UpdateProductSkusDto = {
        version: 1,
        attribute_definitions: [
          {
            key: 'color',
            label: 'Màu',
            type: AttributeType.STRING,
            is_variant_dimension: true,
          },
        ],
        skus: [
          {
            seller_sku: 'TEE-BLK-M',
            attributes: { color: 'black' },
            price_override: null,
          },
        ],
      };

      const result = await controller.updateProductSkus(mockProductId, mockShopId, dto);

      expect(mockSkuService.updateProductSkus).toHaveBeenCalledWith(mockProductId, mockShopId, dto);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getProductSkus', () => {
    it('should delegate to skuService.getSkusByProductId with correct arguments', async () => {
      const result = await controller.getProductSkus(mockProductId, mockShopId);

      expect(mockSkuService.getSkusByProductId).toHaveBeenCalledWith(mockProductId, mockShopId);
      expect(result).toEqual(mockResponse);
    });
  });
});
