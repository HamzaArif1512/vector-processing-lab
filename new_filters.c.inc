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
