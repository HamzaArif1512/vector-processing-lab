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
// Numerically stable approximation for freestanding wasm builds without libm.
static float gaussian_exp(float x){
  if(x<=-24.0f)return 0.0f;if(x>=0.0f)return 1.0f;
  float z=x/64.0f,term=1.0f,sum=1.0f;
  for(int i=1;i<=12;i++){term*=z/(float)i;sum+=term;}
  for(int i=0;i<6;i++)sum*=sum;
  return sum;
}
static inline int clampi(int x,int a,int b){return x<a?a:(x>b?b:x);}
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
