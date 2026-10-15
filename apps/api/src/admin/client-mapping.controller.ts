import { BadRequestException, Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { ClientMappingService } from '../clients/client-mapping.service';

type RequestWithHeaders = { header(name: string): string | undefined };

@Controller('api/admin/client-mapping')
@UseGuards(AdminAccessGuard)
export class ClientMappingController {
  constructor(private readonly mapping: ClientMappingService) {}

  @Get()
  status() {
    return this.mapping.readStatus();
  }

  @Post('start')
  start(@Body() body: unknown, @Req() request: RequestWithHeaders) {
    const token = request.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token) throw new BadRequestException('Administrator access token is required');
    if (body !== null && body !== undefined && (typeof body !== 'object' || Array.isArray(body))) throw new BadRequestException('Request body must be an object');
    return this.mapping.start(token);
  }

  @Post('pause')
  pause() {
    return this.mapping.pause();
  }

  @Get('unmatched')
  unmatched(@Query('system') system?: string, @Query('entityType') entityType?: string, @Query('cursor') cursor?: string) {
    if (system !== undefined && system !== 'BITRIX24' && system !== 'MOYSKLAD') throw new BadRequestException('system must be BITRIX24 or MOYSKLAD');
    if (entityType !== undefined && entityType !== 'COMPANY' && entityType !== 'CONTACT') throw new BadRequestException('entityType must be COMPANY or CONTACT');
    return this.mapping.listUnmatched(system as 'BITRIX24' | 'MOYSKLAD' | undefined, entityType as 'COMPANY' | 'CONTACT' | undefined, cursor);
  }
}
