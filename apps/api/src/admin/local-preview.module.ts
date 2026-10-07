import { Controller, DynamicModule, Get, Module, Provider } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminPreviewController } from './admin-preview.controller';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from './admin-access.guard';
import { DatabaseService } from '../database.service';
import { SyncModeController } from './sync-mode.controller';
import { SyncModeService } from '../sync-mode.service';
import { SyncRecoveryService } from '../sync-recovery.service';
import { ContactSyncProcessor, ContactSyncStatusReader } from '../contact-sync.service';
import { ContactSyncStatusController } from './contact-sync-status.controller';
import { EventsController, EventIntakeService } from '../events.controller';
import { MonitoringController } from './monitoring.controller';
import { RetentionService } from '../retention.service';
import { WebhookDiagnosticsController } from '../webhook-diagnostics.controller';
import { WebhookDiagnosticLog } from '../webhook-diagnostic-log';
import { FieldSettingsController } from './field-settings.controller';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from '../field-settings/read-only-field-data.provider';

@Module({})
export class LocalAdminPreviewModule {
  static register(databaseProvider: Provider = DatabaseService): DynamicModule {
    return {
      module: LocalAdminPreviewModule,
      controllers: [PreviewHealthController, AdminController, AdminPreviewController, FieldSettingsController, SyncModeController, ContactSyncStatusController, MonitoringController, EventsController, WebhookDiagnosticsController],
      providers: [
        databaseProvider,
        SyncModeService,
        SyncRecoveryService,
        ContactSyncProcessor,
        ContactSyncStatusReader,
        EventIntakeService,
        RetentionService,
        ...(databaseProvider === DatabaseService ? [FieldSettingsService, ReadOnlyFieldDataProvider] : []),
        WebhookDiagnosticLog,
        { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true },
        AdminAccessGuard,
      ],
    };
  }
}

@Controller()
class PreviewHealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  async health() {
    await this.database.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'ok' };
  }
}
