import {
  Body,
  BadRequestException,
  Controller,
  GoneException,
  HttpCode,
  Injectable,
  Logger,
  Param,
  Optional,
  Inject,
  Post,
  Query,
  Res,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';
import { SyncModeService } from './sync-mode.service';
import { writeOperationalLog } from './monitoring-log';
import { ContactSyncProcessor } from './contact-sync.service';
import { WebhookDiagnosticLog } from './webhook-diagnostic-log';
import { EventIntakeDisabledError, FieldSettingsService } from './field-settings/field-settings.service';
import { PairFirstEventProcessor } from './pairs/pair-first-event.processor';
import { EventDispatcherService } from './event-dispatcher.service';
import { DatabaseRecoveryService } from './database-recovery.service';

type EventPayload = Record<string, unknown>;
type InboundSource = 'BITRIX24' | 'MOYSKLAD';
const webhookLogger = new Logger('WebhookIntake');

@Injectable()
export class EventIntakeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
    @Optional() @Inject(WebhookDiagnosticLog) private readonly diagnostics?: WebhookDiagnosticLog,
    @Optional() @Inject(FieldSettingsService) private readonly fieldSettings?: FieldSettingsService,
    @Optional() @Inject(DatabaseRecoveryService) private readonly databaseRecovery?: DatabaseRecoveryService,
  ) {}

  async receiveBitrix24(payload: EventPayload) {
    const expectedToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    if (!expectedToken) {
      throw new ServiceUnavailableException('Bitrix24 event authentication is not configured');
    }

    const auth = isRecord(payload.auth) ? payload.auth : {};
    const providedToken = typeof auth.application_token === 'string' ? auth.application_token : '';
    if (!constantTimeEqual(providedToken, expectedToken)) {
      const eventType = readString(payload.event);
      const diagnostic = {
        status: 'rejected', source: 'BITRIX24', reason: 'invalid_application_token',
        eventType: safeDealEventType(eventType), externalEntityId: safeDiagnosticId('BITRIX24', bitrixEntityId(payload)), receivedAt: new Date().toISOString(),
      };
      webhookLogger.warn(JSON.stringify(diagnostic));
      if (diagnostic.eventType) this.diagnostics?.record({
        source: 'BITRIX24', eventType: diagnostic.eventType, entityType: 'deal',
        externalEntityId: diagnostic.externalEntityId, status: 'rejected_validation', reason: diagnostic.reason,
        receivedAt: diagnostic.receivedAt,
      });
      throw new UnauthorizedException();
    }

    await this.ensureIntakeEnabled();
    const safePayload = { ...payload };
    delete safePayload.auth;
    const data = isRecord(safePayload.data) ? safePayload.data : {};
    const fields = isRecord(data.FIELDS) ? data.FIELDS : {};
    const eventType = typeof safePayload.event === 'string' ? safePayload.event : null;
    const externalEntityType = bitrixEntityType(eventType, safePayload);
    const direction = getEventDirection('BITRIX24', eventType, externalEntityType);
    const directionDisabled = direction === 'products-variations:bitrix24ToMoysklad' ||
      (direction !== null && !await this.syncMode.isDirectionEnabled(
        direction.split(':')[0], direction.split(':')[1] as 'bitrix24ToMoysklad' | 'moyskladToBitrix24',
      ));

    const event = {
      eventType,
      externalEntityId: readString(fields.ID) ?? readString(data.ID),
      externalEntityType,
      payload: safePayload,
    };
    // Bitrix's webhook body has no documented stable delivery ID. A payload hash
    // would collapse two legitimate identical updates, so preserve each arrival.
    return this.save('BITRIX24', `delivery:${randomUUID()}`, event, directionDisabled);
  }

  async receiveMoySklad(
    pathSecret: string,
    requestId: unknown,
    payload: EventPayload | undefined,
    query: Record<string, unknown>,
  ) {
    const expectedSecret = process.env.MOYSKLAD_WEBHOOK_SECRET;
    if (!expectedSecret) {
      throw new ServiceUnavailableException('MoySklad webhook authentication is not configured');
    }

    if (!constantTimeEqual(pathSecret, expectedSecret)) {
      const rejectedEvent = readMoySkladEvents(payload ?? {}, query)[0];
      const diagnostic = {
        status: 'rejected', source: 'MOYSKLAD', reason: 'invalid_secret',
        eventType: rejectedEvent.eventType, externalEntityType: rejectedEvent.externalEntityType,
        externalEntityId: safeDiagnosticId('MOYSKLAD', rejectedEvent.externalEntityId), receivedAt: new Date().toISOString(),
      };
      webhookLogger.warn(JSON.stringify(diagnostic));
      if (diagnostic.externalEntityType === 'customerorder' && diagnostic.eventType && ['CREATE', 'UPDATE', 'DELETE'].includes(diagnostic.eventType)) {
        this.diagnostics?.record({
          source: 'MOYSKLAD', eventType: diagnostic.eventType, entityType: diagnostic.externalEntityType,
          externalEntityId: diagnostic.externalEntityId, status: 'rejected_validation', reason: diagnostic.reason,
          receivedAt: diagnostic.receivedAt,
        });
      }
      throw new UnauthorizedException();
    }

    await this.ensureIntakeEnabled();
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200)) {
      throw new BadRequestException('MoySklad requestId must be a non-empty string when provided');
    }

    const safePayload = payload ?? {};
    if (Array.isArray(safePayload.events) &&
      (safePayload.events.length === 0 || safePayload.events.some((event) => !isRecord(event)))) {
      throw new BadRequestException('MoySklad events must be a non-empty array of event objects');
    }
    const events = readMoySkladEvents(safePayload, query);
    const eventIds: string[] = [];
    const contactEventIds: string[] = [];
    const pairEventIds: string[] = [];
    for (const [index, event] of events.entries()) {
      const payload = { ...safePayload, ...(Array.isArray(safePayload.events) ? { events: [event.payload] } : {}) };
      const queueEvent = {
        eventType: event.eventType,
        externalEntityId: event.externalEntityId,
        externalEntityType: event.externalEntityType,
        payload,
      };
      const fingerprint = eventFingerprint('MOYSKLAD', queueEvent);
      const deliveryKey = typeof requestId === 'string'
        ? `request:${sha256(canonicalJson([requestId, index, fingerprint]))}`
        // No stable key means at-least-once intake: retain every arrival rather
        // than risk dropping a later real change with an identical envelope.
        : `delivery:${randomUUID()}`;
      const direction = getEventDirection('MOYSKLAD', event.eventType, event.externalEntityType);
      const directionDisabled = direction !== null && !await this.syncMode.isDirectionEnabled(
        direction.split(':')[0], direction.split(':')[1] as 'bitrix24ToMoysklad' | 'moyskladToBitrix24',
      );
      const acknowledgement = await this.save('MOYSKLAD', deliveryKey, queueEvent, directionDisabled);
      eventIds.push(acknowledgement.eventId);
      if (event.eventType === 'UPDATE' && event.externalEntityType === 'counterparty') {
        contactEventIds.push(acknowledgement.eventId);
      }
      if (event.externalEntityType === 'customerorder' && ['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType ?? '')) {
        pairEventIds.push(acknowledgement.eventId);
      }
    }
    return { accepted: true, eventId: eventIds[0], eventIds, contactEventIds, pairEventIds };
  }

  private async ensureIntakeEnabled() {
    if (this.databaseRecovery && !await this.databaseRecovery.assertReady()) {
      throw new ServiceUnavailableException('Database loss recovery is required before webhook intake');
    }
    const mode = process.env.SYNC_MODE;
    if (mode !== 'dry' && mode !== 'apply') {
      throw new ServiceUnavailableException('SYNC_MODE must be dry or apply');
    }
    if ((await this.syncMode.read()).mode === 'off') {
      throw new GoneException('Event intake is disabled');
    }
  }

  private async save(
    source: InboundSource,
    deliveryKey: string,
    event: { eventType: string | null; externalEntityId: string | null; externalEntityType: string | null; payload: EventPayload },
    directionDisabled = false,
  ) {
    let row: { id: string };
    try {
      row = this.fieldSettings
        ? await this.fieldSettings.saveAcceptedEvent({
          source, deliveryKey, eventType: event.eventType, externalEntityId: event.externalEntityId,
          externalEntityType: event.externalEntityType, payload: event.payload as Prisma.InputJsonValue, directionDisabled,
          requireServiceNotOff: true,
        })
        : typeof this.database.$transaction === 'function'
          ? await this.database.$transaction(async (transaction) => {
            const mode = await transaction.$queryRaw<Array<{ serviceMode: string }>>`
              SELECT "serviceMode" FROM "SyncSetting" WHERE "id" = 'global' FOR SHARE
            `;
            if (!mode[0] || mode[0].serviceMode === 'off') throw new EventIntakeDisabledError();
            return transaction.inboundEvent.upsert({
              where: { source_deliveryKey: { source, deliveryKey } },
              create: {
                source, deliveryKey, eventType: event.eventType, externalEntityId: event.externalEntityId,
                externalEntityType: event.externalEntityType, payload: event.payload as Prisma.InputJsonValue,
                status: directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
                lastErrorCategory: directionDisabled ? 'DIRECTION_DISABLED' : null,
              },
              update: {},
              select: { id: true },
            });
          })
          : await this.database.inboundEvent.upsert({
            where: { source_deliveryKey: { source, deliveryKey } },
            create: {
              source, deliveryKey, eventType: event.eventType, externalEntityId: event.externalEntityId,
              externalEntityType: event.externalEntityType, payload: event.payload as Prisma.InputJsonValue,
              status: directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
              lastErrorCategory: directionDisabled ? 'DIRECTION_DISABLED' : null,
            },
            update: {},
            select: { id: true },
          });
    } catch (error) {
      if (error instanceof EventIntakeDisabledError) throw new GoneException('Event intake is disabled');
      const receivedAt = new Date().toISOString();
      const supportedType = source === 'BITRIX24'
        ? safeDealEventType(event.eventType)
        : event.externalEntityType === 'customerorder' && event.eventType && ['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType)
          ? event.eventType
          : null;
      const reason = 'event_persistence_failed';
      const diagnostic = safeDiagnosticDetails(source, event);
      if (supportedType && diagnostic) this.diagnostics?.record({
        source, eventType: supportedType, entityType: source === 'BITRIX24' ? 'deal' : 'customerorder',
        externalEntityId: diagnostic.externalEntityId, status: 'processing_error', reason, receivedAt,
      });
      if (supportedType && diagnostic) webhookLogger.error(JSON.stringify({ status: 'processing_error', ...diagnostic, reason, receivedAt }));
      throw new ServiceUnavailableException('Event persistence failed');
    }

    void writeOperationalLog(this.database, 'EVENT', 'Inbound event accepted', row.id);
    const diagnostic = safeDiagnosticDetails(source, event);
    if (diagnostic) webhookLogger.log(JSON.stringify({
      status: 'received', ...diagnostic, eventId: row.id, receivedAt: new Date().toISOString(),
      ...(directionDisabled ? { reason: 'direction_disabled' } : {}),
    }));

    return { accepted: true, eventId: row.id };
  }
}

