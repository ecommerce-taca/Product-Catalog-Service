const mongoose = require('mongoose');

async function seed() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/product_catalog?replicaSet=rs0&directConnection=true';
  await mongoose.connect(uri);
  const col = mongoose.connection.collection('shop_snapshots');

  // Seed standard active seller shop
  await col.updateOne(
    { shop_id: '01912f20-0001-7000-8000-000000000001' },
    {
      $set: {
        _id: '01912f20-0001-7000-8000-000000000001',
        shop_id: '01912f20-0001-7000-8000-000000000001',
        name: 'Taca Fashion Official',
        slug: 'taca-fashion-official',
        shop_status: 'ACTIVE',
        kyc_status: 'APPROVED',
        logo_url: null,
        source_event_id: 'seed-seller-01',
        source_version: 1,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );

  // Seed suspended seller shop (for [9.5] test)
  await col.updateOne(
    { shop_id: '01912f20-8888-7000-8000-000000008888' },
    {
      $set: {
        _id: '01912f20-8888-7000-8000-000000008888',
        shop_id: '01912f20-8888-7000-8000-000000008888',
        name: 'Suspended Violator Shop',
        slug: 'suspended-violator-shop',
        shop_status: 'SUSPENDED',
        kyc_status: 'APPROVED',
        logo_url: null,
        source_event_id: 'seed-suspended-01',
        source_version: 1,
        updated_at: new Date(),
      },
    },
    { upsert: true },
  );

  console.log('Test shops seeded successfully in shop_snapshots collection');
  await mongoose.disconnect();
}

seed().catch(console.error);
