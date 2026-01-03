const express          = require('express');
const bodyParser       = require('body-parser');
const jwt              = require('jsonwebtoken');
const pino             = require('pino');
const expPino          = require('express-pino-logger');
const request          = require('request');
const { createClient } = require('redis');

class CartServiceApp {
  constructor(options = {}) {
    const {
      redisHost,
      catalogueHost,
      mockRedisClient,
      jwtsecret
    } = options;

    this.redisConnected     = false;
    this.redisHost          = redisHost;
    this.catalogueHost      = catalogueHost;
    this.catalogueUrl       = 'http://' + this.catalogueHost + ':8226';
    this.jwtsecret          = jwtsecret;

    /* -------------------------
       Logger
    --------------------------*/
    this.logger             = pino({ level: 'info', useLevelLabels: true });
    this.expLogger          = expPino({
      logger               : this.logger,
      autoLogging          : { ignorePaths: ['/health'] }
    });

    /* -------------------------
       Express
    --------------------------*/
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();

    /* -------------------------
       Redis
    --------------------------*/
    if (mockRedisClient) {
      this.redisClient      = mockRedisClient;
      this.redisConnected   = true;
    } else {
      this.setupRedis();
    }
  }

  /* -------------------------
     Logging helpers
  --------------------------*/
  logWarn(req, res, details) {
    req.log.warn({
      statusCode : res.statusCode,
      ...details
    });
  }

  logError(req, res, error, details = {}) {
    req.log.error({
      statusCode : res.statusCode,
      err        : error,
      ...details
    });
  }

  /* -------------------------
     Middleware
  --------------------------*/
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

  authMiddleware(req, res, next) {
    const header = req.headers['authorization'];

    if (!header) {
      res.status(401).send('Missing Authorization header');
      this.logWarn(req, res, { error_type: 'AUTH_HEADER_MISSING' });
      return;
    }

    const token = header.split(' ')[1];
    if (!token) {
      res.status(401).send('Missing token');
      this.logWarn(req, res, { error_type: 'TOKEN_MISSING' });
      return;
    }

    try {
      const decoded = jwt.verify(token, this.jwtsecret);
      req.user      = decoded;

      if (req.params.id && req.params.id !== decoded.name) {
        res.status(403).send('User mismatch');
        this.logWarn(req, res, {
          error_type : 'USER_MISMATCH',
          tokenUser  : decoded.name,
          pathUser   : req.params.id
        });
        return;
      }

      next();
    } catch (e) {
      res.status(403).send('Invalid or expired token');
      this.logWarn(req, res, { error_type: 'TOKEN_INVALID' });
    }
  }

