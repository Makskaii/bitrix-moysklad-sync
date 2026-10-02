import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from './database.service';

type JsonRecord = Record<string, unknown>;
const PROCESSING_LEASE_MS = 60_000;
const EXTERNAL_REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class ContactSyncProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap() {
    void this.resumeReceivedContactEvents();
    this.recoveryTimer = setInterval(() => { void this.resumeReceivedContactEvents(); }, 1_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  enqueue(eventId: string) {
    if (!isApplyEnabled()) return;
    setImmediate(() => { void this.process(eventId); });
  }

  private async resumeReceivedContactEvents() {
    if (!isApplyEnabled()) return;
    try {
      const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
      const pending = await this.database.inboundEvent.findMany({
        where: {
          AND: [
            { OR: [
              { source: 'BITRIX24', eventType: { startsWith: 'ONCRMCONTACT' } },
              { source: 'MOYSKLAD', eventType: 'UPDATE', externalEntityType: 'counterparty' },
            ] },
            { OR: [
              { status: { in: ['RECEIVED', 'RETRYABLE_FAILURE'] } },
              { status: 'PROCESSING', OR: [
                { processingStartedAt: null },
                { processingStartedAt: { lt: staleBefore } },
              ] },
            ] },
          ],
        },
        select: { id: true },
      });
      for (const event of pending) this.enqueue(event.id);
    } catch {
      // A later event delivery can enqueue pending work again; do not block app startup.
    }
  }

  async process(eventId: string) {
    if (this.active.has(eventId)) return;
    this.active.add(eventId);
    try {
      const candidate = await this.database.inboundEvent.findUnique({ where: { id: eventId } });
      if (!candidate) return;
      if (!isContactEmailEvent(candidate.source, candidate.eventType, candidate.externalEntityType)) return;
      const now = new Date();
      const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
      const claim = await this.database.inboundEvent.updateMany({
        where: {
          id: eventId,
          OR: [
            { status: { in: ['RECEIVED', 'RETRYABLE_FAILURE'] } },
            { status: 'PROCESSING', processingStartedAt: null },
            { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
          ],
        },
        data: {
          status: 'PROCESSING',
          processingStartedAt: now,
          attempts: { increment: 1 },
          lastErrorCategory: null,
        },
      });
      if (claim.count !== 1) return;
      const event = await this.database.inboundEvent.findUnique({ where: { id: eventId } });
      if (!event) return;
      const attempt = event.attempts;

      try {
        await this.syncContactEmail(event, attempt);
      } catch (error) {
        const category = errorCategory(error);
        await this.database.inboundEvent.update({
          where: { id: eventId },
          data: {
            status: category === 'REVIEW_REQUIRED' ? 'MANUAL_REVIEW' : 'RETRYABLE_FAILURE',
            lastErrorCategory: category,
          },
        });
      }
    } finally {
      this.active.delete(eventId);
    }
  }

  private async syncContactEmail(
    event: { id: string; source: string; externalEntityId: string | null },
    attempt: number,
  ) {
    const sourceEntityId = event.externalEntityId;
    if (!sourceEntityId) throw new Error('REVIEW_REQUIRED');
    const pair = await this.database.contactPair.findUnique({
      where: event.source === 'BITRIX24'
        ? { bitrix24ContactId: sourceEntityId }
        : { moyskladCounterpartyId: sourceEntityId },
      include: { snapshot: true },
    });
    if (!pair || !pair.active || pair.moyskladType !== 'COUNTERPARTY' || !pair.snapshot) {
      throw new Error('REVIEW_REQUIRED');
    }

    const [bitrixContact, moyskladCounterparty] = await Promise.all([
      this.readBitrixContact(pair.bitrix24ContactId),
      this.readMoyskladCounterparty(pair.moyskladCounterpartyId),
    ]);
    const bitrixEmailField = readSingleBitrixEmail(bitrixContact.EMAIL);
    const bitrixEmail = bitrixEmailField?.email ?? null;
    const moyskladEmail = readEmail(moyskladCounterparty.email);
    if (!bitrixEmail || !moyskladEmail) throw new Error('REVIEW_REQUIRED');

    const snapshot = pair.snapshot;
    const bitrixChanged = bitrixEmail !== snapshot.bitrix24Email;
    const moyskladChanged = moyskladEmail !== snapshot.moyskladEmail;
    const direction = chooseDirection(
      bitrixChanged,
      moyskladChanged,
      bitrixContact.DATE_MODIFY,
      moyskladCounterparty.updated,
    );
    if (!direction) {
      await this.database.inboundEvent.update({
        where: { id: event.id },
        data: { status: 'UNCHANGED', attempts: attempt, direction: null, snapshotRevision: snapshot.revision },
      });
      return;
    }

    if (bitrixEmail === moyskladEmail) {
      const now = new Date();
      const newRevision = snapshot.revision + 1;
      await this.database.contactSnapshot.update({
        where: { pairId: pair.id },
        data: {
          bitrix24Email: bitrixEmail,
          moyskladEmail,
          bitrix24UpdatedAt: readTimestamp(bitrixContact.DATE_MODIFY),
          moyskladUpdatedAt: readTimestamp(moyskladCounterparty.updated),
          revision: newRevision,
          lastSuccessfulAt: now,
        },
      });
      await this.database.inboundEvent.update({
        where: { id: event.id },
        data: {
          status: 'SUCCEEDED',
          attempts: attempt,
          direction: null,
          snapshotRevision: newRevision,
          lastSuccessfulAt: now,
          lastErrorCategory: null,
        },
      });
      return;
    }

    const value = direction === 'BITRIX24_TO_MOYSKLAD' ? bitrixEmail : moyskladEmail;
    if (direction === 'BITRIX24_TO_MOYSKLAD') {
      const result = await this.writeMoyskladEmail(pair.moyskladCounterpartyId, value);
      if (readEmail(result.email) !== value) throw new Error('EXTERNAL_API_FAILURE');
    } else {
      if (!bitrixEmailField) throw new Error('REVIEW_REQUIRED');
      await this.writeBitrixEmail(pair.bitrix24ContactId, bitrixEmailField, value);
    }

    const now = new Date();
    const bitrixTimestamp = readTimestamp(bitrixContact.DATE_MODIFY);
    const moyskladTimestamp = readTimestamp(moyskladCounterparty.updated);
    const newRevision = snapshot.revision + 1;
    await this.database.contactSnapshot.update({
      where: { pairId: pair.id },
      data: {
        bitrix24Email: value,
        moyskladEmail: value,
        bitrix24UpdatedAt: direction === 'BITRIX24_TO_MOYSKLAD' ? bitrixTimestamp : now,
        moyskladUpdatedAt: direction === 'MOYSKLAD_TO_BITRIX24' ? moyskladTimestamp : now,
        revision: newRevision,
        lastSuccessfulAt: now,
      },
    });
    await this.database.inboundEvent.update({
      where: { id: event.id },
      data: {
        status: 'SUCCEEDED',
        attempts: attempt,
        direction,
        snapshotRevision: newRevision,
        lastSuccessfulAt: now,
        lastErrorCategory: null,
      },
    });
  }

  private async readBitrixContact(contactId: string): Promise<JsonRecord> {
    const result = await this.bitrixRequest('crm.contact.get.json', { id: contactId });
    if (!isRecord(result)) throw new Error('EXTERNAL_API_FAILURE');
    return result;
  }

  private async writeBitrixEmail(
    contactId: string,
    currentEmail: { id: string; valueType: string },
    email: string,
  ): Promise<void> {
    await this.bitrixRequest('crm.contact.update.json', {
      id: contactId,
      'fields[EMAIL][0][ID]': currentEmail.id,
      'fields[EMAIL][0][VALUE]': email,
      'fields[EMAIL][0][VALUE_TYPE]': currentEmail.valueType,
    });
  }

  private async bitrixRequest(method: string, fields: Record<string, string>): Promise<unknown> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('EXTERNAL_API_FAILURE');
    const response = await fetch(new URL(method, ensureTrailingSlash(base)), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('EXTERNAL_API_FAILURE');
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.error || !('result' in payload)) throw new Error('EXTERNAL_API_FAILURE');
    return payload.result;
  }

  private async readMoyskladCounterparty(counterpartyId: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(counterpartyId, 'GET');
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async writeMoyskladEmail(counterpartyId: string, email: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(counterpartyId, 'PUT', { email });
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async moyskladRequest(counterpartyId: string, method: 'GET' | 'PUT', body?: JsonRecord): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('EXTERNAL_API_FAILURE');
    const url = new URL(`entity/counterparty/${encodeURIComponent(counterpartyId)}`, ensureTrailingSlash(base));
    const response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('EXTERNAL_API_FAILURE');
    return response.json();
  }
}

@Injectable()
export class ContactSyncStatusReader {
  constructor(private readonly database: DatabaseService) {}

  async read(eventId: string) {
    const event = await this.database.inboundEvent.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        status: true,
        attempts: true,
        direction: true,
        snapshotRevision: true,
        lastSuccessfulAt: true,
        lastErrorCategory: true,
      },
    });
    return event;
  }
}

