import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { HistoricalDealOrderMatchingService } from '../historical-deal-order-matching.service';

@Controller('api/admin/historical-matching')
@UseGuards(AdminAccessGuard)
export class HistoricalDealOrderMatchingController {
  constructor(private readonly matching: HistoricalDealOrderMatchingService) {}

  @Get('status')
  status() {
    return this.matching.readStatus();
  }

  @Post('preview')
  preview() {
    return this.matching.startPreview();
  }

  @Get('results')
  results(@Query('runId') runId?: string, @Query('category') category?: string, @Query('cursor') cursor?: string) {
    if (runId !== undefined && runId.length > 200) throw new BadRequestException('runId is invalid');
    if (cursor !== undefined && cursor.length > 200) throw new BadRequestException('cursor is invalid');
    return this.matching.listResults({ runId, category, cursor });
  }

  @Post('apply')
  apply(@Body() body: { runId?: unknown; confirmed?: unknown } | null) {
    const runId = typeof body?.runId === 'string' ? body.runId.trim() : '';
    if (!runId || runId.length > 200) throw new BadRequestException('runId is required');
    return this.matching.applyPreview(runId, body?.confirmed === true);
  }
}
