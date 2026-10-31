let wasm;
async function load() {
  const response = await fetch('/filters.wasm');
  if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
  const binary = await response.arrayBuffer();
  ({ instance: { exports: wasm } } = await WebAssembly.instantiate(binary));
  postMessage({ kind: 'ready' });
}
load().catch(error => postMessage({ kind: 'error', message: error.message }));

self.onmessage = ({ data }) => {
  if (!wasm || data.kind !== 'process') return;
  try {
    const { buffer, mode, technique, width, height, repetitions = 7 } = data;
    const incoming = new Uint8Array(buffer);
    const gaussian = technique === 'gaussian-scalar' || technique === 'gaussian-simd';
    if (gaussian && (!Number.isInteger(width) || !Number.isInteger(height) || incoming.length !== width * height * 4)) {
      throw new Error('Invalid Gaussian image dimensions');
    }
    const needed = incoming.byteLength;
    // Offset 16 keeps the source non-null and aligned, unlike offset 0.
    const srcOffset = 16;
    const dstOffset = (srcOffset + needed + 15) & ~15;
    const memoryNeeded = gaussian ? dstOffset + needed : srcOffset + needed;
    const pages = Math.ceil((memoryNeeded - wasm.memory.buffer.byteLength) / 65536);
    if (pages > 0) wasm.memory.grow(pages);
    const bytes = new Uint8Array(wasm.memory.buffer, srcOffset, needed);
    const outputBytes = gaussian ? new Uint8Array(wasm.memory.buffer, dstOffset, needed) : bytes;
    const fn = gaussian
      ? (technique === 'gaussian-simd' ? wasm.gaussian_blur_simd : wasm.gaussian_blur_scalar)
      : (technique === 'simd' ? wasm.process_simd : wasm.process_scalar);
    if (typeof fn !== 'function') throw new Error(`Missing WASM export for ${technique}. Rebuild filters.wasm.`);
    const times = [];
    for (let i = 0; i < repetitions; i++) {
      bytes.set(incoming);
      const start = performance.now();
      if (gaussian) fn(srcOffset, dstOffset, width, height, mode.kernelSize, mode.sigma);
      else fn(srcOffset, needed / 4, mode);
      times.push(performance.now() - start);
    }
    const output = outputBytes.slice().buffer;
    times.sort((a, b) => a - b);
    postMessage({ kind: 'result', buffer: output, ms: times[Math.floor(times.length / 2)], times }, [output]);
  } catch (error) { postMessage({ kind: 'error', message: error.message }); }
};
