import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AdminAccessGuard, readBitrixAdministratorIdentity } from './admin-access.guard';
import { ClientLifecycleService } from '../clients/client-lifecycle.service';

@Controller('api/admin/clients/lifecycle')
@UseGuards(AdminAccessGuard)
export class ClientLifecycleController {
  constructor(private readonly lifecycle: ClientLifecycleService) {}

  @Get()
  list() { return this.lifecycle.listTombstones(); }

  @Get('marker-fields')
  markerFields() { return this.lifecycle.deletionMarkerFields(); }

  @Put('marker-fields')
  saveMarkerFields(@Body() body: unknown) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('fields' in body)) {
      throw new BadRequestException('An explicit fields object is required');
    }
    return this.lifecycle.saveDeletionMarkerFields((body as { fields?: unknown }).fields);
  }

  @Post(':pairId/restore')
  async restore(@Param('pairId') pairId: string, @Body() body: unknown, @Headers('authorization') authorization?: string) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('confirmed' in body)) {
      throw new BadRequestException('An explicit confirmed flag is required');
    }
    const token = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const actorId = token && token.length <= 4096 ? await readBitrixAdministratorIdentity(token) : null;
    if (!actorId) throw new ForbiddenException('Administrator identity could not be verified');
    return this.lifecycle.restore(pairId, (body as { confirmed?: unknown }).confirmed as boolean, actorId);
  }
}
