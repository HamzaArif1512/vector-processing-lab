// Fixed 3x3 Sobel edge detection (grayscale). Both implementations are bit-exact.
// gx=[-1 0 1;-2 0 2;-1 0 1], gy=[-1 -2 -1;0 0 0;1 2 1].
// We use |gx|+|gy| (L1 magnitude), clamped to 255. This avoids libm/sqrt.
// Alpha is copied from the original pixel; borders clamp to the edge pixel.
static inline int sobel_luma(const uint8_t* src, int w, int h, int x, int y) {
  x = clampi(x, 0, w - 1);
  y = clampi(y, 0, h - 1);
  const int i = 4 * (y * w + x);
  return (77 * (int)src[i] + 150 * (int)src[i + 1] + 29 * (int)src[i + 2]) >> 8;
}
static inline int sobel_abs(int n) { return n < 0 ? -n : n; }
static inline uint8_t sobel_strength(int tl, int tc, int tr,
                                     int ml, int mr, int bl, int bc, int br) {
  const int gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
  const int gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
  const int magnitude = sobel_abs(gx) + sobel_abs(gy);
  return (uint8_t)(magnitude > 255 ? 255 : magnitude);
}
static inline int sobel_valid(const uint8_t* src, uint8_t* dst, int w, int h) {
  return src && dst && src != dst && w > 0 && h > 0 &&
         w <= 16384 && h <= 16384 && (int64_t)w * h <= 536870911LL;
}
__attribute__((export_name("sobel_scalar")))
void sobel_scalar(const uint8_t* src, uint8_t* dst, int w, int h) {
  if (!sobel_valid(src, dst, w, h)) return;
  for (int y = 0; y < h; ++y) {
    for (int x = 0; x < w; ++x) {
      const uint8_t edge = sobel_strength(
        sobel_luma(src,w,h,x-1,y-1), sobel_luma(src,w,h,x,y-1), sobel_luma(src,w,h,x+1,y-1),
        sobel_luma(src,w,h,x-1,y),                                   sobel_luma(src,w,h,x+1,y),
        sobel_luma(src,w,h,x-1,y+1), sobel_luma(src,w,h,x,y+1), sobel_luma(src,w,h,x+1,y+1));
      const int i = 4 * (y*w+x);
      dst[i] = dst[i+1] = dst[i+2] = edge;
      dst[i+3] = src[i+3];
    }
  }
}
// Pack luminances from four adjacent output pixels into 4x i32 lanes.
static inline v128_t sobel_four_luma(const uint8_t* src, int w, int h, int x, int y) {
  return wasm_i32x4_make(sobel_luma(src,w,h,x,y), sobel_luma(src,w,h,x+1,y),
                         sobel_luma(src,w,h,x+2,y), sobel_luma(src,w,h,x+3,y));
}
__attribute__((export_name("sobel_simd")))
void sobel_simd(const uint8_t* src, uint8_t* dst, int w, int h) {
  if (!sobel_valid(src, dst, w, h)) return;
  for (int y = 0; y < h; ++y) {
    int x = 0;
    for (; x + 4 <= w; x += 4) {
      const v128_t tl=sobel_four_luma(src,w,h,x-1,y-1);
      const v128_t tc=sobel_four_luma(src,w,h,x,y-1);
      const v128_t tr=sobel_four_luma(src,w,h,x+1,y-1);
      const v128_t ml=sobel_four_luma(src,w,h,x-1,y);
      const v128_t mr=sobel_four_luma(src,w,h,x+1,y);
      const v128_t bl=sobel_four_luma(src,w,h,x-1,y+1);
      const v128_t bc=sobel_four_luma(src,w,h,x,y+1);
      const v128_t br=sobel_four_luma(src,w,h,x+1,y+1);
      const v128_t gx = wasm_i32x4_add(
        wasm_i32x4_sub(wasm_i32x4_sub(tr,tl),wasm_i32x4_shl(ml,1)),
        wasm_i32x4_add(wasm_i32x4_shl(mr,1),wasm_i32x4_sub(br,bl)));
      const v128_t gy = wasm_i32x4_add(
        wasm_i32x4_sub(bl,tl),
        wasm_i32x4_add(wasm_i32x4_sub(wasm_i32x4_shl(bc,1),wasm_i32x4_shl(tc,1)),
                       wasm_i32x4_sub(br,tr)));
      const v128_t mag = wasm_i32x4_min(
        wasm_i32x4_add(wasm_i32x4_abs(gx),wasm_i32x4_abs(gy)),
        wasm_i32x4_splat(255));
      int32_t values[4];
      wasm_v128_store(values,mag);
      for(int lane=0;lane<4;++lane) {
        const int i=4*(y*w+x+lane);
        const uint8_t edge=(uint8_t)values[lane];
        dst[i]=dst[i+1]=dst[i+2]=edge;
        dst[i+3]=src[i+3];
      }
    }
    for (; x < w; ++x) {
      const uint8_t edge = sobel_strength(
        sobel_luma(src,w,h,x-1,y-1), sobel_luma(src,w,h,x,y-1), sobel_luma(src,w,h,x+1,y-1),
        sobel_luma(src,w,h,x-1,y),                                   sobel_luma(src,w,h,x+1,y),
        sobel_luma(src,w,h,x-1,y+1), sobel_luma(src,w,h,x,y+1), sobel_luma(src,w,h,x+1,y+1));
      const int i=4*(y*w+x);
      dst[i]=dst[i+1]=dst[i+2]=edge;
      dst[i+3]=src[i+3];
    }
  }
}
