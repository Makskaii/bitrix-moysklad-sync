import { DatabaseService } from './database.service';

export type OperationalLogCategory = 'EVENT' | 'SCHEDULED' | 'ERROR' | 'ADMIN';

export async function writeOperationalLog(
  database: DatabaseService,
  category: OperationalLogCategory,
  message: string,
  referenceId?: string | null,
) {
  try {
    await database.operationalLog.create({ data: { category, message, referenceId: referenceId ?? null } });
  } catch {
    // An auxiliary log write must not undo an accepted event or a completed operation.
  }
}
