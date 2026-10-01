import { Controller, Get } from '@nestjs/common';
import { isLocalAdminPreviewEnabled } from './admin-access.guard';

@Controller('api/admin')
export class AdminPreviewController {
  @Get('preview-mode')
  status() {
    return { enabled: isLocalAdminPreviewEnabled() };
  }
}
