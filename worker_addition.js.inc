// Specialized two-stage histogram requests. The same WASM instance is reused.
async function histogramRequest(data){
  const {kind,buffer,simd,lut,repetitions=7}=data;
  const incoming=new Uint8Array(buffer);
  if(incoming.length===0||incoming.length%4)throw new Error('Invalid histogram RGBA buffer');
  if(!wasm.__heap_base)throw new Error('WASM heap base missing');
  const base=(wasm.__heap_base.value+15)&~15;
  const src=base,dst=(src+incoming.length+15)&~15;
  const aux=(dst+incoming.length+15)&~15;
  const required=aux+1024;
  const pages=Math.ceil((required-wasm.memory.buffer.byteLength)/65536);
  if(pages>0)wasm.memory.grow(pages);
  const srcBytes=new Uint8Array(wasm.memory.buffer,src,incoming.length);
  const dstBytes=new Uint8Array(wasm.memory.buffer,dst,incoming.length);
  const countFn=simd?wasm.histogram_count_simd:wasm.histogram_count_scalar;
  const applyFn=simd?wasm.histogram_apply_simd:wasm.histogram_apply_scalar;
  if(typeof countFn!=='function'||typeof applyFn!=='function')throw new Error('Rebuild WASM: histogram exports missing');
  const mapping=kind==='histogram-apply'?new Uint8Array(lut):null;
  if(mapping&&mapping.length!==256)throw new Error('Expected 256-entry histogram lookup table');
  if(mapping)new Uint8Array(wasm.memory.buffer,aux,256).set(mapping);
  const run=()=>{
    srcBytes.set(incoming);
    if(kind==='histogram-count')countFn(src,incoming.length/4,aux);
    else applyFn(src,dst,incoming.length/4,aux);
  };
  run();
  const times=[];
  for(let i=0;i<repetitions;i++){
    const start=performance.now();run();times.push(performance.now()-start);
  }
  times.sort((a,b)=>a-b);
  const output=kind==='histogram-count'
    ?new Uint8Array(wasm.memory.buffer,aux,1024).slice().buffer
    :dstBytes.slice().buffer;
  postMessage({kind:'result',buffer:output,kernelMs:times[Math.floor(times.length/2)]},[output]);
}
