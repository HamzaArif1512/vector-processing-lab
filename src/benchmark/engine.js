import {histogramLut} from '../histogram.js';
import {PROFILES,maximumDifference,psnr,saltPepper,summarize,speedup} from './core.js';

export class Cancelled extends Error {constructor(){super('Benchmark cancelled');this.name='AbortError';}}
class TimedOut extends Error {constructor(ms){super(`A worker exceeded the ${Math.round(ms/1000)} s execution safeguard.`);this.name='TimeoutError';}}
function check(signal){if(signal?.aborted)throw new Cancelled();}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function percentileTime(values){return summarize(values).medianMs;}
function runMessage(worker,payload,signal,timeoutMs){
  check(signal);
  return new Promise((resolve,reject)=>{
    let done=false;const started=performance.now();
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.removeEventListener('message',message);worker.removeEventListener('error',error);};
    const finish=(err,result)=>{if(done)return;done=true;cleanup();if(err)reject(err);else resolve({...result,wallMs:performance.now()-started});};
    const message=({data})=>{if(data.kind==='result')finish(null,data);else if(data.kind==='error')finish(new Error(data.message));};
    const error=e=>finish(new Error(e.message||'Worker crashed'));
    const abort=()=>finish(new Cancelled());
    const timer=setTimeout(()=>finish(new TimedOut(timeoutMs)),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    worker.addEventListener('message',message);worker.addEventListener('error',error);
    try{const buffer=payload.buffer;worker.postMessage(payload,buffer?[buffer]:[]);}catch(e){finish(e);}
  });
}
function spawn(signal,timeoutMs=12000){
  check(signal);
  const worker=new Worker(new URL('../runner.worker.js',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    let done=false;
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);worker.removeEventListener('message',message);worker.removeEventListener('error',error);};
    const finish=(err)=>{if(done)return;done=true;cleanup();if(err){worker.terminate();reject(err);}else resolve(worker);};
    const message=({data})=>{if(data.kind==='ready')finish();else if(data.kind==='error')finish(new Error(data.message));};
    const error=e=>finish(new Error(e.message||'WASM initialization failed'));
    const abort=()=>finish(new Cancelled());
    const timer=setTimeout(()=>finish(new TimedOut(timeoutMs)),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    worker.addEventListener('message',message);worker.addEventListener('error',error);
  });
}
function partition(image,n,radius){
  const count=Math.min(n,image.height),row=image.width*4;
  return Array.from({length:count},(_,i)=>{
    const first=Math.floor(i*image.height/count),last=Math.floor((i+1)*image.height/count);
    const haloFirst=Math.max(0,first-radius),haloLast=Math.min(image.height,last+radius);
    return {first,last,haloFirst,width:image.width,height:haloLast-haloFirst,pixels:image.data.subarray(haloFirst*row,haloLast*row),offset:first*row};
  });
}
function technique(mode,simd){
  if(mode===3)return `gaussian-${simd?'simd':'scalar'}`;
  if(mode===4)return `sobel-${simd?'simd':'scalar'}`;
  if(mode===5)return `median-${simd?'simd':'scalar'}`;
  if(mode===2)return `brightness-${simd?'simd':'scalar'}`;
  return simd?'simd':'scalar';
}
function responseImage(responses,parts,image,halo){
  const merged=new Uint8ClampedArray(image.data.length),row=image.width*4;
  responses.forEach((res,i)=>{
    const p=parts[i],start=(p.first-p.haloFirst)*row,length=(p.last-p.first)*row;
    const source=new Uint8Array(res.buffer);
    merged.set(source.subarray(start,start+length),p.offset);
  });
  return merged;
}
async function runStage(workers,parts,kind,simd,lut,signal,timeout,warmups){
  const start=performance.now();
  const rs=await Promise.all(workers.map((worker,i)=>runMessage(worker,{kind,simd,lut,repetitions:1,warmups,buffer:parts[i].pixels.slice().buffer},signal,timeout)));
  return {responses:rs,wallMs:performance.now()-start,kernelMs:Math.max(...rs.map(x=>x.kernelMs))};
}
async function executeOnce(workers,image,mode,params,simd,signal,timeoutMs,warmups){
  check(signal);
  const neighborhood=mode===3||mode===4||mode===5;
  const radius=mode===3||mode===5?params.kernelSize>>1:mode===4?1:0;
  // Histogram counts must not overlap halo pixels. Every pixel is counted exactly once.
  const parts=partition(image,workers.length,neighborhood?radius:0);
  if(mode===6){
    const start=performance.now();
    const counted=await runStage(workers,parts,'histogram-count',simd,null,signal,timeoutMs,warmups);
    const counts=new Uint32Array(256);
    for(const r of counted.responses){const bins=new Uint32Array(r.buffer);for(let i=0;i<256;i++)counts[i]+=bins[i];}
    const lut=histogramLut(counts);
    const applied=await runStage(workers,parts,'histogram-apply',simd,lut,signal,timeoutMs,warmups);
    return {image:responseImage(applied.responses,parts,image,false),kernelMs:counted.kernelMs+applied.kernelMs,wallMs:performance.now()-start};
  }
  const config=mode===3?{kernelSize:params.kernelSize,sigma:params.sigma}:mode===5?{kernelSize:params.kernelSize}:mode===2?{amount:params.amount}:mode;
  const start=performance.now();
  const rs=await Promise.all(workers.map((worker,i)=>runMessage(worker,{
    kind:'process',technique:technique(mode,simd),mode:config,width:parts[i].width,height:parts[i].height,repetitions:1,warmups,buffer:parts[i].pixels.slice().buffer
  },signal,timeoutMs)));
  return {image:responseImage(rs,parts,image,neighborhood),kernelMs:Math.max(...rs.map(x=>x.kernelMs)),wallMs:performance.now()-start};
}
export async function measureJob({image,job,profile='balanced',noiseDensity=0,seed=42,signal,budgetRemainingMs=Infinity,onProgress=()=>{}}){
  const policy=PROFILES[profile];if(!policy)throw Error('Unknown measurement profile');
  const start=performance.now(),all=[];
  const record={id:job.id,name:job.name,description:job.description,mode:job.mode,parameters:job.parameters,resolution:job.resolution,workers:job.workers,
    width:image.width,height:image.height,noiseDensity,seed,profile,timestamp:new Date().toISOString(),status:'running',strategies:[],maxDifference:null,setupMs:0,note:''};
  try{
    check(signal);
    const noisy=saltPepper(image,noiseDensity,seed);
    const beginSetup=performance.now();
    const solo=await spawn(signal);all.push(solo);
    const concurrency=Math.min(job.workers,image.height);
    // Worker pool is created after the scalar calibration, avoiding wasteful setup for skipped heavy jobs.
    const definitions=[
      {label:'Scalar WASM',simd:false,parallel:false},
      {label:'SIMD WASM',simd:true,parallel:false},
      {label:`Parallel Scalar (${concurrency})`,simd:false,parallel:true},
      {label:`Parallel SIMD (${concurrency})`,simd:true,parallel:true},
    ];
    record.setupMs+=performance.now()-beginSetup;
    let others=null,baseline=null;
    for(let i=0;i<definitions.length;i++){
      check(signal);
      if(i>0 && budgetRemainingMs-(performance.now()-start)<2500){record.status='skipped';record.note='Batch time budget exhausted before all four strategies finished.';return record;}
      const d=definitions[i];onProgress(`Measuring ${d.label} · ${job.name}`);
      if(d.parallel&&!others){const t=performance.now();others=await Promise.all(Array.from({length:concurrency},()=>spawn(signal)));all.push(...others);record.setupMs+=performance.now()-t;}
      const pool=d.parallel?others:[solo];
      const kernels=[],walls=[];
      const remaining=()=>budgetRemainingMs-(performance.now()-start);
      // A finite timeout protects the UI from a multi-minute kernel. It terminates the worker pool on failure.
      const timeout=Math.max(1500,Math.min(policy.calibrationTimeoutMs,remaining()));
      const first=await executeOnce(pool,noisy,job.mode,job.parameters,d.simd,signal,timeout,1);
      kernels.push(first.kernelMs);walls.push(first.wallMs);
      if(i===0){
        baseline=first.image;
        if(first.wallMs>policy.maxPerStrategyMs){record.note='Scalar calibration exceeded the profile cap; skipped remaining strategies.';record.status='skipped';return record;}
      }else{
        const delta=maximumDifference(baseline,first.image);
        record.maxDifference=Math.max(record.maxDifference??0,delta);
      }
      const maxSamples=policy.samples;
      for(let j=1;j<maxSamples;j++){
        check(signal);
        if(remaining()<=1500||kernels.reduce((a,b)=>a+b,0)+first.wallMs>policy.maxPerStrategyMs)break;
        if((j+1)*Math.max(first.wallMs,2)>Math.min(policy.maxPerStrategyMs,remaining()))break;
        const run=await executeOnce(pool,noisy,job.mode,job.parameters,d.simd,signal,Math.max(1500,Math.min(policy.calibrationTimeoutMs,remaining())),0);
        kernels.push(run.kernelMs);walls.push(run.wallMs);
      }
      record.strategies.push({label:d.label,parallel:d.parallel,simd:d.simd,kernel:summarize(kernels),wall:summarize(walls)});
      onProgress(`${d.label}: ${kernels.length} sample${kernels.length!==1?'s':''}`);
      if(i===0)record.psnrDb=(job.mode===5&&noiseDensity>0)?psnr(image,baseline):null;
      await tick();
    }
    const scalar=record.strategies[0],simd=record.strategies[1];
    for(const s of record.strategies){
      s.speedup=speedup(scalar.wall.medianMs,s.wall.medianMs);
      const compare=s.simd?simd:scalar;
      s.efficiency=s.parallel?speedup(compare.wall.medianMs,s.wall.medianMs)/concurrency:null;
    }
    record.status=(record.maxDifference??0)<=(job.mode===3?1:0)?'completed':'mismatch';
    if(record.strategies.some(s=>s.kernel.n<3))record.note='Some strategies have fewer than 3 timed samples; interpret variability cautiously.';
    return record;
  }catch(e){
    if(e.name==='AbortError')throw e;
    record.status=e.name==='TimeoutError'?'skipped':'failed';record.note=e.message;return record;
  }finally{for(const w of all)w.terminate();}
}
export async function runBatch({jobs,imageProvider,profile='balanced',budgetMs=600000,noiseDensity=0,seed=42,signal,onProgress=()=>{},onRecord=()=>{},existing=[]}){
  const start=performance.now(),records=[...existing];
  const done=new Set(existing.map(r=>r.id));
  for(let i=0;i<jobs.length;i++){
    check(signal);const job=jobs[i];if(done.has(job.id))continue;
    const remaining=budgetMs-(performance.now()-start);
    if(remaining<3000){onProgress('Time budget reached. Unfinished experiments are available for resuming.');break;}
    onProgress(`Experiment ${i+1} of ${jobs.length} · ${job.name} · ${job.resolution}px`);
    const image=await imageProvider(job.resolution);
    check(signal);
    const record=await measureJob({image,job,profile,noiseDensity,seed,signal,budgetRemainingMs:remaining,onProgress});
    records.push(record);done.add(job.id);onRecord(record,records);await tick();
  }
  return {records,remaining:jobs.filter(j=>!done.has(j.id)).length,elapsedMs:performance.now()-start};
}

