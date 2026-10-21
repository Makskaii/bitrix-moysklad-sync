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

export async function readBitrixAdministratorIdentity(accessToken: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), checkTimeoutMs);
  try {
    const body = new URLSearchParams({ auth: accessToken });
    // profile is a base-scope method; user.current requires the separate user scope,
    // which a valid local-app admin token need not have. Never substitute a server identity.
    const response = await fetcher(bitrixAdminMethod.replace('user.admin.json', 'profile.json'), {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !isRecord(payload.result)) return null;
    if (payload.result.ADMIN === false) return null;
    const id = payload.result.ID ?? payload.result.id;
    return (typeof id === 'string' && /^\d{1,20}$/.test(id)) || (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      ? `BITRIX24_USER:${String(id)}`
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isAdminResponse(value: unknown): value is BitrixAdminResponse {
  return typeof value === 'object' && value !== null && 'result' in value &&
    typeof (value as { result?: unknown }).result === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
