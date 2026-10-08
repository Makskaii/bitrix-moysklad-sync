import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { AssignEntityPairInput, EntityPairService } from '../pairs/entity-pair.service';
import { EntityType, isEntityType } from '../pairs/pair-resolver';

@Controller('api/admin/pairs')
@UseGuards(AdminAccessGuard)
export class PairResolutionController {
  constructor(private readonly pairs: EntityPairService) {}

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
  assign(@Body() body: AssignEntityPairInput | null) {
    if (!body || typeof body !== 'object') return this.pairs.assign({} as AssignEntityPairInput);
    return this.pairs.assign(body);
  }
}
