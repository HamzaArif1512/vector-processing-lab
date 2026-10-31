#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
clang --target=wasm32 -O3 -msimd128 -nostdlib \
  -Wl,--no-entry -Wl,--export=process_scalar -Wl,--export=process_simd \
  -Wl,--export-memory -Wl,--initial-memory=131072 -Wl,--max-memory=2147483648 \
  -o public/filters.wasm wasm/filters.c
echo 'Built public/filters.wasm with wasm SIMD128.'
