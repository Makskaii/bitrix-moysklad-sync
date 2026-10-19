import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Optional, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ServiceMode, SyncModeService } from '../sync-mode.service';
import { SyncModeDirection } from '../sync-mode-preflight';
import { SyncRecoveryService } from '../sync-recovery.service';
import { DatabaseService } from '../database.service';
import { writeOperationalLog } from '../monitoring-log';
import { DatabaseRecoveryService } from '../database-recovery.service';
import { readBitrixAdministratorIdentity } from './admin-access.guard';

@Controller('api/admin/sync-mode')
@UseGuards(AdminAccessGuard)
export class SyncModeController {
  constructor(
    private readonly syncMode: SyncModeService,
    private readonly recovery: SyncRecoveryService,
    private readonly database: DatabaseService,
    @Optional() private readonly databaseRecovery?: DatabaseRecoveryService,
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
    return this.syncMode.read().then(async (current) => {
      if (current.mode !== body.mode && body.confirmed !== true) {
        throw new ConflictException('Explicit confirmation is required for mode transitions');
      }
      if (body.mode === 'on' && this.databaseRecovery && !await this.databaseRecovery.assertReady()) {
        throw new ConflictException('Database loss recovery must be explicitly confirmed before Apply can be enabled');
      }
      return this.syncMode.setMode(body.mode as ServiceMode);
    }).then((result) => {
      void writeOperationalLog(this.database, 'ADMIN', `Service mode set to ${result.mode}`);
      return result;
    });
  }

  @Get('database-recovery')
  readDatabaseRecoveryStatus() {
    if (!this.databaseRecovery) throw new ConflictException('Database recovery service is unavailable');
    return this.databaseRecovery.readStatus();
  }

  @Post('database-recovery/confirm')
  async confirmDatabaseRecovery(
    @Body() body: Record<string, unknown> | null,
    @Req() request: { header(name: string): string | undefined },
  ) {
    if (!body) throw new BadRequestException('Recovery confirmation is required');
    if (!this.databaseRecovery) throw new ConflictException('Database recovery service is unavailable');
    const token = request.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const actorId = token ? await readBitrixAdministratorIdentity(token) : null;
    if (!actorId) throw new ForbiddenException('Administrator identity could not be verified');
    const result = await this.databaseRecovery.confirmRecovery(body, actorId);
    await writeOperationalLog(this.database, 'ADMIN', 'Database loss recovery acknowledged; service remains Off');
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

  @Get('entities/:entityKey/preflight')
  preflightEntityDirection(
    @Param('entityKey') entityKey: string,
    @Query('direction') direction: string,
    @Req() request: { header(name: string): string | undefined },
  ) {
    if (direction !== 'bitrix24ToMoysklad' && direction !== 'moyskladToBitrix24') {
      throw new BadRequestException('direction must be bitrix24ToMoysklad or moyskladToBitrix24');
    }
    const token = request.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '';
    return this.syncMode.preflightEntityDirection(entityKey, direction as SyncModeDirection, token);
  }

  @Patch('entities/:entityKey')
  async setEntityDirections(
    @Param('entityKey') entityKey: string,
    @Body() body: Record<string, unknown> | null,
    @Req() request: { header(name: string): string | undefined },
  ) {
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
    }, request.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1] ?? '');
    if (changed) await writeOperationalLog(this.database, 'ADMIN', `Directions updated for ${entityKey}`);
    return result;
  }

}
