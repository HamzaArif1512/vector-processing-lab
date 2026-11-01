import { benchmarkHistogram } from './histogram.js';
export const MODES = [
  { value: 0, label: 'Grayscale', summary: 'Weighted RGB luminance' },
  { value: 1, label: 'Color inversion', summary: 'Invert each RGB channel' },
  { value: 2, label: 'Brightness adjustment', summary: 'Configurable signed brightness with saturating arithmetic' },
  { value: 3, label: 'Gaussian blur', summary: 'Configurable Gaussian convolution · Scalar / SIMD / Workers' },
  { value: 4, label: 'Sobel edge detection', summary: 'Fixed 3×3 grayscale edge detector · Scalar / SIMD / Workers' },
  { value: 5, label: 'Median filter', summary: 'Custom 3×3 / 5×5 / 7×7 RGB median filtering' },
  { value: 6, label: 'Histogram equalization', summary: 'Global grayscale CDF equalization with parallel histogram merging' },
];

function spawn() {
  const worker = new Worker(new URL('./runner.worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.kind === 'ready') resolve(worker);
      if (data.kind === 'error') { worker.terminate(); reject(new Error(data.message)); }
    };
    worker.onerror = error => { worker.terminate(); reject(new Error(error.message)); };
  });
}
function execute(worker, pixels, mode, technique, width, height) {
  return new Promise((resolve, reject) => {
    const sourceBuffer = pixels.slice().buffer;
    const started = performance.now();
    worker.onmessage = ({ data }) => {
      if (data.kind === 'result') {
        resolve({
          image: new Uint8ClampedArray(data.buffer),
          kernelMs: data.kernelMs,
          e2eMs: performance.now() - started,
        });
      }
      if (data.kind === 'error') reject(new Error(data.message));
    };
    worker.onerror = error => reject(new Error(error.message));
    worker.postMessage({ kind: 'process', mode, technique, buffer: sourceBuffer, width, height }, [sourceBuffer]);
  });
}
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function identical(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
function maxDifference(a, b) {
  if (a.length !== b.length) return Infinity;
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta = Math.max(delta, Math.abs(a[i] - b[i]));
  return delta;
}
// Every worker reads a halo of radius rows, then only its owned rows are copied
// to the final image. This also correctly handles the top and bottom borders.
export function gaussianPartition(image, count, radius) {
  const n = Math.min(count, image.height);
  const rowSize = image.width * 4;
  return Array.from({ length: n }, (_, i) => {
    const first = Math.floor(i * image.height / n);
    const last = Math.floor((i + 1) * image.height / n);
    const haloFirst = Math.max(0, first - radius);
    const haloLast = Math.min(image.height, last + radius);
    return {
      first, last, haloFirst, haloLast,
      width: image.width,
      height: haloLast - haloFirst,
      pixels: image.data.subarray(haloFirst * rowSize, haloLast * rowSize),
    };
  });
}

export async function benchmark(image, mode, workersCount = 4, options = {}) {
  const pixels = image.data;
  const gaussian = mode === 3;
  const sobel = mode === 4;
  const medianFilter = mode === 5;
  const brightness = mode === 2;
  const config = gaussian ? {
    kernelSize: Number(options.kernelSize ?? 5), sigma: Number(options.sigma ?? 1),
  } : medianFilter ? { kernelSize: Number(options.kernelSize ?? 3) }
    : brightness ? { amount: Number(options.amount ?? 40) } : mode;
  if (mode === 6) return benchmarkHistogram(image, workersCount);
  if (medianFilter && (![3,5,7].includes(config.kernelSize))) throw new Error('Median kernel must be 3, 5, or 7');
  if (brightness && (!Number.isInteger(config.amount) || config.amount < -100 || config.amount > 100)) throw new Error('Brightness must be between -100 and 100');
  if (gaussian && (!Number.isInteger(config.kernelSize) || config.kernelSize < 3 || config.kernelSize > 31 || !(config.kernelSize & 1) || config.sigma < 0.5 || config.sigma > 10)) {
    throw new Error('Invalid Gaussian kernel size or sigma');
  }
  const runners = [];
  try {
    const single = await spawn();
    runners.push(single);
    const scalarTechnique = gaussian ? 'gaussian-scalar' : sobel ? 'sobel-scalar' : medianFilter ? 'median-scalar' : brightness ? 'brightness-scalar' : 'scalar';
    const simdTechnique = gaussian ? 'gaussian-simd' : sobel ? 'sobel-simd' : medianFilter ? 'median-simd' : brightness ? 'brightness-simd' : 'simd';
    async function singleRun(technique) {
      const trials = [];
      for (let trial = 0; trial < 3; trial++) {
        trials.push(await execute(single, pixels, config, technique, image.width, image.height));
      }
      return {
        image: trials[trials.length - 1].image,
        kernelMs: median(trials.map(trial => trial.kernelMs)),
        e2eMs: median(trials.map(trial => trial.e2eMs)),
      };
    }
    const scalar = await singleRun(scalarTechnique);
    const simd = await singleRun(simdTechnique);
    const n = Math.max(1, Math.min(Math.floor(workersCount), image.height));
    const parallelWorkers = await Promise.all(Array.from({ length: n }, () => spawn()));
    runners.push(...parallelWorkers);
    const rowSize = image.width * 4;
    const partition = (gaussian || sobel || medianFilter)
      ? gaussianPartition(image, n, gaussian ? config.kernelSize >> 1 : medianFilter ? config.kernelSize >> 1 : 1)
      : Array.from({ length: n }, (_, i) => {
        const first = Math.floor(i * image.height / n), last = Math.floor((i + 1) * image.height / n);
        return { first, last, haloFirst: first, width: image.width, height: last - first, pixels: pixels.subarray(first * rowSize, last * rowSize) };
      });
    async function parallel(technique) {
      const trials = [];
      let lastParts;
      for (let trial = 0; trial < 3; trial++) {
        const start = performance.now();
        const parts = await Promise.all(partition.map((part, i) =>
          execute(parallelWorkers[i], part.pixels, config, technique, part.width, part.height)));
        trials.push({
          kernelMs: Math.max(...parts.map(part => part.kernelMs)),
          e2eMs: performance.now() - start,
        });
        lastParts = parts;
      }
      const merged = new Uint8ClampedArray(pixels.length);
      lastParts.forEach((result, i) => {
        const part = partition[i];
        const startRow = part.first - part.haloFirst;
        const length = (part.last - part.first) * rowSize;
        merged.set(result.image.subarray(startRow * rowSize, startRow * rowSize + length), part.first * rowSize);
      });

      return {
        image: merged,
        kernelMs: median(trials.map(trial => trial.kernelMs)),
        e2eMs: median(trials.map(trial => trial.e2eMs)),
      };
    }
    const parallelScalar = await parallel(scalarTechnique);
    const parallelSIMD = await parallel(simdTechnique);
    // Floating-point SIMD arithmetic may differ by one integer intensity level.
    const tolerance = gaussian ? 1 : 0;

    const differences = {
      simd: maxDifference(scalar.image, simd.image),
      parallelScalar: maxDifference(scalar.image, parallelScalar.image),
      parallelSIMD: maxDifference(scalar.image, parallelSIMD.image),
    };

    console.table(differences);

    const delta = Math.max(...Object.values(differences));

    if (delta > tolerance) {
      throw new Error(
        `Implementations disagree: ` +
        `SIMD=${differences.simd}, ` +
        `Parallel Scalar=${differences.parallelScalar}, ` +
        `Parallel SIMD=${differences.parallelSIMD}`
      );
    }

    return {
      image: new ImageData(simd.image, image.width, image.height),
      results: [
        { label: 'Scalar WASM', kernelMs: scalar.kernelMs, e2eMs: scalar.e2eMs, detail: 'One worker · C scalar' },
        { label: 'SIMD WASM', kernelMs: simd.kernelMs, e2eMs: simd.e2eMs, detail: 'One worker · SIMD128' },
        { label: `Parallel Scalar (${n})`, kernelMs: parallelScalar.kernelMs, e2eMs: parallelScalar.e2eMs, detail: 'Scalar workers · transfers included in end-to-end' },
        { label: `Parallel SIMD (${n})`, kernelMs: parallelSIMD.kernelMs, e2eMs: parallelSIMD.e2eMs, detail: 'SIMD workers · transfers included in end-to-end' },
      ],
      consistent: true, maxChannelDifference: delta, gaussian,
    };
  } finally { runners.forEach(worker => worker.terminate()); }
}

export async function gaussianBlur(image, kernelSize = 5, sigma = 1) {
  const result = await benchmark(image, 3, 1, { kernelSize, sigma });
  return result.image;
}
