import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Optional, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ServiceMode, SyncModeService } from '../sync-mode.service';
import { SyncRecoveryService } from '../sync-recovery.service';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { AdminAuditService, createAdminAuditEntry, RequestWithHeaders } from './admin-audit.service';

@Controller('api/admin/sync-mode')
@UseGuards(AdminAccessGuard)
export class SyncModeController {
  constructor(
    private readonly syncMode: SyncModeService,
    private readonly recovery: SyncRecoveryService,
    private readonly database: DatabaseService,
    @Optional() @Inject(AdminAuditService) private readonly audit?: AdminAuditService,
  ) {}

  @Get()
  read() {
    return this.syncMode.read();
  }

  @Patch()
  async setMode(@Body() body: { mode?: unknown; confirmed?: unknown } | null, @Req() request: RequestWithHeaders) {
    if (body?.mode !== 'on' && body?.mode !== 'pause' && body?.mode !== 'off') {
      throw new BadRequestException('mode must be on, pause, or off');
    }
    const actorId = this.audit ? await this.audit.resolveActorId(request) : null;
    const transition = await this.database.$transaction(async (transaction) => {
      const current = await this.syncMode.read(transaction);
      if (current.mode !== body.mode && body.confirmed !== true) throw new ConflictException('Explicit confirmation is required for mode transitions');
      const result = await this.syncMode.setMode(body.mode as ServiceMode, transaction);
      if (current.mode !== result.mode && this.audit && actorId) await createAdminAuditEntry(transaction, {
        actorId, action: 'SERVICE_MODE_CHANGED', entityType: 'service-mode', entityId: 'global',
        before: { mode: current.mode }, after: { mode: result.mode },
      });
      return { current, result };
    });
    const { current, result } = transition;
    if (current.mode !== result.mode) {
      await writeOperationalLog(this.database, 'ADMIN', `Service mode set to ${result.mode}`);
    }
    if (result.mode === 'on') void this.recovery.processPending();
    return result;
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
  async setEntityDirections(@Param('entityKey') entityKey: string, @Body() body: Record<string, unknown> | null, @Req() request: RequestWithHeaders) {
    if (typeof body?.bitrix24ToMoysklad !== 'boolean' || typeof body.moyskladToBitrix24 !== 'boolean') {
      throw new BadRequestException('Both direction values must be boolean');
    }
    const requestedDirections = {
      bitrix24ToMoysklad: body.bitrix24ToMoysklad,
      moyskladToBitrix24: body.moyskladToBitrix24,
    };
    const actorId = this.audit ? await this.audit.resolveActorId(request) : null;
    const transition = await this.database.$transaction(async (transaction) => {
      const current = await this.syncMode.readEntitySettings(transaction);
      const entity = current.find((item) => item.key === entityKey);
      if (!entity) throw new ConflictException(`Unsupported or unavailable exchange entity: ${entityKey}`);
      const changed = entity.bitrix24ToMoysklad !== requestedDirections.bitrix24ToMoysklad
        || entity.moyskladToBitrix24 !== requestedDirections.moyskladToBitrix24;
      if (changed && body.confirmed !== true) throw new ConflictException('Explicit confirmation is required for direction changes');
      const result = await this.syncMode.setEntityDirections(entityKey, {
        ...requestedDirections,
      }, transaction);
      if (changed && this.audit && actorId) await createAdminAuditEntry(transaction, {
        actorId, action: 'ENTITY_DIRECTIONS_CHANGED', entityType: 'sync-direction', entityId: entityKey,
        before: { bitrix24ToMoysklad: entity.bitrix24ToMoysklad, moyskladToBitrix24: entity.moyskladToBitrix24 },
        after: requestedDirections,
      });
      return { entity, changed, result };
    });
    if (transition.changed) {
      await writeOperationalLog(this.database, 'ADMIN', `Directions updated for ${entityKey}`);
    }
    return transition.result;
  }

}
