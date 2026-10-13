import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Optional, Param, Patch, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { ContactSyncProcessor } from '../contact-sync.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';
import { AdminAuditService, createAdminAuditEntry, RequestWithHeaders, safeAuditJson } from './admin-audit.service';

const LOG_CATEGORIES = ['EVENT', 'SCHEDULED', 'ERROR', 'ADMIN', 'MANUAL', 'SYSTEM', 'API'] as const;

@Controller('api/admin/monitoring')
@UseGuards(AdminAccessGuard)
export class MonitoringController {
  constructor(
    private readonly database: DatabaseService,
    private readonly processor: ContactSyncProcessor,
    private readonly audit: AdminAuditService,
    @Optional() @Inject(FieldSettingsService) private readonly fieldSettings?: FieldSettingsService,
  ) {}

  @Get('queue')
  async queue(@Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const take = parseLimit(limit);
    const [counts, events] = await Promise.all([
      this.database.inboundEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.database.inboundEvent.findMany({
        ...(status ? { where: { status } } : {}),
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take,
        select: {
          id: true, source: true, eventType: true, externalEntityId: true, externalEntityType: true,
          status: true, receivedAt: true, attempts: true, direction: true, lastSuccessfulAt: true,
          lastErrorCategory: true,
        },
      }),
    ]);
    const settingsByEvent = this.fieldSettings
      ? await this.fieldSettings.eventSettings(events.map((event) => event.id))
      : new Map<string, { version: number; transforms: string[] }>();
    return {
      counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
      events: events.map((event) => ({
        ...event,
        entityLabel: entityLabel(event.externalEntityType),
        fieldSettingsVersion: settingsByEvent.get(event.id)?.version ?? null,
        transforms: settingsByEvent.get(event.id)?.transforms ?? [],
      })),
      nextCursor: getNextCursor(events, take),
    };
  }

