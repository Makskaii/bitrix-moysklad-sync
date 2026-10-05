import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { SyncModeService } from './sync-mode.service';
import { writeOperationalLog } from './monitoring-log';

type JsonRecord = Record<string, unknown>;
const PROCESSING_LEASE_MS = 60_000;
const EXTERNAL_REQUEST_TIMEOUT_MS = 15_000;

@Injectable()
export class ContactSyncProcessor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly active = new Set<string>();
  private recoveryTimer?: NodeJS.Timeout;

  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
  ) {}

  onApplicationBootstrap() {
    void this.resumeReceivedContactEvents();
    this.recoveryTimer = setInterval(() => { void this.resumeReceivedContactEvents(); }, 1_000);
    this.recoveryTimer.unref();
  }

  onModuleDestroy() {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  enqueue(eventId: string) {
    setImmediate(() => { void this.process(eventId).catch(() => undefined); });
  }

  private async resumeReceivedContactEvents() {
    if (!await this.isApplyEnabled()) return;
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
      if (!await this.isApplyEnabled()) return;
      const candidate = await this.database.inboundEvent.findUnique({ where: { id: eventId } });
      if (!candidate) return;
      if (!isContactEmailEvent(candidate.source, candidate.eventType, candidate.externalEntityType)) return;
      if (await this.skipIfDirectionDisabled(candidate)) return;
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
      if (await this.skipIfDirectionDisabled(event)) return;
      const attempt = event.attempts;

      try {
        await this.syncContactEmail(event, attempt);
      } catch (error) {
        const category = errorCategory(error);
        if (category === 'REVIEW_REQUIRED') {
          const review = error instanceof ReviewRequiredError ? error : new ReviewRequiredError('UNSPECIFIED_REVIEW_REQUIRED');
          await this.database.manualReviewCase.upsert({
            where: { eventId: event.id },
            create: {
              eventId: event.id,
              source: event.source,
              eventType: event.eventType,
              externalEntityId: event.externalEntityId,
              externalEntityType: event.externalEntityType,
              reason: review.reason,
              diagnostic: review.diagnostic,
            },
            update: { reason: review.reason, diagnostic: review.diagnostic },
          });
        }
        await this.database.inboundEvent.update({
          where: { id: eventId },
          data: {
            status: category === 'REVIEW_REQUIRED' ? 'MANUAL_REVIEW' : 'RETRYABLE_FAILURE',
            lastErrorCategory: category,
          },
        });
        await writeOperationalLog(this.database, 'ERROR', `Sync attempt failed: ${category}`, event.id);
      }
    } finally {
      this.active.delete(eventId);
    }
  }

  private async isApplyEnabled(): Promise<boolean> {
    return process.env.SYNC_MODE === 'apply' && (await this.syncMode.read()).mode === 'on';
  }

  private async deferIfModeIsNoLongerOn(eventId: string): Promise<boolean> {
    if (await this.isApplyEnabled()) return false;
    await this.database.inboundEvent.updateMany({
      where: { id: eventId, status: 'PROCESSING' },
      data: { status: 'RECEIVED', processingStartedAt: null, lastErrorCategory: null },
    });
    return true;
  }

  private async skipIfDirectionDisabled(event: {
    id: string; source: string; eventType: string | null; externalEntityType: string | null; status: string;
  }): Promise<boolean> {
    const direction = event.source === 'BITRIX24' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (await this.syncMode.isDirectionEnabled('contacts-companies', direction)) return false;
    const skipped = await this.database.inboundEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status: 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: 'DIRECTION_DISABLED', processingStartedAt: null },
    });
    return skipped.count === 1;
  }

  private async syncContactEmail(
    event: { id: string; source: string; externalEntityId: string | null },
    attempt: number,
  ) {
    const sourceEntityId = event.externalEntityId;
    if (!sourceEntityId) throw new ReviewRequiredError('SOURCE_ENTITY_ID_MISSING');
    const pair = await this.database.contactPair.findUnique({
      where: event.source === 'BITRIX24'
        ? { bitrix24ContactId: sourceEntityId }
        : { moyskladCounterpartyId: sourceEntityId },
      include: { snapshot: true },
    });
    if (!pair) throw new ReviewRequiredError('CONTACT_PAIR_NOT_FOUND');
    if (!pair.active) throw new ReviewRequiredError('CONTACT_PAIR_INACTIVE');
    if (pair.moyskladType !== 'COUNTERPARTY') throw new ReviewRequiredError('UNSUPPORTED_MOYSKLAD_ENTITY_TYPE');
    if (!pair.snapshot) throw new ReviewRequiredError('CONTACT_SNAPSHOT_MISSING', { pairId: pair.id });

    const [bitrixContact, moyskladCounterparty] = await Promise.all([
      this.readBitrixContact(event.id, pair.bitrix24ContactId),
      this.readMoyskladCounterparty(event.id, pair.moyskladCounterpartyId),
    ]);
    const bitrixEmailField = readSingleBitrixEmail(bitrixContact.EMAIL);
    const bitrixEmail = bitrixEmailField?.email ?? null;
    const moyskladEmail = readEmail(moyskladCounterparty.email);
    if (!bitrixEmail || !moyskladEmail) throw new ReviewRequiredError('SYNC_EMAIL_MISSING', {
      bitrixEmailPresent: Boolean(bitrixEmail),
      moyskladEmailPresent: Boolean(moyskladEmail),
      bitrixEmailFieldCount: Array.isArray(bitrixContact.EMAIL) ? bitrixContact.EMAIL.length : 0,
      snapshotRevision: pair.snapshot.revision,
    });

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
      await this.resolveManualReview(event.id);
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
      await this.resolveManualReview(event.id);
      return;
    }

    const value = direction === 'BITRIX24_TO_MOYSKLAD' ? bitrixEmail : moyskladEmail;
    const configuredDirection = direction === 'BITRIX24_TO_MOYSKLAD' ? 'bitrix24ToMoysklad' : 'moyskladToBitrix24';
    if (!await this.syncMode.isDirectionEnabled('contacts-companies', configuredDirection)) {
      await this.database.inboundEvent.update({
        where: { id: event.id },
        data: { status: 'SKIPPED_DIRECTION_DISABLED', lastErrorCategory: 'DIRECTION_DISABLED', processingStartedAt: null },
      });
      return;
    }
    if (await this.deferIfModeIsNoLongerOn(event.id)) return;
    if (direction === 'BITRIX24_TO_MOYSKLAD') {
      const result = await this.writeMoyskladEmail(event.id, pair.moyskladCounterpartyId, value);
      if (readEmail(result.email) !== value) throw new Error('EXTERNAL_API_FAILURE');
    } else {
      if (!bitrixEmailField) throw new ReviewRequiredError('BITRIX_EMAIL_FIELD_NOT_WRITABLE', {
        bitrixEmailPresent: Boolean(bitrixEmail),
        moyskladEmailPresent: Boolean(moyskladEmail),
        snapshotRevision: snapshot.revision,
      });
      await this.writeBitrixEmail(event.id, pair.bitrix24ContactId, bitrixEmailField, value);
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
    await this.resolveManualReview(event.id);
  }

  private async readBitrixContact(eventId: string, contactId: string): Promise<JsonRecord> {
    const result = await this.bitrixRequest(eventId, 'crm.contact.get.json', { id: contactId });
    if (!isRecord(result)) throw new Error('EXTERNAL_API_FAILURE');
    return result;
  }

  private async writeBitrixEmail(
    eventId: string,
    contactId: string,
    currentEmail: { id: string; valueType: string },
    email: string,
  ): Promise<void> {
    await this.bitrixRequest(eventId, 'crm.contact.update.json', {
      id: contactId,
      'fields[EMAIL][0][ID]': currentEmail.id,
      'fields[EMAIL][0][VALUE]': email,
      'fields[EMAIL][0][VALUE_TYPE]': currentEmail.valueType,
    });
  }

  private async bitrixRequest(eventId: string, method: string, fields: Record<string, string>): Promise<unknown> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base) throw new Error('EXTERNAL_API_FAILURE');
    let response: Response;
    try {
      response = await fetch(new URL(method, ensureTrailingSlash(base)), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields),
        signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', null, false);
      throw error;
    }
    if (!response.ok) {
      await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', response.status, false);
      throw new Error('EXTERNAL_API_FAILURE');
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', response.status, false);
      throw error;
    }
    const accepted = acceptsBitrixResponse(method, payload);
    await this.recordApiAttempt(eventId, 'BITRIX24', method.replace(/\.json$/, ''), 'POST', response.status, accepted);
    if (!accepted || !isRecord(payload) || !('result' in payload)) throw new Error('EXTERNAL_API_FAILURE');
    return payload.result;
  }

  private async readMoyskladCounterparty(eventId: string, counterpartyId: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(eventId, counterpartyId, 'GET', undefined, isMoyskladCounterparty);
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async writeMoyskladEmail(eventId: string, counterpartyId: string, email: string): Promise<JsonRecord> {
    const response = await this.moyskladRequest(eventId, counterpartyId, 'PUT', { email }, (payload) => isMoyskladCounterparty(payload) && readEmail(payload.email) === email);
    if (!isRecord(response)) throw new Error('EXTERNAL_API_FAILURE');
    return response;
  }

  private async moyskladRequest(eventId: string, counterpartyId: string, method: 'GET' | 'PUT', body?: JsonRecord, accepts: (payload: unknown) => boolean = isRecord): Promise<unknown> {
    const base = process.env.MOYSKLAD_API_BASE_URL;
    const token = process.env.MOYSKLAD_API_TOKEN;
    if (!base || !token) throw new Error('EXTERNAL_API_FAILURE');
    const url = new URL(`entity/counterparty/${encodeURIComponent(counterpartyId)}`, ensureTrailingSlash(base));
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(EXTERNAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, null, false);
      throw error;
    }
    if (!response.ok) {
      await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, response.status, false);
      throw new Error('EXTERNAL_API_FAILURE');
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, response.status, false);
      throw error;
    }
    const accepted = accepts(payload);
    await this.recordApiAttempt(eventId, 'MOYSKLAD', 'entity/counterparty/{id}', method, response.status, accepted);
    if (!accepted) throw new Error('EXTERNAL_API_FAILURE');
    return payload;
  }

  private async recordApiAttempt(
    eventId: string,
    provider: string,
    operation: string,
    method: string,
    statusCode: number | null,
    succeeded: boolean,
  ) {
    try {
      await this.database.apiAttempt.create({
        data: { eventId, provider, operation, method, statusCode, succeeded },
      });
    } catch {
      // The history is supplementary and cannot change the external API result.
    }
  }

  private async resolveManualReview(eventId: string) {
    try {
      await this.database.manualReviewCase.updateMany({
        where: { eventId, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    } catch {
      // Incident history is separate from event processing; an auxiliary update cannot undo a successful sync.
    }
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
  if (!Number.isFinite(date.getTime())) throw new ReviewRequiredError('SOURCE_MODIFIED_TIMESTAMP_INVALID');
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
  return error instanceof ReviewRequiredError
    ? 'REVIEW_REQUIRED'
    : 'EXTERNAL_API_FAILURE';
}

function acceptsBitrixResponse(method: string, payload: unknown): boolean {
  if (!isRecord(payload) || payload.error || !('result' in payload)) return false;
  if (method.includes('.get.')) {
    return isRecord(payload.result)
      && readString(payload.result.ID) !== null
      && isValidTimestamp(payload.result.DATE_MODIFY);
  }
  return payload.result === true;
}

function isMoyskladCounterparty(payload: unknown): payload is JsonRecord {
  return isRecord(payload) && readString(payload.id) !== null && isValidTimestamp(payload.updated);
}

function isValidTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

class ReviewRequiredError extends Error {
  constructor(readonly reason: string, readonly diagnostic: Record<string, string | number | boolean> = {}) {
    super('REVIEW_REQUIRED');
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
