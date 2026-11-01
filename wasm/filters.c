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

// VectorLab additions: configurable median, global histogram steps, brightness.
static inline uint8_t median_scalar_channel(const uint8_t *src,int w,int h,int x,int y,int k,int ch){
  uint8_t a[49];int n=0, radius=k/2;
  for(int dy=-radius;dy<=radius;dy++)for(int dx=-radius;dx<=radius;dx++){
    int xx=clampi(x+dx,0,w-1),yy=clampi(y+dy,0,h-1);
    uint8_t value=src[4*(yy*w+xx)+ch];
    int j=n++;while(j>0&&a[j-1]>value){a[j]=a[j-1];j--;}a[j]=value;
  }
  return a[n/2];
}
__attribute__((export_name("median_filter_scalar")))
void median_filter_scalar(const uint8_t* src,uint8_t* dst,int w,int h,int k){
  if(!src||!dst||src==dst||w<1||h<1||k<3||k>7||!(k&1))return;
  for(int y=0;y<h;y++)for(int x=0;x<w;x++){
    int pos=4*(y*w+x);
    for(int c=0;c<3;c++)dst[pos+c]=median_scalar_channel(src,w,h,x,y,k,c);
    dst[pos+3]=src[pos+3];
  }
}
// SIMD bitonic sorting network: each vector lane is one different output pixel.
// Sorting stages use packed unsigned 32-bit min/max; supports 3x3,5x5,7x7.
static inline v128_t median_vector_channel(const uint8_t* src,int w,int h,int x,int y,int k,int ch){
  v128_t lanes[64];int count=k*k,capacity=1,rad=k/2;
  while(capacity<count)capacity<<=1;
  int idx=0;
  for(int dy=-rad;dy<=rad;dy++)for(int dx=-rad;dx<=rad;dx++){
    int yy=clampi(y+dy,0,h-1);
    int a=4*(yy*w+clampi(x+dx,0,w-1))+ch;
    int b=4*(yy*w+clampi(x+1+dx,0,w-1))+ch;
    int c=4*(yy*w+clampi(x+2+dx,0,w-1))+ch;
    int d=4*(yy*w+clampi(x+3+dx,0,w-1))+ch;
    lanes[idx++]=wasm_i32x4_make(src[a],src[b],src[c],src[d]);
  }
  for(;idx<capacity;idx++)lanes[idx]=wasm_i32x4_splat(256);
  for(int size=2;size<=capacity;size<<=1)for(int stride=size>>1;stride;stride>>=1){
    for(int i=0;i<capacity;i++){
      int j=i^stride;
      if(j<=i)continue;
      v128_t lo=wasm_u32x4_min(lanes[i],lanes[j]);
      v128_t hi=wasm_u32x4_max(lanes[i],lanes[j]);
      if((i&size)==0){lanes[i]=lo;lanes[j]=hi;}
      else {lanes[i]=hi;lanes[j]=lo;}
    }
  }
  return lanes[count/2];
}
__attribute__((export_name("median_filter_simd")))
void median_filter_simd(const uint8_t* src,uint8_t* dst,int w,int h,int k){
  if(!src||!dst||src==dst||w<1||h<1||k<3||k>7||!(k&1))return;
  for(int y=0;y<h;y++){
    int x=0;
    for(;x+4<=w;x+=4){
      uint32_t r[4],g[4],b[4];
      wasm_v128_store(r,median_vector_channel(src,w,h,x,y,k,0));
      wasm_v128_store(g,median_vector_channel(src,w,h,x,y,k,1));
      wasm_v128_store(b,median_vector_channel(src,w,h,x,y,k,2));
      for(int lane=0;lane<4;lane++){
        int pos=4*(y*w+x+lane);
        dst[pos]=(uint8_t)r[lane];dst[pos+1]=(uint8_t)g[lane];dst[pos+2]=(uint8_t)b[lane];dst[pos+3]=src[pos+3];
      }
    }
    for(;x<w;x++){
      int pos=4*(y*w+x);
      for(int ch=0;ch<3;ch++)dst[pos+ch]=median_scalar_channel(src,w,h,x,y,k,ch);
      dst[pos+3]=src[pos+3];
    }
  }
}
static inline uint8_t luminance(const uint8_t* src,int p){
 return (uint8_t)((77u*src[p]+150u*src[p+1]+29u*src[p+2])>>8);
}
__attribute__((export_name("histogram_count_scalar")))
void histogram_count_scalar(const uint8_t* src,int pixels,uint32_t* hist){
 if(!src||!hist||pixels<=0)return;
 for(int i=0;i<64;i++)wasm_v128_store(hist+4*i,wasm_i32x4_splat(0));
 for(int i=0;i<pixels;i++)hist[luminance(src,4*i)]++;
}
__attribute__((export_name("histogram_count_simd")))
void histogram_count_simd(const uint8_t* src,int pixels,uint32_t* hist){
 if(!src||!hist||pixels<=0)return;
 for(int i=0;i<64;i++)wasm_v128_store(hist+4*i,wasm_i32x4_splat(0));
 int i=0;
 for(;i+4<=pixels;i+=4){
   v128_t p=wasm_v128_load(src+4*i);
   v128_t mask=wasm_i32x4_splat(255);
   v128_t r=wasm_v128_and(p,mask);
   v128_t g=wasm_v128_and(wasm_u32x4_shr(p,8),mask);
   v128_t b=wasm_v128_and(wasm_u32x4_shr(p,16),mask);
   v128_t value=wasm_u32x4_shr(wasm_i32x4_add(wasm_i32x4_add(wasm_i32x4_mul(r,wasm_i32x4_splat(77)),wasm_i32x4_mul(g,wasm_i32x4_splat(150))),wasm_i32x4_mul(b,wasm_i32x4_splat(29))),8);
   uint32_t vals[4];wasm_v128_store(vals,value);
   for(int lane=0;lane<4;lane++)hist[vals[lane]]++;
 }
 for(;i<pixels;i++)hist[luminance(src,4*i)]++;
}
__attribute__((export_name("histogram_apply_scalar")))
void histogram_apply_scalar(const uint8_t* src,uint8_t* dst,int pixels,const uint8_t* lut){
 if(!src||!dst||!lut||pixels<=0)return;
 for(int i=0;i<pixels;i++){int j=4*i;uint8_t v=lut[luminance(src,j)];dst[j]=dst[j+1]=dst[j+2]=v;dst[j+3]=src[j+3];}
}
__attribute__((export_name("histogram_apply_simd")))
void histogram_apply_simd(const uint8_t* src,uint8_t* dst,int pixels,const uint8_t* lut){
 if(!src||!dst||!lut||pixels<=0)return;
 int i=0;
 for(;i+4<=pixels;i+=4){
   v128_t p=wasm_v128_load(src+4*i),mask=wasm_i32x4_splat(255);
   v128_t r=wasm_v128_and(p,mask),g=wasm_v128_and(wasm_u32x4_shr(p,8),mask),b=wasm_v128_and(wasm_u32x4_shr(p,16),mask);
   v128_t y=wasm_u32x4_shr(wasm_i32x4_add(wasm_i32x4_add(wasm_i32x4_mul(r,wasm_i32x4_splat(77)),wasm_i32x4_mul(g,wasm_i32x4_splat(150))),wasm_i32x4_mul(b,wasm_i32x4_splat(29))),8);
   uint32_t ids[4];wasm_v128_store(ids,y);
   v128_t v=wasm_i32x4_make(lut[ids[0]],lut[ids[1]],lut[ids[2]],lut[ids[3]]);
   v128_t rgb=wasm_v128_or(v,wasm_v128_or(wasm_i32x4_shl(v,8),wasm_i32x4_shl(v,16)));
   wasm_v128_store(dst+4*i,wasm_v128_or(rgb,wasm_v128_and(p,wasm_i32x4_splat((int)0xff000000u))));
 }
 for(;i<pixels;i++){int j=4*i;uint8_t v=lut[luminance(src,j)];dst[j]=dst[j+1]=dst[j+2]=v;dst[j+3]=src[j+3];}
}
__attribute__((export_name("brightness_custom_scalar")))
void brightness_custom_scalar(uint32_t* pixels,int count,int amount){
 if(!pixels||count<=0||amount<-255||amount>255)return;
 for(int i=0;i<count;i++){
   uint32_t p=pixels[i], out=p&0xff000000u;
   for(int c=0;c<3;c++){
     int v=(int)((p>>(8*c))&255u)+amount;
     if(v<0)v=0;if(v>255)v=255;
     out|=((uint32_t)v)<<(8*c);
   }
   pixels[i]=out;
 }
}
__attribute__((export_name("brightness_custom_simd")))
void brightness_custom_simd(uint32_t* pixels,int count,int amount){
 if(!pixels||count<=0||amount<-255||amount>255)return;
 int i=0;uint32_t m=(uint32_t)(amount<0?-amount:amount);
 v128_t increment=wasm_i32x4_splat((int)(m*0x00010101u));
 v128_t rgbmask=wasm_i32x4_splat(0x00ffffff);
 for(;i+4<=count;i+=4){
   v128_t p=wasm_v128_load(pixels+i);
   v128_t changed=amount<0?wasm_u8x16_sub_sat(p,increment):wasm_u8x16_add_sat(p,increment);
   wasm_v128_store(pixels+i,wasm_v128_or(wasm_v128_and(changed,rgbmask),wasm_v128_and(p,wasm_i32x4_splat((int)0xff000000u))));
 }
 for(;i<count;i++){
   uint32_t p=pixels[i],out=p&0xff000000u;
   for(int c=0;c<3;c++){int v=(int)((p>>(8*c))&255u)+amount;if(v<0)v=0;if(v>255)v=255;out|=(uint32_t)v<<(8*c);}
   pixels[i]=out;
 }
}
// Freestanding helper for Clang-generated stack initialization in median network.
__attribute__((used)) void *memset(void *ptr,int value,unsigned long size){
  volatile uint8_t *p=(volatile uint8_t*)ptr;
  for(unsigned long i=0;i<size;i++)p[i]=(uint8_t)value;
  return ptr;
}
