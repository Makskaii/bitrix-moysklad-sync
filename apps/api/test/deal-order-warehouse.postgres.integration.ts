import 'reflect-metadata';
import { strict as assert } from 'node:assert';
import { before, after, test } from 'node:test';
import { createServer, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../src/database.service';
import { SyncModeService } from '../src/sync-mode.service';
import { DealOrderFieldRuntimeService, readDealOrderRuleField } from '../src/deals-orders/deal-order-field-runtime.service';
import { DealOrderBaselineService } from '../src/deals-orders/deal-order-baseline.service';
const db=new DatabaseService();let server:Server,base='',pair:any,service:DealOrderFieldRuntimeService;
const store=randomUUID(),unknown=randomUUID();let msStore=store,b24Store='',writes=0;
const rule:any={id:'warehouse',entity:'deals-orders',sourceField:'UF_CRM_1732004209',targetField:'store',criticality:'optional',bitrix24ToMoysklad:{enabled:false,transform:{kind:'tbd'}},moyskladToBitrix24:{enabled:true,transform:{kind:'reference-map',resource:'store',pairs:[{source:store,target:'8682'}]}}};
const config:any={version:1,config:{rules:[rule],groups:[],references:{units:[],priceTypes:[],dictionaries:[]},dealOrderRuntime:{stages:[],stores:[{bitrix24Id:'8682',moyskladId:store}],defaultStoreId:store,unmappedReferencePolicy:'confirmed-defaults'}}};
const reader:any={readBitrix24DealForBaseline:async()=>({UF_CRM_1732004209:b24Store}),readMoySkladCustomerOrderForBaseline:async()=>({store:{meta:{href:base+'entity/store/'+msStore,type:'store'}}})};
before(async()=>{
 const url=new URL(process.env.DATABASE_URL!);assert.equal(url.hostname,'127.0.0.1');assert.match(url.pathname,/root23_warehouse_test$/);assert.equal(process.env.ROOT23_WAREHOUSE_ISOLATED,'1');
 process.env.SYNC_MODE='apply';await db.syncSetting.upsert({where:{id:'global'},create:{serviceMode:'on'},update:{serviceMode:'on'}});
 await db.syncDirectionSetting.upsert({where:{entityKey:'deals-orders'},create:{entityKey:'deals-orders',bitrix24ToMoysklad:true,moyskladToBitrix24:true},update:{bitrix24ToMoysklad:true,moyskladToBitrix24:true}});
 pair=await db.entityPair.create({data:{entityType:'DEAL',bitrix24Id:'9902301',moyskladId:randomUUID(),source:'MANUAL'}});
 server=createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));assert.equal(req.url,'/rest/crm.deal.update.json');const params=new URLSearchParams(Buffer.concat(chunks).toString());assert.equal(params.get('id'),pair.bitrix24Id);b24Store=params.get('fields[UF_CRM_1732004209]')!;writes++;res.end(JSON.stringify({result:true}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert.ok(address&&typeof address!=='string');base=`http://127.0.0.1:${address.port}/`;process.env.BITRIX24_REST_BASE_URL=base+'rest/';process.env.MOYSKLAD_API_BASE_URL=base;
 service=new DealOrderFieldRuntimeService(db,reader,new SyncModeService(db));
});
after(async()=>{if(pair)await db.entityPair.delete({where:{id:pair.id}});await db.$disconnect();if(server)await new Promise<void>(r=>server.close(()=>r()));});
test('new baseline copies the native warehouse into an empty Bitrix field, repeats do not write',async()=>{
 const baseline=new DealOrderBaselineService(db,reader);assert.equal((await baseline.ensureForConfirmedPair({pair,eventId:'warehouse-baseline',eventConfig:config})).status,'READY');
 assert.deepEqual(await service.process({pair,eventId:'warehouse-first',eventConfig:config}),{status:'SYNCED',heldRules:0});assert.equal(b24Store,'8682');assert.equal(writes,1);
 await service.process({pair,eventId:'warehouse-repeat',eventConfig:config});assert.equal(writes,1);
});
test('unknown native warehouse uses only the approved configured default and does not write MySklad',async()=>{
 msStore=unknown;b24Store='';await service.process({pair,eventId:'warehouse-fallback',eventConfig:config});assert.equal(b24Store,'8682');assert.equal(writes,2);
});
test('settings revision copies native warehouse and refuses foreign reference URLs',async()=>{
 msStore=store;b24Store='';const prior:any={version:0,config:{...config.config,rules:[]}};
 assert.equal((await service.reconcileRevisionMappings({pair,eventId:'warehouse-rebase',oldConfig:prior,newConfig:config,assertLease:async()=>true})).status,'verified');assert.equal(b24Store,'8682');assert.equal(writes,3);
 assert.equal(readDealOrderRuleField({store:{meta:{href:'https://foreign.invalid/entity/store/'+store,type:'store'}}},rule,'MOYSKLAD').supported,false);
 assert.deepEqual(readDealOrderRuleField({UF_CRM_1732004209:8682},rule,'BITRIX24'),{supported:true,value:'8682'});
});
