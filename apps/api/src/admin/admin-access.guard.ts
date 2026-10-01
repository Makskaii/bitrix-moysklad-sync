import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';

const bitrixAdminMethod = 'https://aerosystems.bitrix24.ru/rest/user.admin.json';
const checkTimeoutMs = 5_000;

type BitrixAdminResponse = { result: boolean };
export const LOCAL_ADMIN_PREVIEW_ACCESS = Symbol('LOCAL_ADMIN_PREVIEW_ACCESS');

export async function isBitrixAdministrator(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), checkTimeoutMs);
  try {
    const body = new URLSearchParams({ auth: accessToken });
    const response = await fetcher(bitrixAdminMethod, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload: unknown = await response.json();
    return isAdminResponse(payload) && payload.result === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function isAdminResponse(value: unknown): value is BitrixAdminResponse {
  return typeof value === 'object' && value !== null && 'result' in value &&
    typeof (value as { result?: unknown }).result === 'boolean';
}

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(
    @Optional() @Inject(LOCAL_ADMIN_PREVIEW_ACCESS) private readonly localPreviewAccess = false,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.localPreviewAccess) {
      if (process.env.ADMIN_PREVIEW === '1') return true;
      throw new ForbiddenException('Local admin preview is disabled');
    }
    const request = context.switchToHttp().getRequest<{ header(name: string): string | undefined }>();
    const authorization = request.header('authorization');
    const accessToken = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!accessToken || accessToken.length > 4096) throw new ForbiddenException('Administrator access required');
    if (!await isBitrixAdministrator(accessToken)) throw new ForbiddenException('Administrator access required');
    return true;
  }
}
