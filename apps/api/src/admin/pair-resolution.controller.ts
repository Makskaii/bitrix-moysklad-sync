import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { AdminAuditService, RequestWithHeaders } from './admin-audit.service';
import { AssignEntityPairInput, EntityPairService } from '../pairs/entity-pair.service';
import { EntityType, isEntityType } from '../pairs/pair-resolver';

@Controller('api/admin/pairs')
@UseGuards(AdminAccessGuard)
export class PairResolutionController {
  constructor(private readonly pairs: EntityPairService, private readonly audit: AdminAuditService) {}

  @Get()
  list(@Query('entityType') entityType?: string) {
    if (entityType !== undefined && !isEntityType(entityType)) throw new BadRequestException('entityType is unsupported');
    return this.pairs.listActive(entityType as EntityType | undefined);
  }

  @Get('reviews')
  reviews() {
    return this.pairs.listOpenReviews();
  }

  @Post()
  async assign(@Body() body: AssignEntityPairInput | null, @Req() request: RequestWithHeaders) {
    const actorId = await this.audit.resolveActorId(request);
    if (!body || typeof body !== 'object') return this.pairs.assign({} as AssignEntityPairInput, actorId);
    return this.pairs.assign(body, actorId);
  }
}
