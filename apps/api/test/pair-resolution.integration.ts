import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EntityPairService } from '../src/pairs/entity-pair.service';
import { PairResolutionProvider } from '../src/pairs/pair-resolution.provider';

type Pair = {
  id: string; entityType: string; bitrix24Id: string; moyskladId: string;
  moyskladType?: string | null; moyskladParentId?: string | null;
  active: boolean; source: string; reason: string | null; createdAt: Date;
};
type Review = {
  id: string; entityType: string; sourceSystem: string; sourceEntityId: string;
  eventId: string | null; reason: string; status: string; openedAt: Date;
};

function createDatabase() {
  const pairs: Pair[] = [];
  const reviews: Review[] = [];
  let nextId = 0;
  const requeueCalls: unknown[] = [];
  const database = {
    pairs,
    reviews,
    requeueCalls,
    entityPair: {
      findFirst: async ({ where }: { where: Partial<Pair> }) => pairs.find((pair) =>
        Object.entries(where).every(([key, value]) => pair[key as keyof Pair] === value)) ?? null,
      findMany: async ({ where }: { where: Partial<Pair> & { OR?: Array<Partial<Pair>> } }) => pairs.filter((pair) => {
        const { OR, ...conditions } = where;
        const matches = Object.entries(conditions).every(([key, value]) => pair[key as keyof Pair] === value);
        return matches && (!OR || OR.some((condition) => Object.entries(condition).every(([key, value]) => pair[key as keyof Pair] === value)));
      }),
      create: async ({ data }: { data: Omit<Pair, 'id' | 'createdAt'> }) => {
        const pair = { ...data, id: `pair-${++nextId}`, createdAt: new Date('2026-10-07T00:00:00Z') };
        pairs.push(pair);
        return pair;
      },
      updateMany: async ({ where, data }: { where: Partial<Pair> & { id?: { in: string[] } }; data: Partial<Pair> }) => {
        const matches = pairs.filter((pair) => Object.entries(where).every(([key, value]) => key === 'id' && typeof value === 'object' && value !== null && 'in' in value
          ? (value as { in: string[] }).in.includes(pair.id)
          : pair[key as keyof Pair] === value));
        matches.forEach((pair) => Object.assign(pair, data));
        return { count: matches.length };
      },
    },
    pairReviewCase: {
      findFirst: async ({ where }: { where: Partial<Review> }) => reviews.find((review) =>
        Object.entries(where).every(([key, value]) => review[key as keyof Review] === value)) ?? null,
      create: async ({ data }: { data: Omit<Review, 'id' | 'openedAt'> & { eventId?: string | null; status?: string } }) => {
        const review = { ...data, eventId: data.eventId ?? null, status: data.status ?? 'OPEN', id: `review-${++nextId}`, openedAt: new Date('2026-10-07T00:00:00Z') };
        reviews.push(review);
        return review;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Review> }) => {
        const review = reviews.find((candidate) => candidate.id === where.id);
        if (!review) throw new Error('review not found');
        Object.assign(review, data);
        return review;
      },
      findMany: async ({ where }: { where: Partial<Review> }) => reviews.filter((review) =>
        Object.entries(where).every(([key, value]) => review[key as keyof Review] === value)),
      updateMany: async ({ where, data }: { where: Partial<Review>; data: Partial<Review> }) => {
        const matches = reviews.filter((review) => Object.entries(where).every(([key, value]) => review[key as keyof Review] === value));
        matches.forEach((review) => Object.assign(review, data));
        return { count: matches.length };
      },
    },
    clientInventoryObject: { updateMany: async () => ({ count: 0 }) },
    inboundEvent: { updateMany: async (args: unknown) => { requeueCalls.push(args); return { count: 0 }; } },
    $queryRaw: async () => [],
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>) => operation(database as unknown),
  };
  return database;
}

