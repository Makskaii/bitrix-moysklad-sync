import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminAuditService } from './admin-audit.service';
import { DatabaseService } from '../database.service';

@Controller('api/admin')
@UseGuards(AdminAccessGuard)
export class AdminAuditController {
  constructor(private readonly database: DatabaseService, private readonly audit: AdminAuditService) {}

  @Get('overview')
  async overview() {
    const [queue, openManualReviews, openPairReviews, activePairs, mode, latestEvent] = await Promise.all([
      this.database.inboundEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.database.manualReviewCase.count({ where: { status: 'OPEN' } }),
      this.database.pairReviewCase.count({ where: { status: 'OPEN' } }),
      this.database.entityPair.count({ where: { active: true } }),
      this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } }),
      this.database.inboundEvent.findFirst({ orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], select: { receivedAt: true } }),
    ]);
    return {
      mode: mode?.serviceMode ?? 'off',
      queue: Object.fromEntries(queue.map((row) => [row.status, row._count._all])),
      openManualReviews, openPairReviews, activePairs,
      lastEventAt: latestEvent?.receivedAt ?? null,
    };
  }

  @Get('audit')
  async listAudit(@Query('limit') limit?: string, @Query('cursor') cursor?: string, @Query('actorId') actorId?: string, @Query('action') action?: string, @Query('targetType') targetType?: string) {
    const take = parseLimit(limit);
    return this.audit.list({ limit: take, cursor, actorId: boundedFilter(actorId, 'actorId'), action: boundedFilter(action, 'action'), targetType: boundedFilter(targetType, 'targetType') });
  }
}

function parseLimit(value?: string): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException('limit must be a positive integer');
  return Math.min(parsed, 100);
}

function boundedFilter(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value.trim() || value.length > 160) throw new BadRequestException(`${name} filter is invalid`);
  return value.trim();
}
