import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const binary = fs.readFileSync(new URL('../public/filters.wasm', import.meta.url));
const { instance: { exports: wasm } } = await WebAssembly.instantiate(binary);
assert.equal(typeof wasm.sobel_scalar, 'function', 'Rebuild filters.wasm to add sobel_scalar');
assert.equal(typeof wasm.sobel_simd, 'function', 'Rebuild filters.wasm to add sobel_simd');

function run(input, width, height, simd = false) {
  const base = wasm.__heap_base.value;
  const src = Math.ceil(base / 16) * 16;
  const dst = Math.ceil((src + input.length) / 16) * 16;
  const required = dst + input.length;
  const pages = Math.ceil((required - wasm.memory.buffer.byteLength) / 65536);
  if (pages > 0) wasm.memory.grow(pages);
  const srcBytes = new Uint8Array(wasm.memory.buffer, src, input.length);
  const dstBytes = new Uint8Array(wasm.memory.buffer, dst, input.length);
  srcBytes.set(input);
  dstBytes.fill(0xcd);
  (simd ? wasm.sobel_simd : wasm.sobel_scalar)(src, dst, width, height);
  assert.deepEqual(srcBytes, input, 'source must stay unchanged');
  return dstBytes.slice();
}
function image(w,h) {
  const p=new Uint8Array(w*h*4);
  for(let i=0;i<p.length;i+=4) {
    p[i]=(i*37+11)%256;
    p[i+1]=(i*13+19)%256;
    p[i+2]=(i*7+101)%256;
    p[i+3]=(i/4*9+17)%256;
  }
  return p;
}
for (const [w,h] of [[1,1],[2,3],[3,7],[5,5],[13,9],[17,23],[100,73],[900,560]]) {
  test(`Sobel SIMD matches scalar exactly at ${w}x${h}`,()=>{
    const p=image(w,h),a=run(p,w,h),b=run(p,w,h,true);
    assert.deepEqual(a,b);
    for(let i=0;i<p.length;i+=4) {
      assert.equal(a[i],a[i+1]);
      assert.equal(a[i+1],a[i+2]);
      assert.equal(a[i+3],p[i+3]);
    }
  });
}
test('Sobel uniform image has zero edges',()=>{
  const w=17,h=11,p=new Uint8Array(w*h*4);
  for(let i=0;i<p.length;i+=4) {p[i]=p[i+1]=p[i+2]=90;p[i+3]=207;}
  const out=run(p,w,h,true);
  for(let i=0;i<p.length;i+=4) {assert.equal(out[i],0);assert.equal(out[i+3],207);}
});
test('Sobel detects a hard vertical boundary',()=>{
  const w=17,h=11,p=new Uint8Array(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++) {
    let i=4*(y*w+x),v=x<8?0:255;
    p[i]=p[i+1]=p[i+2]=v;p[i+3]=255;
  }
  const out=run(p,w,h,true);
  assert.equal(out[4*(5*w+2)],0);
  assert.equal(out[4*(5*w+7)],255);
  assert.equal(out[4*(5*w+8)],255);
  assert.equal(out[4*(5*w+14)],0);
});
for (const workers of [1,2,4,6,8]) {
  test(`Sobel halo partition/merge agrees with full image (${workers} workers)`,()=>{
    const w=17,h=23,row=w*4,p=image(w,h),expected=run(p,w,h),merged=new Uint8Array(p.length);
    for(let i=0;i<workers;i++) {
      const first=Math.floor(i*h/workers),last=Math.floor((i+1)*h/workers);
      if(first===last)continue;
      const haloFirst=Math.max(0,first-1),haloLast=Math.min(h,last+1);
      const part=run(p.subarray(haloFirst*row,haloLast*row),w,haloLast-haloFirst,true);
      const start=(first-haloFirst)*row;
      merged.set(part.subarray(start,start+(last-first)*row),first*row);
    }
    assert.deepEqual(merged,expected);
  });
}
