import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AdminAccessGuard } from './admin/admin-access.guard';
import { ContactSyncStatusController } from './admin/contact-sync-status.controller';
import { SyncModeController } from './admin/sync-mode.controller';
import { DatabaseService } from './database.service';
import { ContactSyncProcessor, ContactSyncStatusReader } from './contact-sync.service';
import { EventsController, EventIntakeService } from './events.controller';
import { SyncModeService } from './sync-mode.service';
import { SyncRecoveryService } from './sync-recovery.service';
import { MonitoringController } from './admin/monitoring.controller';
import { RetentionService } from './retention.service';
import { RotatingFileLogger } from './rotating-file.logger';
import { WebhookDiagnosticsController } from './webhook-diagnostics.controller';
import { WebhookDiagnosticLog } from './webhook-diagnostic-log';
import { PairResolutionController } from './admin/pair-resolution.controller';
import { EntityPairService } from './pairs/entity-pair.service';
import { PairResolutionProvider } from './pairs/pair-resolution.provider';
import { PAIR_RESOLVER } from './pairs/pair-resolver';
import { PairFirstEventProcessor } from './pairs/pair-first-event.processor';

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
  controllers: [AppController, AdminController, ContactSyncStatusController, MonitoringController, SyncModeController, EventsController, WebhookDiagnosticsController, PairResolutionController],
  providers: [DatabaseService, AdminAccessGuard, EventIntakeService, WebhookDiagnosticLog, ContactSyncProcessor, ContactSyncStatusReader, SyncModeService, SyncRecoveryService, RetentionService, EntityPairService, PairResolutionProvider, { provide: PAIR_RESOLVER, useExisting: PairResolutionProvider }, PairFirstEventProcessor],
})
class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new RotatingFileLogger() });
  await app.listen(process.env.PORT ?? 3000, '0.0.0.0');
}

void bootstrap();
