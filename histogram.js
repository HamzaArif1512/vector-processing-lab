// Global grayscale histogram equalization; all workers share the same global LUT.
// Worker phases: parallel local histogram -> merge/CDF -> parallel lookup application.
function median(a){const b=[...a].sort((x,y)=>x-y);return b[Math.floor(b.length/2)];}
function maxDiff(a,b){if(a.length!==b.length)return Infinity;let d=0;for(let i=0;i<a.length;i++)d=Math.max(d,Math.abs(a[i]-b[i]));return d;}
function createWorker(){
  const w=new Worker(new URL('./runner.worker.js',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    w.onmessage=({data})=>{if(data.kind==='ready')resolve(w);if(data.kind==='error'){w.terminate();reject(new Error(data.message));}};
    w.onerror=e=>{w.terminate();reject(new Error(e.message));};
  });
}
function send(worker,kind,pixels,simd,lut){
  return new Promise((resolve,reject)=>{
    const buffer=pixels.slice().buffer;const started=performance.now();
    worker.onmessage=({data})=>{
      if(data.kind==='result')resolve({...data,e2eMs:performance.now()-started});
      else if(data.kind==='error')reject(new Error(data.message));
    };
    worker.onerror=e=>reject(new Error(e.message));
    worker.postMessage({kind,buffer,simd,lut},[buffer]);
  });
}
export function histogramLut(counts){
  const total=counts.reduce((x,y)=>x+y,0),lut=new Uint8Array(256);
  let cumulative=0,min=null;
  for(let i=0;i<256;i++){
    cumulative+=counts[i];
    if(min===null&&counts[i])min=cumulative;
    // For constant images, retain original brightness instead of collapsing.
    lut[i]=min===null||total===min?i:Math.round((cumulative-min)*255/(total-min));
  }
  return lut;
}
async function stage(workers,partitions,kind,simd,lut){
  const start=performance.now();
  const responses=await Promise.all(workers.map((worker,i)=>send(worker,kind,partitions[i].pixels,simd,lut)));
  return {responses,e2eMs:performance.now()-start,kernelMs:Math.max(...responses.map(r=>r.kernelMs))};
}
async function oneTrial(workers,partitions,simd){
  const started=performance.now();
  const counted=await stage(workers,partitions,'histogram-count',simd);
  const hist=new Uint32Array(256);
  for(const r of counted.responses){const part=new Uint32Array(r.buffer);for(let j=0;j<256;j++)hist[j]+=part[j];}
  const lut=histogramLut(hist);
  const applied=await stage(workers,partitions,'histogram-apply',simd,lut);
  const fullSize=partitions.reduce((m,p)=>Math.max(m,p.offset+p.pixels.length),0);
  const image=new Uint8ClampedArray(fullSize);
  for(let i=0;i<partitions.length;i++)image.set(new Uint8Array(applied.responses[i].buffer),partitions[i].offset);
  return {image,kernelMs:counted.kernelMs+applied.kernelMs,e2eMs:performance.now()-started};
}
async function measure(workers,parts,simd){
  const trials=[];
  for(let i=0;i<3;i++)trials.push(await oneTrial(workers,parts,simd));
  return {image:trials[2].image,kernelMs:median(trials.map(t=>t.kernelMs)),e2eMs:median(trials.map(t=>t.e2eMs))};
}
export async function benchmarkHistogram(image,workersCount){
  const pixels=image.data,n=Math.max(1,Math.min(Math.floor(workersCount),image.height));
  const all=[];
  try{
    const single=await createWorker();all.push(single);
    const whole=[{pixels,offset:0}];
    const scalar=await measure([single],whole,false);
    const simd=await measure([single],whole,true);
    const workers=await Promise.all(Array.from({length:n},()=>createWorker()));all.push(...workers);
    const rowBytes=image.width*4;
    const parts=Array.from({length:n},(_,i)=>{
      const first=Math.floor(i*image.height/n),last=Math.floor((i+1)*image.height/n);
      return {offset:first*rowBytes,pixels:pixels.subarray(first*rowBytes,last*rowBytes)};
    });
    const parallelScalar=await measure(workers,parts,false);
    const parallelSIMD=await measure(workers,parts,true);
    const delta=Math.max(maxDiff(scalar.image,simd.image),maxDiff(scalar.image,parallelScalar.image),maxDiff(scalar.image,parallelSIMD.image));
    if(delta!==0)throw new Error(`Histogram equalization implementations disagree (maximum channel difference ${delta}).`);
    return {image:new ImageData(simd.image,image.width,image.height),results:[
      {label:'Scalar WASM',kernelMs:scalar.kernelMs,e2eMs:scalar.e2eMs,detail:'Global histogram + mapping · scalar'},
      {label:'SIMD WASM',kernelMs:simd.kernelMs,e2eMs:simd.e2eMs,detail:'SIMD luminance and map; scalar histogram increments'},
      {label:`Parallel Scalar (${n})`,kernelMs:parallelScalar.kernelMs,e2eMs:parallelScalar.e2eMs,detail:'Local histograms + global merge + scalar mapping'},
      {label:`Parallel SIMD (${n})`,kernelMs:parallelSIMD.kernelMs,e2eMs:parallelSIMD.e2eMs,detail:'Local histograms + global merge + SIMD mapping'},
    ],consistent:true,maxChannelDifference:delta,gaussian:false};
  }finally{all.forEach(w=>w.terminate());}
}
