import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { LocalAdminPreviewModule } from './local-preview.module';

async function bootstrap() {
  if (process.env.ADMIN_PREVIEW !== '1') {
    throw new Error('ADMIN_PREVIEW=1 is required for the local preview API');
  }

  const app = await NestFactory.create(LocalAdminPreviewModule.register());
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
