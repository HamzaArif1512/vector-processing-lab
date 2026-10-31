#include <stdint.h>
#include <wasm_simd128.h>

// Modes 0-2 operate in-place on RGBA8 pixels (alpha becomes 255).
// Mode 0: grayscale; mode 1: invert RGB; mode 2: brighten RGB by 40.
static inline uint32_t scalar_pixel(uint32_t p, int mode) {
  uint32_t r = p & 255u, g = (p >> 8) & 255u, b = (p >> 16) & 255u;
  if (mode == 0) {
    uint32_t y = (77u * r + 150u * g + 29u * b) >> 8;
    return 0xff000000u | (y * 0x00010101u);
  }
  if (mode == 1) return 0xff000000u | ((~p) & 0x00ffffffu);
  r = r + 40 > 255 ? 255 : r + 40;
  g = g + 40 > 255 ? 255 : g + 40;
  b = b + 40 > 255 ? 255 : b + 40;
  return 0xff000000u | r | (g << 8) | (b << 16);
}

__attribute__((export_name("process_scalar")))
void process_scalar(uint32_t* pixels, int count, int mode) {
  for (int i = 0; i < count; ++i) pixels[i] = scalar_pixel(pixels[i], mode);
}

__attribute__((export_name("process_simd")))
void process_simd(uint32_t* pixels, int count, int mode) {
  int i = 0;
  const v128_t rgbmask = wasm_i32x4_splat(0x00ffffff);
  const v128_t opaque = wasm_i32x4_splat((int)0xff000000u);
  for (; i + 4 <= count; i += 4) {
    v128_t p = wasm_v128_load(pixels + i);
    v128_t rgb;
    if (mode == 0) {
      v128_t r = wasm_v128_and(p, wasm_i32x4_splat(255));
      v128_t g = wasm_v128_and(wasm_u32x4_shr(p, 8), wasm_i32x4_splat(255));
      v128_t b = wasm_v128_and(wasm_u32x4_shr(p, 16), wasm_i32x4_splat(255));
      v128_t y = wasm_u32x4_shr(
          wasm_i32x4_add(
              wasm_i32x4_add(wasm_i32x4_mul(r, wasm_i32x4_splat(77)),
                             wasm_i32x4_mul(g, wasm_i32x4_splat(150))),
              wasm_i32x4_mul(b, wasm_i32x4_splat(29))),
          8);
      rgb = wasm_v128_or(y, wasm_v128_or(wasm_i32x4_shl(y, 8), wasm_i32x4_shl(y, 16)));
    } else if (mode == 1) {
      rgb = wasm_v128_and(wasm_v128_not(p), rgbmask);
    } else {
      v128_t bright = wasm_u8x16_add_sat(p, wasm_i32x4_splat(0x00282828));
      rgb = wasm_v128_and(bright, rgbmask);
    }
    wasm_v128_store(pixels + i, wasm_v128_or(rgb, opaque));
  }
  for (; i < count; ++i) pixels[i] = scalar_pixel(pixels[i], mode);
}

// Standalone WASM builds may lack libm. Approximate exp(x) for -24 <= x <= 0
// with a 12-term Taylor approximation to exp(x / 64), then square 6 times.
// This is sufficiently accurate for normalized Gaussian kernel weights.
static float gaussian_exp(float x) {
  if (x <= -24.0f) return 0.0f;
  if (x >= 0.0f) return 1.0f;
  float z = x * (1.0f / 64.0f);
  float term = 1.0f;
  float sum = 1.0f;
  for (int i = 1; i <= 12; ++i) {
    term *= z / (float)i;
    sum += term;
  }
  for (int i = 0; i < 6; ++i) sum *= sum;
  return sum;
}

static inline int clamp_int(int v, int lower, int upper) {
  return v < lower ? lower : (v > upper ? upper : v);
}

// Gaussian blur: scalar reference implementation, separate source/destination.
// src and dst are pointers (byte offsets) into linear WASM memory holding RGBA8.
// Kernel size: odd integer 3..31. Sigma: 0.5..10.0.
// Boundaries: clamp to nearest valid image pixel; alpha is copied unchanged.
// Invalid inputs cause no writes. src and dst MUST NOT overlap.
__attribute__((export_name("gaussian_blur_scalar")))
void gaussian_blur_scalar(const uint8_t* src, uint8_t* dst,
                          int width, int height, int kernel_size, float sigma) {
  if (!src || !dst || src == dst || width <= 0 || height <= 0 ||
      width > 16384 || height > 16384 ||
      (int64_t)width * (int64_t)height > 536870911LL ||
      kernel_size < 3 || kernel_size > 31 || (kernel_size & 1) == 0 ||
      !(sigma >= 0.5f && sigma <= 10.0f)) {
    return;
  }

  // Gaussian kernels are separable. Generate a normalized 1D kernel and
  // multiply two weights inside the direct 2D convolution (O(K^2)/pixel).
  float weights[31];
  const int radius = kernel_size / 2;
  float total = 0.0f;
  for (int k = 0; k < kernel_size; ++k) {