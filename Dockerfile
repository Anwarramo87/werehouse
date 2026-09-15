FROM node:22-alpine AS deps
WORKDIR /app
COPY backend-nest/package.json backend-nest/package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM deps AS build
COPY backend-nest/ ./
ARG DATABASE_URL=postgresql://postgres:postgres@localhost:5432/warehouse_system?schema=public
ENV DATABASE_URL=${DATABASE_URL}
RUN npm run prisma:generate
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json ./
COPY --from=build /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/scripts ./scripts

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

EXPOSE 5001

# One image, two roles. Set ROLE=worker on a second Railway service to run the
# payroll worker; without it payroll executes inline on the API event loop.
ENTRYPOINT ["./docker-entrypoint.sh"]
