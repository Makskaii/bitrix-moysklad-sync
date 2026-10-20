import 'reflect-metadata';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { isAbsolute, resolve } from 'node:path';
import { AdminController } from './admin/admin.controller';
import { AdminAuditController } from './admin/admin-audit.controller';
import { AdminAuditService } from './admin/admin-audit.service';
import { ClientLifecycleController } from './admin/client-lifecycle.controller';
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
import { FieldSettingsController } from './admin/field-settings.controller';
import { FieldSettingsService } from './field-settings/field-settings.service';
import { ReadOnlyFieldDataProvider } from './field-settings/read-only-field-data.provider';
import { PairResolutionController } from './admin/pair-resolution.controller';
import { EntityPairService } from './pairs/entity-pair.service';
import { PairResolutionProvider } from './pairs/pair-resolution.provider';
import { PAIR_RESOLVER } from './pairs/pair-resolver';
import { PairFirstEventProcessor } from './pairs/pair-first-event.processor';
import { DealOrderBaselineService } from './deals-orders/deal-order-baseline.service';
import { DryRunDocumentReader } from './dry-run-document-reader';
import { DealOrderHeaderSyncProcessor } from './deals-orders/deal-order-header-sync.processor';
import { DealOrderCreationPreparer } from './deals-orders/deal-order-creation-preparer.service';
import { DealOrderCreateOperationService } from './deals-orders/deal-order-create-operation.service';
import { DealOrderPositionRuntimeService } from './deals-orders/deal-order-position-runtime.service';
import { DealOrderFieldRuntimeService } from './deals-orders/deal-order-field-runtime.service';
import { DealOrderReverseCreateService } from './deals-orders/deal-order-reverse-create.service';
import { DealOrderTotalReconciliationHandler } from './deals-orders/deal-order-total-reconciliation';
import { HistoricalInventoryController } from './admin/historical-inventory.controller';
import { HistoricalInventoryService } from './historical-inventory.service';
import { HistoricalDealOrderMatchingController } from './admin/historical-deal-order-matching.controller';
import { HistoricalDealOrderMatchingService } from './historical-deal-order-matching.service';
import { ClientMappingController } from './admin/client-mapping.controller';
import { ClientMappingService } from './clients/client-mapping.service';
import { HttpClientInventoryProvider } from './clients/client-inventory.provider';
import { CLIENT_INVENTORY_PROVIDER } from './clients/client-mapping.service';
import { CLIENT_SYNC_GATEWAY, ClientSyncProcessor } from './clients/client-sync.processor';
import { HttpClientSyncGateway } from './clients/client-sync.gateway';
import { CLIENT_CANDIDATE_GATEWAY, HttpClientCandidateGateway } from './clients/client-candidate.gateway';
import { CLIENT_DEPENDENCY_RESOLVER } from './clients/client-dependency-resolver';
import { ClientChildResourceSync } from './clients/client-child-resource-sync';
import { ADDITIONAL_EVENT_PROCESSORS, EventDispatcherService } from './event-dispatcher.service';
import { EventWorkerLeaseService } from './event-worker-lease.service';
import { ProductCardEventProcessor } from './products/product-card-event.processor';
import { ProductCardHttpApi } from './products/product-card-api';
import { ProductCardRuntimeService } from './products/product-card-runtime.service';
import { ProductCatalogCreateService } from './products/product-catalog-create.service';
import { CLIENT_LIFECYCLE_GATEWAY, ClientLifecycleService } from './clients/client-lifecycle.service';
import { DryRunWriteJournal } from './dry-run-write-journal';
import { DatabaseRecoveryService } from './database-recovery.service';
import { setDatabaseRecoveryReady } from './external-write-guard';
import { readFileSync } from 'node:fs';
import { installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from './external-write-guard';
import { verifyControlledLiveProviderNamespace } from './controlled-live-test-namespace';
import { createControlledLiveTestPolicy } from './controlled-live-test-policy';
import { resolveApiBindHost } from './api-bind-host';
import { ControlledLiveTestAdmissionService } from './controlled-live-test-admission.service';
import { InvoiceHttpApi } from './invoices/invoice-http-api';
import { InvoiceEventProcessor } from './invoices/invoice-event.processor';
import { ProductDuplicatesController } from './admin/product-duplicates.controller';
import { ProductDuplicateAliasService } from './products/product-duplicate-alias.service';
import { ApplicationLaunchController } from './application-launch.controller';

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
  controllers: [AppController, ApplicationLaunchController, AdminController, AdminAuditController, ClientLifecycleController, ProductDuplicatesController, FieldSettingsController, ContactSyncStatusController, MonitoringController, SyncModeController, EventsController, WebhookDiagnosticsController, PairResolutionController, HistoricalInventoryController, HistoricalDealOrderMatchingController, ClientMappingController],
  providers: [DatabaseService, AdminAccessGuard, EventIntakeService, EventDispatcherService,
    { provide: ADDITIONAL_EVENT_PROCESSORS, useFactory: (products: ProductCardEventProcessor, clients: ClientSyncProcessor, lifecycle: ClientLifecycleService, invoices: InvoiceEventProcessor) => [products, clients, lifecycle, invoices], inject: [ProductCardEventProcessor, ClientSyncProcessor, ClientLifecycleService, InvoiceEventProcessor] },
    EventWorkerLeaseService, DatabaseRecoveryService,
    WebhookDiagnosticLog, AdminAuditService, ContactSyncProcessor, ContactSyncStatusReader, SyncModeService, SyncRecoveryService, RetentionService,
    FieldSettingsService, ReadOnlyFieldDataProvider, DryRunDocumentReader, DealOrderBaselineService, DealOrderHeaderSyncProcessor, DealOrderCreationPreparer, DealOrderCreateOperationService, DealOrderPositionRuntimeService, DealOrderFieldRuntimeService, DealOrderReverseCreateService, DealOrderTotalReconciliationHandler,
    EntityPairService, PairResolutionProvider, HistoricalInventoryService, HistoricalDealOrderMatchingService,
    DryRunWriteJournal,
    { provide: InvoiceHttpApi, useFactory: (dry: DryRunWriteJournal) => new InvoiceHttpApi(dry), inject: [DryRunWriteJournal] }, InvoiceEventProcessor,
    { provide: ProductCardHttpApi, useFactory: (dry: DryRunWriteJournal) => new ProductCardHttpApi(dry), inject: [DryRunWriteJournal] }, ProductCatalogCreateService, ProductCardRuntimeService, ProductDuplicateAliasService, ProductCardEventProcessor,
    HttpClientInventoryProvider, { provide: CLIENT_INVENTORY_PROVIDER, useExisting: HttpClientInventoryProvider }, ClientMappingService,
    { provide: HttpClientSyncGateway, useFactory: (dry: DryRunWriteJournal) => new HttpClientSyncGateway(fetch, dry), inject: [DryRunWriteJournal] }, { provide: CLIENT_SYNC_GATEWAY, useExisting: HttpClientSyncGateway },
    { provide: HttpClientCandidateGateway, useFactory: (database: DatabaseService, dry: DryRunWriteJournal) => new HttpClientCandidateGateway(database, fetch, dry), inject: [DatabaseService, DryRunWriteJournal] }, { provide: CLIENT_CANDIDATE_GATEWAY, useExisting: HttpClientCandidateGateway },
    { provide: ClientChildResourceSync, useFactory: (dry: DryRunWriteJournal) => new ClientChildResourceSync(fetch, dry), inject: [DryRunWriteJournal] }, ControlledLiveTestAdmissionService, ClientSyncProcessor, ClientLifecycleService,
    { provide: CLIENT_LIFECYCLE_GATEWAY, useExisting: HttpClientSyncGateway },
    { provide: CLIENT_DEPENDENCY_RESOLVER, useExisting: ClientSyncProcessor }, { provide: PAIR_RESOLVER, useExisting: PairResolutionProvider }, PairFirstEventProcessor],
})
class AppModule {}

