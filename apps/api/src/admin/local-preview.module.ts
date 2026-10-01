import { Controller, DynamicModule, Get, Module, Provider } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminPreviewController } from './admin-preview.controller';
import { AdminAccessGuard, LOCAL_ADMIN_PREVIEW_ACCESS } from './admin-access.guard';
import { DatabaseService } from '../database.service';

@Module({})
export class LocalAdminPreviewModule {
  static register(databaseProvider: Provider = DatabaseService): DynamicModule {
    return {
      module: LocalAdminPreviewModule,
      controllers: [PreviewHealthController, AdminController, AdminPreviewController],
      providers: [
        databaseProvider,
        { provide: LOCAL_ADMIN_PREVIEW_ACCESS, useValue: true },
        AdminAccessGuard,
      ],
    };
  }
}

@Controller()
class PreviewHealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get('health')
  async health() {
    await this.database.$queryRaw`SELECT 1`;
    return { status: 'ok', database: 'ok' };
  }
}
