import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from './local-preview.module';
import { DatabaseService } from '../database.service';
import { LocalPreviewFixtureFieldDataProvider } from './local-preview-fixtures';

async function bootstrap() {
  if (process.env.ADMIN_PREVIEW !== '1') {
    throw new Error('ADMIN_PREVIEW=1 is required for the local preview API');
  }

  const app = await NestFactory.create(LocalAdminPreviewModule.register(DatabaseService, LocalPreviewFixtureFieldDataProvider));
  const database = app.get(DatabaseService);
  const fixturePairs = [
    { entityType: 'CONTACT', bitrix24Id: 'preview-contact-1001', moyskladId: 'preview-counterparty-1001' },
    { entityType: 'COMPANY', bitrix24Id: 'preview-company-1001', moyskladId: 'preview-counterparty-company-1001' },
    { entityType: 'DEAL', bitrix24Id: 'preview-deal-1001', moyskladId: 'preview-customerorder-1001' },
    { entityType: 'PRODUCT', bitrix24Id: 'preview-product-1001', moyskladId: 'preview-product-1001' },
  ];
  for (const pair of fixturePairs) {
    const existing = await database.entityPair.findFirst({ where: { source: 'LOCAL_PREVIEW_FIXTURE', ...pair } });
    if (!existing) await database.entityPair.create({ data: { ...pair, source: 'LOCAL_PREVIEW_FIXTURE', reason: 'Synthetic local-only preview fixture' } });
  }
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