function isContactEmailEvent(source: string, eventType: string | null, externalEntityType: string | null): boolean {
  return (source === 'BITRIX24' && eventType?.startsWith('ONCRMCONTACT') === true) ||
    (source === 'MOYSKLAD' && eventType === 'UPDATE' && externalEntityType === 'counterparty');
}

function readSingleBitrixEmail(value: unknown): { email: string; id: string; valueType: string } | null {
  if (!Array.isArray(value) || value.length !== 1 || !isRecord(value[0])) return null;
  const email = readEmail(value[0].VALUE);
  const id = readString(value[0].ID);
  const valueType = readString(value[0].VALUE_TYPE);
  return email && id && valueType ? { email, id, valueType } : null;
}

function readEmail(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function readTimestamp(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error('REVIEW_REQUIRED');
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function chooseDirection(
  bitrixChanged: boolean,
  moyskladChanged: boolean,
  bitrixUpdated: unknown,
  moyskladUpdated: unknown,
): 'BITRIX24_TO_MOYSKLAD' | 'MOYSKLAD_TO_BITRIX24' | null {
  if (!bitrixChanged && !moyskladChanged) return null;
  if (bitrixChanged && !moyskladChanged) return 'BITRIX24_TO_MOYSKLAD';
  if (moyskladChanged && !bitrixChanged) return 'MOYSKLAD_TO_BITRIX24';
  return readTimestamp(bitrixUpdated).getTime() > readTimestamp(moyskladUpdated).getTime()
    ? 'BITRIX24_TO_MOYSKLAD'
    : 'MOYSKLAD_TO_BITRIX24';
}

function errorCategory(error: unknown): string {
  return error instanceof Error && error.message === 'REVIEW_REQUIRED'
    ? 'REVIEW_REQUIRED'
    : 'EXTERNAL_API_FAILURE';
}

function isApplyEnabled(): boolean {
  return process.env.SYNC_STATE === 'on' && process.env.SYNC_MODE === 'apply';
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
