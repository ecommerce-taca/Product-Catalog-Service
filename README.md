# Product Catalog Service (Dịch Vụ Danh Mục Sản Phẩm)

> Microservice quản lý thông tin danh mục, phân cấp cây danh mục (Taxonomy), cấu hình thuộc tính động (Attributes), giải quyết biến thể SKU (Variant Resolver), và quản lý vòng đời sản phẩm (SPU/SKU) trong hệ sinh thái sàn thương mại điện tử Taca Ecommerce.

---

## 1. Tổng Quan Kiến Trúc (Architecture Overview)

Dịch vụ Product Catalog được xây dựng theo kiến trúc **Modular Hexagonal / Ports & Adapters** trên nền tảng **NestJS 11** và **MongoDB 8.x**, tuân thủ nguyên tắc phân ranh giới trách nhiệm rõ ràng (Bounded Contexts):

- **Không trừ/khóa tồn kho**: Tồn kho thuộc quyền sở hữu của `Inventory Service`. Dịch vụ này chỉ tiêu thụ event để hiển thị snapshot tồn kho read-only.
- **Không lưu snapshot giá thanh toán/voucher**: Nghiệp vụ chốt giá thanh toán thuộc về `Order Commerce Service`.
- **Không ghi trực tiếp Elasticsearch**: Mọi thay đổi dữ liệu (SPU/SKU/Category) được ghi đồng thời vào bảng `outbox_events` trong cùng một MongoDB multi-document ACID transaction, sau đó được **Debezium MongoDB Outbox Event Router (CDC)** relay sang Kafka topics để các consumer (Search Service, AI Recommendation) tiêu thụ.

### Các Tính Năng Kỹ Thuật Nổi Bật
1. **Kiểm soát phiên bản & Concurrency**:
   - Sử dụng **UUIDv7** chuỗi làm khóa chính (`_id`), tối ưu hóa sắp xếp theo thời gian (time-ordered sequential indexing).
   - Kiểm soát đồng thời lạc quan (Optimistic Concurrency Control - OCC) qua trường `version: Long` (BigInt).
   - Xử lý giao dịch phân tán ACID thông qua helper `TransactionRunner` bọc `session.withTransaction()`, tự động retry khi gặp `TransientTransactionError` hoặc `UnknownTransactionCommitResult`.
2. **Bảo mật & Phòng Chống IDOR (Zero-Trust Actor Context)**:
   - `ActorContextGuard` giải mã các headers định tuyến từ API Gateway (`X-User-ID`, `X-User-Roles`, `X-User-Shop-Scope`, `X-User-Permissions`).
   - Mọi thao tác cập nhật dữ liệu của Seller đều kẹp điều kiện bất biến `{ shop_id: actorShopScope }` ở tầng database query, ngăn chặn triệt để lỗ hổng Insecure Direct Object References (IDOR).
3. **Phân cấp Cây Danh mục (Hierarchical Category Taxonomy)**:
   - Cấu trúc **Materialized Path** (`path: /root-id/child-id`) với kiểm soát độ sâu tối đa 5 cấp (`depth <= 5`).
   - Thuật toán **Cycle Detection** phát hiện và ngăn chặn chu trình khi di chuyển nhánh cây danh mục.
   - Cơ chế **Kế thừa Thuế suất Tự động (Tax Rate Inheritance)**: Danh mục con tự động thừa kế `tax_rate_bps` từ tổ tiên gần nhất nếu không được cấu hình trực tiếp.
   - Cập nhật đường dẫn cây con atomic bằng MongoDB Aggregation Pipeline (`$concat`, `$substrCP`).
4. **Quan sát & Chuẩn hóa Phản hồi (Observability & Envelope)**:
   - Truyền ngữ cảnh phân tán theo chuẩn **W3C `traceparent`** qua `AsyncLocalStorage`.
   - Chuẩn hóa lỗi toàn hệ thống qua `GlobalExceptionFilter` với Error Envelope: `{ error: { code, message, details, trace_id } }`.
   - `ResponseEnvelopeInterceptor` tự động chuyển đổi số nguyên lớn `BigInt` (BSON Long) sang `number` an toàn trên JSON response.

---

## 2. Công Nghệ Sử Dụng (Tech Stack)

