import { Controller, DynamicModule, Get, Module, Provider, Type } from '@nestjs/common';
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
import { DryRunDocumentReader } from '../dry-run-document-reader';
import { EntityPairService } from '../pairs/entity-pair.service';
import { PairResolutionProvider } from '../pairs/pair-resolution.provider';
import { PAIR_RESOLVER } from '../pairs/pair-resolver';
import { PairFirstEventProcessor } from '../pairs/pair-first-event.processor';
import { PairResolutionController } from './pair-resolution.controller';
import { DealOrderBaselineService } from '../deals-orders/deal-order-baseline.service';
import { DealOrderHeaderSyncProcessor } from '../deals-orders/deal-order-header-sync.processor';
import { HistoricalInventoryController } from './historical-inventory.controller';
import { HistoricalInventoryService } from '../historical-inventory.service';
import { ReadOnlyFieldDataProvider } from '../field-settings/read-only-field-data.provider';
import { ClientMappingController } from './client-mapping.controller';
import { ClientMappingService } from '../clients/client-mapping.service';
import { HttpClientInventoryProvider } from '../clients/client-inventory.provider';
import { CLIENT_INVENTORY_PROVIDER } from '../clients/client-mapping.service';
import { CLIENT_SYNC_GATEWAY, ClientSyncProcessor } from '../clients/client-sync.processor';
import { HttpClientSyncGateway } from '../clients/client-sync.gateway';
import { CLIENT_CANDIDATE_GATEWAY, HttpClientCandidateGateway } from '../clients/client-candidate.gateway';
import { CLIENT_DEPENDENCY_RESOLVER } from '../clients/client-dependency-resolver';

@Module({})
export class LocalAdminPreviewModule {
  static register(databaseProvider: Provider = DatabaseService, fieldDataProvider: Type<ReadOnlyFieldDataProvider> = ReadOnlyFieldDataProvider): DynamicModule {
    return {
      module: LocalAdminPreviewModule,
      controllers: [PreviewHealthController, AdminController, AdminPreviewController, FieldSettingsController, SyncModeController, ContactSyncStatusController, MonitoringController, EventsController, WebhookDiagnosticsController, ...(databaseProvider === DatabaseService ? [PairResolutionController, HistoricalInventoryController, ClientMappingController] : [])],
      providers: [
        databaseProvider,
        SyncModeService,
        SyncRecoveryService,
        ContactSyncProcessor,
        ContactSyncStatusReader,
        EventIntakeService,
        RetentionService,
        DryRunDocumentReader,
        ...(databaseProvider === DatabaseService ? [
          FieldSettingsService, { provide: ReadOnlyFieldDataProvider, useClass: fieldDataProvider }, DealOrderBaselineService, DealOrderHeaderSyncProcessor,
          HistoricalInventoryService,
          HttpClientInventoryProvider, { provide: CLIENT_INVENTORY_PROVIDER, useExisting: HttpClientInventoryProvider }, ClientMappingService,
          HttpClientSyncGateway, { provide: CLIENT_SYNC_GATEWAY, useExisting: HttpClientSyncGateway },
          HttpClientCandidateGateway, { provide: CLIENT_CANDIDATE_GATEWAY, useExisting: HttpClientCandidateGateway }, ClientSyncProcessor, { provide: CLIENT_DEPENDENCY_RESOLVER, useExisting: ClientSyncProcessor },
          EntityPairService, PairResolutionProvider,
          { provide: PAIR_RESOLVER, useExisting: PairResolutionProvider },
          PairFirstEventProcessor,
        ] : []),
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
