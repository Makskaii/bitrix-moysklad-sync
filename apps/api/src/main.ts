import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AdminPreviewController } from './admin/admin-preview.controller';
import { AdminAccessGuard } from './admin/admin-access.guard';
import { DatabaseService } from './database.service';
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
  controllers: [AppController, AdminController, AdminPreviewController, EventsController],
  providers: [DatabaseService, AdminAccessGuard, EventIntakeService],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
