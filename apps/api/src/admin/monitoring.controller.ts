import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { ContactSyncProcessor } from '../contact-sync.service';

const LOG_CATEGORIES = ['EVENT', 'SCHEDULED', 'ERROR', 'ADMIN'] as const;

@Controller('api/admin/monitoring')
@UseGuards(AdminAccessGuard)
export class MonitoringController {
  constructor(private readonly database: DatabaseService, private readonly processor: ContactSyncProcessor) {}

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
    return {
      counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
      events,
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
      select: { id: true, eventId: true, source: true, eventType: true, externalEntityId: true, externalEntityType: true, reason: true, status: true, openedAt: true, resolvedAt: true },
    });
    return { cases, nextCursor: getNextCursor(cases, take) };
  }

  @Patch('incidents/:incidentId/resolve')
  async resolveIncident(@Param('incidentId') incidentId: string, @Body() body: { confirmed?: unknown }) {
    if (body?.confirmed !== true) throw new BadRequestException('confirmed must be true');
    const updated = await this.database.manualReviewCase.updateMany({
      where: { id: incidentId, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    if (updated.count !== 1) throw new NotFoundException();
    await writeOperationalLog(this.database, 'ADMIN', 'Manual-review case marked resolved', incidentId);
    return { id: incidentId, status: 'RESOLVED' };
  }

  @Post('incidents/:incidentId/retry')
  async retryIncident(@Param('incidentId') incidentId: string) {
    const incident = await this.database.manualReviewCase.findUnique({ where: { id: incidentId } });
    if (!incident || incident.status !== 'OPEN') throw new NotFoundException();
    const event = await this.database.inboundEvent.findUnique({ where: { id: incident.eventId } });
    if (!event) throw new ConflictException('The event history has expired; this incident cannot be retried.');
    if (!['MANUAL_REVIEW', 'RETRYABLE_FAILURE'].includes(event.status)) {
      throw new ConflictException('The event is not waiting for retry.');
    }
    await this.database.inboundEvent.update({
      where: { id: event.id },
      data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null },
    });
    await writeOperationalLog(this.database, 'ADMIN', 'Manual-review event retry requested', incident.id);
    this.processor.enqueue(event.id);
    return { incidentId: incident.id, eventId: event.id, status: 'RECEIVED' };
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
