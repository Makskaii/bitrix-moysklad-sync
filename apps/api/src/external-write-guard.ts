let databaseRecoveryReady = true;

/** Closed by bootstrap before the server starts accepting requests. */
export function setDatabaseRecoveryReady(ready: boolean): void {
  databaseRecoveryReady = ready;
}

export function assertApplyExternalWrite(provider: string, operation: string): void {
  if (process.env.SYNC_MODE === 'dry') {
    throw new Error(`${provider}_${operation}_WRITE_REQUIRES_APPLY_MODE`);
  }
  if (process.env.SYNC_MODE === 'apply' && !databaseRecoveryReady) {
    throw new Error(`${provider}_${operation}_BLOCKED_DATABASE_RECOVERY_REQUIRED`);
  }
}
