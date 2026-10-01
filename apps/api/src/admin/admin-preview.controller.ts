import { Controller, Get } from '@nestjs/common';

@Controller('api/admin')
export class AdminPreviewController {
  @Get('preview-mode')
  status() {
    return { enabled: true };
  }
}