  @Get('incidents')
  async incidents(@Query('status') status?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (status && !['OPEN', 'RESOLVED'].includes(status)) throw new BadRequestException('status must be OPEN or RESOLVED');
    const take = parseLimit(limit);
    const cases = await this.database.manualReviewCase.findMany({
      ...(status ? { where: { status } } : {}),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, eventId: true, source: true, eventType: true, externalEntityId: true, externalEntityType: true, entityLabel: true, fieldTitle: true, previousValue: true, proposedValue: true, reason: true, diagnostic: true, status: true, openedAt: true, resolvedAt: true },
    });
    return { cases: cases.map((item) => ({ ...item, entityLabel: item.entityLabel ?? entityLabel(item.externalEntityType), diagnostic: safeAuditJson(item.diagnostic), previousValue: safeAuditJson(item.previousValue), proposedValue: safeAuditJson(item.proposedValue) })), nextCursor: getNextCursor(cases, take) };
  }

  @Patch('incidents/:incidentId/resolve')
  async resolveIncident(@Param('incidentId') incidentId: string, @Body() body: { confirmed?: unknown }, @Req() request: RequestWithHeaders) {
    if (body?.confirmed !== true) throw new BadRequestException('confirmed must be true');
    const actorId = await this.audit.resolveActorId(request);
    const before = await this.database.$transaction(async (transaction) => {
      const current = await transaction.manualReviewCase.findUnique({ where: { id: incidentId } });
      if (!current || current.status !== 'OPEN') throw new NotFoundException();
      const updated = await transaction.manualReviewCase.updateMany({
        where: { id: incidentId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
      if (updated.count !== 1) throw new NotFoundException();
      await createAdminAuditEntry(transaction, { actorId, action: 'MANUAL_REVIEW_RESOLVED', entityType: 'manual-review-case', entityId: incidentId, before: { status: current.status, reason: current.reason, previousValue: current.previousValue, proposedValue: current.proposedValue }, after: { status: 'RESOLVED' }, reason: current.reason });
      return current;
    });
    await writeOperationalLog(this.database, 'MANUAL', 'Manual-review case marked resolved', incidentId);
    return { id: incidentId, status: 'RESOLVED' };
  }

  @Post('incidents/:incidentId/retry')
  async retryIncident(@Param('incidentId') incidentId: string, @Req() request: RequestWithHeaders) {
    const actorId = await this.audit.resolveActorId(request);
    const { incident, event } = await this.database.$transaction(async (transaction) => {
      const currentIncident = await transaction.manualReviewCase.findUnique({ where: { id: incidentId } });
      if (!currentIncident || currentIncident.status !== 'OPEN') throw new NotFoundException();
      const currentEvent = await transaction.inboundEvent.findUnique({ where: { id: currentIncident.eventId } });
      if (!currentEvent) throw new ConflictException('The event history has expired; this incident cannot be retried.');
      if (!['MANUAL_REVIEW', 'RETRYABLE_FAILURE'].includes(currentEvent.status)) throw new ConflictException('The event is not waiting for retry.');
      await transaction.inboundEvent.update({
        where: { id: currentEvent.id },
        data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null },
      });
      await createAdminAuditEntry(transaction, { actorId, action: 'MANUAL_REVIEW_RETRY', entityType: currentIncident.externalEntityType ?? 'event', entityId: currentIncident.externalEntityId ?? currentEvent.id, before: { eventStatus: currentEvent.status, incidentStatus: currentIncident.status }, after: { eventStatus: 'RECEIVED', incidentStatus: currentIncident.status }, reason: currentIncident.reason });
      return { incident: currentIncident, event: currentEvent };
    });
    await writeOperationalLog(this.database, 'MANUAL', 'Manual-review event retry requested', incident.id);
    this.processor.enqueue(event.id);
    const settings = this.fieldSettings ? await this.fieldSettings.eventSettings([event.id]) : new Map();
    const eventSettings = settings.get(event.id);
    return {
      incidentId: incident.id, eventId: event.id, status: 'RECEIVED',
      fieldSettingsVersion: eventSettings?.version ?? null,
      transforms: eventSettings?.transforms ?? [],
    };
  }

  @Post('events/:eventId/recompute')
  async recomputeEvent(@Param('eventId') eventId: string, @Body() body: { confirmed?: unknown }, @Req() request: RequestWithHeaders) {
    if (body?.confirmed !== true) throw new BadRequestException('confirmed must be true');
    if (!this.fieldSettings) throw new ServiceUnavailableException('Field settings are not available');
    const actorId = await this.audit.resolveActorId(request);
    const fieldSettingsVersion = await this.database.$transaction(async (transaction) => {
      const before = await transaction.inboundEvent.findUnique({ where: { id: eventId }, select: { status: true, externalEntityType: true, externalEntityId: true } });
      if (!before) throw new NotFoundException();
      const version = await this.fieldSettings!.repinEvent(eventId, transaction);
      await createAdminAuditEntry(transaction, { actorId, action: 'EVENT_RECOMPUTE_REQUESTED', entityType: before.externalEntityType ?? 'event', entityId: before.externalEntityId ?? eventId, before: { status: before.status }, after: { status: 'RECEIVED', fieldSettingsVersion: version } });
      return version;
    });
    this.processor.enqueue(eventId);
    await writeOperationalLog(this.database, 'MANUAL', 'One event recompute requested with newer field settings', eventId);
    return { eventId, status: 'RECEIVED', fieldSettingsVersion };
  }

  @Get('logs')
  async logs(@Query('category') category?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (category && !LOG_CATEGORIES.includes(category as typeof LOG_CATEGORIES[number])) {
      throw new BadRequestException(`category must be one of ${LOG_CATEGORIES.join(', ')}`);
    }
    const take = parseLimit(limit);
    const entries = await this.database.operationalLog.findMany({
      ...(category ? { where: { category } } : {}),
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, category: true, message: true, referenceId: true, occurredAt: true },
    });
    return { entries, nextCursor: getNextCursor(entries, take) };
  }

  @Get('api-attempts')
  async apiAttempts(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const take = parseLimit(limit);
    const attempts = await this.database.apiAttempt.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: { id: true, eventId: true, provider: true, operation: true, method: true, statusCode: true, succeeded: true, occurredAt: true },
    });
    return { attempts, nextCursor: getNextCursor(attempts, take) };
  }
}

function parseLimit(value?: string): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException('limit must be a positive integer');
  return Math.min(parsed, 100);
}

function getNextCursor(rows: Array<{ id: string }>, take: number): string | null {
  return rows.length === take ? rows[rows.length - 1]?.id ?? null : null;
}

function entityLabel(value: string | null): string | null {
  if (!value) return null;
  const labels: Record<string, string> = {
    deal: 'Сделка', customerorder: 'Заказ покупателя', company: 'Компания', contact: 'Контакт',
    counterparty: 'Контрагент', contactperson: 'Контактное лицо', product: 'Товар', assortment: 'Товар или услуга', invoiceout: 'Счёт',
  };
  return labels[value.toLowerCase()] ?? value;
}
