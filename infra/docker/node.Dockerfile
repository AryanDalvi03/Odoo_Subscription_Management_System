FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci && npm run build
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir -p /app/var/mail && chown -R node:node /app/var
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
