import { ImportJobSchema, ImportJobStatus } from '../../src/database/schemas/import-job.schema';

describe('ImportJobSchema', () => {
  it('should define collection name as import_jobs', () => {
    expect(ImportJobSchema.get('collection')).toBe('import_jobs');
  });

  it('should have required schema paths', () => {
    const paths = ImportJobSchema.paths;

    expect(paths._id).toBeDefined();
    expect(paths.shop_id).toBeDefined();
    expect(paths.actor_user_id).toBeDefined();
    expect(paths.category_id).toBeDefined();
    expect(paths.status).toBeDefined();
    expect(paths.file_url).toBeDefined();
    expect(paths.result_file_url).toBeDefined();
    expect(paths.total_rows).toBeDefined();
    expect(paths.processed_rows).toBeDefined();
    expect(paths.success_count).toBeDefined();
    expect(paths.error_count).toBeDefined();
    expect(paths.error_summary).toBeDefined();
    expect(paths.locked_until).toBeDefined();
    expect(paths.started_at).toBeDefined();
    expect(paths.completed_at).toBeDefined();
    expect(paths.created_at).toBeDefined();
    expect(paths.updated_at).toBeDefined();
  });

  it('should have correct default values and enum constraints', () => {
    const paths = ImportJobSchema.paths;

    expect(paths.status.options.default).toBe(ImportJobStatus.PENDING);
    expect(paths.status.options.enum).toEqual(Object.values(ImportJobStatus));

    expect(paths.processed_rows.options.default).toBe(0);
    expect(paths.success_count.options.default).toBe(0);
    expect(paths.error_count.options.default).toBe(0);
  });

  it('should define indices as specified in SRS and Architecture', () => {
    const indexes = ImportJobSchema.indexes();

    const shopCreatedIndex = indexes.find((idx) => idx[1]?.name === 'idx_import_jobs_shop_created');
    expect(shopCreatedIndex).toBeDefined();
    expect(shopCreatedIndex![0]).toEqual({ shop_id: 1, created_at: -1 });

    const shopStatusIndex = indexes.find((idx) => idx[1]?.name === 'idx_import_jobs_shop_status');
    expect(shopStatusIndex).toBeDefined();
    expect(shopStatusIndex![0]).toEqual({ shop_id: 1, status: 1 });

    const ttlIndex = indexes.find((idx) => idx[1]?.name === 'idx_import_jobs_ttl_7d');
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex![0]).toEqual({ created_at: 1 });
    expect(ttlIndex![1]?.expireAfterSeconds).toBe(604800);
  });
});