@Controller('webhooks')
export class EventsController {
  constructor(
    private readonly intake: EventIntakeService,
    @Optional() private readonly contactSync?: ContactSyncProcessor,
    @Optional() private readonly pairFirstEvent?: PairFirstEventProcessor,
    @Optional() private readonly dispatcher?: EventDispatcherService,
  ) {}

  @Post('bitrix24')
  @HttpCode(200)
  async receiveBitrix24(
    @Body() payload: EventPayload | null,
    @Res({ passthrough: true }) response: { once(event: 'finish', listener: () => void): unknown },
  ) {
    if (!isRecord(payload)) throw new UnauthorizedException();
    const acknowledgement = await this.intake.receiveBitrix24(payload);
    if (this.dispatcher) {
      response.once('finish', () => { void this.dispatcher!.dispatch(acknowledgement.eventId).catch(() => undefined); });
    } else if (isContactBitrixEvent(readString(payload.event))) {
      response.once('finish', () => this.contactSync?.enqueue(acknowledgement.eventId));
    }
    if (!this.dispatcher && isDealBitrixEvent(readString(payload.event))) {
      response.once('finish', () => this.pairFirstEvent?.enqueue(acknowledgement.eventId));
    }
    return acknowledgement;
  }

  @Post('moysklad/:secret')
  @HttpCode(200)
  receiveMoySklad(
    @Param('secret') secret: string,
    @Query('requestId') requestId: unknown,
    @Query() query: Record<string, unknown>,
    @Body() payload: EventPayload | undefined,
    @Res({ passthrough: true }) response: { once(event: 'finish', listener: () => void): unknown },
  ) {
    if (payload !== undefined && !isRecord(payload)) throw new UnauthorizedException();
    return this.intake.receiveMoySklad(secret, requestId, payload, query).then((acknowledgement) => {
      if (this.dispatcher) {
        response.once('finish', () => acknowledgement.eventIds.forEach((eventId) => {
          void this.dispatcher!.dispatch(eventId).catch(() => undefined);
        }));
      } else if (acknowledgement.contactEventIds.length > 0) {
        response.once('finish', () => acknowledgement.contactEventIds.forEach((eventId) => this.contactSync?.enqueue(eventId)));
      }
      if (!this.dispatcher && acknowledgement.pairEventIds.length > 0) {
        response.once('finish', () => acknowledgement.pairEventIds.forEach((eventId) => this.pairFirstEvent?.enqueue(eventId)));
      }
      const { contactEventIds, pairEventIds, eventIds, ...singleEventAcknowledgement } = acknowledgement;
      return eventIds.length > 1 ? { ...singleEventAcknowledgement, eventIds } : singleEventAcknowledgement;
    });
  }
}

