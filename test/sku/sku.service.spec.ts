import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ClientSession } from 'mongoose';
import { SkuService } from '../../src/sku/services/sku.service';
import { VariantResolver } from '../../src/sku/services/variant-resolver.service';
import { AttributeDefinitionRepositoryPort } from '../../src/attribute/repositories/attribute-definition.repository.interface';
import { SkuRepositoryPort } from '../../src/sku/repositories/sku.repository.interface';
import { ProductRepositoryPort } from '../../src/product/repositories/product.repository.interface';
import { TransactionRunner } from '../../src/database/transaction.runner';
import { ProductDocument, ProductStatus } from '../../src/database/schemas/product.schema';
import { SkuDocument, SkuStatus } from '../../src/database/schemas/sku.schema';
import { AttributeType } from '../../src/database/schemas/attribute-definition.schema';
import { UpdateProductSkusDto } from '../../src/sku/dto/update-product-skus.dto';

describe('SkuService', () => {
  let service: SkuService;
  let mockProductRepo: jest.Mocked<ProductRepositoryPort>;
  let mockAttrDefRepo: jest.Mocked<AttributeDefinitionRepositoryPort>;
  let mockSkuRepo: jest.Mocked<SkuRepositoryPort>;
  let mockTransactionRunner: jest.Mocked<TransactionRunner>;
  let mockSession: ClientSession;

  const mockShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d920';
  const mockOtherShopId = '01912f30-7a1b-7c12-9c55-8b1c34a6d999';
  const mockProductId = '01912f31-7a1b-7c12-9c55-8b1c34a6d921';

  const createMockProduct = (overrides?: Partial<ProductDocument>): ProductDocument => {
    return {
      _id: mockProductId,
      shop_id: mockShopId,
      title: 'Áo thun cotton cao cấp',
      slug: 'ao-thun-cotton-cao-cap',
      status: ProductStatus.DRAFT,
      price_summary: {
        base_price: BigInt(299000),
        sale_price: BigInt(249000),
        currency: 'VND',
      },
      version: BigInt(1),
      save: jest.fn().mockImplementation(function (this: ProductDocument) {
        return Promise.resolve(this);
      }),
      ...overrides,
    } as unknown as ProductDocument;
  };

  const createMockSku = (overrides?: Partial<SkuDocument>): SkuDocument => {
    return {
      _id: '01912f33-7a1b-7c12-9c55-8b1c34a6d923',
      product_id: mockProductId,
      shop_id: mockShopId,
      seller_sku: 'TEE-BLK-M',
      attributes: { color: 'black', size: 'M' },
      variant_key: 'color=black|size=M',
      price_override: null,
      status: SkuStatus.ACTIVE,
      media_ids: [],
      version: BigInt(1),
      created_at: new Date('2026-09-01T00:00:00Z'),
      updated_at: new Date('2026-09-01T00:00:00Z'),
      save: jest.fn().mockImplementation(function (this: SkuDocument) {
        return Promise.resolve(this);
      }),
      ...overrides,
    } as unknown as SkuDocument;
  };

  beforeEach(async () => {
    mockSession = { id: 'mock-session-id' } as unknown as ClientSession;
    mockTransactionRunner = {
      execute: jest
        .fn()
        .mockImplementation(async (cb: (session: ClientSession) => Promise<unknown>) => {
          return cb(mockSession);
        }),
    } as unknown as jest.Mocked<TransactionRunner>;

    mockProductRepo = {
      findById: jest.fn(),
      atomicCasUpdate: jest
        .fn()
        .mockImplementation((_productId, _shopId, expectedVersion, updateData) => {
          return Promise.resolve({
            ...createMockProduct(),
            version: BigInt(expectedVersion) + BigInt(1),
            price_summary: (
              updateData as {
                price_summary?: {
                  base_price: bigint;
                  sale_price: bigint;
                  currency: string;
                };
              }
            )?.price_summary || {
              base_price: BigInt(299000),
              sale_price: BigInt(249000),
              currency: 'VND',
            },
          } as ProductDocument);
        }),
      findByShopAndId: jest.fn(),
      findByShopAndSlug: jest.fn(),
      findSellerProducts: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findAll: jest.fn(),
    } as unknown as jest.Mocked<ProductRepositoryPort>;

    mockAttrDefRepo = {
      findByScope: jest.fn().mockResolvedValue([]),
      deleteByScope: jest.fn().mockResolvedValue(0),
      bulkUpsert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AttributeDefinitionRepositoryPort>;

    mockSkuRepo = {
      findByProductId: jest.fn().mockResolvedValue([]),
      findBySellerSku: jest.fn().mockResolvedValue(null),
      findBySellerSkus: jest.fn().mockResolvedValue([]),
      countBySellerSku: jest.fn().mockResolvedValue(0),
      bulkUpsert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SkuRepositoryPort>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkuService,
        VariantResolver,
        {
          provide: 'ProductRepositoryPort',
          useValue: mockProductRepo,
        },
        {
          provide: 'AttributeDefinitionRepositoryPort',
          useValue: mockAttrDefRepo,
        },
        {
          provide: 'SkuRepositoryPort',
          useValue: mockSkuRepo,
        },
        {
          provide: TransactionRunner,
          useValue: mockTransactionRunner,
        },
      ],
    }).compile();

    service = module.get<SkuService>(SkuService);
  });

  describe('updateProductSkus', () => {
    const validDto: UpdateProductSkusDto = {
      version: 1,
      attribute_definitions: [
        {
          key: 'color',
          label: 'Màu sắc',
          type: AttributeType.ENUM,
          is_variant_dimension: true,
          allowed_values: ['black', 'white'],
        },
        {
          key: 'size',
          label: 'Kích cỡ',
          type: AttributeType.ENUM,
          is_variant_dimension: true,
          allowed_values: ['S', 'M', 'L'],
        },
      ],
      skus: [
        {
          seller_sku: 'TEE-BLK-M',
          attributes: { color: 'black', size: 'M' },
          price_override: 199000,
          status: SkuStatus.ACTIVE,
        },
        {
          seller_sku: 'TEE-WHT-L',
          attributes: { color: 'white', size: 'L' },
          price_override: null,
          status: SkuStatus.ACTIVE,
        },
      ],
    };

    it('should successfully update SKUs, recalculate price_summary and increment product version inside transaction', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const result = await service.updateProductSkus(mockProductId, mockShopId, validDto);

      // Verify transaction runner was executed
      expect(mockTransactionRunner.execute).toHaveBeenCalled();

      // Verify attribute definitions were replaced
      expect(mockAttrDefRepo.deleteByScope).toHaveBeenCalledWith(
        'PRODUCT',
        mockProductId,
        mockSession,
      );
      expect(mockAttrDefRepo.bulkUpsert).toHaveBeenCalled();

      // Verify SKUs were upserted
      expect(mockSkuRepo.bulkUpsert).toHaveBeenCalled();

      // Verify price calculation and atomic CAS update:
      // Product base_price = 299000
      // SKU 1 sale_price = 199000
      // SKU 2 sale_price = product.price_summary.sale_price = 249000
      // min sale_price = 199000
      expect(mockProductRepo.atomicCasUpdate).toHaveBeenCalledWith(
        mockProductId,
        mockShopId,
        BigInt(1),
        {
          price_summary: {
            base_price: BigInt(299000),
            sale_price: BigInt(199000),
            currency: 'VND',
          },
        },
        mockSession,
      );

      // Verify response payload
      expect(result).toHaveLength(2);
      expect(result[0].seller_sku).toBe('TEE-BLK-M');
      expect(result[0].variant_key).toBe('color=black|size=M');
      expect(result[0].price).toEqual({
        base_price: 299000,
        sale_price: 199000,
        currency: 'VND',
      });
      expect(result[1].seller_sku).toBe('TEE-WHT-L');
      expect(result[1].price).toEqual({
        base_price: 299000,
        sale_price: 199000,
        currency: 'VND',
      });
    });

    it('should throw NotFoundException (PRODUCT_NOT_FOUND) when product does not exist', async () => {
      mockProductRepo.findById.mockResolvedValue(null);

      await expect(service.updateProductSkus(mockProductId, mockShopId, validDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException (PRODUCT_FORBIDDEN) when shop_id does not match actorShopId (IDOR)', async () => {
      const mockProduct = createMockProduct({ shop_id: mockOtherShopId });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      try {
        await service.updateProductSkus(mockProductId, mockShopId, validDto);
        fail('Expected ForbiddenException');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const res = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_FORBIDDEN');
      }
    });

    it('should throw ConflictException (PRODUCT_VERSION_CONFLICT) on version mismatch', async () => {
      const mockProduct = createMockProduct({ version: BigInt(5) });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      try {
        await service.updateProductSkus(mockProductId, mockShopId, {
          ...validDto,
          version: 4, // mismatch
        });
        fail('Expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_VERSION_CONFLICT');
      }
    });

    it('should throw ConflictException (PRODUCT_VERSION_CONFLICT) when atomicCasUpdate returns null (CAS failure)', async () => {
      const mockProduct = createMockProduct({ version: BigInt(1) });
      mockProductRepo.findById.mockResolvedValue(mockProduct);
      mockProductRepo.atomicCasUpdate.mockResolvedValue(null);

      try {
        await service.updateProductSkus(mockProductId, mockShopId, {
          ...validDto,
          version: 1,
        });
        fail('Expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_VERSION_CONFLICT');
        expect(res.message).toBe('Sản phẩm đã được cập nhật bởi thao tác khác. Vui lòng tải lại.');
      }
    });

    it('should throw BadRequestException when definitions exceed 50', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const excessDefs = Array.from({ length: 51 }, (_, i) => ({
        key: `attr_${i}`,
        label: `Attr ${i}`,
        type: AttributeType.STRING,
        is_variant_dimension: false,
      }));

      await expect(
        service.updateProductSkus(mockProductId, mockShopId, {
          ...validDto,
          attribute_definitions: excessDefs,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException when variant dimensions exceed 10', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const excessVariantDimensions = Array.from({ length: 11 }, (_, i) => ({
        key: `dim_${i}`,
        label: `Dim ${i}`,
        type: AttributeType.STRING,
        is_variant_dimension: true,
      }));

      await expect(
        service.updateProductSkus(mockProductId, mockShopId, {
          ...validDto,
          attribute_definitions: excessVariantDimensions,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw ConflictException (PRODUCT_SKU_DUPLICATE) when seller_sku already exists in another product in the shop', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      // Sku already exists in another product
      mockSkuRepo.findBySellerSkus.mockResolvedValue([
        {
          _id: 'other-sku-id',
          product_id: 'other-product-id',
          seller_sku: 'TEE-BLK-M',
        } as SkuDocument,
      ]);

      try {
        await service.updateProductSkus(mockProductId, mockShopId, validDto);
        fail('Expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_SKU_DUPLICATE');
      }
    });

    it('B-01: should throw ForbiddenException (PRODUCT_FORBIDDEN) when sku_id does not belong to this product', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const ownSku = createMockSku({ _id: 'own-sku-1', variant_key: 'color=black|size=M' });
      mockSkuRepo.findByProductId.mockResolvedValue([ownSku]);

      const dtoWithForeignSkuId: UpdateProductSkusDto = {
        ...validDto,
        skus: [
          {
            sku_id: 'foreign-sku-id', // Attacker trying to hijack an SKU from another product
            seller_sku: 'TEE-BLK-M',
            attributes: { color: 'black', size: 'M' },
            price_override: null,
          },
        ],
      };

      try {
        await service.updateProductSkus(mockProductId, mockShopId, dtoWithForeignSkuId);
        fail('Expected ForbiddenException');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const res = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_FORBIDDEN');
      }
    });

    it('B-02: should reuse existing _id when sku_id is omitted but variant_key matches an existing SKU', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const existingSku = createMockSku({
        _id: 'existing-sku-uuid-001',
        variant_key: 'color=black|size=M',
        seller_sku: 'OLD-SKU-1',
      });
      mockSkuRepo.findByProductId.mockResolvedValue([existingSku]);

      const dtoWithoutSkuId: UpdateProductSkusDto = {
        ...validDto,
        skus: [
          {
            // sku_id omitted
            seller_sku: 'NEW-SKU-1',
            attributes: { color: 'black', size: 'M' },
            price_override: 180000,
          },
        ],
      };

      const result = await service.updateProductSkus(mockProductId, mockShopId, dtoWithoutSkuId);

      expect(mockSkuRepo.bulkUpsert).toHaveBeenCalled();
      const upsertArgs = mockSkuRepo.bulkUpsert.mock.calls[0][0];
      expect(upsertArgs[0]._id).toBe('existing-sku-uuid-001');
      expect(result[0].sku_id).toBe('existing-sku-uuid-001');
    });

    it('SF-05: should throw ConflictException (PRODUCT_ARCHIVED) when product is ARCHIVED', async () => {
      const mockProduct = createMockProduct({ status: ProductStatus.ARCHIVED });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      try {
        await service.updateProductSkus(mockProductId, mockShopId, validDto);
        fail('Expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_ARCHIVED');
      }
    });

    it('SF-05: should throw ForbiddenException (PRODUCT_BLOCKED) when product is BLOCKED', async () => {
      const mockProduct = createMockProduct({ status: ProductStatus.BLOCKED });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      try {
        await service.updateProductSkus(mockProductId, mockShopId, validDto);
        fail('Expected ForbiddenException');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const res = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_BLOCKED');
      }
    });

    it('SF-04: should throw ConflictException (PRODUCT_SKU_LIMIT_EXCEEDED) when skus exceed 1000', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const excessSkus = Array.from({ length: 1001 }, (_, i) => ({
        seller_sku: `SKU-${i}`,
        attributes: { color: 'black', size: 'M' },
      }));

      try {
        await service.updateProductSkus(mockProductId, mockShopId, {
          ...validDto,
          skus: excessSkus,
        });
        fail('Expected ConflictException');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictException);
        const res = (err as ConflictException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_SKU_LIMIT_EXCEEDED');
      }
    });

    it('SF-06: should throw BadRequestException when allowed_values has duplicate values', async () => {
      const mockProduct = createMockProduct();
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const invalidDefDto: UpdateProductSkusDto = {
        ...validDto,
        attribute_definitions: [
          {
            key: 'color',
            label: 'Màu',
            type: AttributeType.ENUM,
            is_variant_dimension: true,
            allowed_values: ['red', 'blue', 'red'],
          },
        ],
      };

      await expect(
        service.updateProductSkus(mockProductId, mockShopId, invalidDefDto),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getSkusByProductId', () => {
    it('should return SKUs with resolved prices', async () => {
      const mockProduct = createMockProduct({
        price_summary: {
          base_price: BigInt(350000),
          sale_price: BigInt(299000),
          currency: 'VND',
        },
      });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      const mockSku1 = createMockSku({
        _id: 'sku-1',
        seller_sku: 'SKU-01',
        price_override: 280000 as unknown as bigint,
      });
      const mockSku2 = createMockSku({
        _id: 'sku-2',
        seller_sku: 'SKU-02',
        price_override: null,
      });

      mockSkuRepo.findByProductId.mockResolvedValue([mockSku1, mockSku2]);

      const result = await service.getSkusByProductId(mockProductId, mockShopId);

      expect(result).toHaveLength(2);
      expect(result[0].price).toEqual({
        base_price: 350000,
        sale_price: 280000,
        currency: 'VND',
      });
      expect(result[1].price).toEqual({
        base_price: 350000,
        sale_price: 299000,
        currency: 'VND',
      });
    });

    it('should throw ForbiddenException if actorShopId does not match product shop_id', async () => {
      const mockProduct = createMockProduct({ shop_id: mockOtherShopId });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      await expect(service.getSkusByProductId(mockProductId, mockShopId)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('SF-01: should throw ForbiddenException if actorShopId is missing/undefined (Zero-Trust IDOR)', async () => {
      const mockProduct = createMockProduct({ shop_id: mockShopId });
      mockProductRepo.findById.mockResolvedValue(mockProduct);

      await expect(service.getSkusByProductId(mockProductId, undefined)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException if product is not found', async () => {
      mockProductRepo.findById.mockResolvedValue(null);

      await expect(service.getSkusByProductId('non-existent-id', mockShopId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
