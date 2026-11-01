import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlan,median,percentile,summarize,saltPepper,checksum,psnr,formatCSV,maximumDifference,speedup} from '../src/benchmark/core.js';
test('plan enumerates distinct valid algorithm configurations',()=>{
 const p=buildPlan({modes:[0,3,5],gaussianKernels:[3,5],medianKernels:[3,7],resolutions:[320,720],workers:[2,4]});
 assert.equal(p.length,20);assert.equal(new Set(p.map(x=>x.id)).size,p.length);
});
test('plan rejects oversized batches and bad configs',()=>{
 assert.throws(()=>buildPlan({modes:[0,1,2,3,4,5,6],gaussianKernels:[3,5,7,9],medianKernels:[3,5,7],resolutions:[320,480,720],workers:[2,4,6,8]}),/48/);
 assert.throws(()=>buildPlan({modes:[5],medianKernels:[4]}),/median/);
});
test('statistics are mathematically correct',()=>{
 assert.equal(median([4,1,3,2]),2.5);assert.equal(percentile([0,10,20],.25),5);
 const s=summarize([10,20,30]);assert.equal(s.n,3);assert.equal(s.medianMs,20);assert.equal(s.p75Ms,25);assert.ok(s.cv>0);
 assert.equal(speedup(10,2),5);assert.equal(speedup(10,0),null);
});
test('salt pepper deterministic and preserves alpha / original',()=>{
 const source={width:40,height:40,data:new Uint8ClampedArray(6400).fill(127)};
 const a=saltPepper(source,.2,123),b=saltPepper(source,.2,123),c=saltPepper(source,.2,124);
 assert.deepEqual(a.data,b.data);assert.notDeepEqual(a.data,c.data);
 for(let i=3;i<a.data.length;i+=4)assert.equal(a.data[i],127);
 assert.equal(source.data[0],127);assert.equal(checksum(source),checksum(source));
});
test('PSNR and differences',()=>{
 const im={width:1,height:1,data:new Uint8ClampedArray([100,100,100,255])};
 assert.equal(psnr(im,im.data),Infinity);
 assert.equal(maximumDifference(im.data,new Uint8Array([99,101,100,255])),1);
 assert.ok(psnr(im,new Uint8Array([0,0,0,255]))<20);
});
test('CSV escapes formulas and quotes as data',()=>{
 const csv=formatCSV([{name:'A, "B"',status:'skipped',timestamp:'2026-01-01',note:'test'}]);assert.match(csv,/"A, ""B"""/);
});
