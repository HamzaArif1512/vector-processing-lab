import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const binary = fs.readFileSync(new URL('../public/filters.wasm', import.meta.url));
const {instance:{exports:wasm}} = await WebAssembly.instantiate(binary);
function alloc(len) {
  const source=16, dest=(source+len+15)&~15;
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
  new Uint8Array(wasm.memory.buffer,source,input.length).set(input);
  const f=simd?wasm.gaussian_blur_simd:wasm.gaussian_blur_scalar;
  assert.equal(typeof f,'function');f(source,dest,w,h,k,sigma);
  return new Uint8Array(wasm.memory.buffer,dest,input.length).slice();
}
for(const [w,h,k,sigma] of [[1,1,3,1],[3,7,5,1.5],[13,9,7,1],[31,27,15,3],[41,13,31,8]]){
  test(`Gaussian SIMD and scalar agree ${w}x${h} kernel ${k}`,()=>{
    const input=new Uint8Array(w*h*4);
    for(let i=0;i<input.length;i++)input[i]=(i*89+13)%256;
    const a=blur(input,w,h,k,sigma,false),b=blur(input,w,h,k,sigma,true);
    let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));
    assert.ok(max<=1,`max channel difference ${max}`);
    for(let i=3;i<input.length;i+=4)assert.equal(a[i],input[i]);
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
