// Pure, deterministic configuration and measurement helpers. Node-testable.
export const OPERATIONS = [
  {mode:0,name:'Grayscale',family:'per-pixel'},
  {mode:1,name:'Color inversion',family:'per-pixel'},
  {mode:2,name:'Brightness',family:'per-pixel'},
  {mode:3,name:'Gaussian blur',family:'neighborhood'},
  {mode:4,name:'Sobel edges',family:'neighborhood'},
  {mode:5,name:'Median filter',family:'neighborhood'},
  {mode:6,name:'Histogram equalization',family:'global reduction'},
];
export const PROFILES={
  quick:{label:'Quick',samples:1,calibrationTimeoutMs:12000,maxPerStrategyMs:12000},
  balanced:{label:'Balanced',samples:3,calibrationTimeoutMs:20000,maxPerStrategyMs:25000},
  thorough:{label:'Thorough',samples:5,calibrationTimeoutMs:35000,maxPerStrategyMs:50000},
};
export function buildPlan({modes=[0,3,5],gaussianKernels=[5],medianKernels=[3],sigma=1.5,brightness=40,resolutions=[480],workers=[4]}={}){
  const jobs=[];
  for(const resolution of resolutions){
    if(![320,480,720,960,1280].includes(Number(resolution)))throw Error('Unsupported resolution');
    for(const mode of modes){
      if(!Number.isInteger(mode)||mode<0||mode>6)throw Error('Unsupported operation');
      const configurations=mode===3?gaussianKernels.map(kernelSize=>({kernelSize,sigma}))
        :mode===5?medianKernels.map(kernelSize=>({kernelSize}))
        :mode===2?[{amount:brightness}]:[{}];
      for(const parameters of configurations){
        if(mode===3&&(!Number.isInteger(parameters.kernelSize)||parameters.kernelSize<3||parameters.kernelSize>31||parameters.kernelSize%2!==1||!Number.isFinite(parameters.sigma)||parameters.sigma<0.5||parameters.sigma>10))throw Error('Invalid Gaussian parameters');
        if(mode===5&&![3,5,7].includes(parameters.kernelSize))throw Error('Invalid median kernel');
        if(mode===2&&(!Number.isInteger(parameters.amount)||Math.abs(parameters.amount)>100))throw Error('Invalid brightness');
        for(const workerCount of workers){
          if(![2,4,6,8].includes(Number(workerCount)))throw Error('Worker count must be 2, 4, 6 or 8');
          const name=OPERATIONS[mode].name;
          const suffix=mode===3?`${parameters.kernelSize}×${parameters.kernelSize}, σ ${parameters.sigma}`:mode===5?`${parameters.kernelSize}×${parameters.kernelSize}`:mode===2?`${parameters.amount>=0?'+':''}${parameters.amount}`:'';
          jobs.push({id:`r${resolution}-m${mode}-${JSON.stringify(parameters)}-w${workerCount}`,mode,name,description:suffix,resolution:Number(resolution),parameters,workers:Number(workerCount)});
        }
      }
    }
  }
  if(jobs.length>48)throw Error(`${jobs.length} experiments selected. Limit the batch to 48 jobs.`);
  if(!jobs.length)throw Error('Choose at least one experiment.');
  return jobs;
}
export function median(values){if(!values.length)return null;const arr=[...values].sort((a,b)=>a-b);const mid=Math.floor(arr.length/2);return arr.length%2?arr[mid]:(arr[mid-1]+arr[mid])/2;}
export function percentile(values,p){if(!values.length)return null;const v=[...values].sort((a,b)=>a-b),k=(v.length-1)*p,low=Math.floor(k),high=Math.ceil(k);return v[low]+(v[high]-v[low])*(k-low);}
export function summarize(values){
  if(!values.length)return {n:0,medianMs:null};
  const avg=values.reduce((a,b)=>a+b,0)/values.length;
  const sd=Math.sqrt(values.reduce((a,b)=>a+(b-avg)**2,0)/values.length);
  return {n:values.length,medianMs:median(values),minMs:Math.min(...values),maxMs:Math.max(...values),p25Ms:percentile(values,.25),p75Ms:percentile(values,.75),cv:avg>0?sd/avg:null};
}
export function speedup(a,b){return a>0&&b>0?a/b:null;}
export function maximumDifference(a,b){if(a.length!==b.length)return Infinity;let m=0;for(let i=0;i<a.length;i++)m=Math.max(m,Math.abs(a[i]-b[i]));return m;}
export function checksum(image){
  // Fast, sampled content signature to prevent resuming with the wrong image.
  let x=2166136261,bytes=image.data,step=Math.max(1,Math.floor(bytes.length/4096));
  for(let i=0;i<bytes.length;i+=step){x=Math.imul(x^bytes[i],16777619)>>>0;}
  return `${image.width}x${image.height}-${x.toString(16)}`;
}
export function saltPepper(image,density=0,seed=42){
  if(!Number.isFinite(density)||density<0||density>0.3)throw Error('Noise density must be 0–30%');
  const data=new Uint8ClampedArray(image.data),length=data.length;
  let state=(seed>>>0)||1;
  const rand=()=>{state=(Math.imul(1664525,state)+1013904223)>>>0;return state/4294967296;};
  for(let i=0;i<length;i+=4)if(rand()<density){const color=rand()<.5?0:255;data[i]=data[i+1]=data[i+2]=color;}
  return {data,width:image.width,height:image.height};
}
export function psnr(clean,filtered){
  if(clean.data.length!==filtered.length)return null;
  let error=0,n=0;
  for(let i=0;i<filtered.length;i+=4){for(let c=0;c<3;c++){error+=(clean.data[i+c]-filtered[i+c])**2;n++;}}
  if(n===0)return null;const mse=error/n;return mse===0?Infinity:10*Math.log10(255*255/mse);
}
export function formatCSV(rows){
  const cols=['timestamp','algorithm','parameters','resolution','width','height','workers','noiseDensity','profile','strategy','samples','kernelMedianMs','kernelP25Ms','kernelP75Ms','kernelCV','wallMedianMs','setupMs','speedupVsScalar','parallelEfficiency','maxDifference','psnrDb','status','notes'];
  const esc=x=>{const s=x==null?'':typeof x==='object'?JSON.stringify(x):String(x);return /[",\r\n]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
  return '\uFEFF'+[cols.join(','),...rows.flatMap(record=>{
    if(!record.strategies?.length)return [cols.map(c=>esc({timestamp:record.timestamp,algorithm:record.name,parameters:record.parameters,resolution:record.resolution,workers:record.workers,status:record.status,notes:record.note}[c])).join(',')];
    return record.strategies.map(s=>cols.map(c=>esc({timestamp:record.timestamp,algorithm:record.name,parameters:record.parameters,resolution:record.resolution,width:record.width,height:record.height,workers:record.workers,noiseDensity:record.noiseDensity,profile:record.profile,strategy:s.label,samples:s.kernel.n,kernelMedianMs:s.kernel.medianMs,kernelP25Ms:s.kernel.p25Ms,kernelP75Ms:s.kernel.p75Ms,kernelCV:s.kernel.cv,wallMedianMs:s.wall.medianMs,setupMs:record.setupMs,speedupVsScalar:s.speedup,parallelEfficiency:s.efficiency,maxDifference:record.maxDifference,psnrDb:record.psnrDb,status:record.status,notes:record.note}[c])).join(','));
  })].join('\r\n');
}
