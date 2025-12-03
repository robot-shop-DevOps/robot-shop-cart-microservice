FROM robotshopdevacr.azurecr.io/baseimages/node:25-slim-internal AS build

WORKDIR /opt/server

COPY package.json /opt/server/

RUN npm install

COPY src/ ./src

FROM robotshopdevacr.azurecr.io/baseimages/node:25-slim-internal

WORKDIR /opt/server

COPY --from=build /opt/server/node_modules ./node_modules

COPY --from=build /opt/server/src ./src

CMD ["node", "src/server.js"]