import { BadRequestException, Body, Controller, Get, Inject, Optional, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { AssignEntityPairInput, EntityPairService } from '../pairs/entity-pair.service';
import { EntityType, isEntityType } from '../pairs/pair-resolver';
import { AdminAuditService, RequestWithHeaders } from './admin-audit.service';

@Controller('api/admin/pairs')
@UseGuards(AdminAccessGuard)
export class PairResolutionController {
  constructor(
    private readonly pairs: EntityPairService,
    @Optional() @Inject(AdminAuditService) private readonly audit?: AdminAuditService,
  ) {}

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
    if (!body || typeof body !== 'object') return this.pairs.assign({} as AssignEntityPairInput);
    const actorId = this.audit ? await this.audit.resolveActorId(request) : null;
    return this.pairs.assign(body, actorId ?? undefined);
  }
}
