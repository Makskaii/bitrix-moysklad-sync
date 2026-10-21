import { isIP } from 'node:net';

export function resolveApiBindHost(configuredHost: string | undefined): string {
  const host = configuredHost ?? '0.0.0.0';
  if (isIP(host) === 0) {
    throw new Error('API_BIND_HOST must be an IPv4 or IPv6 address');
  }
  return host;
}
