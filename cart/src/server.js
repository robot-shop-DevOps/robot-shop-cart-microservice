const CartServiceApp = require('./app');

const redisHost     = process.env.REDIS_HOST;
const catalogueHost = process.env.CATALOGUE_HOST;
const port          = process.env.CART_SERVER_PORT;
const jwtsecret     = process.env.JWT_SECRET;

const service = new CartServiceApp({ redisHost, catalogueHost, jwtsecret });
const app     = service.getApp();

app.listen(port, () => {
  console.log('Started on port', port);
});