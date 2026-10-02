import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ServiceMode, SyncModeService } from '../sync-mode.service';
import { SyncRecoveryService } from '../sync-recovery.service';

@Controller('api/admin/sync-mode')
@UseGuards(AdminAccessGuard)
export class SyncModeController {
  constructor(private readonly syncMode: SyncModeService, private readonly recovery: SyncRecoveryService) {}

  @Get()
  read() {
    return this.syncMode.read();
  }

  @Patch()
  setMode(@Body() body: { mode?: unknown; confirmed?: unknown } | null) {
    if (body?.mode !== 'on' && body?.mode !== 'pause' && body?.mode !== 'off') {
      throw new BadRequestException('mode must be on, pause, or off');
    }
    if ((body.mode === 'on' || body.mode === 'off') && body.confirmed !== true) {
      throw new ConflictException('Explicit confirmation is required for On and Off transitions');
    }
    return this.syncMode.setMode(body.mode as ServiceMode).then((result) => {
      if (result.mode === 'on') void this.recovery.processPending();
      return result;
    });
  }

  @Get('recovery')
  readRecoveryStatus() {
    return this.recovery.readStatus();
  }

  @Get('entities')
  readEntitySettings() {
    return this.syncMode.readEntitySettings();
  }

  @Patch('entities/:entityKey')
  setEntityDirections(@Param('entityKey') entityKey: string, @Body() body: Record<string, unknown> | null) {
    if (typeof body?.bitrix24ToMoysklad !== 'boolean' || typeof body.moyskladToBitrix24 !== 'boolean') {
      throw new BadRequestException('Both direction values must be boolean');
    }
    return this.syncMode.setEntityDirections(entityKey, {
      bitrix24ToMoysklad: body.bitrix24ToMoysklad,
      moyskladToBitrix24: body.moyskladToBitrix24,
    });
  }

}
