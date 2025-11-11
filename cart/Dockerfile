FROM robotshopdevacr.azurecr.io/baseimages/node:25-slim-internal

WORKDIR /opt/server

COPY package.json /opt/server/

RUN npm install

COPY src/ ./src

CMD ["node", "src/server.js"]