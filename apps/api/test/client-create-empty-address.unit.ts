import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HttpClientCandidateGateway } from '../src/clients/client-candidate.gateway';
import { HttpClientSyncGateway } from '../src/clients/client-sync.gateway';

const targetId = '33333333-3333-4333-8333-333333333333';
const fakeDatabase = {} as never;
function setup() {
  process.env.MOYSKLAD_API_BASE_URL = 'https://empty-address.fake/api/remap/1.2/';
  process.env.MOYSKLAD_API_TOKEN = 'synthetic-empty-address-token';
}

test('new company omits only absent optional address and does not mutate configured fields', async () => {
  setup();
  for (const actualAddress of [null, undefined]) {
    const configuredFields = { actualAddress, phone: '', email: '', description: 'test', legalAddress: null };
    let writes = 0;
    const gateway = new HttpClientCandidateGateway(fakeDatabase, async (input, init) => {
      writes++;
      assert.equal(String(input), 'https://empty-address.fake/api/remap/1.2/entity/counterparty');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(Object.hasOwn(body, 'actualAddress'), false);
      assert.deepEqual(body, { name: 'Test empty address', phone: '', email: '', description: 'test', legalAddress: null });
      return new Response(JSON.stringify({ id: targetId }), { status: 200 });
    });
    assert.equal(await gateway.createTarget({ entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty',
      parentId: null, source: { TITLE: 'Test empty address' }, configuredFields }), targetId);
    assert.equal(writes, 1);
    assert.equal(configuredFields.actualAddress, actualAddress);
  }
});

test('new company retains explicit non-null address exactly, including an empty string', async () => {
  setup();
  for (const actualAddress of ['Test address', '']) {
    const gateway = new HttpClientCandidateGateway(fakeDatabase, async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).actualAddress, actualAddress);
      return new Response(JSON.stringify({ id: targetId }), { status: 200 });
    });
    await gateway.createTarget({ entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null,
      source: { TITLE: 'Test address' }, configuredFields: { actualAddress } });
  }
});

test('existing company explicit address clear still sends null on PUT', async () => {
  setup();
  let writes = 0;
  const gateway = new HttpClientSyncGateway(async (input, init) => {
    writes++;
    assert.equal(String(input), `https://empty-address.fake/api/remap/1.2/entity/counterparty/${targetId}`);
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init?.body)), { actualAddress: null });
    return new Response(null, { status: 204 });
  });
  await gateway.updateMoysklad('counterparty', targetId, null, { actualAddress: null });
  assert.equal(writes, 1);
});

test('required company name validation is unchanged', async () => {
  setup();
  const gateway = new HttpClientCandidateGateway(fakeDatabase, async () => { assert.fail('invalid name must not reach transport'); });
  await assert.rejects(gateway.createTarget({ entity: 'COMPANY', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null,
    source: { TITLE: '' }, configuredFields: { actualAddress: null } }), /CLIENT_CREATE_REQUIRED_NAME_MISSING/);
});

test('contact create payload is not changed by company-only omission', async () => {
  setup();
  const gateway = new HttpClientCandidateGateway(fakeDatabase, async (_input, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { name: 'Test contact', actualAddress: null, companyType: 'individual' });
    return new Response(JSON.stringify({ id: targetId }), { status: 200 });
  });
  await gateway.createTarget({ entity: 'CONTACT', targetSystem: 'MOYSKLAD', targetType: 'counterparty', parentId: null,
    source: { NAME: 'Test contact' }, configuredFields: { actualAddress: null } });
});
