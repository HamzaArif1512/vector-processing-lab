
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

clang --target=wasm32 -O3 -ffp-contract=off -msimd128 -nostdlib \
  -Wl,--no-entry \
  -Wl,--export=process_scalar \
  -Wl,--export=process_simd \
  -Wl,--export=gaussian_blur_scalar \
  -Wl,--export=gaussian_blur_simd \
  -Wl,--export=sobel_scalar \
  -Wl,--export=sobel_simd \
  -Wl,--export=__heap_base \
  -Wl,--export-memory \
  -Wl,--initial-memory=131072 \
  -Wl,--max-memory=2147483648 \
  -o public/filters.wasm wasm/filters.c

echo 'Built public/filters.wasm with SIMD128 Gaussian blur and heap base export.'