  /* -------------------------
     Routes
  --------------------------*/
  setupRoutes() {
    this.app.get('/health', async (req, res) => {
      const catalogueStatus = await this.checkCatalogue();
      res.json({
        app       : 'OK',
        redis     : this.redisConnected,
        catalogue : catalogueStatus
      });
    });

    this.app.get('/cart/:id', this.authMiddleware.bind(this), async (req, res) => {
      try {
        const data = await this.redisClient.get(req.params.id);
        if (!data) {
          res.status(404).send('cart not found');
          this.logWarn(req, res, {
            error_type : 'CART_NOT_FOUND',
            user       : req.params.id
          });
          return;
        }
        res.json(JSON.parse(data));
      } catch (err) {
        res.status(500).send('internal error');
        this.logError(req, res, err, { error_type: 'FETCH_CART_FAILED' });
      }
    });

    this.app.delete('/cart/:id', this.authMiddleware.bind(this), async (req, res) => {
      try {
        const result = await this.redisClient.del(req.params.id);
        if (result === 1) {
          res.send('OK');
        } else {
          res.status(404).send('cart not found');
          this.logWarn(req, res, {
            error_type : 'CART_NOT_FOUND',
            user       : req.params.id
          });
        }
      } catch (err) {
        res.status(500).send('internal error');
        this.logError(req, res, err, { error_type: 'DELETE_CART_FAILED' });
      }
    });

    this.app.get('/add/:id/:sku/:qty', this.authMiddleware.bind(this), async (req, res) => {
      const qty = parseInt(req.params.qty);

      if (!req.params.id || req.params.id === 'undefined') {
        res.status(401).send('User not logged in');
        this.logWarn(req, res, { error_type: 'USER_NOT_LOGGED_IN' });
        return;
      }

      if (isNaN(qty) || qty < 1) {
        res.status(400).send('quantity must be a positive number');
        this.logWarn(req, res, { error_type: 'INVALID_QUANTITY', qty });
        return;
      }

      try {
        const product = await this.getProduct(req.params.sku);
        if (!product) {
          res.status(404).send('product not found');
          this.logWarn(req, res, {
            error_type : 'PRODUCT_NOT_FOUND',
            sku        : req.params.sku
          });
          return;
        }

        if (product.instock === 0) {
          res.status(404).send('out of stock');
          this.logWarn(req, res, {
            error_type : 'OUT_OF_STOCK',
            sku        : req.params.sku
          });
          return;
        }

        let cartData = await this.redisClient.get(req.params.id);
        let cart     = cartData
          ? JSON.parse(cartData)
          : { total: 0, tax: 0, items: [] };

        const item            = {
          qty,
          sku      : req.params.sku,
          name     : product.name,
          price    : product.price,
          subtotal : qty * product.price
        };

        cart.items = this.mergeList(cart.items, item, qty);
        cart.total = this.calcTotal(cart.items);
        cart.tax   = this.calcTax(cart.total);

        await this.saveCart(req.params.id, cart);
        res.json(cart);
      } catch (err) {
        res.status(500).send('internal error');
        this.logError(req, res, err, { error_type: 'ADD_TO_CART_FAILED' });
      }
    });

    this.app.get('/update/:id/:sku/:qty', this.authMiddleware.bind(this), async (req, res) => {
      const qty = parseInt(req.params.qty);

      if (isNaN(qty) || qty < 0) {
        res.status(400).send('quantity must be non-negative number');
        this.logWarn(req, res, { error_type: 'INVALID_QUANTITY', qty });
        return;
      }

      try {
        const data = await this.redisClient.get(req.params.id);
        if (!data) {
          res.status(404).send('cart not found');
          this.logWarn(req, res, {
            error_type : 'CART_NOT_FOUND',
            user       : req.params.id
          });
          return;
        }

        let cart  = JSON.parse(data);
        const idx = cart.items.findIndex(i => i.sku === req.params.sku);

        if (idx === -1) {
          res.status(404).send('not in cart');
          this.logWarn(req, res, {
            error_type : 'ITEM_NOT_IN_CART',
            sku        : req.params.sku
          });
          return;
        }

        if (qty === 0) {
          cart.items.splice(idx, 1);
        } else {
          cart.items[idx].qty      = qty;
          cart.items[idx].subtotal = cart.items[idx].price * qty;
        }

        cart.total = this.calcTotal(cart.items);
        cart.tax   = this.calcTax(cart.total);

        await this.saveCart(req.params.id, cart);
        res.json(cart);
      } catch (err) {
        res.status(500).send('internal error');
        this.logError(req, res, err, { error_type: 'UPDATE_CART_FAILED' });
      }
    });

    this.app.post('/shipping/:id', this.authMiddleware.bind(this), async (req, res) => {
      const shipping = req.body;

      if (!shipping.distance || !shipping.cost || !shipping.location) {
        res.status(400).send('shipping data missing');
        this.logWarn(req, res, { error_type: 'INVALID_SHIPPING_DATA' });
        return;
      }

      try {
        const data = await this.redisClient.get(req.params.id);
        if (!data) {
          res.status(404).send('cart not found');
          this.logWarn(req, res, {
            error_type : 'CART_NOT_FOUND',
            user       : req.params.id
          });
          return;
        }

        let cart   = JSON.parse(data);
        const item = {
          qty      : 1,
          sku      : 'SHIP',
          name     : 'shipping to ' + shipping.location,
          price    : shipping.cost,
          subtotal : shipping.cost
        };

        const idx = cart.items.findIndex(i => i.sku === item.sku);
        if (idx === -1) cart.items.push(item);
        else cart.items[idx] = item;

        cart.total             = this.calcTotal(cart.items);
        cart.tax               = this.calcTax(cart.total);

        await this.saveCart(req.params.id, cart);
        res.json(cart);
      } catch (err) {
        res.status(500).send('internal error');
        this.logError(req, res, err, { error_type: 'SHIPPING_FAILED' });
      }
    });
  }

  /* -------------------------
     Dependencies
  --------------------------*/
  async checkCatalogue() {
    return new Promise((resolve) => {
      request(this.catalogueUrl + '/health', (err, res) => {
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

    this.redisClient.on('error', (e) => {
      this.redisConnected = false;
      this.logger.error({ err: e }, 'Redis error');
    });

    await this.redisClient.connect();
  }

  async getProduct(sku) {
    return new Promise((resolve, reject) => {
      request(this.catalogueUrl + '/product/' + sku, (err, res, body) => {
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
      list[idx].qty      += qty;
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