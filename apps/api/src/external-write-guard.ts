export function assertApplyExternalWrite(provider: string, operation: string): void {
  if (process.env.SYNC_MODE === 'dry') {
    throw new Error(`${provider}_${operation}_WRITE_REQUIRES_APPLY_MODE`);
  }
}
