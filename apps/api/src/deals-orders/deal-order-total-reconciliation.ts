/**
 * Q26.37/Q26.51 document-total reconciliation. This handler owns no pair lock:
 * callers invoke it inside the existing deal/order lease, after complete row
 * reconciliation, so header, row, and total work cannot deadlock each other.
 * The adapter may journal writes in dry mode; this module never writes MS sum.
 */

export type DealOrderTotalSnapshot = {
  bitrix24: { amount: unknown; currencyCode: unknown };
  moysklad: { amount: unknown; currencyCode: unknown };
};

export type DealOrderTotalState = {
  settingsVersion: number;
  bitrix24: DealOrderTotalSnapshot['bitrix24'];
  moysklad: DealOrderTotalSnapshot['moysklad'];
};

export type DealOrderTotalResult =
  | { status: 'SYNCED'; state: DealOrderTotalState; conflict: false; reason: null }
  | { status: 'SYNCED'; state: DealOrderTotalState; conflict: true; reason: 'B24_TOTAL_RESTORED_FROM_MOYSKLAD' | 'B24_ONE_KOPECK_RETAINED' }
  | { status: 'MANUAL_REVIEW'; reason: string }
  | { status: 'RETRY'; reason: string };

export type DealOrderTotalAdapter = {
  /** Must read both live documents and normalize currencies to ISO 4217 codes. */
  readCurrent(): Promise<DealOrderTotalSnapshot>;
  /** Only the writable B24 OPPORTUNITY field. MySklad customerorder.sum is read-only. */
  writeBitrix24Opportunity(amount: unknown): Promise<void>;
  /** Readback is required after a real or journaled write. */
  persistState(state: DealOrderTotalState): Promise<void>;
  /** Keep raw values in event history even when the one-kopeck rule suppresses a conflict. */
  recordHistory(input: { eventId: string; pairId: string; outcome: string; raw: DealOrderTotalSnapshot }): Promise<void>;
};

