import { Controller, Header, HttpCode, Post } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Bitrix opens local UI applications with POST, while the embedded UI obtains
 * user auth from BX24.init/getAuth in the parent frame. This route deliberately
 * ignores the posted auth payload and returns only the same public SPA shell as
 * GET /. Administrative APIs continue to enforce AdminAccessGuard.
 */
@Controller()
export class ApplicationLaunchController {
  @Post('/')
  @HttpCode(200)
  @Header('Content-Type', 'text/html; charset=utf-8')
  launch(): string {
    return readFileSync(resolve(__dirname, '../../../../apps/web/dist/index.html'), 'utf8');
  }
}
