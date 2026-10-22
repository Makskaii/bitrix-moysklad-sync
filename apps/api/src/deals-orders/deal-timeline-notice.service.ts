import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseService } from '../database.service';
import { assertApplyExternalWrite } from '../external-write-guard';
import { ServiceModeNotOnError, withServiceModeOn } from '../service-mode-transaction';
import { providerResponseFailure, retryAtForFailure } from '../provider-failure';
import { dealTimelineMessage } from './deal-timeline-message';

type NoticeInput = { bitrix24DealId: string; kind: 'ERROR' | 'CREATED'; reason?: string | null; moyskladOrderId?: string | null };

/** Own durable outbox: a failed comment never replays a document CREATE. */
@Injectable()
export class DealTimelineNoticeService implements OnApplicationBootstrap, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;

  constructor(private readonly database: DatabaseService) {}

  onApplicationBootstrap() {
    if (process.env.SYNC_MODE !== 'apply' || process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') return;
    this.timer = setInterval(() => {
      if (!this.running) this.running = this.drain().catch(() => undefined).finally(() => { this.running = null; });
    }, 3000);
    this.timer.unref();
  }

  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running; }

  async enqueue(input: NoticeInput, tx: Prisma.TransactionClient = this.database) {
    if (!/^\d{1,20}$/.test(input.bitrix24DealId)) return;
    const reason = /^[A-Z_]{1,120}$/.test(input.reason ?? '') ? input.reason! : null;
    const orderId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.moyskladOrderId ?? '') ? input.moyskladOrderId! : null;
    if (input.kind === 'CREATED' && !orderId) return;
    const dedupKey = createHash('sha256').update(JSON.stringify([input.bitrix24DealId, input.kind, reason, orderId])).digest('hex');
    await tx.dealTimelineNotice.createMany({ data: [{ dedupKey, bitrix24DealId: input.bitrix24DealId,
      kind: input.kind, reason, moyskladOrderId: orderId }], skipDuplicates: true });
    if (input.kind === 'CREATED') await tx.dealTimelineNotice.updateMany({
      where: { bitrix24DealId: input.bitrix24DealId, kind: 'ERROR', status: 'PENDING', reason: { not: 'DEAL_ORDER_PARTIAL_ROWS' } },
      data: { status: 'SUPERSEDED' },
    });
  }

  async errorForEvent(eventId: string, reason: string | null, tx: Prisma.TransactionClient) {
    if (!reason || ['STAGE_NOT_READY', 'FORWARD_ORDER_ECHO_DEFERRED'].includes(reason)) return;
    const event = await tx.inboundEvent.findUnique({ where: { id: eventId }, select: { source: true, externalEntityType: true, externalEntityId: true } });
    if (!event?.externalEntityId) return;
    let dealId = event.source === 'BITRIX24' && event.externalEntityType === 'deal' ? event.externalEntityId : null;
    if (event.source === 'MOYSKLAD' && event.externalEntityType === 'customerorder') {
      const pair = await tx.entityPair.findFirst({ where: { entityType: 'DEAL', moyskladId: event.externalEntityId, active: true }, select: { bitrix24Id: true } });
      dealId = pair?.bitrix24Id ?? null;
    }
    if (dealId) await this.enqueue({ bitrix24DealId: dealId, kind: 'ERROR', reason }, tx);
  }

  async drain() {
    if (process.env.SYNC_MODE !== 'apply' || process.env.CONTROLLED_LIVE_TEST_MODE === 'enabled') return;
    const direction = await this.database.syncDirectionSetting.findUnique({ where: { entityKey: 'deals-orders' } });
    if (!direction || !direction.bitrix24ToMoysklad && !direction.moyskladToBitrix24) return;
    const now = new Date();
    const due = await this.database.dealTimelineNotice.findMany({
      where: { status: { in: ['PENDING', 'WRITING'] }, retryAfter: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      orderBy: [{ retryAfter: 'asc' }, { id: 'asc' }], take: 5,
    });
    for (const row of due) {
      const token = randomUUID();
      const claim = await withServiceModeOn(this.database, (tx) => tx.dealTimelineNotice.updateMany({
        where: { id: row.id, status: { in: ['PENDING', 'WRITING'] }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }] },
        data: { status: 'WRITING', leaseToken: token, leaseUntil: new Date(Date.now() + 90_000), attempts: { increment: 1 } },
      }));
      if (!claim.enabled || claim.value.count !== 1) continue;
      try {
        const message = dealTimelineMessage(row);
        let commentId: string | null = null;
        let complete = false;
        for (let start = 0; start < 2000;) {
          const body = await this.request(row.id, token, 'crm.timeline.comment.list', {
            'filter[ENTITY_ID]': row.bitrix24DealId, 'filter[ENTITY_TYPE]': 'deal', 'select[0]': 'ID', 'select[1]': 'COMMENT', start: String(start),
          });
          if (!Array.isArray(body.result)) throw new Error('TIMELINE_READ_INVALID');
          const existing = body.result.find((item: unknown) => isRecord(item) && item.COMMENT === message);
          if (isRecord(existing) && /^\d+$/.test(String(existing.ID))) { commentId = String(existing.ID); break; }
          if (body.next === undefined || body.next === null) { complete = true; break; }
          if (!Number.isInteger(body.next) || Number(body.next) <= start) throw new Error('TIMELINE_PAGE_INVALID');
          start = Number(body.next);
        }
        if (!commentId) {
          if (!complete) throw new Error('TIMELINE_READ_INCOMPLETE');
          const added = await this.request(row.id, token, 'crm.timeline.comment.add', {
            'fields[ENTITY_ID]': row.bitrix24DealId, 'fields[ENTITY_TYPE]': 'deal', 'fields[COMMENT]': message,
          });
          if (!/^\d+$/.test(String(added.result))) throw new Error('TIMELINE_ACK_INVALID');
          commentId = String(added.result);
        }
        await this.database.dealTimelineNotice.updateMany({ where: { id: row.id, status: 'WRITING', leaseToken: token },
          data: { status: 'POSTED', commentId, leaseToken: null, leaseUntil: null } });
      } catch (error) {
        await this.database.dealTimelineNotice.updateMany({ where: { id: row.id, status: 'WRITING', leaseToken: token }, data: {
          status: 'PENDING', leaseToken: null, leaseUntil: null, retryAfter: retryAtForFailure(error, row.attempts + 1),
        } });
      }
    }
  }

  private async request(id: string, token: string, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const base = process.env.BITRIX24_REST_BASE_URL;
    if (!base || new URL(base).protocol !== 'https:') throw new Error('TIMELINE_PROVIDER_NOT_CONFIGURED');
    const result = await withServiceModeOn(this.database, async (tx) => {
      const row = await tx.dealTimelineNotice.findUnique({ where: { id } });
      if (!row || row.status !== 'WRITING' || row.leaseToken !== token || !row.leaseUntil || row.leaseUntil.getTime() < Date.now() + 15_000) throw new Error('TIMELINE_LEASE_LOST');
      const directions = await tx.$queryRaw<Array<{ bitrix24ToMoysklad: boolean; moyskladToBitrix24: boolean }>>`
        SELECT "bitrix24ToMoysklad", "moyskladToBitrix24" FROM "SyncDirectionSetting" WHERE "entityKey"='deals-orders' FOR SHARE
      `;
      if (!directions[0] || !directions[0].bitrix24ToMoysklad && !directions[0].moyskladToBitrix24) throw new ServiceModeNotOnError();
      if (row.kind === 'ERROR' && row.reason !== 'DEAL_ORDER_PARTIAL_ROWS') {
        const newerSuccess = await tx.dealTimelineNotice.findFirst({ where: {
          bitrix24DealId: row.bitrix24DealId, kind: 'CREATED', createdAt: { gt: row.createdAt },
        }, select: { id: true } });
        if (newerSuccess) {
          await tx.dealTimelineNotice.update({ where: { id }, data: { status: 'SUPERSEDED', leaseToken: null, leaseUntil: null } });
          return { noticeSuperseded: true };
        }
      }
      if (method === 'crm.timeline.comment.add') assertApplyExternalWrite('BITRIX24', 'DEAL_TIMELINE_COMMENT', row.bitrix24DealId, 'DEAL');
      const response = await fetch(new URL(method + '.json', base.replace(/\/?$/, '/')), {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
        redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw providerResponseFailure('BITRIX24', response.status, response.headers.get('retry-after'));
      const body: unknown = await response.json();
      if (!isRecord(body) || body.error) throw new Error('TIMELINE_PROVIDER_REJECTED');
      return body;
    });
    if (!result.enabled) throw new ServiceModeNotOnError();
    if (result.value.noticeSuperseded) throw new Error('TIMELINE_ERROR_SUPERSEDED');
    return result.value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