async function bootstrap() {
  const apiBindHost = resolveApiBindHost(process.env.API_BIND_HOST);
  if (process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
    if (process.env.CONTROLLED_LIVE_TEST_INSTANCE !== 'isolated') {
      throw new Error('CONTROLLED_LIVE_TEST_REQUIRES_ISOLATED_INSTANCE');
    }
    if (process.env.SYNC_MODE !== 'apply') throw new Error('CONTROLLED_LIVE_TEST_REQUIRES_APPLY_MODE');
    const manifestPath = process.env.CONTROLLED_LIVE_TEST_MANIFEST;
    if (!manifestPath || !isAbsolute(manifestPath)) {
      throw new Error('CONTROLLED_LIVE_TEST_MANIFEST_PATH_INVALID');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { providerNamespace?: unknown };
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy(manifest, process.env.DATABASE_URL));
    installControlledLiveFetchGuard(manifest.providerNamespace);
    await verifyControlledLiveProviderNamespace(manifest.providerNamespace, {
      bitrix24RestBaseUrl: process.env.BITRIX24_REST_BASE_URL,
      moyskladApiBaseUrl: process.env.MOYSKLAD_API_BASE_URL,
      moyskladApiToken: process.env.MOYSKLAD_API_TOKEN,
      allowLoopbackHttp: process.env.CONTROLLED_LIVE_TEST_FAKE_PROVIDER_HTTP === 'enabled',
    });
  }
  setDatabaseRecoveryReady(false);
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: new RotatingFileLogger() });
  await app.get(DatabaseRecoveryService).initialize();
  app.useStaticAssets(resolve(__dirname, '../../../../apps/web/dist'));
  await app.listen(process.env.PORT ?? 3000, apiBindHost);
}

void bootstrap();