export class DealOrderTotalReconciliationHandler {
  async process(input: {
    pairId: string;
    eventId: string;
    eventSource: 'BITRIX24' | 'MOYSKLAD';
    /** Immutable settings version attached to this event; total policy is Q26.37/.51, not a user toggle. */
    pinnedConfig: { version: number };
    bitrix24Current: DealOrderTotalSnapshot['bitrix24'];
    moyskladCurrent: DealOrderTotalSnapshot['moysklad'];
    priorBaseline: DealOrderTotalState | null;
    completeRows: boolean;
    /** True when any live row quantity, unit price, discount, tax, or identity changed this event. */
    rowValuesChanged?: boolean;
    adapter: DealOrderTotalAdapter;
    assertLease: () => Promise<boolean>;
  }): Promise<DealOrderTotalResult> {
    if (!input.completeRows) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_ROWS_INCOMPLETE' };
    if (!input.priorBaseline) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_BASELINE_MISSING' };
    if (input.priorBaseline.settingsVersion !== input.pinnedConfig.version) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_SETTINGS_VERSION_MISMATCH' };

    const current: DealOrderTotalSnapshot = {
      bitrix24: input.bitrix24Current,
      moysklad: input.moyskladCurrent,
    };
    const b24Minor = parseMinorUnits(current.bitrix24.amount);
    const msMinor = parseMinorUnits(current.moysklad.amount);
    const priorB24Minor = parseMinorUnits(input.priorBaseline.bitrix24.amount);
    const priorMsMinor = parseMinorUnits(input.priorBaseline.moysklad.amount);
    const b24Currency = currency(current.bitrix24.currencyCode);
    const msCurrency = currency(current.moysklad.currencyCode);
    const priorB24Currency = currency(input.priorBaseline.bitrix24.currencyCode);
    const priorMsCurrency = currency(input.priorBaseline.moysklad.currencyCode);
    if ([b24Minor, msMinor, priorB24Minor, priorMsMinor].some((value) => value === null)) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_AMOUNT_INVALID' };
    if (!b24Currency || !msCurrency || !priorB24Currency || !priorMsCurrency) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_CURRENCY_UNSET_OR_UNSUPPORTED' };
    if (b24Currency !== msCurrency || priorB24Currency !== b24Currency || priorMsCurrency !== msCurrency) return { status: 'MANUAL_REVIEW', reason: 'DEAL_ORDER_TOTAL_CURRENCY_MISMATCH' };

    const b24Changed = b24Minor !== priorB24Minor || b24Currency !== priorB24Currency;
    const msChanged = msMinor !== priorMsMinor || msCurrency !== priorMsCurrency;
    let outcome = 'TOTALS_MATCH_OR_UNCHANGED';
    let retainedB24 = false;
    if (b24Minor !== msMinor) {
      // The exception is specific to a B24-origin change, RUB totals, and at
      // most one minor unit. A simultaneous change remains an MS-wins conflict.
      if (input.eventSource === 'BITRIX24' && !input.rowValuesChanged && b24Changed && !msChanged && b24Currency === 'RUB' && abs(b24Minor! - msMinor!) <= 1n) {
        retainedB24 = true;
        outcome = 'B24_ONE_KOPECK_RETAINED';
      } else {
        outcome = 'B24_TOTAL_RESTORED_FROM_MOYSKLAD';
      }
    }

    let final = current;
    if (outcome === 'B24_TOTAL_RESTORED_FROM_MOYSKLAD') {
      try {
        const latest = await input.adapter.readCurrent();
        if (!sameSnapshot(latest, current)) return { status: 'RETRY', reason: 'DEAL_ORDER_TOTAL_CHANGED_BEFORE_WRITE' };
        if (!await input.assertLease()) return { status: 'RETRY', reason: 'DEAL_ORDER_PAIR_LOCK_LOST' };
        await input.adapter.writeBitrix24Opportunity(current.moysklad.amount);
        final = await input.adapter.readCurrent();
        const finalB24 = parseMinorUnits(final.bitrix24.amount);
        const finalMs = parseMinorUnits(final.moysklad.amount);
        if (finalB24 === null || finalMs === null || finalB24 !== finalMs || currency(final.bitrix24.currencyCode) !== b24Currency || currency(final.moysklad.currencyCode) !== msCurrency) {
          return { status: 'RETRY', reason: 'DEAL_ORDER_TOTAL_READBACK_MISMATCH' };
        }
      } catch (error) {
        if (error instanceof Error && /^DEAL_ORDER_WRITE_BLOCKED_/.test(error.message)) return { status: 'RETRY', reason: error.message };
        return { status: 'RETRY', reason: 'DEAL_ORDER_TOTAL_PROVIDER_FAILURE' };
      }
    }

    const state: DealOrderTotalState = {
      settingsVersion: input.pinnedConfig.version,
      bitrix24: final.bitrix24,
      moysklad: final.moysklad,
    };
    try {
      await input.adapter.persistState(state);
      await input.adapter.recordHistory({ eventId: input.eventId, pairId: input.pairId, outcome, raw: current });
    } catch {
      return { status: 'RETRY', reason: 'DEAL_ORDER_TOTAL_STATE_SAVE_FAILED' };
    }
    return {
      status: 'SYNCED', state, conflict: outcome === 'B24_TOTAL_RESTORED_FROM_MOYSKLAD',
      reason: retainedB24 ? 'B24_ONE_KOPECK_RETAINED' : outcome === 'B24_TOTAL_RESTORED_FROM_MOYSKLAD' ? 'B24_TOTAL_RESTORED_FROM_MOYSKLAD' : null,
    } as DealOrderTotalResult;
  }
}

/** Parses decimal major units without floating point comparison or rounding. */
export function parseMinorUnits(value: unknown): bigint | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(raw);
  if (!match) return null;
  return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
}

function currency(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
}

function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function sameSnapshot(a: DealOrderTotalSnapshot, b: DealOrderTotalSnapshot): boolean {
  return a.bitrix24.amount === b.bitrix24.amount && a.bitrix24.currencyCode === b.bitrix24.currencyCode &&
    a.moysklad.amount === b.moysklad.amount && a.moysklad.currencyCode === b.moysklad.currencyCode;
}
