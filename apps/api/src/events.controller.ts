import {
  Body,
  BadRequestException,
  Controller,
  GoneException,
  HttpCode,
  Injectable,
  Param,
  Optional,
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

type EventPayload = Record<string, unknown>;
type InboundSource = 'BITRIX24' | 'MOYSKLAD';

@Injectable()
export class EventIntakeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly syncMode: SyncModeService,
  ) {}

  async receiveBitrix24(payload: EventPayload) {
    const expectedToken = process.env.BITRIX24_EVENT_APPLICATION_TOKEN;
    if (!expectedToken) {
      throw new ServiceUnavailableException('Bitrix24 event authentication is not configured');
    }

    const auth = isRecord(payload.auth) ? payload.auth : {};
    const providedToken = typeof auth.application_token === 'string' ? auth.application_token : '';
    if (!constantTimeEqual(providedToken, expectedToken)) {
      throw new UnauthorizedException();
    }

    await this.ensureIntakeEnabled();
    const safePayload = { ...payload };
    delete safePayload.auth;
    const data = isRecord(safePayload.data) ? safePayload.data : {};
    const fields = isRecord(data.FIELDS) ? data.FIELDS : {};
    const eventType = typeof safePayload.event === 'string' ? safePayload.event : null;
    const directionDisabled = eventType?.startsWith('ONCRMCONTACT') === true &&
      !await this.syncMode.isDirectionEnabled('contacts-companies', 'bitrix24ToMoysklad');

    return this.save('BITRIX24', sha256(canonicalJson(safePayload)), {
      eventType,
      externalEntityId: readString(fields.ID) ?? readString(data.ID),
      externalEntityType: null,
      payload: safePayload,
    }, directionDisabled);
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
      throw new UnauthorizedException();
    }

    await this.ensureIntakeEnabled();
    if (requestId !== undefined && (typeof requestId !== 'string' || requestId.length === 0 || requestId.length > 200)) {
      throw new BadRequestException('MoySklad requestId must be a non-empty string when provided');
    }

    const safePayload = payload ?? {};
    const nativeEvent = readMoySkladEvent(safePayload);
    const deliveryKey = typeof requestId === 'string' ? `request:${requestId}` : `unkeyed:${randomUUID()}`;
    const eventType = nativeEvent.eventType ?? readString(safePayload.event) ?? readString(safePayload.action) ?? readString(query.type);
    const directionDisabled = eventType === 'UPDATE' && nativeEvent.externalEntityType === 'counterparty' &&
      !await this.syncMode.isDirectionEnabled('contacts-companies', 'moyskladToBitrix24');
    return this.save('MOYSKLAD', deliveryKey, {
      eventType,
      externalEntityId: nativeEvent.externalEntityId ?? readString(safePayload.id) ?? readString(query.id),
      externalEntityType: nativeEvent.externalEntityType,
      payload: safePayload,
    }, directionDisabled);
  }

  private async ensureIntakeEnabled() {
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
    const row = await this.database.inboundEvent.upsert({
      where: { source_deliveryKey: { source, deliveryKey } },
      create: {
        source,
        deliveryKey,
        eventType: event.eventType,
        externalEntityId: event.externalEntityId,
        externalEntityType: event.externalEntityType,
        payload: event.payload as Prisma.InputJsonValue,
        status: directionDisabled ? 'SKIPPED_DIRECTION_DISABLED' : 'RECEIVED',
        lastErrorCategory: directionDisabled ? 'DIRECTION_DISABLED' : null,
      },
      update: {},
      select: { id: true },
    });
    void writeOperationalLog(this.database, 'EVENT', 'Inbound event accepted', row.id);

    return { accepted: true, eventId: row.id };
  }
}

@Controller('webhooks')
export class EventsController {
  constructor(
    private readonly intake: EventIntakeService,
    @Optional() private readonly contactSync?: ContactSyncProcessor,
  ) {}

  @Post('bitrix24')
  @HttpCode(200)
  async receiveBitrix24(
    @Body() payload: EventPayload | null,
    @Res({ passthrough: true }) response: { once(event: 'finish', listener: () => void): unknown },
  ) {
    if (!isRecord(payload)) throw new UnauthorizedException();
    const acknowledgement = await this.intake.receiveBitrix24(payload);
    response.once('finish', () => this.contactSync?.enqueue(acknowledgement.eventId));
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
      response.once('finish', () => this.contactSync?.enqueue(acknowledgement.eventId));
      return acknowledgement;
    });
  }
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
