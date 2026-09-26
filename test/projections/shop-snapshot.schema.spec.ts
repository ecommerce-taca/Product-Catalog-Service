import {
  KycStatus,
  ShopSnapshotSchema,
  ShopStatus,
} from '../../src/database/schemas/shop-snapshot.schema';

describe('ShopSnapshotSchema', () => {
  it('should define collection name as shop_snapshots', () => {
    expect(ShopSnapshotSchema.get('collection')).toBe('shop_snapshots');
  });

  it('should have required schema paths', () => {
    const paths = ShopSnapshotSchema.paths;

    expect(paths._id).toBeDefined();
    expect(paths.shop_id).toBeDefined();
    expect(paths.name).toBeDefined();
    expect(paths.slug).toBeDefined();
    expect(paths.logo_url).toBeDefined();
    expect(paths.shop_status).toBeDefined();
    expect(paths.kyc_status).toBeDefined();
    expect(paths.source_version).toBeDefined();
    expect(paths.source_event_id).toBeDefined();
    expect(paths.updated_at).toBeDefined();
  });

  it('should have correct default values and enum constraints', () => {
    const paths = ShopSnapshotSchema.paths;

    expect(paths.shop_status.options.default).toBe(ShopStatus.ACTIVE);
    expect(paths.shop_status.options.enum).toEqual(Object.values(ShopStatus));

    expect(paths.kyc_status.options.default).toBe(KycStatus.PENDING);
    expect(paths.kyc_status.options.enum).toEqual(Object.values(KycStatus));
  });

  it('should define compound and unique indexes as specified in DB §4', () => {
    const indexes = ShopSnapshotSchema.indexes();

    const uniqueShopIdIndex = indexes.find(
      (idx) => idx[1]?.name === 'idx_shop_snapshots_shop_id_unique',
    );
    expect(uniqueShopIdIndex).toBeDefined();
    expect(uniqueShopIdIndex![0]).toEqual({ shop_id: 1 });
    expect(uniqueShopIdIndex![1]?.unique).toBe(true);

    const statusKycIndex = indexes.find((idx) => idx[1]?.name === 'idx_shop_snapshots_status_kyc');
    expect(statusKycIndex).toBeDefined();
    expect(statusKycIndex![0]).toEqual({ shop_status: 1, kyc_status: 1 });
  });
});
