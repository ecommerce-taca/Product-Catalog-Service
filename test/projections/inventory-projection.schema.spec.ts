import {
  InventoryProjectionSchema,
  InventoryStockStatus,
  LOW_STOCK_THRESHOLD,
  INVENTORY_SNAPSHOT_STALE_AFTER_SECONDS,
} from '../../src/database/schemas/inventory-projection.schema';

describe('InventoryProjectionSchema', () => {
  it('should define collection name as inventory_projections', () => {
    expect(InventoryProjectionSchema.get('collection')).toBe('inventory_projections');
  });

  it('should define domain constants correctly', () => {
    expect(LOW_STOCK_THRESHOLD).toBe(5);
    expect(INVENTORY_SNAPSHOT_STALE_AFTER_SECONDS).toBe(60);
  });

  it('should have required schema paths', () => {
    const paths = InventoryProjectionSchema.paths;

    expect(paths._id).toBeDefined();
    expect(paths.sku_id).toBeDefined();
    expect(paths.product_id).toBeDefined();
    expect(paths.available_qty_snapshot).toBeDefined();
    expect(paths.reserved_qty_snapshot).toBeDefined();
    expect(paths.committed_qty_snapshot).toBeDefined();
    expect(paths.stock_status).toBeDefined();
    expect(paths.as_of).toBeDefined();
    expect(paths.source_version).toBeDefined();
    expect(paths.source_event_id).toBeDefined();
    expect(paths.updated_at).toBeDefined();
  });

  it('should have correct default values and enum constraints', () => {
    const paths = InventoryProjectionSchema.paths;

    expect(paths.stock_status.options.default).toBe(InventoryStockStatus.UNKNOWN);
    expect(paths.stock_status.options.enum).toEqual(Object.values(InventoryStockStatus));
  });

  it('should define compound and unique indexes as specified in DB §4', () => {
    const indexes = InventoryProjectionSchema.indexes();

    const uniqueSkuIndex = indexes.find((idx) => idx[1]?.name === 'idx_inv_proj_sku_id');
    expect(uniqueSkuIndex).toBeDefined();
    expect(uniqueSkuIndex![0]).toEqual({ sku_id: 1 });
    expect(uniqueSkuIndex![1]?.unique).toBe(true);

    const productStockIndex = indexes.find((idx) => idx[1]?.name === 'idx_inv_proj_product_stock');
    expect(productStockIndex).toBeDefined();
    expect(productStockIndex![0]).toEqual({ product_id: 1, stock_status: 1 });
  });
});
