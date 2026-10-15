export function assertConfiguredDatabaseTargets(): void {
  const mode = process.env.SYNC_MODE;
  if (mode !== 'apply' && mode !== 'dry') throw new Error('SYNC_MODE must be dry or apply');
  const selected = mode === 'dry' ? process.env.DRY_DATABASE_URL : process.env.DATABASE_URL;
  if (!selected) throw new Error(`${mode === 'dry' ? 'DRY_DATABASE_URL' : 'DATABASE_URL'} is required when SYNC_MODE=${mode}`);

  const apply = process.env.DATABASE_URL;
  const dry = process.env.DRY_DATABASE_URL;
  if (mode === 'dry' && !apply) throw new Error('DATABASE_URL is required to verify dry database isolation');
  if (apply && dry && databaseTarget(apply) === databaseTarget(dry)) {
    throw new Error('DATABASE_URL and DRY_DATABASE_URL must target different PostgreSQL databases or schemas');
  }
}

export function databaseTarget(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Database URL is invalid'); }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('Database URL must use PostgreSQL');
  const schema = url.searchParams.get('schema') ?? 'public';
  const host = url.hostname.toLowerCase();
  return JSON.stringify({
    host: host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ? '<loopback>' : host,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    schema,
  });
}
