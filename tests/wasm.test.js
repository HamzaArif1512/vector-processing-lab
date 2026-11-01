import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const binary = fs.readFileSync(new URL('../public/filters.wasm', import.meta.url));
const {instance:{exports:wasm}} = await WebAssembly.instantiate(binary);
function alloc(len) {
  const heapBase=wasm.__heap_base ? wasm.__heap_base.value : 65536;
  const source=(heapBase+15)&~15, dest=(source+len+15)&~15;
  const pages=Math.ceil((dest+len-wasm.memory.buffer.byteLength)/65536);
  if(pages>0)wasm.memory.grow(pages);
  return {source,dest};
}
for(let mode=0;mode<3;mode++)test(`Existing SIMD mode ${mode} matches scalar`,()=>{
  const n=103, input=new Uint8Array(n*4);
  for(let i=0;i<input.length;i++)input[i]=(i*17+5)%256;
  const {source}=alloc(input.length);
  const bytes=new Uint8Array(wasm.memory.buffer,source,input.length);
  bytes.set(input);wasm.process_scalar(source,n,mode);const expected=bytes.slice();
  bytes.set(input);wasm.process_simd(source,n,mode);assert.deepEqual(bytes,expected);
});
function blur(input,w,h,k,sigma,simd){
  const {source,dest}=alloc(input.length);
  const sourceBytes=new Uint8Array(wasm.memory.buffer,source,input.length);
  const destinationBytes=new Uint8Array(wasm.memory.buffer,dest,input.length);
  sourceBytes.set(input);
  destinationBytes.fill(0xcd);
  const f=simd?wasm.gaussian_blur_simd:wasm.gaussian_blur_scalar;
  assert.equal(typeof f,'function');f(source,dest,w,h,k,sigma);
  return {
    output: destinationBytes.slice(),
    source: sourceBytes.slice(),
    sourceOffset: source,
    destinationOffset: dest,
  };
}
for(const [w,h,k,sigma] of [[1,1,3,0.5],[3,7,5,1.5],[13,9,7,1],[41,13,31,8],[100,100,15,3],[900,560,5,10]]){
  test(`Gaussian SIMD and scalar agree ${w}x${h} kernel ${k}`,()=>{
    const input=new Uint8Array(w*h*4);
    for(let i=0;i<input.length;i+=4){input[i]=(i*89+13)%256;input[i+1]=(i*37+7)%256;input[i+2]=(i*19+3)%256;input[i+3]=255-(i/4)%37}
    const a=blur(input,w,h,k,sigma,false),b=blur(input,w,h,k,sigma,true);
    let max=0;for(let i=0;i<a.output.length;i++)max=Math.max(max,Math.abs(a.output[i]-b.output[i]));
    assert.ok(max<=1,`max channel difference ${max}`);
    assert.deepEqual(a.source,input);
    assert.deepEqual(b.source,input);
    assert.notEqual(a.sourceOffset,a.destinationOffset);
    assert.notEqual(b.sourceOffset,b.destinationOffset);
    assert.deepEqual(a.output,b.output);
    for(let i=3;i<a.output.length;i+=4)assert.equal(a.output[i],input[i]);
  });
}
test('Large image allocation keeps source and destination disjoint',()=>{
  const w=1800,h=1200,len=w*h*4,{source,dest}=alloc(len);
  assert.ok(dest >= source + len);
  assert.ok(dest + len <= wasm.memory.buffer.byteLength);
});
for (const workers of [1, 2, 4, 6, 8]) {
  test(`Gaussian halo merge handles ${workers} workers`,()=>{
    const w=17,h=23,k=7,sigma=1.5,r=k>>1,row=w*4;
    const input=new Uint8Array(w*h*4);
    for(let i=0;i<input.length;i++)input[i]=(i*53+29)%256;
    const baseline=blur(input,w,h,k,sigma,false).output,merged=new Uint8Array(input.length);
    for(let i=0;i<workers;i++){
      const first=Math.floor(i*h/workers),last=Math.floor((i+1)*h/workers);
      if(first===last)continue;
      const haloFirst=Math.max(0,first-r),haloLast=Math.min(h,last+r);
      const result=blur(input.subarray(haloFirst*row,haloLast*row),w,haloLast-haloFirst,k,sigma,true).output;
      const start=(first-haloFirst)*row;
      merged.set(result.subarray(start,start+(last-first)*row),first*row);
    }
    let max=0;for(let i=0;i<merged.length;i++)max=Math.max(max,Math.abs(merged[i]-baseline[i]));
    assert.ok(max<=1,`halo mismatch: ${max}`);
  });
}
test('Halo-row partition yields same Gaussian output',()=>{
  const w=17,h=23,k=9,sigma=2,workers=4,r=k>>1,row=w*4;
  const input=new Uint8Array(w*h*4);
  for(let i=0;i<input.length;i++)input[i]=(i*37+11)%256;
  const baseline=blur(input,w,h,k,sigma,false),merged=new Uint8Array(input.length);
  for(let i=0;i<workers;i++){
    const first=Math.floor(i*h/workers),last=Math.floor((i+1)*h/workers);
    const haloFirst=Math.max(0,first-r),haloLast=Math.min(h,last+r);
    const sub=input.subarray(haloFirst*row,haloLast*row);
    const result=blur(sub,w,haloLast-haloFirst,k,sigma,true);
    const start=(first-haloFirst)*row;
    merged.set(result.subarray(start,start+(last-first)*row),first*row);
  }
  let max=0;for(let i=0;i<merged.length;i++)max=Math.max(max,Math.abs(merged[i]-baseline[i]));
  assert.ok(max<=1,`halo mismatch: ${max}`);
});
