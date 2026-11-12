import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../src/server.mjs';
const TOKEN = 'SYNTHETIC-136-OBLIGATION';
const start={id:'000-legacy-owed',title:'synthetic',startedAt:'2026-01-01T00:00:00.000Z',events:[],notes:[],goalOffsets:{},meldAutoSession:true,platforms:{twitch:{streamId:'synthetic'}}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){for(let i=0;i<800;i++){const x=await fn();if(x)return x;await sleep(5)}throw Error('timeout '+label)}
async function receiver(t){const requests=[];const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;requests.push({body,auth:req.headers.authorization});res.end('{"result":"stored"}');});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r))});return {requests,url:`http://127.0.0.1:${server.address().port}/ingest`};}
async function fixture(t,factory,push){const root=await fs.mkdtemp(path.join(tmpdir(),'136-disabled-obligation-')),data=path.join(root,'data');await fs.mkdir(data);await fs.writeFile(path.join(data,'session-current.json'),JSON.stringify(start));let app;
 async function launch(config){app=await factory({dataDir:data,mediaDir:path.join(root,'media'),push:config,log:()=>{}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));}
 await launch(push);t.after(async()=>{await app.closeHttp().catch(()=>{});await fs.rm(root,{recursive:true,force:true})});
 return {data,get app(){return app},async restart(config){await app.closeHttp();await launch(config)},async request(method,url,body={}){const r=await fetch(`http://127.0.0.1:${app.server.address().port}${url}`,{method,headers:{'content-type':'application/json'},...(method==='POST'||method==='PUT'?{body:JSON.stringify(body)}:{})});return {status:r.status,text:await r.text()}}};}
test('S8 first enqueue of a pre-existing archive remains owed through disabled restart',async t=>{
 const r=await receiver(t),f=await fixture(t,createApp,{}),original=fs.open;t.after(()=>{fs.open=original});
 assert.equal((await f.request('POST','/api/session/end')).status,200);
 assert.equal((await f.request('POST','/api/session/new')).status,200);
 const before=await f.request('GET','/api/metrics/v1/sessions/000-legacy-owed');assert.equal(before.status,200);
 assert.equal((await f.request('PUT','/api/config',{sessions:{retention:1}})).status,200);
 fs.open=async function(file,...args){if(String(file).includes('.push-export.json.'))throw Error('synthetic checkpoint failure');return original.call(this,file,...args)};
 await f.restart({url:r.url,token:TOKEN});
 await until(async()=>{const st=JSON.parse((await f.request('GET','/api/status')).text).push;return st.lastError==='No se pudo guardar o leer la cola de envío.'},'first enabled enqueue failed');
 assert.deepEqual(r.requests,[]);
 for(let i=0;i<2;i++)assert.equal((await f.request('POST','/api/session/new')).status,200);
 assert.equal((await f.request('GET','/api/metrics/v1/sessions/000-legacy-owed')).status,200,'enabled process protects undurable archive');
 await f.restart({});
 for(let i=0;i<2;i++)assert.equal((await f.request('POST','/api/session/new')).status,200);
 await sleep(250);
 const after=await f.request('GET','/api/metrics/v1/sessions/000-legacy-owed'),status=JSON.parse((await f.request('GET','/api/status')).text).push;
 console.log('S8 previously_disabled_archive: before=',before.status,'first_enqueue=failed disabled_restart=',after.status,'body=',after.text,'status=',JSON.stringify(status),'requests=',r.requests.length);
 assert.equal(after.status,200,'the prior attempted enqueue remains owed, even if the archive predates enabling push');
 fs.open=original;await f.restart({url:r.url,token:TOKEN});await until(()=>r.requests.length===1,'owed legacy archive delivered');assert.equal(r.requests[0].auth,`Bearer ${TOKEN}`);const sent=JSON.parse(r.requests[0].body),expected=JSON.parse(before.text);assert.deepEqual({...sent,generatedAt:expected.generatedAt},expected);
});
test('S8 ordinary disabled retention remains unchanged',async t=>{
 const f=await fixture(t,createApp,{});
 assert.equal((await f.request('PUT','/api/config',{sessions:{retention:1}})).status,200);
 assert.equal((await f.request('POST','/api/session/end')).status,200);
 for(let i=0;i<2;i++)assert.equal((await f.request('POST','/api/session/new')).status,200);
 await sleep(100);
 assert.deepEqual(await f.request('GET','/api/metrics/v1/sessions/000-legacy-owed'),{status:404,text:'{"error":"No existe ese directo"}'});
});
