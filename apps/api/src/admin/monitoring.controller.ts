import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Optional, Param, Patch, Post, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminAuditService, RequestWithHeaders } from './admin-audit.service';
import { manualReviewDetails, sanitizeReviewDiagnostic } from './manual-review-details';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { ContactSyncProcessor } from '../contact-sync.service';
import { FieldSettingsService } from '../field-settings/field-settings.service';

const LOG_CATEGORIES = ['EVENT', 'SCHEDULED', 'ERROR', 'ADMIN', 'EVENTS', 'CRON_SYSTEM', 'MANUAL'] as const;
const LOG_CATEGORY_GROUPS: Record<string, string[]> = {
  EVENTS: ['EVENT', 'CLIENT_SYNC', 'CLIENT_DEPENDENCY', 'CLIENT_RUNTIME'],
  CRON_SYSTEM: ['SCHEDULED', 'ERROR'],
  MANUAL: ['ADMIN'],
};

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
          lastErrorCategory: true, retryAfter: true,
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
      select: { id: true, eventId: true, source: true, eventType: true, externalEntityId: true, externalEntityType: true, reason: true, diagnostic: true, entityLabel: true, fieldTitle: true, previousValue: true, proposedValue: true, status: true, openedAt: true, resolvedAt: true },
    });
    return { cases: cases.map((item) => ({ ...item, diagnostic: sanitizeReviewDiagnostic(item.diagnostic), ...manualReviewDetails(item.diagnostic),
      entityLabel: item.entityLabel ?? manualReviewDetails(item.diagnostic).entityLabel ?? null,
      fieldTitle: item.fieldTitle ?? manualReviewDetails(item.diagnostic).fieldTitle ?? null,
      previousValue: item.previousValue ?? manualReviewDetails(item.diagnostic).previousValue ?? null,
      proposedValue: item.proposedValue ?? manualReviewDetails(item.diagnostic).proposedValue ?? null,
    })), nextCursor: getNextCursor(cases, take) };
  }

  @Patch('incidents/:incidentId/resolve')
  async resolveIncident(@Param('incidentId') incidentId: string, @Body() body: { confirmed?: unknown }, @Req() request: RequestWithHeaders) {
    if (body?.confirmed !== true) throw new BadRequestException('confirmed must be true');
    const actorId = await this.audit.resolveActorId(request);
    const result = await this.database.$transaction(async (transaction) => {
      const before = await transaction.manualReviewCase.findUnique({ where: { id: incidentId } });
      if (!before || before.status !== 'OPEN') return { count: 0 };
      const resolvedAt = new Date();
      const updated = await transaction.manualReviewCase.updateMany({
        where: { id: incidentId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt },
      });
      if (updated.count === 1) await this.audit.record(transaction, {
        actorId, action: 'MANUAL_REVIEW_RESOLVED', targetType: 'ManualReviewCase', targetId: incidentId,
        reason: before.reason, before: { status: before.status }, after: { status: 'RESOLVED', resolvedAt },
      });
      return updated;
    });
    if (result.count !== 1) throw new NotFoundException();
    await writeOperationalLog(this.database, 'ADMIN', 'Manual-review case marked resolved', incidentId);
    return { id: incidentId, status: 'RESOLVED' };
  }

  @Post('incidents/:incidentId/retry')
  async retryIncident(@Param('incidentId') incidentId: string, @Req() request: RequestWithHeaders) {
    const incident = await this.database.manualReviewCase.findUnique({ where: { id: incidentId } });
    if (!incident || incident.status !== 'OPEN') throw new NotFoundException();
    const event = await this.database.inboundEvent.findUnique({ where: { id: incident.eventId } });
    if (!event) throw new ConflictException('The event history has expired; this incident cannot be retried.');
    if (!['MANUAL_REVIEW', 'RETRYABLE_FAILURE'].includes(event.status)) {
      throw new ConflictException('The event is not waiting for retry.');
    }
    const actorId = await this.audit.resolveActorId(request);
    await this.database.$transaction(async (transaction) => {
      const updated = await transaction.inboundEvent.updateMany({
        where: { id: event.id, status: { in: ['MANUAL_REVIEW', 'RETRYABLE_FAILURE'] } },
        data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null },
      });
      if (updated.count !== 1) throw new ConflictException('The event is no longer waiting for retry.');
      await this.audit.record(transaction, {
        actorId, action: 'MANUAL_REVIEW_RETRY_REQUESTED', targetType: 'ManualReviewCase', targetId: incident.id,
        reason: incident.reason, before: { eventStatus: event.status, attempts: event.attempts }, after: { eventStatus: 'RECEIVED' },
      });
    });
    await writeOperationalLog(this.database, 'ADMIN', 'Manual-review event retry requested', incident.id);
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
    const fieldSettingsVersion = await this.fieldSettings.repinEvent(eventId);
    this.processor.enqueue(eventId);
    await this.database.$transaction((transaction) => this.audit.record(transaction, {
      actorId, action: 'EVENT_RECOMPUTE_REQUESTED', targetType: 'InboundEvent', targetId: eventId,
      after: { settingsVersion: fieldSettingsVersion },
    }));
    await writeOperationalLog(this.database, 'ADMIN', 'One event recompute requested with newer field settings', eventId);
    return { eventId, status: 'RECEIVED', fieldSettingsVersion };
  }

  @Get('logs')
  async logs(@Query('category') category?: string, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    if (category && !LOG_CATEGORIES.includes(category as typeof LOG_CATEGORIES[number])) {
      throw new BadRequestException(`category must be one of ${LOG_CATEGORIES.join(', ')}`);
    }
    const take = parseLimit(limit);
    const categories = category ? LOG_CATEGORY_GROUPS[category] : undefined;
    const entries = await this.database.operationalLog.findMany({
      ...(category ? { where: categories ? { category: { in: categories } } : { category } } : {}),
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
