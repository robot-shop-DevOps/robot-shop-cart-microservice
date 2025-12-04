const request = require('supertest');
const CartServiceApp = require('../src/app');

// ---- MOCK JWT ----
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn(() => ({ name: 'cartuser' })),    // always valid
  sign: jest.fn(() => "mock.jwt.token")
}));

// ---- MOCK REDIS ----
const mockRedis = {
  get: jest.fn(),
  setEx: jest.fn(),
  del: jest.fn(),
};

// ---- MOCK CATALOGUE REQUEST ----
jest.mock('request', () => jest.fn());
const requestModule = require('request');

describe('CartServiceApp Functional Tests (JWT Enabled)', () => {
  let app;

  const AUTH = { Authorization: "Bearer faketoken" };

  beforeEach(() => {
    jest.clearAllMocks();

    const service = new CartServiceApp({
      redisHost: 'mock-redis',
      catalogueHost: 'mock-catalogue',
      mockRedisClient: mockRedis,
      jwtsecret: "testsecret"
    });

    app = service.getApp();
  });

  // ---------------- HEALTH ----------------
  test('GET /health → returns status', async () => {
    requestModule.mockImplementation((url, cb) =>
      cb(null, { statusCode: 200 }, 'OK')
    );

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      app: 'OK',
      redis: true,
      catalogue: true
    });
  });

  // ---------------- CART GET ----------------
  test('GET /cart/:id → 404 when not found', async () => {
    mockRedis.get.mockResolvedValue(null);

    const res = await request(app)
      .get('/cart/cartuser')
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.text).toBe('cart not found');
  });

  test('GET /cart/:id → returns cart', async () => {
    const cart = { items: [], total: 0 };
    mockRedis.get.mockResolvedValue(JSON.stringify(cart));

    const res = await request(app)
      .get('/cart/cartuser')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cart);
  });

  // ---------------- CART DELETE ----------------
  test('DELETE /cart/:id → delete OK', async () => {
    mockRedis.del.mockResolvedValue(1);

    const res = await request(app)
      .delete('/cart/cartuser')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.text).toBe('OK');
  });

  test('DELETE /cart/:id → delete 404', async () => {
    mockRedis.del.mockResolvedValue(0);

    const res = await request(app)
      .delete('/cart/cartuser')
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.text).toBe('cart not found');
  });

  // ---------------- ADD ITEM ----------------
  test('GET /add/:id/:sku/:qty → adds new item', async () => {
    requestModule.mockImplementation((url, cb) => {
      cb(null, { statusCode: 200 }, JSON.stringify({
        name: 'RobotX',
        price: 10,
        instock: 5
      }));
    });

    mockRedis.get.mockResolvedValue(null);
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app)
      .get('/add/cartuser/sku123/2')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({
      sku: 'sku123',
      qty: 2,
      name: 'RobotX',
      price: 10,
      subtotal: 20
    });
  });

  test('GET /add/:id/:sku/:qty → invalid qty', async () => {
    const res = await request(app)
      .get('/add/cartuser/sku123/0')
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.text).toBe('quantity must be a positive number');
  });

  test('GET /add/:id/:sku/:qty → product not found', async () => {
    requestModule.mockImplementation((url, cb) =>
      cb(null, { statusCode: 404 }, "")
    );

    const res = await request(app)
      .get('/add/cartuser/sku123/1')
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.text).toBe('product not found');
  });

  // ---------------- UPDATE ITEM ----------------
  test('GET /update/:id/:sku/:qty → update works', async () => {
    const cart = {
      items: [{ sku: 'sku1', qty: 2, price: 10, subtotal: 20 }],
      total: 20, tax: 3
    };

    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app)
      .get('/update/cartuser/sku1/5')
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.items[0].qty).toBe(5);
  });

  test('GET /update/:id/:sku/:qty → negative qty', async () => {
    const cart = {
      items: [{ sku: 'sku1', qty: 2, price: 10, subtotal: 20 }],
      total: 20, tax: 3
    };

    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const res = await request(app)
      .get('/update/cartuser/sku1/-1')
      .set(AUTH);

    expect(res.status).toBe(400);
    expect(res.text).toBe('quantity must be non-negative number');
  });

  // ---------------- SHIPPING ----------------
  test('POST /shipping/:id → add shipping', async () => {
    const cart = { items: [], total: 0, tax: 0 };

    mockRedis.get.mockResolvedValue(JSON.stringify(cart));
    mockRedis.setEx.mockResolvedValue('OK');

    const shippingData = { distance: 10, cost: 5, location: 'Hyderabad' };

    const res = await request(app)
      .post('/shipping/cartuser')
      .set(AUTH)
      .send(shippingData);

    expect(res.status).toBe(200);
    expect(res.body.items[0].sku).toBe('SHIP');
  });

  test('POST /shipping/:id → missing data', async () => {
    const res = await request(app)
      .post('/shipping/cartuser')
      .set(AUTH)
      .send({ distance: 10 });

    expect(res.status).toBe(400);
    expect(res.text).toBe('shipping data missing');
  });

});