function isDealBitrixEvent(eventType: string | null): boolean {
  return /^ONCRMDEAL(?:ADD|UPDATE|DELETE)$/.test(eventType ?? '');
}

function isRecord(value: unknown): value is EventPayload {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function constantTimeEqual(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventFingerprint(
  source: InboundSource,
  event: { eventType: string | null; externalEntityId: string | null; externalEntityType: string | null; payload: EventPayload },
): string {
  return sha256(canonicalJson([
    source,
    event.externalEntityType,
    event.externalEntityId,
    event.eventType,
    event.payload,
  ]));
}

function readMoySkladEvent(payload: EventPayload): {
  eventType: string | null;
  externalEntityId: string | null;
  externalEntityType: string | null;
} {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const firstEvent = events.find(isRecord);
  if (!firstEvent) return { eventType: null, externalEntityId: null, externalEntityType: null };

  const meta = isRecord(firstEvent.meta) ? firstEvent.meta : {};
  const href = readString(meta.href);
  const hrefParts = href?.split('/').filter(Boolean) ?? [];
  const externalEntityId = hrefParts.at(-1) ?? null;
  const externalEntityType = readString(meta.type)?.toLowerCase() ?? hrefParts.at(-2)?.toLowerCase() ?? null;
  return { eventType: readString(firstEvent.action), externalEntityId, externalEntityType };
}

function readMoySkladEvents(payload: EventPayload, query: Record<string, unknown>): Array<{
  eventType: string | null;
  externalEntityId: string | null;
  externalEntityType: string | null;
  payload: EventPayload;
}> {
  const events = Array.isArray(payload.events) ? payload.events.filter(isRecord) : [];
  const sourceEvents = events.length > 0 ? events : [payload];
  return sourceEvents.map((event) => {
    const native = readMoySkladEvent({ events: [event] });
    return {
      eventType: native.eventType ?? readString(event.event) ?? readString(event.action) ?? readString(query.type),
      externalEntityId: native.externalEntityId ?? readString(event.id) ?? readString(query.id),
      externalEntityType: native.externalEntityType ?? normalizeMoySkladType(readString(query.type)),
      payload: event,
    };
  });
}

function normalizeMoySkladType(value: string | null): string | null {
  return value?.toLowerCase() === 'customerorder' ? 'customerorder' : value?.toLowerCase() ?? null;
}

function safeDealEventType(value: string | null): string | null {
  return value && /^ONCRMDEAL(?:ADD|UPDATE|DELETE)$/.test(value) ? value : null;
}

function bitrixEntityType(value: string | null, payload: EventPayload): string | null {
  if (value?.startsWith('CATALOG.PRODUCT.')) return 'product';
  if (value?.startsWith('CATALOG.PRICE.')) return 'catalogprice';
  if (/^ONCRMDYNAMICITEM(?:ADD|UPDATE|DELETE)$/.test(value ?? '') && bitrixEntityTypeId(payload) === 31) return 'invoice';
  if (value?.startsWith('ONCRMDEAL')) return 'deal';
  if (value?.startsWith('ONCRMCONTACT')) return 'contact';
  if (value?.startsWith('ONCRMCOMPANY')) return 'company';
  return null;
}

function bitrixEntityTypeId(payload: EventPayload): number | null {
  const data = isRecord(payload.data) ? payload.data : {};
  const fields = isRecord(data.FIELDS) ? data.FIELDS : {};
  const value = fields.ENTITY_TYPE_ID ?? data.ENTITY_TYPE_ID ?? payload.ENTITY_TYPE_ID;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function getEventDirection(
  source: InboundSource,
  eventType: string | null,
  externalEntityType: string | null,
): string | null {
  if (source === 'BITRIX24') {
    if (externalEntityType === 'contact' || externalEntityType === 'company') return 'contacts-companies:bitrix24ToMoysklad';
    if (externalEntityType === 'deal') return 'deals-orders:bitrix24ToMoysklad';
    if (externalEntityType === 'invoice') return 'invoices:bitrix24ToMoysklad';
    if (externalEntityType === 'product' || externalEntityType === 'catalogprice') return 'products-variations:bitrix24ToMoysklad';
    return null;
  }
  if (['counterparty', 'contactperson'].includes(externalEntityType ?? '') && ['CREATE', 'UPDATE', 'DELETE'].includes(eventType ?? '')) {
    return 'contacts-companies:moyskladToBitrix24';
  }
  if (externalEntityType === 'customerorder' && ['CREATE', 'UPDATE', 'DELETE'].includes(eventType ?? '')) {
    return 'deals-orders:moyskladToBitrix24';
  }
  if (externalEntityType === 'invoiceout' && ['CREATE', 'UPDATE', 'DELETE'].includes(eventType ?? '')) {
    return 'invoices:moyskladToBitrix24';
  }
  if (['product', 'service'].includes(externalEntityType ?? '') && ['CREATE', 'UPDATE', 'DELETE'].includes(eventType ?? '')) {
    return 'products-variations:moyskladToBitrix24';
  }
  return null;
}

function bitrixEntityId(payload: EventPayload): string | null {
  const data = isRecord(payload.data) ? payload.data : {};
  const fields = isRecord(data.FIELDS) ? data.FIELDS : {};
  return readString(fields.ID) ?? readString(data.ID);
}

function safeDiagnosticDetails(
  source: InboundSource,
  event: { eventType: string | null; externalEntityId: string | null; externalEntityType: string | null },
) {
  if (source === 'BITRIX24') {
    const eventType = safeDealEventType(event.eventType);
    if (!eventType) return null;
    return { source, eventType, entityType: 'deal', externalEntityId: safeDiagnosticId(source, event.externalEntityId) };
  }
  if (event.externalEntityType !== 'customerorder' || !event.eventType || !['CREATE', 'UPDATE', 'DELETE'].includes(event.eventType)) return null;
  return {
    source,
    eventType: event.eventType,
    entityType: 'customerorder',
    externalEntityId: safeDiagnosticId(source, event.externalEntityId),
  };
}

function safeDiagnosticId(source: InboundSource, value: string | null): string | null {
  if (!value) return null;
  if (source === 'BITRIX24') return /^\d{1,20}$/.test(value) ? value : null;
  return /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value) ? value : null;
}

function isContactBitrixEvent(value: string | null): boolean {
  return value?.startsWith('ONCRMCONTACT') === true;
}
