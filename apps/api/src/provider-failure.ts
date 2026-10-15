/** Normalized HTTP/network failure used by the wired entity processors. */
export class ProviderFailure extends Error {
  constructor(
    readonly provider: 'BITRIX24' | 'MOYSKLAD',
    readonly status: number | null,
    readonly retryAfterAt: Date | null = null,
  ) {
    super(`${provider}_API_FAILURE`);
    this.name = 'ProviderFailure';
  }

  get retryable(): boolean {
    return this.status === null || this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

/** Parse both legal Retry-After forms, clamped to a one hour scheduling horizon. */
export function retryAfterAt(value: string | null, now = Date.now()): Date | null {
  if (!value?.trim()) return null;
  const text = value.trim();
  let requested: number;
  if (/^\d+(?:\.\d+)?$/.test(text)) requested = now + Number(text) * 1000;
  else requested = Date.parse(text);
  if (!Number.isFinite(requested)) return null;
  return new Date(Math.min(Math.max(now, requested), now + 60 * 60 * 1000));
}

export function providerResponseFailure(provider: 'BITRIX24' | 'MOYSKLAD', status: number, retryAfter: string | null): ProviderFailure {
  return new ProviderFailure(provider, status, retryAfterAt(retryAfter));
}

export function isRetryableFailure(error: unknown): boolean {
  return !(error instanceof ProviderFailure) || error.retryable;
}

export function retryAtForFailure(error: unknown, attempt: number, now = Date.now()): Date {
  if (error instanceof ProviderFailure && error.retryable && error.retryAfterAt) return error.retryAfterAt;
  const delay = Math.min(5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8), 15 * 60_000);
  return new Date(now + delay);
}
