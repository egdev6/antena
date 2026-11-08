import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { Bus } from '../src/bus.mjs';
import { WsResponse } from '../src/ws-stream.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('S4/S5: real backpressured socket drains ordered ephemeral burst exactly once', {timeout:10000}, async t=>{
  let socket, res, falseWrites=0, socketDrains=0, responseDrains=0;
  const server=net.createServer(s=>{
    socket=s; const write=s.write.bind(s);
    s.write=(...args)=>{const ok=write(...args); if(!ok) falseWrites++; return ok;};
    s.on('drain',()=>socketDrains++); res=new WsResponse(s); res.on('drain',()=>responseDrains++);
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const peer=net.connect(server.address().port,'127.0.0.1'); peer.pause(); peer.on('error',()=>{});
  t.after(()=>{peer.destroy();socket?.destroy();server.close();});
  await once(peer,'connect'); while(!res) await wait(2);
  const bus=new Bus({byteBudget:16*1024*1024}); const client=bus.addClient(res,'widget');
  const expected=Array.from({length:40},(_,i)=>`event: chat\ndata: ${JSON.stringify({i,text:'x'.repeat(96*1024)})}\n\n`);
  for(let i=0;i<40;i++) bus.send('chat',{i,text:'x'.repeat(96*1024)},['widget']);
  await wait(150); const chunks=[]; let bytes=0;
  peer.on('data',b=>{chunks.push(b);bytes+=b.length;}); peer.resume();
  const need=expected.reduce((n,s)=>n+Buffer.byteLength(s)+10,0), deadline=Date.now()+5000;
  while((bytes<need || client.blocked) && Date.now()<deadline) await wait(5);
  assert.equal(bytes,need); assert.equal(client.blocked,false);
  const data=Buffer.concat(chunks); let offset=0; const actual=[];
  while(offset<data.length){
    assert.equal(data[offset++],0x81); assert.equal(data[offset++],127);
    const n=Number(data.readBigUInt64BE(offset)); offset+=8;
    actual.push(data.subarray(offset,offset+n).toString()); offset+=n;
  }
  assert.deepEqual(actual,expected); assert.ok(falseWrites>0); assert.ok(socketDrains>0); assert.ok(responseDrains>0);
  const before=responseDrains; socket.emit('drain'); assert.equal(responseDrains,before,'spurious drain');
  console.log(`real burst bytes=${bytes} falseWrites=${falseWrites} socketDrains=${socketDrains} responseDrains=${responseDrains}`);
});