// Studio uses the same worker execution, timing definitions, and correctness rules
// as Benchmark Lab. First show the SIMD image, then collect comparison strategies.
export async function runStudio({image,mode,parameters={},workers=4,profile='quick',signal,onProgress=()=>{},onPreview=()=>{}}){
  if(!image?.data?.length)throw Error('Choose an image first');
  if(!['quick','full'].includes(profile))throw Error('Unknown Studio profile');
  const start=performance.now();
  const all=[];
  const n=Math.max(1,Math.min(Math.floor(workers),image.height));
  const samples=profile==='full'?3:1;
  const defs=[
    {label:'SIMD WASM',simd:true,parallel:false},
    {label:'Scalar WASM',simd:false,parallel:false},
    {label:`Parallel Scalar (${n})`,simd:false,parallel:true},
    {label:`Parallel SIMD (${n})`,simd:true,parallel:true},
  ];
  let preview=null,reference=null,pool=null;
  const measured=[];
  let diff=0;
  try{
    onProgress('Initializing WebAssembly…');
    const solo=await spawn(signal);all.push(solo);
    for(const def of defs){
      check(signal);
      if(def.parallel&&!pool){onProgress('Preparing parallel workers…');pool=await Promise.all(Array.from({length:n},()=>spawn(signal)));all.push(...pool);}
      const workersForRun=def.parallel?pool:[solo];
      const kernel=[],wall=[];
      for(let sample=0;sample<samples;sample++){
        check(signal);
        onProgress(`${def.label} · measurement ${sample+1}/${samples}`);
        // A generous watchdog guards a stalled worker without invalidating slower
        // real workloads. Cancellation terminates its workers immediately.
        const result=await executeOnce(workersForRun,image,mode,parameters,def.simd,signal,180000,sample===0?1:0);
        kernel.push(result.kernelMs);wall.push(result.wallMs);
        if(sample===0){
          if(def.label==='SIMD WASM'){preview=result.image;onPreview(new ImageData(new Uint8ClampedArray(preview),image.width,image.height));}
          if(def.label==='Scalar WASM'){reference=result.image;diff=Math.max(diff,maximumDifference(reference,preview));}
          if(def.parallel){diff=Math.max(diff,maximumDifference(reference,result.image));}
        }
        await tick();
      }
      measured.push({label:def.label,parallel:def.parallel,simd:def.simd,kernel:summarize(kernel),wall:summarize(wall)});
      onProgress(`${def.label} complete · ${measured.length}/4 strategies`);
    }
    const tolerance=mode===3?1:0;
    if(diff>tolerance)throw Error(`Implementations disagree: max channel difference ${diff}, allowed ${tolerance}`);
    const results=[measured[1],measured[0],measured[2],measured[3]].map(s=>({
      label:s.label,kernelMs:s.kernel.medianMs,e2eMs:s.wall.medianMs,
      samples:s.kernel.n,kernelCV:s.kernel.cv,wallCV:s.wall.cv,
      detail:`${s.parallel?'Parallel workers':'One worker'} · ${s.simd?'SIMD128':'scalar'} · ${s.kernel.n} measured run(s)`
    }));
    onProgress('Verified all four execution strategies.');
    return {image:new ImageData(new Uint8ClampedArray(preview),image.width,image.height),
      results,consistent:true,maxChannelDifference:diff,studioProfile:profile,
      totalElapsedMs:performance.now()-start,actualWidth:image.width,actualHeight:image.height};
  }finally{for(const w of all)w.terminate();}
}
