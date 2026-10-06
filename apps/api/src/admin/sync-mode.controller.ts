import { BadRequestException, Body, ConflictException, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ServiceMode, SyncModeService } from '../sync-mode.service';
import { SyncRecoveryService } from '../sync-recovery.service';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';

@Controller('api/admin/sync-mode')
@UseGuards(AdminAccessGuard)
export class SyncModeController {
  constructor(
    private readonly syncMode: SyncModeService,
    private readonly recovery: SyncRecoveryService,
    private readonly database: DatabaseService,
  ) {}

  @Get()
  read() {
    return this.syncMode.read();
  }

  @Patch()
  setMode(@Body() body: { mode?: unknown; confirmed?: unknown } | null) {
    if (body?.mode !== 'on' && body?.mode !== 'pause' && body?.mode !== 'off') {
      throw new BadRequestException('mode must be on, pause, or off');
    }
    return this.syncMode.read().then((current) => {
      if (current.mode !== body.mode && body.confirmed !== true) {
        throw new ConflictException('Explicit confirmation is required for mode transitions');
      }
      return this.syncMode.setMode(body.mode as ServiceMode);
    }).then((result) => {
      void writeOperationalLog(this.database, 'ADMIN', `Service mode set to ${result.mode}`);
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
  async setEntityDirections(@Param('entityKey') entityKey: string, @Body() body: Record<string, unknown> | null) {
    if (typeof body?.bitrix24ToMoysklad !== 'boolean' || typeof body.moyskladToBitrix24 !== 'boolean') {
      throw new BadRequestException('Both direction values must be boolean');
    }
    const current = await this.syncMode.readEntitySettings();
    const entity = current.find((item) => item.key === entityKey);
    if (!entity) throw new ConflictException(`Unsupported or unavailable exchange entity: ${entityKey}`);
    const changed = entity.bitrix24ToMoysklad !== body.bitrix24ToMoysklad
      || entity.moyskladToBitrix24 !== body.moyskladToBitrix24;
    if (changed && body.confirmed !== true) {
      throw new ConflictException('Explicit confirmation is required for direction changes');
    }
    const result = await this.syncMode.setEntityDirections(entityKey, {
      bitrix24ToMoysklad: body.bitrix24ToMoysklad,
      moyskladToBitrix24: body.moyskladToBitrix24,
    });
    if (changed) await writeOperationalLog(this.database, 'ADMIN', `Directions updated for ${entityKey}`);
    return result;
  }

}
