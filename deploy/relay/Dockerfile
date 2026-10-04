FROM node:26-alpine AS build
WORKDIR /build
COPY packages/remote-relay/package.json packages/remote-relay/tsconfig.json ./
COPY packages/remote-relay/src ./src
RUN npm install --ignore-scripts --no-audit --no-fund && npm run build

FROM node:26-alpine
WORKDIR /app
COPY --from=build /build/package.json ./package.json
COPY --from=build /build/dist ./dist
COPY --from=build /build/node_modules/ws ./node_modules/ws
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/cli.js", "serve", "--home", "/data", "--host", "0.0.0.0", "--port", "8787", "--allow-private-bind", "--trust-proxy"]
