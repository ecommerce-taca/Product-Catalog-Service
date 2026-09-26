export const TOPIC_CATALOG_EVENTS = 'catalog.events.v1';
export const TOPIC_INVENTORY_EVENTS = 'inventory.events.v1';
export const TOPIC_AUTH_EVENTS = 'auth.events.v1';
export const TOPIC_RATING_EVENTS = 'rating.events.v1';
export const TOPIC_DLQ = 'product-catalog.events.dlq.v1';

export const EVENT_SHOP_CREATED = 'shop.created';
export const EVENT_SHOP_UPDATED = 'shop.updated';
export const EVENT_SHOP_STATUS_CHANGED = 'shop.status_changed';
export const EVENT_SHOP_KYC_SUBMITTED = 'shop.kyc.submitted';
export const EVENT_SHOP_KYC_APPROVED = 'shop.kyc.approved';
export const EVENT_SHOP_KYC_NEEDS_INFO = 'shop.kyc.needs_info';
export const EVENT_SHOP_KYC_REJECTED = 'shop.kyc.rejected';
export const EVENT_SHOP_KYC_EXPIRED = 'shop.kyc.expired';

export const EVENT_INVENTORY_STOCK_SNAPSHOT_UPDATED = 'inventory.stock_snapshot.updated';
export const EVENT_RATING_AGGREGATE_UPDATED = 'rating.aggregate.updated';
export const EVENT_PRODUCT_SHOP_SNAPSHOT_UPDATED = 'product.shop_snapshot_updated';

export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_BASE_MS = 50;
