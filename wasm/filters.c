#include <stdint.h>
#include <wasm_simd128.h>

static inline uint32_t scalar_pixel(uint32_t p, int mode) {
  uint32_t r=p&255u,g=(p>>8)&255u,b=(p>>16)&255u;
  if(mode==0){uint32_t y=(77u*r+150u*g+29u*b)>>8;return 0xff000000u|y*0x00010101u;}
  if(mode==1)return 0xff000000u|((~p)&0x00ffffffu);
  r=r+40>255?255:r+40;g=g+40>255?255:g+40;b=b+40>255?255:b+40;
  return 0xff000000u|r|(g<<8)|(b<<16);
}
__attribute__((export_name("process_scalar"))) void process_scalar(uint32_t* p,int n,int mode){for(int i=0;i<n;i++)p[i]=scalar_pixel(p[i],mode);}
__attribute__((export_name("process_simd"))) void process_simd(uint32_t* pixels,int count,int mode){
  int i=0;v128_t rgbmask=wasm_i32x4_splat(0x00ffffff),opaque=wasm_i32x4_splat((int)0xff000000u);
  for(;i+4<=count;i+=4){v128_t p=wasm_v128_load(pixels+i),rgb;
    if(mode==0){v128_t r=wasm_v128_and(p,wasm_i32x4_splat(255)),g=wasm_v128_and(wasm_u32x4_shr(p,8),wasm_i32x4_splat(255)),b=wasm_v128_and(wasm_u32x4_shr(p,16),wasm_i32x4_splat(255));v128_t y=wasm_u32x4_shr(wasm_i32x4_add(wasm_i32x4_add(wasm_i32x4_mul(r,wasm_i32x4_splat(77)),wasm_i32x4_mul(g,wasm_i32x4_splat(150))),wasm_i32x4_mul(b,wasm_i32x4_splat(29))),8);rgb=wasm_v128_or(y,wasm_v128_or(wasm_i32x4_shl(y,8),wasm_i32x4_shl(y,16)));}
    else if(mode==1)rgb=wasm_v128_and(wasm_v128_not(p),rgbmask);
    else rgb=wasm_v128_and(wasm_u8x16_add_sat(p,wasm_i32x4_splat(0x00282828)),rgbmask);
    wasm_v128_store(pixels+i,wasm_v128_or(rgb,opaque));
  }
  for(;i<count;i++)pixels[i]=scalar_pixel(pixels[i],mode);
}
static inline int clampi(int x,int a,int b){return x<a?a:(x>b?b:x);}

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

