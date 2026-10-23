import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createControlledLiveTestPolicy, withControlledLiveEventScope } from '../src/controlled-live-test-policy';
import { installControlledLiveFetchGuard, setControlledLiveTestWriteCheck } from '../src/external-write-guard';
import { setVerifiedControlledLiveProviderNamespace } from '../src/controlled-live-test-namespace';

test('invoice row reads require an exact SI owner and reject other invoices, DEAL collisions and broad filters before transport', async () => {
  const keys = ['CONTROLLED_LIVE_TEST_MODE','BITRIX24_REST_BASE_URL','MOYSKLAD_API_BASE_URL'];
  const old = keys.map((key) => process.env[key]);
  const fetch = globalThis.fetch;
  const ns = { bitrix24PortalOrigin:'https://invoice-guard.invalid',bitrix24UserId:'42',moyskladAccountId:'02888dd3-d515-11e2-63af-7054d21a8d1e' };
  const runId = 'LIVE-TEST-20261021T0856Z-root00';
  const name = `тест ${runId} invoice`;
  const nativeInvoice = '922ad01a-cd39-11f1-0a80-0d2d0074384b';
  let calls = 0;
  try {
    process.env.CONTROLLED_LIVE_TEST_MODE = 'enabled';
    process.env.BITRIX24_REST_BASE_URL = ns.bitrix24PortalOrigin+'/rest/';
    process.env.MOYSKLAD_API_BASE_URL = 'https://invoice-ms.invalid/api/remap/1.2/';
    globalThis.fetch = async () => { calls++; return Response.json({ result:{ productRows:[] } }); };
    setVerifiedControlledLiveProviderNamespace(ns);
    setControlledLiveTestWriteCheck(createControlledLiveTestPolicy({ runId,providerNamespace:ns,testDatabaseName:'sync_invoice_guard_test',testSchemaName:'invoice_guard_test',records:[{
      entity:'invoice',direction:'BITRIX24_TO_MOYSKLAD',name,syntheticOnly:true,sourceSystem:'BITRIX24',sourceNativeId:'7982',targetSystem:'MOYSKLAD',targetNativeId:nativeInvoice,createdAfterUtc:'2026-10-21T08:56:00Z',allowedActions:['UPDATE'],
    }]},'postgresql://localhost/sync_invoice_guard_test?schema=invoice_guard_test'));
    installControlledLiveFetchGuard(ns);
    await withControlledLiveEventScope({eventId:'invoice-guard-event',runId,entity:'invoice',sourceSystem:'BITRIX24',sourceNativeId:'7982',targetSystem:'MOYSKLAD',targetNativeId:nativeInvoice,admittedSourceName:name,admittedSourceCreatedAt:'2026-10-21T09:00:00Z'}, async () => {
      const read = (body: Record<string,string>) => globalThis.fetch(ns.bitrix24PortalOrigin+'/rest/crm.item.productrow.list.json',{method:'POST',body:new URLSearchParams(body)});
      await read({'filter[=ownerType]':'SI','filter[=ownerId]':'7982',start:'0'});
      await assert.rejects(read({'filter[=ownerType]':'SI','filter[=ownerId]':'7984',start:'0'}));
      await assert.rejects(read({'filter[=ownerType]':'D','filter[=ownerId]':'7982',start:'0'}));
      await assert.rejects(read({'filter[=ownerType]':'SI',start:'0'}));
      await assert.rejects(read({'filter[=ownerType]':'SI','filter[=ownerId]':'7982','filter[productId]':'50070'}));
      const msBase = process.env.MOYSKLAD_API_BASE_URL!;
      await globalThis.fetch(msBase+`entity/invoiceout/${nativeInvoice}/positions/${nativeInvoice}`,{method:'PUT',body:'{"quantity":2}'});
      await globalThis.fetch(msBase+`entity/invoiceout/${nativeInvoice}/positions`,{method:'POST',body:'{"quantity":1}'});
      await assert.rejects(globalThis.fetch(msBase+'entity/invoiceout/ffffffff-ffff-ffff-ffff-ffffffffffff/positions',{method:'POST',body:'{"quantity":1}'}));
    });
    assert.equal(calls,3);
  } finally {
    globalThis.fetch = fetch;
    setControlledLiveTestWriteCheck(null);
    keys.forEach((key,index) => { if(old[index]===undefined) delete process.env[key]; else process.env[key]=old[index]; });
  }
});
