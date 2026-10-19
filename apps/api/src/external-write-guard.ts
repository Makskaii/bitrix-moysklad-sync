let databaseRecoveryReady = true;
let controlledWriteCheck: ((provider: string, operation: string) => void) | null = null;

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
  if (process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') {
    if (!controlledWriteCheck) throw new Error('CONTROLLED_LIVE_TEST_POLICY_NOT_INITIALIZED');
    controlledWriteCheck(provider, operation);
  }
}

/** Installs the manifest-backed policy. Enabling test mode without this policy fails closed. */
export function setControlledLiveTestWriteCheck(check: ((provider: string, operation: string) => void) | null): void {
  controlledWriteCheck = check;
}
