# VectorLab Sobel Edge Detection — patch for `main`

The ZIP contains a **patch installer**, the complete new Sobel C source segment, and a new Node.js test file. The installer edits your *existing* repository files, retaining code that may have changed since this patch was prepared.

Source inspected: `HamzaArif1512/vector-processing-lab` branch `main`, on November 1, 2026.

## Files changed by installer

1. `wasm/filters.c`: adds `sobel_scalar` and a **real SIMD128** `sobel_simd`, using a fixed 3x3 Sobel operator, integer luminance, clamped borders, saturation, and original alpha.
2. `scripts/build-wasm.sh`: exports both Sobel functions.
3. `src/runner.worker.js`: runs Sobel using separate WASM source/destination buffers, and unchanged worker timing infrastructure.
4. `src/processing.js`: adds mode 4, four Sobel techniques, 1-row halo partitions, and exact output comparison. Also removes an existing misplaced debug block that references `simd` outside its scope.
5. `src/main.jsx`: labels the Sobel processed output correctly, retains existing 4-strategy timing bars.
6. `tests/sobel.test.js`: adds scalar/SIMD parity, visual edge behavior, alpha, no input mutation, and partition/halo merge tests.

## Apply on Windows

From PowerShell in project root:

```powershell
git switch main
git switch -c feature/sobel-edge-detection
# Extract ZIP, then copy its three files/directories into the project (keep paths):
#   apply_sobel.py
#   sobel_impl.c.inc
#   tests/sobel.test.js
python apply_sobel.py
wsl -d Ubuntu -- bash scripts/build-wasm.sh
npm test
npm run build
node .\node_modules\vite\bin\vite.js
```

If `wsl -d Ubuntu` doesn't work, start your Ubuntu WSL distribution and run `bash scripts/build-wasm.sh` there.

The ZIP does **not** contain `filters.wasm`, since the binary needs to be rebuilt from the changed C source.

## Algorithm / benchmark policy

- Fixed 3x3 Sobel grayscale edge detector; absolute horizontal plus vertical gradients, clamped to 255; pixels become gray while input alpha is retained.
- Scalar and SIMD use identical integer arithmetic (exact output agreement expected).
- Multithreading uses one source halo row above and below each owned strip, preserving clamped image borders.
- Four benchmark strategies: single scalar, single SIMD, parallel scalar, parallel SIMD.
- Existing Gaussian controls stay exclusive to Gaussian mode; Sobel has no sigma or adjustable kernel.
- Existing per-worker warmups/repetitions remain unchanged. For long-running benchmarks, implement adaptive repetitions in a later change.

## Notes on the inspected `main` branch

The existing `src/processing.js` contains a debug-only block **inside** `parallel()` that compares against a `simd` variable and prints `config.kernelSize` even when that is not applicable. This block is erroneous in that scope and is removed by the installer. The existing Gaussian tests also contain old assertions that may cause unrelated failures; this patch doesn't silently change existing Gaussian test expectations.
