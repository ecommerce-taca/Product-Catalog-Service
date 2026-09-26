const http = require('http');
const crypto = require('crypto');

const HOST = 'localhost';
const PORT = 3000;
const BASE_PATH = '/api/v1';

const sellerHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-user-id': '01912f10-0001-7000-8000-000000000001',
  'x-user-roles': 'SELLER',
  'x-user-shop-scope': '01912f20-0001-7000-8000-000000000001',
};

const adminHeaders = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-user-id': '01912f10-0003-7000-8000-000000000003',
  'x-user-roles': 'CATALOG_ADMIN',
};

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: method,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
        });
      });
    });

    req.on('error', (e) => reject(e));

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }
    req.end();
  });
}

function uploadToUrl(url, buffer, contentType) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

function uploadMultipart(
  path,
  headers = {},
  fileBuffer,
  filename = 'products.xlsx',
  fieldName = 'file',
  contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
) {
  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    const headerPart = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
    );
    const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuffer = Buffer.concat([headerPart, fileBuffer, footerPart]);

    const options = {
      hostname: HOST,
      port: PORT,
      path: path,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...headers,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': bodyBuffer.length,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: json,
        });
      });
    });

    req.on('error', (e) => reject(e));
    req.write(bodyBuffer);
    req.end();
  });
}