// Numerically stable approximation for freestanding wasm builds without libm.
static float gaussian_exp(float x){
  if(x<=-24.0f)return 0.0f;if(x>=0.0f)return 1.0f;
  float z=x/64.0f,term=1.0f,sum=1.0f;
  for(int i=1;i<=12;i++){term*=z/(float)i;sum+=term;}
  for(int i=0;i<6;i++)sum*=sum;
  return sum;
}
static inline uint8_t roundbyte(float x){int v=(int)(x+0.5f);return (uint8_t)clampi(v,0,255);}
static void make_weights(float* weights,int k,float sigma){
  float inv=-0.5f/(sigma*sigma),sum=0;int radius=k/2;
  for(int i=0;i<k;i++){int d=i-radius;weights[i]=gaussian_exp((float)(d*d)*inv);sum+=weights[i];}
  for(int i=0;i<k;i++)weights[i]/=sum;
}
static inline int valid(const uint8_t* src,uint8_t* dst,int w,int h,int k,float sigma){
  return src&&dst&&src!=dst&&w>0&&h>0&&w<=16384&&h<=16384&&(int64_t)w*h<=536870911LL&&k>=3&&k<=31&&(k&1)&&sigma>=0.5f&&sigma<=10.0f;
}
// Both paths process the same full input rows, using local coordinates. For parallelism,
// JS provides halos and crops only the owned rows from each worker's output.
__attribute__((export_name("gaussian_blur_scalar")))
void gaussian_blur_scalar(const uint8_t* src,uint8_t* dst,int w,int h,int k,float sigma){
  if(!valid(src,dst,w,h,k,sigma))return;
  float weights[31];make_weights(weights,k,sigma);int radius=k/2;
  for(int y=0;y<h;y++)for(int x=0;x<w;x++){
    float sums[3]={0,0,0};
    for(int ky=0;ky<k;ky++){int sy=clampi(y+ky-radius,0,h-1);
      for(int kx=0;kx<k;kx++){int sx=clampi(x+kx-radius,0,w-1);float weight=weights[ky]*weights[kx];int idx=4*(sy*w+sx);
        for(int c=0;c<3;c++)sums[c]+=((float)src[idx+c])*weight;
      }
    }
    int out=4*(y*w+x);for(int c=0;c<3;c++)dst[out+c]=roundbyte(sums[c]);dst[out+3]=src[out+3];
  }
}
// SIMD128 computes four neighboring output pixels at once. Loading strided RGBA
// channels uses lane assembly; arithmetic is actually packed f32x4 operations.
__attribute__((export_name("gaussian_blur_simd")))
void gaussian_blur_simd(const uint8_t* src,uint8_t* dst,int w,int h,int k,float sigma){
  if(!valid(src,dst,w,h,k,sigma))return;
  float weights[31];make_weights(weights,k,sigma);int radius=k/2;
  for(int y=0;y<h;y++){
    int x=0;
    for(;x+4<=w;x+=4){
      v128_t sr=wasm_f32x4_splat(0),sg=sr,sb=sr;
      for(int ky=0;ky<k;ky++){int sy=clampi(y+ky-radius,0,h-1);
        for(int kx=0;kx<k;kx++){
          int dx=kx-radius;
          int a=4*(sy*w+clampi(x+dx,0,w-1));
          int b=4*(sy*w+clampi(x+1+dx,0,w-1));
          int c=4*(sy*w+clampi(x+2+dx,0,w-1));
          int d=4*(sy*w+clampi(x+3+dx,0,w-1));
          v128_t wt=wasm_f32x4_splat(weights[ky]*weights[kx]);
          sr=wasm_f32x4_add(sr,wasm_f32x4_mul(wasm_f32x4_make(src[a],src[b],src[c],src[d]),wt));
          sg=wasm_f32x4_add(sg,wasm_f32x4_mul(wasm_f32x4_make(src[a+1],src[b+1],src[c+1],src[d+1]),wt));
          sb=wasm_f32x4_add(sb,wasm_f32x4_mul(wasm_f32x4_make(src[a+2],src[b+2],src[c+2],src[d+2]),wt));
        }
      }
      for(int lane=0;lane<4;lane++){int pos=4*(y*w+x+lane);
        // Dynamic extract is unavailable; store lanes to scratch first.
        float rs[4],gs[4],bs[4];wasm_v128_store(rs,sr);wasm_v128_store(gs,sg);wasm_v128_store(bs,sb);
        dst[pos]=roundbyte(rs[lane]);dst[pos+1]=roundbyte(gs[lane]);dst[pos+2]=roundbyte(bs[lane]);dst[pos+3]=src[pos+3];
      }
    }
    for(;x<w;x++){
      float sums[3]={0,0,0};
      for(int ky=0;ky<k;ky++){int sy=clampi(y+ky-radius,0,h-1);
        for(int kx=0;kx<k;kx++){int sx=clampi(x+kx-radius,0,w-1),idx=4*(sy*w+sx);float wt=weights[ky]*weights[kx];
          for(int c=0;c<3;c++)sums[c]+=(float)src[idx+c]*wt;
        }
      }
      int pos=4*(y*w+x);for(int c=0;c<3;c++)dst[pos+c]=roundbyte(sums[c]);dst[pos+3]=src[pos+3];
    }
  }
}
