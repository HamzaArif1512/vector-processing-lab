import React,{useEffect,useMemo,useRef,useState} from 'react';
import {Zap,Play,Square,Download,RotateCcw,BarChart3,Activity,CheckCircle2,AlertTriangle,Clock3,SlidersHorizontal,Database,Info,FileText,Image as ImageIcon} from 'lucide-react';
import {OPERATIONS,PROFILES,buildPlan,checksum,saltPepper} from './core.js';
import {Cancelled,runBatch} from './engine.js';
import {loadSession,saveSession,clearSession,environment,exportCSV,exportJSON,exportReport} from './report.js';
import './bench.css';
const arrayToggle=(a,v)=>a.includes(v)?a.filter(x=>x!==v):[...a,v].sort((x,y)=>x-y);
const formatMs=v=>v==null?'—':v>=1000?`${(v/1000).toFixed(2)} s`:`${v.toFixed(2)} ms`;
const formatFactor=v=>v&&Number.isFinite(v)?`${v.toFixed(2)}×`:'—';
function LabelCheck({value,selected,onChange,children}){return <label className={`bench-check ${selected?'selected':''}`}><input type="checkbox" checked={selected} onChange={()=>onChange(value)}/>{children}</label>;}
function resizeImage(image,maxEdge){
  if(Math.max(image.width,image.height)<=maxEdge)return image;
  const f=Math.min(1,maxEdge/Math.max(image.width,image.height)),w=Math.max(1,Math.floor(image.width*f)),h=Math.max(1,Math.floor(image.height*f));
  const original=document.createElement('canvas');original.width=image.width;original.height=image.height;original.getContext('2d').putImageData(image,0,0);
  const scaled=document.createElement('canvas');scaled.width=w;scaled.height=h;scaled.getContext('2d').drawImage(original,0,0,w,h);
  return scaled.getContext('2d',{willReadFrequently:true}).getImageData(0,0,w,h);
}
function Preview({image,density,seed}){
  const a=useRef(),b=useRef();
  useEffect(()=>{
    if(!image)return;
    const reduced=resizeImage(image,480),noisy=saltPepper(reduced,density,seed);
    for(const [canvas,pixels] of [[a.current,reduced],[b.current,noisy]]){
      if(!canvas)continue;canvas.width=pixels.width;canvas.height=pixels.height;
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.data),pixels.width,pixels.height),0,0);
    }
  },[image,density,seed]);
  return <div className="bench-preview"><div><span>CLEAN REFERENCE</span><canvas ref={a}/></div><div><span>BENCHMARK INPUT {density?`· ${Math.round(density*100)}% NOISE`:''}</span><canvas ref={b}/></div></div>;
}
function GroupedChart({records,metric='wall'}){
  const completed=records.filter(r=>r.status==='completed');
  if(!completed.length)return <div className="bench-empty-chart">Completed experiments will appear here.</div>;
  const recent=completed.slice(-14),max=Math.max(0.001,...recent.flatMap(r=>r.strategies.map(s=>s[metric].medianMs||0)));
  return <div className="bench-chart-list">{recent.map(r=><div className="bench-chart-group" key={r.id}>
    <div className="bench-chart-title"><strong>{r.name} {r.description}</strong><span>{r.width}×{r.height} · {r.workers} workers</span></div>
    {r.strategies.map((s,i)=><div className="bench-chart-line" key={i}><span>{['Scalar','SIMD','P. Scalar','P. SIMD'][i]}</span><div className="bench-chart-track"><div className={`bench-chart-fill v${i}`} style={{width:`${100*(s[metric].medianMs||0)/max}%`}}/></div><b>{formatMs(s[metric].medianMs)}</b></div>)}
  </div>)}</div>;
}
function Scatter({records}){
  const done=records.filter(r=>r.status==='completed');
  const groups=new Map();
  for(const r of done){const k=`${r.name} ${r.description} · ${r.resolution}px`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
  const selected=[...groups].find(([,v])=>v.length>=2)||[...groups][0];
  if(!selected)return null;
  const [group,points]=selected;const ordered=[...points].sort((a,b)=>a.workers-b.workers);
  const xValues=ordered.map(r=>r.workers),yValues=ordered.map(r=>r.strategies[3].speedup).filter(Number.isFinite);
  if(!yValues.length)return null;
  const ymin=0,ymax=Math.max(1,...yValues)*1.18,xmin=Math.min(...xValues),xmax=Math.max(...xValues);
  const loc=(x,y)=>`${44+(x-xmin)/Math.max(1,xmax-xmin)*450},${172-(y-ymin)/(ymax-ymin)*138}`;
  return <div className="bench-scatter"><div className="bench-chart-title"><strong>Parallel SIMD speedup vs scalar</strong><span>{group}</span></div><svg role="img" aria-label={`Parallel SIMD speedup for ${group}`} viewBox="0 0 520 205" preserveAspectRatio="xMidYMid meet"><path d="M44 22 V172 H494" stroke="#385369" fill="none" strokeWidth="1.5"/><path d={`M44 ${172-138/ymax} H494`} stroke="#49606c" strokeDasharray="4 5"/><text x="8" y="32" fill="#8a9bae" fontSize="11">{ymax.toFixed(1)}×</text><text x="12" y="176" fill="#8a9bae" fontSize="11">0×</text>
    {ordered.length>1&&<polyline points={ordered.map(r=>loc(r.workers,r.strategies[3].speedup)).join(' ')} stroke="#23cba9" fill="none" strokeWidth="3"/>}
    {ordered.map(r=><g key={r.id}><circle cx={44+(r.workers-xmin)/Math.max(1,xmax-xmin)*450} cy={172-r.strategies[3].speedup/ymax*138} r="5" fill="#23cba9"/><text x={44+(r.workers-xmin)/Math.max(1,xmax-xmin)*450} y="192" textAnchor="middle" fill="#a4b9c7" fontSize="11">{r.workers}w</text></g>)}
  </svg></div>;
}
function ScalingChart({records}){
  const done=records.filter(r=>r.status==='completed');
  let group=null,axis='Image edge';
  const find=(kind)=>{
    const groups=new Map();
    for(const r of done){
      if(kind==='kernel'&&![3,5].includes(r.mode))continue;
      const key=kind==='resolution'?`${r.mode}:${JSON.stringify(r.parameters)}:${r.workers}`
        :`${r.mode}:${r.resolution}:${r.workers}:${r.parameters.sigma??''}`;
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({...r,x:kind==='resolution'?Math.max(r.width,r.height):r.parameters.kernelSize});
    }
    return [...groups.values()].find(g=>new Set(g.map(r=>r.x)).size>=2)||null;
  };
  group=find('resolution');if(!group){group=find('kernel');axis='Kernel width';}
  if(!group)return <p className="bench-help">Select at least two resolutions or kernel sizes to visualize workload scaling.</p>;
  const data=[...group].sort((a,b)=>a.x-b.x);
  const xmin=data[0].x,xmax=data[data.length-1].x;
  const ymax=Math.max(1,...data.flatMap(r=>[r.strategies[0].wall.medianMs,r.strategies[3].wall.medianMs]))*1.15;
  const xx=x=>42+(x-xmin)/Math.max(1,xmax-xmin)*448;
  const yy=y=>173-y/ymax*142;
  return <div className="bench-scatter"><div className="bench-chart-title"><strong>{axis} scaling · {data[0].name}</strong><span>Wall-clock latency · same algorithm and worker configuration</span></div><svg role="img" aria-label={`${axis} scaling for ${data[0].name}`} viewBox="0 0 520 218">
  <path d="M42 27V173H492" fill="none" stroke="#385369" strokeWidth="1.5"/>
  <text x="3" y="32" fill="#8a9bae" fontSize="10">{ymax>=1000?`${(ymax/1000).toFixed(1)}s`:`${Math.round(ymax)}ms`}</text>
  {[[0,'#8da5bd'],[3,'#23cba9']].map(([i,color])=><polyline key={i} points={data.map(r=>`${xx(r.x)},${yy(r.strategies[i].wall.medianMs)}`).join(' ')} fill="none" stroke={color} strokeWidth="2.5"/>)}
  {data.map(r=><g key={r.id}><circle cx={xx(r.x)} cy={yy(r.strategies[0].wall.medianMs)} r="4" fill="#8da5bd"/><circle cx={xx(r.x)} cy={yy(r.strategies[3].wall.medianMs)} r="4" fill="#23cba9"/><text x={xx(r.x)} y="193" textAnchor="middle" fill="#a4b9c7" fontSize="10">{r.x}</text></g>)}
  <text x="75" y="213" fill="#8da5bd" fontSize="10">● Scalar</text><text x="175" y="213" fill="#23cba9" fontSize="10">● Parallel SIMD</text>
  </svg></div>;
}
function Interpretation({record}){
  if(!record||record.status!=='completed')return null;
  const s=record.strategies,p=s[3]?.speedup,simd=s[1]?.speedup;
  const insights=[];
  if(p<1)insights.push('Parallel SIMD was slower than scalar on this input; coordination and transfer costs may outweigh the compute gain.');
  else if(p>1.5)insights.push(`Parallel SIMD delivered ${p.toFixed(2)}× lower wall-clock latency than scalar for this configuration.`);
  else insights.push('Parallel SIMD provided a modest wall-clock improvement.');
  if(simd<1)insights.push('Single-worker SIMD did not improve wall-clock latency on this experiment.');
  if(s.some(x=>x.kernel.n<3))insights.push('Some strategies have fewer than three samples; treat speedups as preliminary.');
  if(s.some(x=>x.kernel.cv!=null&&x.kernel.cv>.12))insights.push('Timing variation exceeds 12% for at least one strategy; system load may affect results.');
  return <div className="bench-interpret"><strong><Info size={15}/> Interpretation</strong>{insights.map((x,i)=><p key={i}>{x}</p>)}</div>;
}
export default function BenchmarkLab({source,sourceName}){
  const [modes,setModes]=useState([0,3,5]);
  const [gaussianKernels,setGaussianKernels]=useState([5]);
  const [medianKernels,setMedianKernels]=useState([3]);
  const [sigma,setSigma]=useState(1.5),[brightness,setBrightness]=useState(40);
  const [resolutions,setResolutions]=useState([480]);
  const [workers,setWorkers]=useState([4]);
  const [noisePct,setNoisePct]=useState(0),[seed,setSeed]=useState(42);
  const [profile,setProfile]=useState('balanced'),[budget,setBudget]=useState(5);
  const [saved,setSaved]=useState(()=>loadSession());
  const [records,setRecords]=useState(()=>loadSession()?.records||[]);
  const [running,setRunning]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState('');
  const [view,setView]=useState('wall'),[detailsId,setDetailsId]=useState('');
  const abortRef=useRef(null),sessionRef=useRef(saved);
  useEffect(()=>()=>{abortRef.current?.abort();},[]);
  const sig=useMemo(()=>source?checksum(source):null,[source]);
  const settings={modes,gaussianKernels,medianKernels,sigma,brightness,resolutions,workers};
  const plan=useMemo(()=>{try{return {jobs:buildPlan(settings)};}catch(e){return {jobs:[],error:e.message};}},[modes,gaussianKernels,medianKernels,sigma,brightness,resolutions,workers]);
  const signature=JSON.stringify({sig,settings,noisePct,seed,profile,budget});
  const canResume=!!(saved?.signature===signature && records.length<plan.jobs.length);
  const completed=records.filter(r=>r.status==='completed');
  const selected=records.find(r=>r.id===detailsId)||[...records].reverse().find(r=>r.status==='completed');
  const store=(s)=>{sessionRef.current=s;setSaved(s);saveSession(s);};
  const start=async()=>{
    if(!source||running||plan.error)return;
    const resume=canResume;const now=new Date().toISOString();
    const env=resume?saved.environment:environment();
    const initial=resume?records:[];
    const session={version:1,signature,profile,noiseDensity:noisePct/100,seed,jobs:plan.jobs,records:initial,environment:env,sourceName,createdAt:resume?saved.createdAt:now,updatedAt:now};
    store(session);setRecords(initial);setRunning(true);setError('');setProgress('Preparing experiments...');
    const ctrl=new AbortController();abortRef.current=ctrl;
    const cache=new Map();
    try{
      const result=await runBatch({jobs:plan.jobs,imageProvider:async resolution=>{
        if(!cache.has(resolution))cache.set(resolution,resizeImage(source,resolution));return cache.get(resolution);
      },profile,budgetMs:budget*60000,noiseDensity:noisePct/100,seed,signal:ctrl.signal,existing:initial,
      onProgress:setProgress,onRecord:(_,list)=>{
        const current={...sessionRef.current,records:[...list],updatedAt:new Date().toISOString()};
        store(current);setRecords([...list]);
      }});
      setProgress(result.remaining?`${result.remaining} experiment(s) remain. Resume to continue.`:`Batch completed. ${result.records.length} experiment(s) recorded.`);
    }catch(e){if(e instanceof Cancelled||e.name==='AbortError')setProgress('Stopped. Completed measurements are saved; Resume continues unfinished experiments.');else{setError(e.message);setProgress('Batch interrupted. Existing results were preserved.');}}
    finally{setRunning(false);abortRef.current=null;cache.clear();}
  };
  const stop=()=>{abortRef.current?.abort();setProgress('Stopping active worker...');};
  const reset=()=>{if(running)return;setRecords([]);sessionRef.current=null;setSaved(null);clearSession();setDetailsId('');setProgress('');setError('');};
  const exportable={...saved,records};
  return <div className="bench-root">
    <div className="bench-heading"><div><div className="sectiontag">BENCHMARK LAB / CONTROLLED EXPERIMENTS</div><h2>Turn filters into evidence.</h2><p>Choose workloads, run fair comparisons, track variability, and export reproducible results. All processing stays in your browser.</p></div><div className="bench-pill"><Activity size={16}/> CPU · WASM SIMD128</div></div>
    <div className="bench-columns"><section className="bench-panel bench-config">
      <div className="bench-section-header"><SlidersHorizontal size={18}/><h3>Experiment design</h3><small>01 / SETUP</small></div>
      <label className="bench-field-title">Algorithms</label>
      <div className="bench-operations">{OPERATIONS.map(op=><LabelCheck key={op.mode} value={op.mode} selected={modes.includes(op.mode)} onChange={v=>setModes(arrayToggle(modes,v))}>{op.name}<span>{op.family}</span></LabelCheck>)}</div>
      {(modes.includes(3)||modes.includes(5)||modes.includes(2))&&<div className="bench-param-grid">
        {modes.includes(3)&&<div><label className="bench-field-title">Gaussian kernels</label><div className="bench-option-row">{[3,5,7,9,15].map(v=><LabelCheck key={v} value={v} selected={gaussianKernels.includes(v)} onChange={x=>setGaussianKernels(arrayToggle(gaussianKernels,x))}>{v}×{v}</LabelCheck>)}</div><label className="bench-sub-label">Sigma · {sigma.toFixed(1)}</label><input type="range" min="0.5" max="10" step="0.5" value={sigma} onChange={e=>setSigma(Number(e.target.value))}/></div>}
        {modes.includes(5)&&<div><label className="bench-field-title">Median kernels</label><div className="bench-option-row">{[3,5,7].map(v=><LabelCheck key={v} value={v} selected={medianKernels.includes(v)} onChange={x=>setMedianKernels(arrayToggle(medianKernels,x))}>{v}×{v}</LabelCheck>)}</div></div>}
        {modes.includes(2)&&<div><label className="bench-field-title">Brightness · {brightness>0?'+':''}{brightness}</label><input type="range" min="-100" max="100" step="5" value={brightness} onChange={e=>setBrightness(Number(e.target.value))}/></div>}
      </div>}
      <div className="bench-divider"/>
      <label className="bench-field-title">Maximum image edge</label><p className="bench-help">Source: {source?.width} × {source?.height} px. Every result records the effective processed dimensions.</p><div className="bench-option-row">{[320,480,720,960,1280,1800].map(v=><LabelCheck key={v} value={v} selected={resolutions.includes(v)} onChange={x=>setResolutions(arrayToggle(resolutions,x))}>{v}px</LabelCheck>)}</div>
      <p className="bench-help">Images are downscaled only, never enlarged. 1800px preserves full resolution for images uploaded at or below the Studio upload limit. Resizing and noise generation are excluded from timed processing.</p>
      <label className="bench-field-title">Parallel workers</label><div className="bench-option-row">{[2,4,6,8].map(v=><LabelCheck key={v} value={v} selected={workers.includes(v)} onChange={x=>setWorkers(arrayToggle(workers,x))}>{v}</LabelCheck>)}</div>
      <div className="bench-divider"/>
      <div className="bench-section-header"><ImageIcon size={18}/><h3>Noise injection</h3><small>02 / INPUT</small></div>
      <div className="bench-between"><label className="bench-field-title">Salt-and-pepper density</label><strong>{noisePct}%</strong></div>
      <input type="range" min="0" max="30" step="1" value={noisePct} onChange={e=>setNoisePct(Number(e.target.value))}/>
      <label className="bench-sub-label">Random seed <input className="bench-number" type="number" min="1" max="2147483647" value={seed} onChange={e=>setSeed(Math.max(1,Math.min(2147483647,Number(e.target.value)||1)))}/></label>
      {source?<Preview image={source} density={noisePct/100} seed={seed}/>:<p className="bench-help">Select or upload an image in Image Studio first.</p>}
      <p className="bench-help">Noise is generated once per resolution with a fixed seed. It is not included in kernel or wall-clock operation timing.</p>
    </section>
    <section className="bench-right"><div className="bench-panel">
      <div className="bench-section-header"><Clock3 size={18}/><h3>Execution policy</h3><small>03 / RUN</small></div>
      <div className="bench-two-col"><label>Measurement profile<select value={profile} onChange={e=>setProfile(e.target.value)}>{Object.entries(PROFILES).map(([key,p])=><option key={key} value={key}>{p.label} · up to {p.samples} samples</option>)}</select></label><label>Soft batch budget<select value={budget} onChange={e=>setBudget(Number(e.target.value))}>{[2,5,10,15,30].map(v=><option key={v} value={v}>{v} minutes</option>)}</select></label></div>
      <div className="bench-summary"><div><strong>{plan.jobs.length}</strong><span>Planned jobs</span></div><div><strong>{completed.length}</strong><span>Completed</span></div><div><strong>{records.length}</strong><span>Recorded</span></div></div>
      <p className="bench-help">Each job runs scalar, SIMD, parallel scalar and parallel SIMD on identical pixels. Expensive kernels can be skipped by a timeout. A budget is not a promise of exact completion time.</p>
      {plan.error&&<div className="bench-warning"><AlertTriangle size={16}/>{plan.error}</div>}
      <div className="bench-action-row"><button className="bench-start" disabled={!source||running||!!plan.error} onClick={start}><Play size={16}/>{canResume?'Resume unfinished jobs':'Start new batch'}</button><button className="bench-stop" disabled={!running} onClick={stop}><Square size={15}/> Stop</button><button className="bench-reset" disabled={running||!records.length} title="Clear saved session" onClick={reset}><RotateCcw size={17}/></button></div>
      <div className="bench-progress" role="status"><span className={running?'bench-pulse':''}/>{running?'Running · ':''}{progress||'Ready to benchmark'}{error&&<div className="bench-warning">{error}</div>}</div>
      {saved&&saved.signature!==signature&&records.length>0&&<p className="bench-help">Configuration or image changed. Starting will create a new batch. Export your previous results first if needed.</p>}
      <div className="bench-export"><button disabled={!records.length||running} onClick={()=>exportCSV(records)}><Download size={14}/> CSV</button><button disabled={!records.length||running} onClick={()=>exportJSON(exportable)}><Database size={14}/> JSON</button><button disabled={!records.length||running} onClick={()=>exportReport(exportable)}><FileText size={14}/> HTML report</button></div>
    </div>
    <div className="bench-panel"><div className="bench-section-header"><BarChart3 size={18}/><h3>Performance analysis</h3><small>04 / RESULTS</small></div>
      <div className="bench-tab-row"><button className={view==='wall'?'active':''} onClick={()=>setView('wall')}>Wall-clock</button><button className={view==='kernel'?'active':''} onClick={()=>setView('kernel')}>Kernel</button></div>
      <GroupedChart records={records} metric={view}/><Scatter records={records}/><ScalingChart records={records}/>
      <p className="bench-help">Wall-clock excludes worker initialization and input resizing. Parallel kernel time reports the longest worker (for histogram, the sum of stage maxima).</p>
    </div></section></div>
    <section className="bench-panel bench-records"><div className="bench-section-header"><Activity size={18}/><h3>Experiment log</h3><small>05 / AUDIT TRAIL</small></div>
    <div className="bench-table-scroll"><table><thead><tr><th>Experiment</th><th>Input</th><th>Workers</th><th>Scalar wall</th><th>Parallel SIMD wall</th><th>Speedup</th><th>Result</th></tr></thead><tbody>{records.length===0?<tr><td colSpan="7" className="bench-table-empty">No measurements recorded yet. Pick a small workload and start a batch.</td></tr>:records.map(r=><tr key={r.id} className={selected?.id===r.id?'selected':''} onClick={()=>setDetailsId(r.id)}><td><strong>{r.name}</strong><small>{r.description||'Default parameters'}</small></td><td>{r.width}×{r.height}</td><td>{r.workers}</td><td>{formatMs(r.strategies?.[0]?.wall?.medianMs)}</td><td>{formatMs(r.strategies?.[3]?.wall?.medianMs)}</td><td>{formatFactor(r.strategies?.[3]?.speedup)}</td><td><span className={`bench-status ${r.status}`}>{r.status==='completed'?<CheckCircle2 size={13}/>:<AlertTriangle size={13}/>} {r.status}</span></td></tr>)}</tbody></table></div>
    {selected&&<div className="bench-detail"><div className="bench-between"><strong>{selected.name} {selected.description} · {selected.width}×{selected.height}</strong><span className="bench-help">{new Date(selected.timestamp).toLocaleString()}</span></div>
      {selected.strategies?.length>0&&<div className="bench-table-scroll"><table><thead><tr><th>Strategy</th><th>Kernel median</th><th>Kernel IQR</th><th>Wall median</th><th>Samples</th><th>Kernel CV</th><th>Efficiency</th></tr></thead><tbody>{selected.strategies.map(s=><tr key={s.label}><td>{s.label}</td><td>{formatMs(s.kernel.medianMs)}</td><td>{formatMs(s.kernel.p25Ms)}–{formatMs(s.kernel.p75Ms)}</td><td>{formatMs(s.wall.medianMs)}</td><td>{s.kernel.n}</td><td>{s.kernel.cv==null?'—':`${(s.kernel.cv*100).toFixed(1)}%`}</td><td>{s.efficiency==null?'—':`${(s.efficiency*100).toFixed(1)}%`}</td></tr>)}</tbody></table></div>}
      <div className="bench-detail-meta"><span>Max channel difference: <b>{selected.maxDifference??'—'}</b></span><span>Setup: <b>{formatMs(selected.setupMs)}</b></span><span>Output PSNR: <b>{selected.psnrDb===Infinity?'∞':selected.psnrDb==null?'—':`${selected.psnrDb.toFixed(1)} dB`}</b></span></div>
      {selected.note&&<p className="bench-warning">{selected.note}</p>}<Interpretation record={selected}/>
    </div>}
    <div className="bench-footer-note"><Info size={15}/><span>Warm-ups are untimed. Samples and variability are recorded for transparency. Actual timings depend on browser, device, worker transfers and thermal load. Reports can be reproduced with saved parameters and seed, not guaranteed identical timings.</span></div>
    </section>
  </div>;
}
