import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const binary = fs.readFileSync(new URL('../public/filters.wasm',import.meta.url));
const {instance:{exports:wasm}} = await WebAssembly.instantiate(binary);
for(let mode=0;mode<3;mode++){
  test(`SIMD matches scalar for mode ${mode} with nonmultiple-of-4 pixel count`,()=>{
    const count=103;
    const inputs=new Uint8Array(count*4);
    for(let i=0;i<count;i++){inputs[i*4]=i*3%256;inputs[i*4+1]=i*7%256;inputs[i*4+2]=i*11%256;inputs[i*4+3]=255}
    const scalar=new Uint8Array(wasm.memory.buffer,0,inputs.length);
    scalar.set(inputs);wasm.process_scalar(0,count,mode);
    const expected=scalar.slice();
    scalar.set(inputs);wasm.process_simd(0,count,mode);
    assert.deepEqual(scalar,expected);
  });
}
