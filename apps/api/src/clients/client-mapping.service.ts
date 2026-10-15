import { BadRequestException, ConflictException, Injectable, Optional, Inject } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database.service';
import { lockEntityPairState } from '../pairs/pair-db-lock';
import { ClientInventoryProvider, HttpClientInventoryProvider, ClientInventoryEntity, ClientPage, BitrixClientRow, MoyskladClientRow } from './client-inventory.provider';
import { ClientMapDecision, planInitialClientMap } from './client-map';

export const CLIENT_INVENTORY_PROVIDER = Symbol('CLIENT_INVENTORY_PROVIDER');
const JOB_ID = 'client-map';
const LEASE_MS = 90_000;

type Job = {
  id: string; status: string; phase: string; bitrix24CompanyStart: number; bitrix24ContactStart: number;
  moyskladCounterpartyOffset: number; moyskladContactpersonParentOffset: number; moyskladContactpersonOffset: number;
  bitrix24CompanyProcessed: number; bitrix24ContactProcessed: number; moyskladCounterpartyProcessed: number;
  moyskladContactpersonProcessed: number; attempts: number; error: string | null; checkpointAt: Date | null;
  leaseOwner: string | null; leaseUntil: Date | null; pauseRequested: boolean; updatedAt: Date;
};

@Injectable()
export class ClientMappingService {
  private activeOwner: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    @Optional() @Inject(CLIENT_INVENTORY_PROVIDER) private readonly provider: ClientInventoryProvider = new HttpClientInventoryProvider(),
  ) {}

  async readStatus() {
    return this.ensureJob();
  }

  async start(accessToken: unknown) {
    if (typeof accessToken !== 'string' || !accessToken.trim() || accessToken.length > 4096) {
      throw new BadRequestException('An active Bitrix24 administrator session is required to start client mapping.');
    }
    const current = await this.ensureJob();
    if (current.status === 'complete') return current;
    const now = new Date();
    if (current.leaseUntil && current.leaseUntil > now) return current;
    const owner = randomUUID();
    const claim = await this.database.clientInventoryJob.updateMany({
      where: { id: JOB_ID, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      data: { status: 'running', error: null, pauseRequested: false, leaseOwner: owner, leaseUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (claim.count !== 1) return this.ensureJob();
    this.activeOwner = owner;
    void this.run(owner, accessToken.trim());
    return this.ensureJob();
  }

  async pause() {
    const job = await this.ensureJob();
    if (job.status !== 'running') throw new ConflictException('Client mapping is not running.');
    await this.database.clientInventoryJob.update({ where: { id: JOB_ID }, data: { pauseRequested: true } });
    return this.ensureJob();
  }

  async listUnmatched(entityType?: ClientInventoryEntity, cursor?: string) {
    if (entityType !== undefined && entityType !== 'COMPANY' && entityType !== 'CONTACT') throw new BadRequestException('entityType must be COMPANY or CONTACT');
    const after = cursor ? parseCursor(cursor) : null;
    const rows = await this.database.clientInventoryObject.findMany({
      where: {
        system: 'BITRIX24', status: 'UNMATCHED', ...(entityType ? { entityType } : {}),
        ...(after ? { OR: [{ entityType: { gt: after.entityType } }, { entityType: after.entityType, externalId: { gt: after.externalId } }] } : {}),
      },
      orderBy: [{ entityType: 'asc' }, { externalId: 'asc' }], take: 100,
      select: { entityType: true, externalId: true, matchValue: true, reason: true, observedAt: true },
    });
    const last = rows[rows.length - 1];
    return { entries: rows, nextCursor: rows.length === 100 && last ? `${last.entityType}:${last.externalId}` : null };
  }

  private async run(owner: string, accessToken: string) {
    try {
      let job = await this.database.clientInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job;
      while (job.phase !== 'COMPLETE') {
        if (await this.pauseRequested(owner)) return;
        if (job.phase === 'BITRIX24_COMPANIES' || job.phase === 'BITRIX24_CONTACTS') {
          const entity: ClientInventoryEntity = job.phase === 'BITRIX24_COMPANIES' ? 'COMPANY' : 'CONTACT';
          const start = entity === 'COMPANY' ? job.bitrix24CompanyStart : job.bitrix24ContactStart;
          const page = await this.provider.bitrixPage(entity, start, accessToken);
          assertPage(page, start);
          await this.saveBitrixPage(entity, page.rows, owner);
          job = await this.checkpoint(owner, entity === 'COMPANY' ? {
            bitrix24CompanyStart: page.next ?? 0,
            bitrix24CompanyProcessed: { increment: page.rows.length },
            phase: page.next === null ? 'BITRIX24_CONTACTS' : 'BITRIX24_COMPANIES',
          } : {
            bitrix24ContactStart: page.next ?? 0,
            bitrix24ContactProcessed: { increment: page.rows.length },
            phase: page.next === null ? 'MOYSKLAD_COUNTERPARTIES' : 'BITRIX24_CONTACTS',
          });
          continue;
        }

        if (job.phase === 'MOYSKLAD_COUNTERPARTIES') {
          const page = await this.provider.counterpartyPage(job.moyskladCounterpartyOffset);
          assertPage(page, job.moyskladCounterpartyOffset);
          await this.saveMoyskladPage('counterparty', page.rows, owner);
          job = await this.checkpoint(owner, {
            moyskladCounterpartyOffset: page.next ?? 0,
            moyskladCounterpartyProcessed: { increment: page.rows.length },
            phase: page.next === null ? 'MOYSKLAD_CONTACTPERSONS' : 'MOYSKLAD_COUNTERPARTIES',
          });
          continue;
        }

        if (job.phase === 'MOYSKLAD_CONTACTPERSONS') {
          const parents = await this.provider.counterpartyPage(job.moyskladContactpersonParentOffset);
          assertPage(parents, job.moyskladContactpersonParentOffset);
          if (!parents.rows.length && parents.next !== null) throw new Error('CLIENT_INVENTORY_EMPTY_PAGE');
          for (const parent of parents.rows) {
            if (await this.pauseRequested(owner)) return;
            let offset = 0;
            while (true) {
              const page = await this.provider.contactpersonPage(parent.id, offset);
              assertPage(page, offset);
              await this.saveMoyskladPage('contactperson', page.rows.map((row) => ({ ...row, parentId: parent.id })), owner);
              await this.checkLease(owner);
              if (page.next === null) break;
              offset = page.next;
            }
          }
          job = await this.checkpoint(owner, {
            moyskladContactpersonParentOffset: parents.next ?? 0,
            moyskladContactpersonOffset: 0,
            moyskladContactpersonProcessed: { increment: parents.rows.length },
            phase: parents.next === null ? 'RECONCILE' : 'MOYSKLAD_CONTACTPERSONS',
          });
          continue;
        }

        if (job.phase === 'RECONCILE') {
          await this.reconcile(owner);
          job = await this.checkpoint(owner, { phase: 'COMPLETE', status: 'complete', leaseOwner: null, leaseUntil: null, error: null });
          return;
        }
        throw new Error('CLIENT_INVENTORY_PHASE_INVALID');
      }
    } catch (error) {
      const safeError = error instanceof Error && /^[A-Z0-9_]{1,100}$/.test(error.message) ? error.message : 'CLIENT_INVENTORY_PROVIDER_FAILURE';
      await this.database.clientInventoryJob.updateMany({
        where: { id: JOB_ID, leaseOwner: owner },
        data: { status: 'failed', error: safeError, attempts: { increment: 1 }, leaseOwner: null, leaseUntil: null, checkpointAt: new Date() },
      }).catch(() => undefined);
    } finally {
      if (this.activeOwner === owner) this.activeOwner = null;
    }
  }

  private async saveBitrixPage(entityType: ClientInventoryEntity, rows: BitrixClientRow[], owner: string) {
    for (const row of rows) {
      await this.database.clientInventoryObject.upsert({
        where: { system_entityType_externalId: { system: 'BITRIX24', entityType, externalId: row.id } },
        create: { system: 'BITRIX24', entityType, nativeType: entityType === 'COMPANY' ? 'company' : 'contact', externalId: row.id, matchValue: row.uuid, status: 'PENDING' },
        update: { matchValue: row.uuid, status: 'PENDING', reason: null, observedAt: new Date() },
      });
      await this.checkLease(owner);
    }
  }

  private async saveMoyskladPage(nativeType: 'counterparty' | 'contactperson', rows: MoyskladClientRow[], owner: string) {
    for (const row of rows) {
      const entityTypes: ClientInventoryEntity[] = nativeType === 'counterparty' ? ['COMPANY', 'CONTACT'] : ['CONTACT'];
      for (const entityType of entityTypes) {
        await this.database.clientInventoryObject.upsert({
          where: { system_entityType_externalId: { system: 'MOYSKLAD', entityType, externalId: row.id } },
          create: { system: 'MOYSKLAD', entityType, nativeType, externalId: row.id, parentId: row.parentId ?? null, companyType: nativeType === 'counterparty' ? row.companyType ?? null : null, status: 'INVENTORIED' },
          update: { nativeType, parentId: row.parentId ?? null, companyType: nativeType === 'counterparty' ? row.companyType ?? null : null, status: 'INVENTORIED', reason: null, observedAt: new Date() },
        });
      }
      await this.checkLease(owner);
    }
  }

  private async reconcile(owner: string) {
    const bitrixSources = await this.database.clientInventoryObject.findMany({
      where: { system: 'BITRIX24' }, select: { entityType: true, externalId: true, matchValue: true },
    });
    const moyskladTargets = await this.database.clientInventoryObject.findMany({
      where: { system: 'MOYSKLAD' }, select: { entityType: true, nativeType: true, externalId: true, parentId: true, companyType: true },
    });
    for (const entity of ['COMPANY', 'CONTACT'] as const) {
      const sources = bitrixSources.filter((row) => row.entityType === entity).map((row) => ({ entity, bitrix24Id: row.externalId, uuid: row.matchValue }));
      const targets = moyskladTargets.filter((row) => row.entityType === entity).map((row) => ({ id: row.externalId, type: row.nativeType as 'counterparty' | 'contactperson', parentId: row.parentId, companyType: row.companyType }));
      await this.reconcileEntity(entity, sources, targets, owner);
    }
  }

  private async reconcileEntity(
    entity: ClientInventoryEntity,
    sources: Array<{ entity: ClientInventoryEntity; bitrix24Id: string; uuid: string | null }>,
    targets: Array<{ id: string; type: 'counterparty' | 'contactperson'; parentId?: string | null; companyType?: string | null }>,
    owner: string,
  ) {
    await this.database.$transaction(async (transaction) => {
      await lockEntityPairState(transaction);
      const currentPairs = await transaction.entityPair.findMany({ where: { entityType: entity, active: true }, select: { entityType: true, bitrix24Id: true, moyskladId: true, moyskladType: true, moyskladParentId: true } });
      const legacyPairs = entity === 'CONTACT'
        ? await transaction.contactPair.findMany({ where: { active: true }, select: { bitrix24ContactId: true, moyskladCounterpartyId: true, moyskladType: true } })
        : [];
      const preservedPairs = [
        ...currentPairs.map((pair) => ({ entity: pair.entityType as ClientInventoryEntity, bitrix24Id: pair.bitrix24Id, moyskladId: pair.moyskladId, moyskladType: targetType(pair.moyskladType), moyskladParentId: pair.moyskladParentId })),
        ...legacyPairs.map((pair) => ({ entity: 'CONTACT' as const, bitrix24Id: pair.bitrix24ContactId, moyskladId: pair.moyskladCounterpartyId, moyskladType: targetType(pair.moyskladType), moyskladParentId: null })),
      ];
      const decisions = planInitialClientMap({ sources, targets, activePairs: preservedPairs, inventoryComplete: true });
      for (const decision of decisions) {
        if (decision.status === 'MATCHED' && decision.source === 'UUID') {
          try {
            await transaction.entityPair.create({
              data: {
                entityType: entity, bitrix24Id: decision.bitrix24Id, moyskladId: decision.moyskladId,
                moyskladType: decision.moyskladType, moyskladParentId: decision.moyskladParentId,
                active: true, source: 'UUID', reason: 'PRIMARY_UUID_MAP',
              },
            });
          } catch {
            throw new Error('CLIENT_PAIR_CONFLICT');
          }
        }
        if (decision.status === 'MATCHED' && decision.source === 'EXISTING' && entity === 'CONTACT') {
          const canonical = await transaction.entityPair.findFirst({ where: { entityType: 'CONTACT', bitrix24Id: decision.bitrix24Id, moyskladId: decision.moyskladId, active: true } });
          if (!canonical) {
            const conflict = await transaction.entityPair.findFirst({
              where: { entityType: 'CONTACT', active: true, OR: [{ bitrix24Id: decision.bitrix24Id }, { moyskladId: decision.moyskladId }] },
            });
            if (!conflict) await transaction.entityPair.create({
              data: {
                entityType: 'CONTACT', bitrix24Id: decision.bitrix24Id, moyskladId: decision.moyskladId,
                moyskladType: decision.moyskladType, moyskladParentId: decision.moyskladParentId,
                active: true, source: 'LEGACY', reason: 'PRESERVED_CONTACT_PAIR',
              },
            });
          }
        }
        const status = decision.status === 'MATCHED' ? 'MATCHED' : 'UNMATCHED';
        await transaction.clientInventoryObject.update({
          where: { system_entityType_externalId: { system: 'BITRIX24', entityType: entity, externalId: decision.bitrix24Id } },
          data: { status, reason: decision.status === 'UNMATCHED' ? decision.reason : null },
        });
      }
    }, { isolationLevel: 'Serializable', timeout: 60_000 });
    await this.checkLease(owner);
  }

  private async pauseRequested(owner: string) {
    const job = await this.database.clientInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job | null;
    if (job?.leaseOwner !== owner) return true;
    if (!job.pauseRequested) return false;
    await this.database.clientInventoryJob.updateMany({ where: { id: JOB_ID, leaseOwner: owner }, data: { status: 'paused', pauseRequested: false, leaseOwner: null, leaseUntil: null, checkpointAt: new Date() } });
    return true;
  }

  private async checkLease(owner: string) {
    const now = new Date();
    const updated = await this.database.clientInventoryJob.updateMany({ where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: now } }, data: { leaseUntil: new Date(now.getTime() + LEASE_MS) } });
    if (updated.count !== 1) throw new Error('CLIENT_INVENTORY_LEASE_LOST');
  }

  private async checkpoint(owner: string, data: Prisma.ClientInventoryJobUpdateInput): Promise<Job> {
    const now = new Date();
    const updated = await this.database.clientInventoryJob.updateMany({
      where: { id: JOB_ID, leaseOwner: owner, leaseUntil: { gt: now } },
      data: { ...data, leaseUntil: new Date(now.getTime() + LEASE_MS), checkpointAt: now },
    });
    if (updated.count !== 1) throw new Error('CLIENT_INVENTORY_LEASE_LOST');
    return await this.database.clientInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job;
  }

  private async ensureJob(): Promise<Job> {
    try {
      return await this.database.clientInventoryJob.upsert({ where: { id: JOB_ID }, create: { id: JOB_ID }, update: {} }) as Job;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.database.clientInventoryJob.findUnique({ where: { id: JOB_ID } }) as Job | null;
        if (existing) return existing;
      }
      throw error;
    }
  }
}

function assertPage<T>(page: ClientPage<T>, requested: number) {
  if (!Array.isArray(page.rows) || (page.next !== null && (!Number.isInteger(page.next) || page.next <= requested || page.rows.length === 0))) throw new Error('CLIENT_INVENTORY_PAGE_INVALID');
}

function targetType(value: string | null): 'counterparty' | 'contactperson' | null {
  if (value?.toLocaleLowerCase('en-US') === 'contactperson') return 'contactperson';
  if (value?.toLocaleLowerCase('en-US') === 'counterparty') return 'counterparty';
  return null;
}

function parseCursor(value: string): { entityType: ClientInventoryEntity; externalId: string } {
  const separator = value.indexOf(':');
  const entityType = value.slice(0, separator);
  const externalId = value.slice(separator + 1);
  if (separator < 1 || (entityType !== 'COMPANY' && entityType !== 'CONTACT') || !externalId) throw new BadRequestException('cursor is invalid');
  return { entityType, externalId };
}

export function clientMapDecisionSummary(decision: ClientMapDecision): string {
  return decision.status === 'MATCHED' ? `${decision.source}:${decision.moyskladType}` : decision.reason;
}
