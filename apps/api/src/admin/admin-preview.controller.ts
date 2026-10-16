import { Controller, Get, Inject } from '@nestjs/common';
import { LOCAL_ADMIN_PREVIEW_ACCESS } from './admin-access.guard';

@Controller('api/admin')
export class AdminPreviewController {
  constructor(@Inject(LOCAL_ADMIN_PREVIEW_ACCESS) private readonly localPreviewAccess: boolean) {}

  @Get('preview-mode')
  status() {
    return { enabled: this.localPreviewAccess };
  }
}
