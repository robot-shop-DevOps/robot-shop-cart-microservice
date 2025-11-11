const CartServiceApp = require('./app');

const redisHost = process.env.REDIS_HOST;
const catalogueHost = process.env.CATALOGUE_HOST;
const port = process.env.CART_SERVER_PORT;

const service = new CartServiceApp({ redisHost, catalogueHost });
const app = service.getApp();

app.listen(port, () => {
  console.log('Started on port', port);
});