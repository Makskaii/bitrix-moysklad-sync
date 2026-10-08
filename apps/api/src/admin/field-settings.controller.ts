import { BadRequestException, Body, Controller, Get, Inject, Optional, Param, ParseIntPipe, Post, Put, Query, Req, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from './admin-access.guard';
import { FieldSettingsService } from '../field-settings/field-settings.service';

type RequestWithHeaders = { header(name: string): string | undefined };

@Controller('api/admin/field-settings')
@UseGuards(AdminAccessGuard)
export class FieldSettingsController {
  constructor(@Optional() @Inject(FieldSettingsService) private readonly settings?: FieldSettingsService) {}

  @Get()
  active() {
    return this.service().active();
  }

  @Get('catalogs')
  catalogs(@Req() request: RequestWithHeaders, @Query('kind') kind?: string, @Query('system') system?: string, @Query('cursor') cursor?: string) {
    if (kind || system || cursor) {
      if (!['units', 'priceTypes'].includes(String(kind)) || !['bitrix24', 'moysklad'].includes(String(system))) {
        throw new BadRequestException('kind and system must select a supported catalog page');
      }
      const offset = cursor === undefined ? 0 : Number(cursor);
      return this.service().catalogPage(accessToken(request), kind as 'units' | 'priceTypes', system as 'bitrix24' | 'moysklad', offset);
    }
    return this.service().catalogs(accessToken(request));
  }

  @Get('fields')
  fields(@Req() request: RequestWithHeaders, @Query('entity') entity?: string, @Query('pairId') pairId?: string) {
    return this.service().fieldCatalogs(accessToken(request), { entity, pairId });
  }

  @Get('versions/:version')
  version(@Param('version', ParseIntPipe) version: number) {
    return this.service().version(version);
  }

  @Put()
  save(@Body() body: { config?: unknown } | null, @Req() request: RequestWithHeaders) {
    return this.service().save(body?.config, accessToken(request));
  }

  @Post('preview')
  preview(@Body() body: unknown, @Req() request: RequestWithHeaders) {
    return this.service().preview(body, accessToken(request));
  }

  private service(): FieldSettingsService {
    if (!this.settings) throw new ServiceUnavailableException('Field settings are not available');
    return this.settings;
  }
}

function accessToken(request: RequestWithHeaders): string {
  const token = request.header('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token) throw new BadRequestException('Administrator access token is required');
  return token;
}