test('an unpaired event is held for manual review rather than guessed or marked unmatched', async () => {
  const database = createDatabase();
  const provider = new PairResolutionProvider(database as never);

  const result = await provider.resolve({ entityType: 'DEAL', sourceSystem: 'BITRIX24', externalId: 'deal-42', eventId: 'event-1' });

  assert.equal(result.status, 'manual_review');
  if (result.status !== 'manual_review') return;
  assert.equal(result.reason, 'NO_APPROVED_MATCH_KEY');
  assert.equal(database.reviews.length, 1);
  assert.equal(database.reviews[0].sourceEntityId, 'deal-42');
});

test('a unique conflict while opening a review re-reads the winning open case', async () => {
  const database = createDatabase();
  const originalCreate = database.pairReviewCase.create;
  database.pairReviewCase.create = async (args) => {
    await originalCreate(args);
    throw Object.assign(new Error('simulated concurrent unique insert'), { code: 'P2002' });
  };
  const provider = new PairResolutionProvider(database as never);

  const result = await provider.resolve({ entityType: 'DEAL', sourceSystem: 'BITRIX24', externalId: 'racing-deal' });

  assert.equal(result.status, 'manual_review');
  if (result.status !== 'manual_review') return;
  assert.equal(result.reviewCaseId, 'review-1');
  assert.equal(database.reviews.length, 1);
});

test('a saved pair resolves by either side and stays authoritative', async () => {
  const database = createDatabase();
  const pairs = new EntityPairService(database as never);
  const provider = new PairResolutionProvider(database as never);
  const saved = await pairs.assign({ entityType: 'DEAL', bitrix24Id: 'deal-42', moyskladId: 'order-9' });

  const result = await provider.resolve({ entityType: 'DEAL', sourceSystem: 'MOYSKLAD', externalId: 'order-9' });

  assert.equal(result.status, 'confirmed');
  if (result.status !== 'confirmed') return;
  assert.equal(result.pair.id, saved.id);
  assert.equal(result.pair.bitrix24Id, 'deal-42');
  assert.equal(result.pair.moyskladId, 'order-9');
  assert.equal(result.pair.source, 'PERSISTED');
});

test('manual reassignment requires an explicit replace flag and keeps prior assignment history', async () => {
  const database = createDatabase();
  const pairs = new EntityPairService(database as never);
  const original = await pairs.assign({ entityType: 'DEAL', bitrix24Id: 'deal-42', moyskladId: 'order-9' });

  await assert.rejects(() => pairs.assign({ entityType: 'DEAL', bitrix24Id: 'deal-42', moyskladId: 'order-10' }), /PAIR_ALREADY_ASSIGNED/);
  const replacement = await pairs.assign({ entityType: 'DEAL', bitrix24Id: 'deal-42', moyskladId: 'order-10', replaceExisting: true });

  assert.equal(database.pairs.find((pair) => pair.id === original.id)?.active, false);
  assert.equal(replacement.active, true);
  assert.equal((await pairs.listActive('DEAL')).length, 1);
});

test('manual CONTACT pairs require a native MoySklad type and parent ID for nested contacts', async () => {
  const database = createDatabase();
  const pairs = new EntityPairService(database as never);
  await assert.rejects(() => pairs.assign({ entityType: 'CONTACT', bitrix24Id: 'b24-contact', moyskladId: 'ms-contact' }), /moyskladType/);
  await assert.rejects(() => pairs.assign({ entityType: 'CONTACT', bitrix24Id: 'b24-contact', moyskladId: 'ms-contact', moyskladType: 'contactperson' }), /parent counterparty ID/);
  const saved = await pairs.assign({ entityType: 'CONTACT', bitrix24Id: 'b24-contact', moyskladId: 'ms-contact', moyskladType: 'contactperson', moyskladParentId: 'ms-parent' });
  assert.equal(saved.moyskladType, 'contactperson');
  assert.equal(saved.moyskladParentId, 'ms-parent');
  assert.equal(database.requeueCalls.length, 0, 'contact-pair correction must not release historical document events in bulk');
});

