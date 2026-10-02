import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AdminAccessGuard } from './admin/admin-access.guard';
import { ContactSyncStatusController } from './admin/contact-sync-status.controller';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor, ContactSyncStatusReader } from './contact-sync.service';
import { EventsController, EventIntakeService } from './events.controller';

@Controller()
class AppController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  async health() {
    await this.database.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'ok' };
  }

}

@Module({
  controllers: [AppController, AdminController, ContactSyncStatusController, EventsController],
  providers: [DatabaseService, AdminAccessGuard, EventIntakeService, ContactSyncProcessor, ContactSyncStatusReader],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