async function run() {
  console.log('=== RUNNING COMPLETE HTTP TEST SUITE AGAINST LOCALHOST:3000 ===\n');

  // Test 0.1: Health Live
  let res = await request('GET', '/health/live');
  console.log(`[0.1] GET /health/live => ${res.status}`, JSON.stringify(res.data));

  // Test 0.2: Health Ready
  res = await request('GET', '/health/ready');
  console.log(`[0.2] GET /health/ready => ${res.status}`, JSON.stringify(res.data));

  // Test 1.1: Public Category Tree
  res = await request('GET', `${BASE_PATH}/categories`);
  console.log(
    `[1.1] GET /categories => ${res.status}`,
    `Count: ${Array.isArray(res.data?.data) ? res.data.data.length : 'N/A'}`,
  );

  // Test 1.2: Admin Create Root Category
  const rootSlug = `thoi-trang-nam-${Date.now()}`;
  res = await request('POST', `${BASE_PATH}/admin/catalog/categories`, adminHeaders, {
    name: `Thời Trang Nam ${Date.now()}`,
    slug: rootSlug,
    parent_id: null,
    tax_rate_bps: 1000,
    sort_order: 1,
  });
  console.log(
    `[1.2] POST /admin/catalog/categories (root) => ${res.status}`,
    JSON.stringify(res.data?.data?.category_id ? 'Created ' + res.data.data.category_id : res.data),
  );
  const rootCatId = res.data?.data?.category_id;

  // Test 1.3: Admin Create Sub Category
  const subSlug = `ao-khoac-nam-${Date.now()}`;
  res = await request('POST', `${BASE_PATH}/admin/catalog/categories`, adminHeaders, {
    name: `Áo Khoác Nam ${Date.now()}`,
    slug: subSlug,
    parent_id: rootCatId,
    tax_rate_bps: null,
    sort_order: 1,
  });
  console.log(
    `[1.3] POST /admin/catalog/categories (sub) => ${res.status}`,
    JSON.stringify(res.data?.data?.category_id ? 'Created ' + res.data.data.category_id : res.data),
  );
  const subCatId = res.data?.data?.category_id;

  // Test 1.4: Public Category Detail
  res = await request('GET', `${BASE_PATH}/categories/${subCatId}`);
  console.log(`[1.4] GET /categories/:id => ${res.status}`, res.data?.data?.name);

  // Test 1.5: Admin Update Category
  res = await request('PATCH', `${BASE_PATH}/admin/catalog/categories/${subCatId}`, adminHeaders, {
    version: 1,
    name: 'Áo Khoác Nam Cao Cấp',
    sort_order: 2,
  });
  console.log(
    `[1.5] PATCH /admin/catalog/categories/:id => ${res.status}`,
    `New Name: ${res.data?.data?.name}, Version: ${res.data?.data?.version}`,
  );

  // Test 1.6: Cycle Detection (Should be 409)
  res = await request('PATCH', `${BASE_PATH}/admin/catalog/categories/${rootCatId}`, adminHeaders, {
    version: 1,
    parent_id: subCatId,
  });
  console.log(`[1.6] Edge Case Cycle Detection => ${res.status}`, res.data?.error?.code);

  // Test 2.1: Seller Create Product Draft
  const productSlug = `ao-khoac-gio-${Date.now()}`;
  res = await request('POST', `${BASE_PATH}/seller/products`, sellerHeaders, {
    title: 'Áo Khoác Gió Nam Chống Nước 2026',
    slug: productSlug,
    brand: 'Taca Active',
    description:
      '<p>Áo khoác gió cao cấp, chất liệu <strong>Polyester chống nước</strong> an toàn.</p>',
    price_summary: {
      base_price: 450000,
      sale_price: 389000,
      currency: 'VND',
    },
  });
  console.log(
    `[2.1] POST /seller/products => ${res.status}`,
    JSON.stringify(res.data?.data?.product_id ? 'Created ' + res.data.data.product_id : res.data),
  );
  const productId = res.data?.data?.product_id;

  // Test 2.2: Seller List Products
  res = await request('GET', `${BASE_PATH}/seller/products?page=1&size=20`, sellerHeaders);
  console.log(`[2.2] GET /seller/products => ${res.status}`, `Total: ${res.data?.meta?.total}`);

  // Test 2.3: Seller Product Detail
  res = await request('GET', `${BASE_PATH}/seller/products/${productId}`, sellerHeaders);
  console.log(
    `[2.3] GET /seller/products/:id => ${res.status}`,
    res.data?.data?.title,
    `Version: ${res.data?.data?.version}`,
  );
  let version = res.data?.data?.version || 1;

  // Test 2.4: Seller Patch Product
  res = await request('PATCH', `${BASE_PATH}/seller/products/${productId}`, sellerHeaders, {
    version: version,
    title: 'Áo Khoác Gió Nam Chống Nước Bản Nâng Cấp 2026',
    description:
      '<p>Mô tả chuẩn <script>alert("xss")</script><strong>chống thấm nước</strong>.</p>',
  });
  console.log(
    `[2.4] PATCH /seller/products/:id => ${res.status}`,
    `Updated title, Version: ${res.data?.data?.version}`,
  );
  version = res.data?.data?.version || version + 1;

  // Test 2.5: OCC Mismatch
  res = await request('PATCH', `${BASE_PATH}/seller/products/${productId}`, sellerHeaders, {
    version: 999999,
    title: 'Sai version',
  });
  console.log(`[2.5] Edge Case OCC Mismatch => ${res.status}`, res.data?.error?.code);

  // Test 3.1: Seller Assign Categories
  res = await request(
    'PUT',
    `${BASE_PATH}/seller/products/${productId}/categories`,
    sellerHeaders,
    {
      version: version,
      primary_category_id: subCatId,
      secondary_category_ids: [],
    },
  );
  console.log(
    `[3.1] PUT /seller/products/:id/categories => ${res.status}`,
    `Assigned primary: ${res.data?.data?.primary_category_id}, Version: ${res.data?.data?.version}`,
  );
  version = res.data?.data?.version || version + 1;

  // Test 3.2: Seller Update SKUs
  res = await request('PUT', `${BASE_PATH}/seller/products/${productId}/skus`, sellerHeaders, {
    version: version,
    attribute_definitions: [
      { key: 'color', label: 'Màu sắc', type: 'STRING', is_variant_dimension: true, sort_order: 1 },
      { key: 'size', label: 'Kích cỡ', type: 'STRING', is_variant_dimension: true, sort_order: 2 },
    ],
    skus: [
      {
        seller_sku: `AKG-DEN-L-${Date.now()}`,
        price_override: 389000,
        attributes: { color: 'Đen', size: 'L' },
        status: 'ACTIVE',
      },
      {
        seller_sku: `AKG-DEN-XL-${Date.now()}`,
        price_override: 399000,
        attributes: { color: 'Đen', size: 'XL' },
        status: 'ACTIVE',
      },
    ],
  });
  console.log(
    `[3.2] PUT /seller/products/:id/skus => ${res.status}`,
    `Created ${res.data?.data?.length} SKUs`,
  );
  version = version + 1; // skus update doesn't return product version envelope, version increments in DB

  // Fetch updated product version
  res = await request('GET', `${BASE_PATH}/seller/products/${productId}`, sellerHeaders);
  version = res.data?.data?.version || version;

  // Test 4.1: Media Upload URL
  const sampleBuffer = Buffer.from('fake image content for testing 123456');
  const sampleSha256 = crypto.createHash('sha256').update(sampleBuffer).digest('hex');

  res = await request(
    'POST',
    `${BASE_PATH}/seller/products/${productId}/media/upload-url`,
    sellerHeaders,
    {
      scope: 'SPU',
      content_type: 'image/jpeg',
      size_bytes: sampleBuffer.length,
      sha256: sampleSha256,
      is_cover: true,
    },
  );
  console.log(
    `[4.1] POST /seller/products/:id/media/upload-url => ${res.status}`,
    `Media ID: ${res.data?.data?.media_id}`,
  );
  const mediaId = res.data?.data?.media_id;
  const objectKey = res.data?.data?.object_key;
  const uploadUrl = res.data?.data?.upload_url;

  // Actual upload of buffer to MinIO via Presigned URL
  if (uploadUrl) {
    const putRes = await uploadToUrl(uploadUrl, sampleBuffer, 'image/jpeg');
    console.log(`[4.1.1] Direct PUT buffer to S3/MinIO => ${putRes.status}`);
  }

  // Test 4.2: Complete Media Upload (Transitions media to READY)
  res = await request(
    'POST',
    `${BASE_PATH}/seller/products/${productId}/media/complete`,
    sellerHeaders,
    {
      media_id: mediaId,
      object_key: objectKey,
      sha256: sampleSha256,
    },
  );
  console.log(
    `[4.2] POST /seller/products/:id/media/complete => ${res.status}`,
    `Media Status: ${res.data?.data?.status}`,
  );

  // Fetch latest version before publishing
  res = await request('GET', `${BASE_PATH}/seller/products/${productId}`, sellerHeaders);
  version = res.data?.data?.version || version;

  // Test 5.1: Publish Product
  res = await request('POST', `${BASE_PATH}/seller/products/${productId}/publish`, sellerHeaders, {
    version: version,
  });
  console.log(
    `[5.1] POST /seller/products/:id/publish => ${res.status}`,
    `Product Status: ${res.data?.data?.status}, Version: ${res.data?.data?.version}`,
  );
  if (res.data?.data?.version) version = res.data.data.version;

  // Test 6.1: Public List Products
  res = await request('GET', `${BASE_PATH}/products`);
  console.log(`[6.1] GET /products => ${res.status}`, `Total: ${res.data?.meta?.total}`);

  // Test 6.4: Public PDP Detail
  res = await request('GET', `${BASE_PATH}/products/${productId}`);
  console.log(
    `[6.4] GET /products/:id => ${res.status}`,
    res.data?.data?.title,
    `Stock status: ${res.data?.data?.stock_display?.status}`,
  );

  // Test 7.1: Seller Export
  res = await request('GET', `${BASE_PATH}/seller/products/export`, sellerHeaders);
  console.log(
    `[7.1] GET /seller/products/export => ${res.status}`,
    `Rows: ${res.data?.row_count ?? res.data?.data?.row_count}`,
    `Format: ${res.data?.format ?? res.data?.data?.format}`,
  );

  // Test 8.1: Admin List Products (All statuses)
  res = await request('GET', `${BASE_PATH}/admin/catalog/products?page=1&size=20`, adminHeaders);
  console.log(
    `[8.1] GET /admin/catalog/products => ${res.status}`,
    `Total: ${res.data?.meta?.total}`,
  );

  // Test 8.2: Admin Product Detail
  res = await request('GET', `${BASE_PATH}/admin/catalog/products/${productId}`, adminHeaders);
  console.log(
    `[8.2] GET /admin/catalog/products/:id => ${res.status}`,
    res.data?.data?.title,
    `Status: ${res.data?.data?.status}`,
  );

  // Test 8.3: Admin Block Product
  res = await request(
    'POST',
    `${BASE_PATH}/admin/catalog/products/${productId}/block`,
    adminHeaders,
    {
      version: version,
      reason: 'Sản phẩm vi phạm bản quyền thương hiệu',
    },
  );
  console.log(
    `[8.3] POST /admin/catalog/products/:id/block => ${res.status}`,
    `Blocked, New Status: ${res.data?.data?.status}, Version: ${res.data?.data?.version}`,
  );
  if (res.data?.data?.version) version = res.data.data.version;

  // Test 8.4: Public PDP after block (Zero Leak Check -> Should be 404)
  res = await request('GET', `${BASE_PATH}/products/${productId}`);
  console.log(`[8.4] Zero Leak Check (after block) => ${res.status}`, res.data?.error?.code);

  // Test 8.5: Admin Unblock
  res = await request(
    'POST',
    `${BASE_PATH}/admin/catalog/products/${productId}/unblock`,
    adminHeaders,
    {
      version: version,
      reason: 'Đã giải trình và khắc phục',
    },
  );
  console.log(
    `[8.5] POST /admin/catalog/products/:id/unblock => ${res.status}`,
    `Unblocked, New Status: ${res.data?.data?.status}, Version: ${res.data?.data?.version}`,
  );
  if (res.data?.data?.version) version = res.data.data.version;

  // Test 9.1: Unauthorized (no auth headers)
  res = await request('GET', `${BASE_PATH}/seller/products`);
  console.log(`[9.1] Security Unauthorized => ${res.status}`, res.data?.error?.code);

  // Test 9.2: Forbidden Role (BUYER accessing seller API)
  res = await request('GET', `${BASE_PATH}/seller/products`, {
    'x-user-id': '01912f10-0005-7000-8000-000000000005',
    'x-user-roles': 'BUYER',
  });
  console.log(`[9.2] Security Role Guard (BUYER) => ${res.status}`, res.data?.error?.code);

  // Test 9.3: IDOR Attack (Attacker tries to patch Seller A's product)
  res = await request(
    'PATCH',
    `${BASE_PATH}/seller/products/${productId}`,
    {
      ...sellerHeaders,
      'x-user-shop-scope': '01912f20-9999-7000-8000-000000009999',
    },
    {
      version: version,
      title: 'Tấn công IDOR',
    },
  );
  console.log(`[9.3] Security IDOR Defense => ${res.status}`, res.data?.error?.code);

  // Test 9.4: IDOR Export (Attacker exports their own shop, cannot see Seller A products)
  res = await request('GET', `${BASE_PATH}/seller/products/export`, {
    ...sellerHeaders,
    'x-user-shop-scope': '01912f20-9999-7000-8000-000000009999',
  });
  console.log(
    `[9.4] Security IDOR Export Isolation => ${res.status}`,
    `Rows: ${res.data?.row_count ?? res.data?.data?.row_count}`,
  );

  // Test 9.5: Suspended Shop publish attempt
  res = await request(
    'POST',
    `${BASE_PATH}/seller/products/${productId}/publish`,
    {
      ...sellerHeaders,
      'x-user-shop-scope': '01912f20-8888-7000-8000-000000008888',
    },
    {
      version: version,
    },
  );
  console.log(`[9.5] Security Suspended Shop Block => ${res.status}`, res.data?.error?.code);

  // Test 10.1: Bulk Import Template (Default / No category)
  res = await request('GET', `${BASE_PATH}/seller/products/import/template`, {
    ...sellerHeaders,
    Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  console.log(
    `[10.1] GET /seller/products/import/template (default) => ${res.status}`,
    `Content-Type: ${res.headers?.['content-type']}`,
  );

  // Test 10.2: Bulk Import Template (With valid category_id)
  res = await request(
    'GET',
    `${BASE_PATH}/seller/products/import/template?category_id=${subCatId}`,
    {
      ...sellerHeaders,
      Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
  );
  console.log(
    `[10.2] GET /seller/products/import/template?category_id=${subCatId} => ${res.status}`,
    `Content-Type: ${res.headers?.['content-type']}`,
  );

  // Test 10.3: Bulk Import Template (Non-existent category_id)
  res = await request(
    'GET',
    `${BASE_PATH}/seller/products/import/template?category_id=01912f20-9999-7000-8000-000000009999`,
    sellerHeaders,
  );
  console.log(
    `[10.3] GET /seller/products/import/template (invalid category) => ${res.status}`,
    res.data?.error?.code,
  );

  // Test 10.4: Bulk Import Template (Suspended Shop Block)
  res = await request('GET', `${BASE_PATH}/seller/products/import/template`, {
    ...sellerHeaders,
    'x-user-shop-scope': '01912f20-8888-7000-8000-000000008888',
  });
  console.log(
    `[10.4] GET /seller/products/import/template (suspended shop) => ${res.status}`,
    res.data?.error?.code,
  );

  // Test 10.5: Bulk Import Template (Unauthorized - no auth)
  res = await request('GET', `${BASE_PATH}/seller/products/import/template`);
  console.log(
    `[10.5] GET /seller/products/import/template (unauthorized) => ${res.status}`,
    res.data?.error?.code,
  );

  // Load sample fixtures for upload tests
  const fs = require('fs');
  const path = require('path');
  const fixturesDir = path.join(__dirname, 'fixtures');
  const sampleXlsx = fs.readFileSync(path.join(fixturesDir, 'sample-import.xlsx'));
  const oversizeXlsx = fs.readFileSync(path.join(fixturesDir, 'oversize-import.xlsx'));
  const sampleCsv = fs.readFileSync(path.join(fixturesDir, 'sample-import.csv'));

  // Test 10.6: Upload Valid Excel File -> 202 Accepted
  res = await uploadMultipart(
    `${BASE_PATH}/seller/products/import`,
    sellerHeaders,
    sampleXlsx,
    'sample-import.xlsx',
  );
  console.log(
    `[10.6] POST /seller/products/import (valid file) => ${res.status}`,
    `JobId: ${res.data?.data?.job_id || res.data?.data?.jobId}, Status: ${res.data?.data?.status}`,
  );
  const importJobId = res.data?.data?.job_id || res.data?.data?.jobId;

  // Test 10.7: Upload File > 2MB -> 400 Bad Request (PRODUCT_IMPORT_FILE_TOO_LARGE)
  res = await uploadMultipart(
    `${BASE_PATH}/seller/products/import`,
    sellerHeaders,
    oversizeXlsx,
    'oversize-import.xlsx',
  );
  console.log(
    `[10.7] POST /seller/products/import (>2MB oversize) => ${res.status}`,
    res.data?.error?.code,
  );

  // Test 10.8: Upload File Invalid Format (.csv) -> 400 Bad Request (PRODUCT_IMPORT_FILE_TYPE_INVALID)
  res = await uploadMultipart(
    `${BASE_PATH}/seller/products/import`,
    sellerHeaders,
    sampleCsv,
    'sample-import.csv',
    'file',
    'text/csv',
  );
  console.log(
    `[10.8] POST /seller/products/import (invalid format csv) => ${res.status}`,
    res.data?.error?.code,
  );

  // Test 10.9: Upload when active job running -> 409 Conflict (PRODUCT_IMPORT_JOB_RUNNING)
  // If the job from 10.6 is still processing/pending or simulated:
  res = await uploadMultipart(
    `${BASE_PATH}/seller/products/import`,
    sellerHeaders,
    sampleXlsx,
    'sample-import.xlsx',
  );
  console.log(
    `[10.9] POST /seller/products/import (concurrent job attempt) => ${res.status}`,
    res.data?.error?.code || `Accepted (job 10.6 completed already: ${res.data?.data?.status})`,
  );

  // Test 10.10: Suspended Shop Upload Attempt -> 403 Forbidden (PRODUCT_SHOP_SUSPENDED)
  res = await uploadMultipart(
    `${BASE_PATH}/seller/products/import`,
    {
      ...sellerHeaders,
      'x-user-shop-scope': '01912f20-8888-7000-8000-000000008888',
    },
    sampleXlsx,
    'sample-import.xlsx',
  );
  console.log(
    `[10.10] POST /seller/products/import (suspended shop) => ${res.status}`,
    res.data?.error?.code,
  );

  // Test 10.11: Job Progress Tracking (GET /seller/products/import/jobs/:jobId - AC-IM-16)
  if (importJobId) {
    res = await request(
      'GET',
      `${BASE_PATH}/seller/products/import/jobs/${importJobId}`,
      sellerHeaders,
    );
    console.log(
      `[10.11] GET /seller/products/import/jobs/${importJobId} => ${res.status}`,
      `Status: ${res.data?.data?.status || res.data?.status}, Processed: ${res.data?.data?.processed_rows ?? res.data?.processed_rows}/${res.data?.data?.total_rows ?? res.data?.total_rows}`,
    );

    // Test 10.12: Direct binary download (.xlsx error result - AC-IM-17)
    res = await request('GET', `${BASE_PATH}/seller/products/import/jobs/${importJobId}/result`, {
      ...sellerHeaders,
      Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    console.log(
      `[10.12] GET /seller/products/import/jobs/${importJobId}/result (binary stream) => ${res.status}`,
      res.status === 200 ? `Content-Type: ${res.headers?.['content-type']}` : res.data?.error?.code,
    );

    // Test 10.13: JSON Presigned Download URL (Accept: application/json)
    res = await request('GET', `${BASE_PATH}/seller/products/import/jobs/${importJobId}/result`, {
      ...sellerHeaders,
      Accept: 'application/json',
    });
    console.log(
      `[10.13] GET /seller/products/import/jobs/${importJobId}/result (JSON) => ${res.status}`,
      res.status === 200
        ? `DownloadUrl: ${res.data?.data?.result_file_url || res.data?.result_file_url}`
        : res.data?.error?.code,
    );

    // Test 10.14: Security Zero-Trust IDOR check (Seller B attempts to access Seller A's job - AC-IM-18)
    res = await request('GET', `${BASE_PATH}/seller/products/import/jobs/${importJobId}`, {
      ...sellerHeaders,
      'x-user-id': '01912f10-9999-7000-8000-000000009999',
      'x-user-shop-scope': '01912f20-9999-7000-8000-000000009999',
    });
    console.log(`[10.14] Security IDOR Job Access Defense => ${res.status}`, res.data?.error?.code);
  }

  // Test 10.15: Result error export for non-existent job or non-finished job
  res = await request(
    'GET',
    `${BASE_PATH}/seller/products/import/jobs/01912f20-0000-7000-8000-000000000000/result`,
    sellerHeaders,
  );
  console.log(
    `[10.15] Edge Case: Non-existent job result query => ${res.status}`,
    res.data?.error?.code,
  );

  console.log('\n=== ALL HTTP RUNNER TESTS EXECUTED SUCCESSFULLY ===');
}

run().catch((e) => console.error('FATAL ERROR:', e));
