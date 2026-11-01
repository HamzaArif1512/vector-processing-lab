let wasm;
async function load() {
  const response = await fetch('/filters.wasm');
  if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
  const binary = await response.arrayBuffer();
  ({ instance: { exports: wasm } } = await WebAssembly.instantiate(binary));
  postMessage({ kind: 'ready' });
}
load().catch(error => postMessage({ kind: 'error', message: error.message }));

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

self.onmessage = ({ data }) => {
  if (data.kind === 'histogram-count' || data.kind === 'histogram-apply') {
    if (!wasm) return;
    histogramRequest(data).catch(error => postMessage({kind:'error',message:error.message}));
    return;
  }
  if (!wasm || data.kind !== 'process') return;
  try {
    const { buffer, mode, technique, width, height, repetitions = 7 } = data;
    const incoming = new Uint8Array(buffer);
    const gaussian = technique === 'gaussian-scalar' || technique === 'gaussian-simd';
    const sobel = technique === 'sobel-scalar' || technique === 'sobel-simd';
    const median = technique === 'median-scalar' || technique === 'median-simd';
    const brightness = technique === 'brightness-scalar' || technique === 'brightness-simd';
    if ((gaussian || sobel || median) && (!Number.isInteger(width) || !Number.isInteger(height) || incoming.length !== width * height * 4)) {
      throw new Error('Invalid Gaussian image dimensions');
    }
    const needed = incoming.byteLength;
    // Offset 16 keeps the source non-null and aligned, unlike offset 0.
    if (!wasm.__heap_base) {
      throw new Error(
        'WASM __heap_base export missing. Rebuild filters.wasm.'
      );
    }

    const heapBase = wasm.__heap_base.value;

    const srcOffset = (heapBase + 15) & ~15;
    const dstOffset = (srcOffset + needed + 15) & ~15;
    const memoryNeeded = (gaussian || sobel || median) ? dstOffset + needed : srcOffset + needed;
    const pages = Math.ceil((memoryNeeded - wasm.memory.buffer.byteLength) / 65536);
    if (pages > 0) wasm.memory.grow(pages);
    const bytes = new Uint8Array(wasm.memory.buffer, srcOffset, needed);
    const outputBytes = (gaussian || sobel || median) ? new Uint8Array(wasm.memory.buffer, dstOffset, needed) : bytes;
    const fn = gaussian
      ? (technique === 'gaussian-simd' ? wasm.gaussian_blur_simd : wasm.gaussian_blur_scalar)
      : sobel ? (technique === 'sobel-simd' ? wasm.sobel_simd : wasm.sobel_scalar)
      : median ? (technique === 'median-simd' ? wasm.median_filter_simd : wasm.median_filter_scalar)
      : brightness ? (technique === 'brightness-simd' ? wasm.brightness_custom_simd : wasm.brightness_custom_scalar)
      : (technique === 'simd' ? wasm.process_simd : wasm.process_scalar);
    if (typeof fn !== 'function') throw new Error(`Missing WASM export for ${technique}. Rebuild filters.wasm.`);
    const warmup = () => {
      bytes.set(incoming);
      if (gaussian) fn(srcOffset, dstOffset, width, height, mode.kernelSize, mode.sigma);
      else if (sobel) fn(srcOffset, dstOffset, width, height);
      else if (median) fn(srcOffset, dstOffset, width, height, mode.kernelSize);
      else if (brightness) fn(srcOffset, needed / 4, mode.amount);
      else fn(srcOffset, needed / 4, mode);
    };
    warmup();
    const times = [];
    for (let i = 0; i < repetitions; i++) {
      bytes.set(incoming);
      const start = performance.now();
      if (gaussian) fn(srcOffset, dstOffset, width, height, mode.kernelSize, mode.sigma);
      else if (sobel) fn(srcOffset, dstOffset, width, height);
      else if (median) fn(srcOffset, dstOffset, width, height, mode.kernelSize);
      else if (brightness) fn(srcOffset, needed / 4, mode.amount);
      else fn(srcOffset, needed / 4, mode);
      times.push(performance.now() - start);
    }
    const output = outputBytes.slice().buffer;
    times.sort((a, b) => a - b);
    const kernelMs = times[Math.floor(times.length / 2)];
    postMessage({ kind: 'result', buffer: output, ms: kernelMs, kernelMs, times }, [output]);
  } catch (error) { postMessage({ kind: 'error', message: error.message }); }
};
