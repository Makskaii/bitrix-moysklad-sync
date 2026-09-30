FROM node:22-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY prisma prisma
COPY apps/api apps/api
RUN npx prisma generate --schema prisma/schema.prisma && npm run build --workspace @sync/api
EXPOSE 3000
CMD ["sh", "-c", "case \"${SYNC_MODE:-apply}\" in apply) ;; dry) export DATABASE_URL=\"${DRY_DATABASE_URL:?DRY_DATABASE_URL is required when SYNC_MODE=dry}\" ;; *) echo 'SYNC_MODE must be dry or apply' >&2; exit 1 ;; esac; npx prisma migrate deploy --schema prisma/schema.prisma && node dist/apps/api/src/main.js"]
