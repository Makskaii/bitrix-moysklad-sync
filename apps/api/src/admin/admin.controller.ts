import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TrialAction } from '@prisma/client';
import { AdminAccessGuard } from './admin-access.guard';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';

@Controller('api/admin')
@UseGuards(AdminAccessGuard)
export class AdminController {
  constructor(private readonly database: DatabaseService) {}

  @Get('trial-actions')
  list(): Promise<TrialAction[]> {
    return this.database.trialAction.findMany({ orderBy: { createdAt: 'desc' } });
  }

  @Post('trial-actions')
  create(@Body() body: { message?: unknown } | null): Promise<TrialAction> {
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    if (!message || message.length > 200) {
      throw new BadRequestException('message must contain between 1 and 200 characters');
    }
    return this.database.trialAction.create({ data: { message } }).then((action) => {
      void writeOperationalLog(this.database, 'ADMIN', 'Trial action added', action.id);
      return action;
    });
  }
}
