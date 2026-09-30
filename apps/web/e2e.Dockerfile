FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/web/playwright.config.ts apps/web/playwright.config.ts
COPY apps/web/e2e apps/web/e2e
RUN npm ci
CMD ["npm", "run", "test:e2e", "--workspace", "@sync/web"]
