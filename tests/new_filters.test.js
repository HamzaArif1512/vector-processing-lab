import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {histogramLut} from '../src/histogram.js';
const bytes=fs.readFileSync(new URL('../public/filters.wasm',import.meta.url));
const {instance:{exports:wasm}}=await WebAssembly.instantiate(bytes);
const funcs=['median_filter_scalar','median_filter_simd','histogram_count_scalar','histogram_count_simd','histogram_apply_scalar','histogram_apply_simd','brightness_custom_scalar','brightness_custom_simd'];
for(const f of funcs)assert.equal(typeof wasm[f],'function',`Missing ${f}; rebuild public/filters.wasm`);
function memory(n){
 const src=(wasm.__heap_base.value+15)&~15,dst=(src+n+15)&~15,aux=(dst+n+15)&~15;
 const required=aux+2048,pages=Math.ceil((required-wasm.memory.buffer.byteLength)/65536);
 if(pages>0)wasm.memory.grow(pages);
 return {src,dst,aux};
}
function sample(w,h){let p=new Uint8Array(w*h*4);for(let i=0;i<p.length;i+=4){p[i]=(i*31+17)%256;p[i+1]=(i*19+29)%256;p[i+2]=(i*13+43)%256;p[i+3]=(i*7+151)%256;}return p;}
function med(p,w,h,k,simd){const {src,dst}=memory(p.length);new Uint8Array(wasm.memory.buffer,src,p.length).set(p);(simd?wasm.median_filter_simd:wasm.median_filter_scalar)(src,dst,w,h,k);return new Uint8Array(wasm.memory.buffer,dst,p.length).slice();}
function bright(p,amount,simd){const {src}=memory(p.length);const view=new Uint8Array(wasm.memory.buffer,src,p.length);view.set(p);(simd?wasm.brightness_custom_simd:wasm.brightness_custom_scalar)(src,p.length/4,amount);return view.slice();}
function count(p,simd){const {src,aux}=memory(p.length);new Uint8Array(wasm.memory.buffer,src,p.length).set(p);(simd?wasm.histogram_count_simd:wasm.histogram_count_scalar)(src,p.length/4,aux);return new Uint32Array(wasm.memory.buffer,aux,256).slice();}
function apply(p,lut,simd){const {src,dst,aux}=memory(p.length);new Uint8Array(wasm.memory.buffer,src,p.length).set(p);new Uint8Array(wasm.memory.buffer,aux,256).set(lut);(simd?wasm.histogram_apply_simd:wasm.histogram_apply_scalar)(src,dst,p.length/4,aux);return new Uint8Array(wasm.memory.buffer,dst,p.length).slice();}
for(const [w,h] of [[1,1],[2,3],[3,5],[7,11],[17,23],[44,37]])for(const k of [3,5,7])test(`Median scalar/SIMD exact ${w}x${h} ${k}x${k}`,()=>{
 const input=sample(w,h),a=med(input,w,h,k,false),b=med(input,w,h,k,true);assert.deepEqual(b,a);
 for(let i=3;i<input.length;i+=4)assert.equal(a[i],input[i]);
});
for(const k of [3,5,7])for(const workers of [1,2,4,8])test(`Median parallel halo ${k}x${k}, ${workers} workers`,()=>{
 const w=17,h=23,p=sample(w,h),expected=med(p,w,h,k,false),actual=new Uint8Array(p.length),row=w*4,r=k>>1;
 for(let i=0;i<workers;i++){const first=Math.floor(i*h/workers),last=Math.floor((i+1)*h/workers),lo=Math.max(0,first-r),hi=Math.min(h,last+r),part=med(p.subarray(lo*row,hi*row),w,hi-lo,k,true);actual.set(part.subarray((first-lo)*row,(last-lo)*row),first*row);}
 assert.deepEqual(actual,expected);
});
for(const v of [-100,-40,-1,0,1,40,100])test(`Brightness SIMD exact ${v}`,()=>{
 const p=sample(37,23),a=bright(p,v,false),b=bright(p,v,true);assert.deepEqual(a,b);
 for(let i=3;i<p.length;i+=4)assert.equal(a[i],p[i]);
});
for(const [w,h] of [[1,1],[2,3],[13,9],[31,25]])test(`Histogram exact ${w}x${h} and parallel aggregation`,()=>{
 const p=sample(w,h),a=count(p,false),b=count(p,true);assert.deepEqual(a,b);assert.equal(a.reduce((s,x)=>s+x,0),w*h);
 const parts=3,merged=new Uint32Array(256),row=w*4;
 for(let i=0;i<parts;i++){const first=Math.floor(i*h/parts),last=Math.floor((i+1)*h/parts);if(first===last)continue;const local=count(p.subarray(first*row,last*row),true);for(let j=0;j<256;j++)merged[j]+=local[j];}
 assert.deepEqual(merged,a);
 const lut=histogramLut(a),x=apply(p,lut,false),y=apply(p,lut,true);assert.deepEqual(x,y);
 for(let i=0;i<p.length;i+=4){assert.equal(x[i],x[i+1]);assert.equal(x[i+1],x[i+2]);assert.equal(x[i+3],p[i+3]);}
});
test('Uniform histogram maps intensity to itself',()=>{
 const p=new Uint8Array(8*8*4);for(let i=0;i<p.length;i+=4){p[i]=p[i+1]=p[i+2]=91;p[i+3]=200;}
 const lut=histogramLut(count(p,false));assert.equal(lut[91],91);assert.deepEqual(apply(p,lut,false),p);
});
