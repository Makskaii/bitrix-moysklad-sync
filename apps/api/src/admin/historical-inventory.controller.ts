import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { HistoricalInventoryService } from '../historical-inventory.service';

@Controller('api/admin/historical-inventory')
@UseGuards(AdminAccessGuard)
export class HistoricalInventoryController {
  constructor(private readonly inventory: HistoricalInventoryService) {}

  @Get()
  status() {
    return this.inventory.readStatus();
  }

  @Post('start')
  start(@Body() body: { accessToken?: unknown; moyskladPageSize?: unknown; requestIntervalMs?: unknown } | null) {
    return this.inventory.start(body ?? {});
  }

  @Post('pause')
  pause() {
    return this.inventory.pause();
  }

  @Get('entries')
  entries(@Query('source') source?: string, @Query('cursor') cursor?: string) {
    if (source !== 'BITRIX24' && source !== 'MOYSKLAD') throw new BadRequestException('source must be BITRIX24 or MOYSKLAD');
    return this.inventory.listEntries(source, cursor);
  }
}
