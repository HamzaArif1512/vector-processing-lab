# VectorLab — SIMD & Parallel Image Processing

A browser-based, Vercel-ready project comparing **scalar WebAssembly**, **SIMD128 WebAssembly**, and **parallel Web Workers** on exactly the same image pixels.

## Current features
- React + Vite dashboard with original/processed image preview
- Upload JPG/PNG/WebP/etc. (downscaled to maximum dimension 1800px)
- Grayscale, invert colors, and increase brightness by 40
- Native C compiled to SIMD128-enabled `.wasm` and a scalar C baseline in the *same module*
- Configurable 2/4/6/8 Web Workers, each running the scalar WASM baseline on its slice of image rows
- Pixel-exact verification of all three outputs (fails rather than reporting inaccurate results)
- Benchmark chart and SIMD-to-scalar speedup; download processed PNG
- No external API, user images remain in the browser

## Run locally

Requires Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Visit the URL Vite prints (usually http://localhost:5173).

To test the core WebAssembly implementation:

```bash
npm test
```

To build and preview the deployable version:

```bash
npm run build
npm run preview
```

## Deploy to Vercel

1. Push this directory to a GitHub repository.
2. Vercel → New Project → Import repository.
3. Select Vite (usually auto-detected), build command `npm run build`, output directory `dist`.
4. Deploy. No server or environment variables required.

`public/filters.wasm` is *already compiled and included*: **Vercel does not need Clang or Emscripten** during deploy.

To rebuild WebAssembly on Linux/macOS with Clang 17+ and `wasm32` linker available:

```bash
bash scripts/build-wasm.sh
```

## Benchmark methodology and limitations

- The scalar and SIMD modes are both compiled from the same C source file with Clang `-O3`; the SIMD function uses explicit `wasm_simd128.h` intrinsics. This enables a direct comparison of algorithmic strategies, but a compiler may also optimize scalar code.
- Each single-worker mode runs seven repetitions, reloading original pixels before each, and displays the **median kernel execution time**. Image loading, decoding, and display are excluded.
- Parallel mode divides complete image rows across multiple independent Web Workers and uses scalar WASM; **its displayed latency is wall-clock time including worker messaging and result transfer**. This is not an apples-to-apples pure-kernel comparison with the scalar/SIMD times. The browser worker pool is initialized before that measurement.
- Comparisons depend on device, browser, thermal state, image dimensions, and workload. Small images can be so fast that the timer is noisy. Run repeated trials on larger images.
- No claim of GPU acceleration or AVX2 in the deployed browser: **WebAssembly SIMD128 is a browser-facing SIMD instruction set**, distinct from native x86 AVX2. A standalone AVX2 C++ backend would be a separate build.
- Browser worker row processing is independent for the current per-pixel operations. A future Gaussian blur / Sobel filter needs halo rows at chunk boundaries.

## Suggested next milestones

1. Add Gaussian blur and Sobel edge detection with border handling and chunk halo rows.
2. Add repeated full-pipeline trials for the parallel mode with median wall-clock results, and a separate kernel-only throughput metric.
3. Build combined SIMD + Web Workers mode (each worker runs SIMD WASM).
4. Add exportable benchmark CSV, plots across resolutions, speedup and efficiency.
5. Add native C++ AVX2 CLI comparison for coursework if desired (runs outside Vercel).
