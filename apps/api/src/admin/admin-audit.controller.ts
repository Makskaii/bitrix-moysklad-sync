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
    const [queue, openCases, openPairReviews, activePairs, mode] = await Promise.all([
      this.database.inboundEvent.groupBy({ by: ['status'], _count: { _all: true } }),
      this.database.manualReviewCase.count({ where: { status: 'OPEN' } }),
      this.database.pairReviewCase.count({ where: { status: 'OPEN' } }),
      this.database.entityPair.count({ where: { active: true } }),
      this.database.syncSetting.findUnique({ where: { id: 'global' }, select: { serviceMode: true } }),
    ]);
    return {
      mode: mode?.serviceMode ?? 'off',
      queue: Object.fromEntries(queue.map((row) => [row.status, row._count._all])),
      openManualReviews: openCases,
      openPairReviews,
      activePairs,
    };
  }

  @Get('audit')
  async listAudit(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('actorId') actorId?: string,
    @Query('action') action?: string,
    @Query('targetType') targetType?: string,
  ) {
    const take = parseLimit(limit);
    const entries = await this.database.adminAuditEntry.findMany({
      where: {
        ...(actorId ? { actorId: boundedFilter(actorId, 'actorId') } : {}),
        ...(action ? { action: boundedFilter(action, 'action') } : {}),
        ...(targetType ? { targetType: boundedFilter(targetType, 'targetType') } : {}),
      },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
    });
    return { entries, nextCursor: entries.length === take ? entries.at(-1)?.id ?? null : null };
  }
}

function parseLimit(value?: string): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new BadRequestException('limit must be a positive integer');
  return Math.min(parsed, 100);
}

function boundedFilter(value: string, name: string): string {
  if (!value.trim() || value.length > 160) throw new BadRequestException(`${name} filter is invalid`);
  return value.trim();
}
