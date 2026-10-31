let wasm;
async function load() {
  const response = await fetch('/filters.wasm');
  const binary = await response.arrayBuffer();
  ({ instance: { exports: wasm } } = await WebAssembly.instantiate(binary));
  postMessage({ kind: 'ready' });
}
load().catch(error => postMessage({ kind: 'error', message: error.message }));

self.onmessage = ({ data }) => {
  if (!wasm || data.kind !== 'process') return;
  try {
    const { buffer, destinationBuffer, mode, technique, width, height, repetitions = 7 } = data;
    const incoming = new Uint8Array(buffer);
    const needed = incoming.byteLength;
    const destination = technique === 'gaussian'
      ? new Uint8Array(destinationBuffer)
      : null;
    const sourceOffset = technique === 'gaussian' ? 1 : 0;
    const destinationOffset = sourceOffset + needed;
    const memoryNeeded = technique === 'gaussian' ? destinationOffset + needed : needed;
    const pages = Math.ceil((memoryNeeded - wasm.memory.buffer.byteLength) / 65536);
    if (pages > 0) wasm.memory.grow(pages);
    const bytes = new Uint8Array(wasm.memory.buffer, sourceOffset, needed);
    const outputBytes = technique === 'gaussian'
      ? new Uint8Array(wasm.memory.buffer, destinationOffset, needed)
      : bytes;
    const fn = technique === 'simd' ? wasm.process_simd : wasm.process_scalar;
    const times = [];
    for (let i = 0; i < repetitions; i++) {
      const start = performance.now();
      if (technique === 'gaussian') {
        bytes.set(incoming);
        wasm.gaussian_blur_scalar(
          sourceOffset,
          destinationOffset,
          width,
          height,
          mode.kernelSize,
          mode.sigma,
        );
      } else {
        bytes.set(incoming);
        fn(0, needed / 4, mode);
      }
      times.push(performance.now() - start);
    }
    if (destination) destination.set(outputBytes);
    const output = (destination || outputBytes).slice().buffer;
    times.sort((a, b) => a - b);
    postMessage({ kind: 'result', buffer: output, ms: times[Math.floor(times.length / 2)], times }, [output]);
  } catch (error) { postMessage({ kind: 'error', message: error.message }); }
};