| Thành phần | Công nghệ / Thư viện | Mục đích |
|---|---|---|
| **Runtime** | Node.js 20+ (LTS), TypeScript 5.7+ | Nền tảng thực thi ngôn ngữ strict mode |
| **Framework** | NestJS 11.x | Kiến trúc Module, Dependency Injection, Guards, Filters, Interceptors |
| **Database** | MongoDB 8.x | Cơ sở dữ liệu tài liệu NoSQL, Replica Set Mode (`rs0`) |
| **ODM / Driver** | Mongoose 8.x | Quản lý schema, hooks, indexing và ClientSession transactions |
| **Tracing** | W3C Trace Context, Node.js AsyncLocalStorage | Distributed tracing xuyên suốt microservices |
| **CDC / Outbox** | Debezium MongoDB Outbox Connector | CDC streaming qua Kafka topics |
| **Containerization**| Docker, Docker Compose | Khởi chạy MongoDB 8.0 Single-Node Replica Set và đóng gói ứng dụng |
| **Validation** | class-validator, class-transformer | Xác thực payload DTO ở tầng controller |
| **Testing** | Jest, Supertest | Unit test, Integration test và E2E test nội bộ |

---

## 3. Cấu Trúc Thư Mục Dự Án (Project Structure)

```text
product-catalog-service/
├── .postman.json               # Cấu hình đồng bộ Postman Cloud Workspace & Collection
├── Dockerfile                  # Multi-stage production build (Alpine, non-root user)
├── docker-compose.yml          # Môi trường MongoDB 8.0 Single-Node Replica Set (rs0)
├── scripts/
│   └── mongo-init.sh           # Script khởi tạo replica set rs0 tự động và idempotent
├── src/
│   ├── app.module.ts           # Root module kết nối DatabaseModule, CategoryModule, HealthModule
│   ├── main.ts                 # Bootstrap application, global guards, filters, interceptors
│   ├── config/                 # Cấu hình App & MongoDB Connection Options (Pool min 5 / max 20)
│   ├── common/                 # Hạ tầng dùng chung
│   │   ├── context/            # AsyncLocalStorage lưu trữ ActorContext & W3C TraceContext
│   │   ├── decorators/         # @Public(), @Roles(), @ShopScope(), @Actor()
│   │   ├── filters/            # GlobalExceptionFilter chuẩn hóa Error Envelope
│   │   ├── guards/             # ActorContextGuard (Zero-Trust IDOR protection)
│   │   ├── interceptors/       # ResponseEnvelopeInterceptor (BigInt Long -> Number serializer)
│   │   ├── middleware/         # TraceContextMiddleware (W3C traceparent propagation)
│   │   └── repositories/       # BaseRepository interface & MongooseBaseRepository
│   ├── database/               # Mongoose setup, BaseSchema (UUIDv7, OCC version), TransactionRunner
│   │   └── schemas/            # Schemas: categories, product_categories, outbox_events, catalog_audits
│   ├── category/               # Module phân cấp danh mục
│   │   ├── controllers/        # CategoryController (Public), AdminCategoryController (Admin)
│   │   ├── dto/                # Create, Update, Archive, Query, Response DTOs
│   │   ├── repositories/       # CategoryRepository, ProductCategoryRepository
│   │   └── services/           # CategoryService (Domain logic), CategoryTreeService (Tree builder)
│   └── health/                 # Healthcheck probes: GET /health/live, GET /health/ready
└── test/                       # Kiểm thử tự động nội bộ (Unit & E2E Tests)
```

---

## 4. Yêu Cầu Môi Trường (Prerequisites)

- **Node.js**: Phiên bản `>= 20.x`
- **npm**: Phiên bản `>= 10.x`
- **Docker & Docker Compose**: Phiên bản Compose v2 trở lên (dùng để khởi chạy MongoDB Replica Set)

---

## 5. Hướng Dẫn Cài Đặt & Khởi Chạy (Getting Started)

### Bước 1: Sao chép mã nguồn và cài đặt dependencies
```bash
# Clone repository
git clone https://github.com/ecommerce-taca/Product-Catalog-Service.git
cd Product-Catalog-Service

# Cài đặt các gói thư viện
npm install
```

### Bước 2: Thiết lập biến môi trường
Tạo file cấu hình môi trường `.env` từ file mẫu:
```bash
cp .env.example .env
```
Các tham số cấu hình chính trong `.env`:
```ini
NODE_ENV=development
PORT=3000

# MongoDB 8.x Connection (yêu cầu Replica Set để chạy Multi-document Transactions)
MONGODB_URI=mongodb://localhost:27017/product_catalog?replicaSet=rs0
MONGODB_MIN_POOL_SIZE=5
MONGODB_MAX_POOL_SIZE=20
MONGODB_READ_PREFERENCE=primaryPreferred
```

