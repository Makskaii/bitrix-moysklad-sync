import { Controller, Get, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { AdminAccessGuard } from './admin/admin-access.guard';
import { WebhookDiagnosticLog } from './webhook-diagnostic-log';

const expectedSubscriptions = [
  { source: 'BITRIX24', eventType: 'ONCRMDEALADD', entityType: 'deal', operation: 'create' },
  { source: 'BITRIX24', eventType: 'ONCRMDEALUPDATE', entityType: 'deal', operation: 'update' },
  { source: 'BITRIX24', eventType: 'ONCRMDEALDELETE', entityType: 'deal', operation: 'delete' },
  { source: 'MOYSKLAD', eventType: 'CREATE', entityType: 'customerorder', operation: 'create' },
  { source: 'MOYSKLAD', eventType: 'UPDATE', entityType: 'customerorder', operation: 'update' },
  { source: 'MOYSKLAD', eventType: 'DELETE', entityType: 'customerorder', operation: 'delete' },
] as const;

@Controller('api/admin')
@UseGuards(AdminAccessGuard)
export class WebhookDiagnosticsController {
  constructor(private readonly database: DatabaseService, private readonly diagnostics: WebhookDiagnosticLog) {}

  @Get('dry-webhooks')
  async readDryWebhookReport() {
    if (process.env.SYNC_MODE !== 'dry') {
      throw new ServiceUnavailableException('Dry webhook diagnostics are available only when SYNC_MODE=dry');
    }

    const rows = await this.database.inboundEvent.findMany({
      where: {
        OR: [
          { source: 'BITRIX24', externalEntityType: 'deal' },
          { source: 'MOYSKLAD', externalEntityType: 'customerorder' },
        ],
      },
      orderBy: { receivedAt: 'desc' },
      take: 100,
      select: {
        id: true,
        source: true,
        eventType: true,
        externalEntityType: true,
        externalEntityId: true,
        status: true,
        receivedAt: true,
        lastErrorCategory: true,
      },
    });

    const events = rows.map((row) => ({
      eventId: row.id,
      source: row.source,
      eventType: row.eventType,
      entityType: row.externalEntityType,
      externalEntityId: safeDiagnosticId(row.source, row.externalEntityId),
      receivedAt: row.receivedAt.toISOString(),
      status: statusFor(row.status),
      ...(safeReason(row.lastErrorCategory) ? { reason: safeReason(row.lastErrorCategory) } : {}),
    }));
    const diagnostics = this.diagnostics.read();

    return {
      mode: 'dry',
      targets: {
        bitrix24: '/webhooks/bitrix24',
        moysklad: '/webhooks/moysklad/{MOYSKLAD_WEBHOOK_SECRET}',
      },
      subscriptions: expectedSubscriptions.map((expected) => {
        const latest = [
          ...events.filter((event) => event.source === expected.source && event.eventType === expected.eventType),
          ...diagnostics.filter((entry) => entry.source === expected.source && entry.eventType === expected.eventType),
        ].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))[0];
        return {
          ...expected,
          status: latest?.status ?? 'not_checked',
          ...(latest ? { lastCheckedAt: latest.receivedAt } : {}),
          ...(latest && 'reason' in latest ? { reason: latest.reason } : {}),
        };
      }),
      events,
      diagnostics,
    };
  }
}

function statusFor(status: string): 'event_received' | 'processing_error' {
  return ['ERROR', 'FAILED', 'PROCESSING_ERROR'].includes(status) ? 'processing_error' : 'event_received';
}

function safeReason(value: string | null): string | null {
  return value && /^[A-Z0-9_]{1,64}$/.test(value) ? value : null;
}

function safeDiagnosticId(source: string, value: string | null): string | null {
  if (!value) return null;
  if (source === 'BITRIX24') return /^\d{1,20}$/.test(value) ? value : null;
  if (source === 'MOYSKLAD') return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value) ? value : null;
  return null;
}
