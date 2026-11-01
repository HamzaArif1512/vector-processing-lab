import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan} from '../src/benchmark/core.js';
import {measureJob,runBatch,Cancelled} from '../src/benchmark/engine.js';
class FakeWorker {
  static terminated=0;
  constructor(){this.events={message:new Set(),error:new Set()};this.dead=false;queueMicrotask(()=>this.emit('message',{data:{kind:'ready'}}));}
  addEventListener(k,f){this.events[k].add(f);}
  removeEventListener(k,f){this.events[k].delete(f);}
  emit(k,v){for(const fn of this.events[k])fn(v);}
  terminate(){this.dead=true;FakeWorker.terminated++;}
  postMessage(payload){
    if(this.dead)return;
    queueMicrotask(()=>{
      if(this.dead)return;
      const input=new Uint8Array(payload.buffer);
      let output;
      if(payload.kind==='histogram-count'){
        const counts=new Uint32Array(256);for(let i=0;i<input.length;i+=4)counts[input[i]]++;
        output=counts.buffer;
      }else if(payload.kind==='histogram-apply'){
        const lut=new Uint8Array(payload.lut);const data=input.slice();
        for(let i=0;i<data.length;i+=4)data[i]=data[i+1]=data[i+2]=lut[data[i]];
        output=data.buffer;
      }else{output=input.slice().buffer;}
      this.emit('message',{data:{kind:'result',buffer:output,kernelMs:2,times:[2]}});
    });
  }
}
globalThis.Worker=FakeWorker;
function image(w=8,h=7){const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=(i*17)%256;data[i+3]=255;}return {width:w,height:h,data};}
test('all four execution modes complete and workers are terminated',async()=>{
 const job=buildPlan({modes:[0]})[0];const result=await measureJob({image:image(),job,profile:'balanced',budgetRemainingMs:30000});
 assert.equal(result.status,'completed');assert.equal(result.strategies.length,4);assert.equal(result.maxDifference,0);
 assert.deepEqual(result.strategies.map(s=>s.kernel.n),[3,3,3,3]);assert.ok(FakeWorker.terminated>=5);
 assert.ok(result.strategies[3].efficiency>0);
});
test('histogram global stage uses shared LUT and outputs agree across partitions',async()=>{
 const job=buildPlan({modes:[6],workers:[4]})[0];const result=await measureJob({image:image(),job,profile:'quick'});
 assert.equal(result.status,'completed');assert.equal(result.maxDifference,0);
 assert.equal(result.strategies.length,4);assert.equal(result.strategies[0].kernel.n,1);
});
test('batch accumulates records and skips previously completed jobs on resume',async()=>{
 const jobs=buildPlan({modes:[0,1],workers:[2]});const results=[];
 const completed=await runBatch({jobs,imageProvider:async()=>image(),profile:'quick',budgetMs:20000,onRecord:r=>results.push(r)});
 assert.equal(completed.remaining,0);assert.equal(results.length,2);
 const rerun=await runBatch({jobs,imageProvider:async()=>image(),profile:'quick',budgetMs:20000,existing:completed.records,onRecord:()=>{throw Error('Should skip');}});
 assert.equal(rerun.records.length,2);
});
test('abort signal interrupts a batch before starting work',async()=>{
 const controller=new AbortController();controller.abort();
 await assert.rejects(runBatch({jobs:buildPlan({modes:[0]}),imageProvider:async()=>image(),signal:controller.signal}),Cancelled);
});
