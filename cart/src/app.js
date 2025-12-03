const express = require('express');
const bodyParser = require('body-parser');
const pino = require('pino');
const expPino = require('express-pino-logger');
const request = require('request');
const { createClient } = require('redis');

class CartServiceApp {
  constructor(options = {}) {
    const { redisHost, catalogueHost, mockRedisClient } = options;

    this.redisConnected = false;
    this.redisHost = redisHost;
    this.catalogueHost = catalogueHost;
    this.catalogueUrl = 'http://' + this.catalogueHost + ':8226/'

    this.logger = pino({ level: 'info', prettyPrint: false, useLevelLabels: true });
    this.expLogger = expPino({ 
      logger: this.logger,

      customLogLevel: function (req, res, err) {
        if (req.url === '/health') {
          return 'silent';
        }

        if (err) {
          return 'error';
        }

        return 'info';
      }

    });

    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();

    // Redis or mock
    if (mockRedisClient) {
      this.redisClient = mockRedisClient;
      this.redisConnected = true;
    } 
    else {
      this.setupRedis();
    }
  }

  setupMiddleware() {
    this.app.use(this.expLogger);
    this.app.use(bodyParser.json());
    this.app.use(bodyParser.urlencoded({ extended: true }));

    this.app.use((req, res, next) => {
      res.set('Timing-Allow-Origin', '*');
      res.set('Access-Control-Allow-Origin', '*');
      next();
    });
  }

  setupRoutes() {
    // health
    this.app.get('/health', async (req, res) => {
      const catalogueStatus = await this.checkCatalogue();
      res.json({ 
        app: 'OK', 
        redis: this.redisConnected,
        catalogue: catalogueStatus
      });
    });

    // get cart
    this.app.get('/cart/:id', async (req, res) => {
      try {
        const data = await this.redisClient.get(req.params.id);
        if (!data) return res.status(404).send('cart not found');
        res.json(JSON.parse(data));
      } catch (err) {
        req.log.error('ERROR', err);
        res.status(500).send(err);
      }
    });

    // delete cart
    this.app.delete('/cart/:id', async (req, res) => {
      try {
        const result = await this.redisClient.del(req.params.id);
        if (result === 1) res.send('OK');
        else res.status(404).send('cart not found');
      } catch (err) {
        req.log.error('ERROR', err);
        res.status(500).send(err);
      }
    });

    // rename cart
    this.app.get('/rename/:from/:to', async (req, res) => {
      try {
        const data = await this.redisClient.get(req.params.from);
        if (!data) return res.status(404).send('cart not found');

        const cart = JSON.parse(data);
        await this.saveCart(req.params.to, cart);
        res.json(cart);
      } catch (err) {
        req.log.error(err);
        res.status(500).send(err);
      }
    });

    // add item
    this.app.get('/add/:id/:sku/:qty', async (req, res) => {
      const qty = parseInt(req.params.qty);

      if (!req.params.id || req.params.id === 'undefined') {
          return res.status(401).send('User not logged in');
      }

      if (isNaN(qty) || qty < 1)
        return res.status(400).send('quantity must be a positive number');

      try {
        const product = await this.getProduct(req.params.sku);
        if (!product) return res.status(404).send('product not found');
        if (product.instock === 0) return res.status(404).send('out of stock');

        let cartData = await this.redisClient.get(req.params.id);
        let cart = cartData ? JSON.parse(cartData) : { total: 0, tax: 0, items: [] };

        const item = {
          qty,
          sku: req.params.sku,
          name: product.name,
          price: product.price,
          subtotal: qty * product.price
        };

        cart.items = this.mergeList(cart.items, item, qty);
        cart.total = this.calcTotal(cart.items);
        cart.tax = this.calcTax(cart.total);

        await this.saveCart(req.params.id, cart);
        res.json(cart);
      } catch (err) {
        req.log.error(err);
        res.status(500).send(err);
      }
    });

    // update quantity
    this.app.get('/update/:id/:sku/:qty', async (req, res) => {
      const qty = parseInt(req.params.qty);
      if (isNaN(qty) || qty < 0)
        return res.status(400).send('quantity must be non-negative number');

      try {
        const data = await this.redisClient.get(req.params.id);
        if (!data) return res.status(404).send('cart not found');

        let cart = JSON.parse(data);
        const idx = cart.items.findIndex(i => i.sku === req.params.sku);

        if (idx === -1) return res.status(404).send('not in cart');

        if (qty === 0) cart.items.splice(idx, 1);
        else {
          cart.items[idx].qty = qty;
          cart.items[idx].subtotal = cart.items[idx].price * qty;
        }

        cart.total = this.calcTotal(cart.items);
        cart.tax = this.calcTax(cart.total);
        await this.saveCart(req.params.id, cart);
        res.json(cart);
      } catch (err) {
        req.log.error(err);
        res.status(500).send(err);
      }
    });

    // shipping
    this.app.post('/shipping/:id', async (req, res) => {
      const shipping = req.body;
      if (!shipping.distance || !shipping.cost || !shipping.location)
        return res.status(400).send('shipping data missing');

      try {
        const data = await this.redisClient.get(req.params.id);
        if (!data) return res.status(404).send('cart not found');

        let cart = JSON.parse(data);
        const item = {
          qty: 1,
          sku: 'SHIP',
          name: 'shipping to ' + shipping.location,
          price: shipping.cost,
          subtotal: shipping.cost
        };

        const idx = cart.items.findIndex(i => i.sku === item.sku);
        if (idx === -1) cart.items.push(item);
        else cart.items[idx] = item;

        cart.total = this.calcTotal(cart.items);
        cart.tax = this.calcTax(cart.total);

        await this.saveCart(req.params.id, cart);
        res.json(cart);
      } catch (err) {
        req.log.error(err);
        res.status(500).send(err);
      }
    });
  }

  async checkCatalogue() {
    return new Promise((resolve) => {
        request(this.catalogueUrl + 'health', (err, res, body) => {
        if (err || res.statusCode !== 200) resolve(false);
        else resolve(true);
        });
    });
  }

  async setupRedis() {
    this.redisClient = createClient({ socket: { host: this.redisHost } });
    this.redisClient.on('ready', () => {
      this.logger.info('Redis connected');
      this.redisConnected = true;
    });
    this.redisClient.on('error', e => {
      this.logger.error('Redis ERROR', e);
    });
    await this.redisClient.connect();
  }

  async getProduct(sku) {
    return new Promise((resolve, reject) => {
      request(this.catalogueUrl+'/product/'+sku, (err, res, body) => {
        if (err) reject(err);
        else if (res.statusCode !== 200) resolve(null);
        else resolve(JSON.parse(body));
      });
    });
  }

  async saveCart(id, cart) {
    await this.redisClient.setEx(id, 3600, JSON.stringify(cart));
  }

  mergeList(list, product, qty) {
    const idx = list.findIndex(i => i.sku === product.sku);
    if (idx !== -1) {
      list[idx].qty += qty;
      list[idx].subtotal = list[idx].price * list[idx].qty;
    } else {
      list.push(product);
    }
    return list;
  }

  calcTotal(list) {
    return list.reduce((acc, i) => acc + i.subtotal, 0);
  }

  calcTax(total) {
    return total - total / 1.2;
  }

  getApp() {
    return this.app;
  }
}

module.exports = CartServiceApp;