### Bước 3: Khởi chạy MongoDB Replica Set bằng Docker Compose
Dịch vụ yêu cầu MongoDB chạy ở chế độ **Replica Set** (`rs0`) để hỗ trợ MongoDB Transactions:
```bash
docker compose up -d
```
> **Lưu ý**: Service `mongo-init` sẽ tự động thực thi script `scripts/mongo-init.sh` để kích hoạt `rs.initiate()` idempotency. Kiểm tra trạng thái sẵn sàng của replica set:
> ```bash
> docker compose exec mongodb mongosh --eval "rs.status().ok"
> ```
> Kết quả trả về `1` nghĩa là Replica Set đã sẵn sàng.

### Bước 4: Khởi chạy ứng dụng
```bash
# Chế độ phát triển (Hot reload)
npm run start:dev

# Chế độ Production build
npm run build
npm run start:prod
```

### Bước 5: Kiểm tra trạng thái hệ thống (Health Check)
Mở terminal hoặc trình duyệt gửi request kiểm tra:
- **Liveness Probe**: Kiểm tra process đang hoạt động
  ```bash
  curl http://localhost:3000/health/live
  ```
  *Phản hồi (HTTP 200)*:
  ```json
  {
    "status": "UP",
    "timestamp": "2026-09-24T12:00:00.000Z"
  }
  ```

- **Readiness Probe**: Kiểm tra kết nối MongoDB Replica Set
  ```bash
  curl http://localhost:3000/health/ready
  ```
  *Phản hồi (HTTP 200)*:
  ```json
  {
    "status": "UP",
    "timestamp": "2026-09-24T12:00:00.000Z",
    "checks": {
      "database": {
        "status": "UP",
        "latency_ms": 3
      }
    }
  }
  ```

---

## 6. Danh Sách API Endpoints (API Specification)

### 6.1. Health & Ops
| Method | Endpoint | Quyền hạn | Mô tả |
|---|---|---|---|
| `GET` | `/health/live` | Public | Liveness probe kiểm tra process ứng dụng |
| `GET` | `/health/ready` | Public | Readiness probe kiểm tra kết nối CSDL MongoDB |

### 6.2. Danh Mục Sản Phẩm (Category Taxonomy)
| Method | Endpoint | Quyền hạn | Mô tả |
|---|---|---|---|
| `GET` | `/categories` | Public | Lấy cây danh mục phân cấp lồng nhau đang hoạt động (`ACTIVE`) |
| `GET` | `/categories/:id` | Public | Xem thông tin chi tiết danh mục và các danh mục con trực tiếp |
| `GET` | `/admin/catalog/categories` | Admin (`CATALOG_ADMIN`) | Tìm kiếm, phân trang và lọc danh mục theo trạng thái và danh mục cha |
| `POST` | `/admin/catalog/categories` | Admin (`CATALOG_ADMIN`) | Tạo danh mục mới (Root bắt buộc có thuế suất `tax_rate_bps`, Child tối đa 5 cấp) |
| `PATCH` | `/admin/catalog/categories/:id` | Admin (`CATALOG_ADMIN`) | Cập nhật danh mục, di chuyển nhánh cây con (kiểm tra chu trình & OCC) |
| `POST` | `/admin/catalog/categories/:id/archive` | Admin (`CATALOG_ADMIN`) | Lưu trữ danh mục (chặn nếu còn danh mục con active hoặc còn sản phẩm gán) |

---

## 7. Các Lệnh Thường Dùng (Scripts Reference)

```bash
# Định dạng và kiểm tra chuẩn mã nguồn
npm run lint          # Kiểm tra lỗi tĩnh bằng ESLint
npm run format        # Tự động định dạng mã nguồn bằng Prettier

# Biên dịch TypeScript sang JavaScript
npm run build         # Build project vào thư mục dist/

# Khởi chạy ứng dụng
npm run start         # Chạy trực tiếp từ dist/
npm run start:dev     # Chạy chế độ development với hot-reload
```

---

## 8. Giấy Phép & Tác Giả (License)

Dự án phát triển nội bộ bởi đội ngũ kỹ sư **Taca Ecommerce Platform**. Mọi quyền được bảo lưu.
