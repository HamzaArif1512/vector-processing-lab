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
