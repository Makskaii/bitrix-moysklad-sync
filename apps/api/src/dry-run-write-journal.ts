import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from './database.service';

@Injectable()
export class DryRunWriteJournal {
  constructor(private readonly database: DatabaseService) {}

  async propose(input: {
    eventId?: string | null;
    provider: 'BITRIX24' | 'MOYSKLAD';
    entityType: string;
    entityId: string;
    operation: string;
    fields: Record<string, unknown>;
  }): Promise<boolean> {
    if (process.env.SYNC_MODE !== 'dry') return false;
    const id = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.database.dryRunWriteProposal.upsert({
      where: { id },
      create: { id, ...input, fields: input.fields as Prisma.InputJsonValue },
      update: { fields: input.fields as Prisma.InputJsonValue },
    });
    return true;
  }

  async readback(provider: 'BITRIX24' | 'MOYSKLAD', entityType: string, entityId: string): Promise<Record<string, unknown>> {
    if (process.env.SYNC_MODE !== 'dry') return {};
    const proposals = await this.database.dryRunWriteProposal.findMany({
      where: { provider, entityType, entityId },
      orderBy: { createdAt: 'asc' },
      select: { fields: true },
    });
    return proposals.reduce<Record<string, unknown>>((values, proposal) => ({ ...values, ...asRecord(proposal.fields) }), {});
  }

  async createdRecord(provider: 'BITRIX24' | 'MOYSKLAD', entityType: string, entityId: string): Promise<Record<string, unknown> | null> {
    if (process.env.SYNC_MODE !== 'dry') return null;
    const proposal = await this.database.dryRunWriteProposal.findFirst({
      where: { provider, entityType, entityId, operation: 'CREATE' },
      orderBy: { createdAt: 'asc' },
      select: { fields: true },
    });
    return proposal ? asRecord(proposal.fields) : null;
  }
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
