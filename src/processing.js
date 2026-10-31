export const MODES = [
  { value: 0, label: 'Grayscale', summary: 'Weighted RGB luminance' },
  { value: 1, label: 'Color inversion', summary: 'Invert each RGB channel' },
  { value: 2, label: 'Brightness +40', summary: 'Saturating addition per channel' },
  { value: 3, label: 'Gaussian blur', summary: 'Scalar convolution with configurable kernel' },
];

function spawn() {
  const worker = new Worker(new URL('./runner.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.kind === 'ready') resolve(worker);
      if (data.kind === 'error') { worker.terminate(); reject(new Error(data.message)); }
    };
    worker.onerror = (error) => { worker.terminate(); reject(new Error(error.message)); };
  });
}

function execute(worker, imageData, mode, technique) {
  return new Promise((resolve, reject) => {
    const pixels = imageData.data ?? imageData;
    const sourceBuffer = pixels.slice().buffer;
    const destinationBuffer = technique === 'gaussian'
      ? new ArrayBuffer(sourceBuffer.byteLength)
      : null;
    worker.onmessage = ({ data }) => {
      if (data.kind === 'result') resolve({ image: new Uint8ClampedArray(data.buffer), ms: data.ms });
      if (data.kind === 'error') reject(new Error(data.message));
    };
    worker.onerror = error => reject(new Error(error.message));
    const message = {
      kind: 'process',
      mode,
      technique,
      buffer: sourceBuffer,
      width: imageData.width,
      height: imageData.height,
    };
    const transfer = [sourceBuffer];
    if (destinationBuffer) {
      message.destinationBuffer = destinationBuffer;
      transfer.push(destinationBuffer);
    }
    worker.postMessage(message, transfer);
  });
}

export async function gaussianBlur(image, kernelSize = 5, sigma = 1) {
  const worker = await spawn();
  try {
    const result = await execute(worker, image, {
      kernelSize,
      sigma,
    }, 'gaussian');
    return new ImageData(result.image, image.width, image.height);
  } finally {
    worker.terminate();
  }
}

export async function benchmark(image, mode, workersCount = 4) {
  const pixels = image.data;
  const runners = [];
  try {
    const single = await spawn();
    runners.push(single);
    const scalar = await execute(single, pixels, mode, 'scalar');
    const simd = await execute(single, pixels, mode, 'simd');
    const n = Math.min(workersCount, Math.max(1, image.height));
    const parallelWorkers = await Promise.all(Array.from({ length: n }, () => spawn()));
    runners.push(...parallelWorkers);
    const rowSize = image.width * 4;
    const boundaries = Array.from({length: n}, (_, i) => [
      Math.floor(i * image.height / n) * rowSize,
      Math.floor((i + 1) * image.height / n) * rowSize,
    ]);
    const start = performance.now();
    const parts = await Promise.all(parallelWorkers.map((worker, i) => {
      const [begin, end] = boundaries[i];
      return execute(worker, pixels.subarray(begin, end), mode, 'scalar');
    }));
    const wallMs = performance.now() - start;
    const merged = new Uint8ClampedArray(pixels.length);
    parts.forEach((part, i) => merged.set(part.image, boundaries[i][0]));
    const consistent = scalar.image.every((value, i) => value === simd.image[i] && value === merged[i]);
    if (!consistent) throw new Error('Implementations disagree. Benchmark was rejected.');
    return {
      image: new ImageData(simd.image, image.width, image.height),
      results: [
        { label: 'Scalar WASM', ms: scalar.ms, detail: 'Single worker · C scalar' },
        { label: 'SIMD WASM', ms: simd.ms, detail: 'Single worker · SIMD128' },
        { label: `Parallel (${n})`, ms: wallMs, detail: 'Multi-worker · includes messaging' },
      ],
      consistent,
    };
  } finally { runners.forEach(worker => worker.terminate()); }
}
