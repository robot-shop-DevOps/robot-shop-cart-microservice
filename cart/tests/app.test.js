const request = require('supertest');
const CartServiceApp = require('../src/app');

const mockRedis = {
  get: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
};

jest.mock('request', () => jest.fn());
const requestModule = require('request');

describe('CartServiceApp Functional Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();

    const service = new CartServiceApp({
      redisHost: 'mock-redis',
      catalogueHost: 'mock-catalogue',
      mockRedisClient: mockRedis,
    });

    app = service.getApp();
  });

  test('GET /health → returns app + redis + catalogue status', async () => {
    requestModule.mockImplementation((url, cb) => cb(null, { statusCode: 200 }, 'OK'));

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app: 'OK',
      redis: true,
      catalogue: true,
    });
  });

  test('GET /cart/:id → returns 404 if not found', async () => {
    mockRedis.get.mockResolvedValue(null);

    const res = await request(app).get('/cart/abc');

    expect(res.status).toBe(404);
    expect(res.text).toBe('cart not found');
  });

  test('GET /cart/:id → returns cart data if found', async () => {
    const cart = { items: [], total: 0 };
    mockRedis.get.mockResolvedValue(JSON.stringify(cart));

    const res = await request(app).get('/cart/abc');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cart);
  });

  test('DELETE /cart/:id → deletes cart if found', async () => {
    mockRedis.del.mockResolvedValue(1);

    const res = await request(app).delete('/cart/abc');

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });

  test('DELETE /cart/:id → returns 404 if not found', async () => {
    mockRedis.del.mockResolvedValue(0);

    const res = await request(app).delete('/cart/abc');

    expect(res.status).toBe(404);
    expect(res.text).toBe('cart not found');
  });

  test('GET /rename/:from/:to → renames cart', async () => {
    const cart = { items: [{ sku: 'X', qty: 1 }] };
    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app).get('/rename/old/new');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cart);
    expect(mockRedis.setEx).toHaveBeenCalledWith('new', expect.any(Number), JSON.stringify(cart));
  });

  test('GET /rename/:from/:to → returns 404 if old not found', async () => {
    mockRedis.get.mockResolvedValue(null);

    const res = await request(app).get('/rename/old/new');

    expect(res.status).toBe(404);
    expect(res.text).toBe('cart not found');
  });

  test('GET /add/:id/:sku/:qty → adds a new item', async () => {
    requestModule.mockImplementation((url, cb) => {
      if (url.includes('product')) {
        cb(null, { statusCode: 200 }, JSON.stringify({ name: 'Test Product', price: 10, instock: 5 }));
      } else {
        cb(null, { statusCode: 200 }, 'OK');
      }
    });

    mockRedis.get.mockResolvedValue(null);
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app).get('/add/cart123/sku123/2');

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      sku: 'sku123',
      qty: 2,
      name: 'Test Product',
      price: 10,
      subtotal: 20,
    });
  });

  test('GET /add/:id/:sku/:qty → fails for invalid qty', async () => {
    const res = await request(app).get('/add/cart123/sku123/0');
    expect(res.status).toBe(400);
    expect(res.text).toBe('quantity must be a positive number');
  });

  test('GET /add/:id/:sku/:qty → returns 404 if product not found', async () => {
    requestModule.mockImplementation((url, cb) => cb(null, { statusCode: 404 }, ''));
    const res = await request(app).get('/add/cart123/sku123/1');
    expect(res.status).toBe(404);
    expect(res.text).toBe('product not found');
  });

  test('GET /update/:id/:sku/:qty → updates item quantity', async () => {
    const cart = { items: [{ sku: 'sku1', qty: 2, price: 10, subtotal: 20 }], total: 20, tax: 3 };
    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app).get('/update/cart1/sku1/5');
    expect(res.status).toBe(200);
    expect(res.body.items[0].qty).toBe(5);
  });

  test('GET /update/:id/:sku/:qty → returns 400 for negative qty', async () => {
    const cart = { items: [{ sku: 'sku1', qty: 3, price: 10, subtotal: 20 }], total: 20, tax: 3 };
    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app).get('/update/cart1/sku1/-1');
    expect(res.status).toBe(400);
    expect(res.text).toBe('quantity must be non-negative number');
  });

  test('POST /shipping/:id → adds shipping item', async () => {
    const cart = { items: [], total: 0, tax: 0 };
    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const shippingData = { distance: 100, cost: 20, location: 'Hyderabad' };

    const res = await request(app)
      .post('/shipping/cart1')
      .send(shippingData);

    expect(res.status).toBe(200);
    expect(res.body.items[0].sku).toBe('SHIP');
    expect(res.body.items[0].price).toBe(20);
  });

  test('POST /shipping/:id → fails if missing fields', async () => {
    const res = await request(app)
      .post('/shipping/cart1')
      .send({ distance: 100 });
    expect(res.status).toBe(400);
    expect(res.text).toBe('shipping data missing');
  });
});