import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { parseExpectedNamespace, verifyControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';

const accountId = '11111111-1111-1111-63af-111111111111';
let server: Server;
let origin = '';
let currentBitrixUserId = '42';
let currentMoyskladAccountId = accountId;
let observed: string[] = [];

before(async () => {
  server = createServer(async (request, response) => {
    observed.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/rest/user.current.json' && request.method === 'POST') {
      response.end(JSON.stringify({ result: { ID: currentBitrixUserId } }));
      return;
    }
    if (request.url === '/api/remap/1.2/context/employee' && request.method === 'GET') {
      response.end(JSON.stringify({ id: 'employee-id', accountId: currentMoyskladAccountId }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const options = () => ({
  bitrix24RestBaseUrl: `${origin}/rest/`,
  moyskladApiBaseUrl: `${origin}/api/remap/1.2/`,
  moyskladApiToken: 'fake-only-token',
  allowLoopbackHttp: true,
});
const manifest = () => ({
  bitrix24PortalOrigin: origin,
  bitrix24UserId: '42',
  moyskladAccountId: accountId,
});

test('provider namespace verification matches portal origin and read-only current credential identities', async () => {
  observed = [];
  const verified = await verifyControlledLiveProviderNamespace(manifest(), options());
  assert.deepEqual(verified, { ...manifest() });
  assert.deepEqual(observed, ['POST /rest/user.current.json', 'GET /api/remap/1.2/context/employee']);
});

test('provider account IDs accept UUID-shaped MoySklad values without RFC variant assumptions', async () => {
  const verified = await verifyControlledLiveProviderNamespace(manifest(), options());
  assert.equal(verified.moyskladAccountId, accountId);
  assert.throws(() => parseExpectedNamespace({ ...manifest(), moyskladAccountId: 'not-a-provider-account-id' }), /PROVIDER_NAMESPACE_INVALID/);
});

test('provider namespace verification rejects wrong portal, wrong current principal, and wrong account', async () => {
  await assert.rejects(verifyControlledLiveProviderNamespace({ ...manifest(), bitrix24PortalOrigin: 'https://other.example' }, options()), /BITRIX24_PORTAL_ORIGIN_MISMATCH/);
  currentBitrixUserId = '43';
  await assert.rejects(verifyControlledLiveProviderNamespace(manifest(), options()), /BITRIX24_CREDENTIAL_IDENTITY_MISMATCH/);
  currentBitrixUserId = '42';
  currentMoyskladAccountId = '21111111-1111-1111-63af-111111111111';
  await assert.rejects(verifyControlledLiveProviderNamespace(manifest(), options()), /MOYSKLAD_ACCOUNT_IDENTITY_MISMATCH/);
  currentMoyskladAccountId = accountId;
});

test('namespace verifier refuses remote HTTP and credential-bearing or ambiguous base URLs', async () => {
  await assert.rejects(verifyControlledLiveProviderNamespace({ ...manifest(), bitrix24PortalOrigin: 'https://portal.example' }, { ...options(), allowLoopbackHttp: false }), /PROVIDER_BASE_URL_MUST_USE_HTTPS/);
  await assert.rejects(verifyControlledLiveProviderNamespace({ ...manifest(), bitrix24PortalOrigin: 'https://portal.example' }, {
    ...options(), bitrix24RestBaseUrl: 'http://portal.example/rest/', moyskladApiBaseUrl: 'http://portal.example/api/remap/1.2/', allowLoopbackHttp: true,
  }), /PROVIDER_BASE_URL_MUST_USE_HTTPS/);
  await assert.rejects(verifyControlledLiveProviderNamespace(manifest(), { ...options(), bitrix24RestBaseUrl: 'ftp://127.0.0.1/rest/' }), /PROVIDER_BASE_URL_MUST_USE_HTTPS/);
  await assert.rejects(verifyControlledLiveProviderNamespace(manifest(), { ...options(), bitrix24RestBaseUrl: `http://user:secret@127.0.0.1:${new URL(origin).port}/rest/` }), /PROVIDER_BASE_URL_INVALID/);
  await assert.rejects(verifyControlledLiveProviderNamespace(manifest(), { ...options(), bitrix24RestBaseUrl: `${origin}/rest/?token=secret` }), /PROVIDER_BASE_URL_INVALID/);
});
