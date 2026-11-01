import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UploadCloud, Zap, Cpu, Layers, Image as ImageIcon, Download, CheckCircle2, AlertTriangle, RefreshCw, Github, ArrowRight, Activity } from 'lucide-react';
import { benchmark, MODES } from './processing';
import './styles.css';
import BenchmarkLab from './benchmark/BenchmarkLab.jsx';

function makeDemo() {
  const canvas = document.createElement('canvas');
  canvas.width = 900; canvas.height = 560;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 900, 560);
  grad.addColorStop(0, '#0b294d'); grad.addColorStop(.55, '#1b6384'); grad.addColorStop(1, '#fabd83');
  ctx.fillStyle = grad; ctx.fillRect(0,0,900,560);
  const sun = ctx.createRadialGradient(690,155,2,690,155,140);
  sun.addColorStop(0,'#fff2c3'); sun.addColorStop(.2,'#ffe1a0'); sun.addColorStop(1,'#ffe1a000');
  ctx.fillStyle=sun;ctx.fillRect(520,-10,340,340);
  ctx.fillStyle='#1e526e';ctx.beginPath();ctx.moveTo(0,350);ctx.lineTo(175,105);ctx.lineTo(360,350);ctx.lineTo(510,180);ctx.lineTo(755,390);ctx.lineTo(900,290);ctx.lineTo(900,560);ctx.lineTo(0,560);ctx.fill();
  ctx.fillStyle='#123b55';ctx.beginPath();ctx.moveTo(0,415);ctx.lineTo(260,250);ctx.lineTo(420,425);ctx.lineTo(650,300);ctx.lineTo(900,460);ctx.lineTo(900,560);ctx.lineTo(0,560);ctx.fill();
  const water=ctx.createLinearGradient(0,410,0,560);water.addColorStop(0,'#79a9ac');water.addColorStop(1,'#163f65');ctx.fillStyle=water;ctx.fillRect(0,439,900,121);
  for(let i=0;i<80;i++){const x=(i*173)%900, y=445+(i*47)%110;ctx.fillStyle=`rgba(255,240,206,${0.1+(i%6)*0.05})`;ctx.fillRect(x,y,18+(i%8)*11,1.5)}
  return canvas;
}

function App() {
  const [workspace,setWorkspace]=useState('studio');
  const [source, setSource] = useState(null);
  const [sourceName,setSourceName]=useState('demo-landscape.png');
  const [mode,setMode]=useState(0);
  const [threads,setThreads]=useState(4);
  const [kernelSize,setKernelSize]=useState(5);
  const [sigma,setSigma]=useState(1);
  const [medianSize,setMedianSize]=useState(3);
  const [brightness,setBrightness]=useState(40);
  const [timing,setTiming]=useState('kernelMs');
  const [results,setResults]=useState(null);
  const [running,setRunning]=useState(false);
  const [error,setError]=useState('');
  const original=useRef(null), output=useRef(null), fileInput=useRef(null);
  const setFromCanvas=useCallback((canvas,name)=>{
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    setSource(image);setSourceName(name);setResults(null);setError('');
  },[]);
  useEffect(()=>{setFromCanvas(makeDemo(),'demo-landscape.png')},[setFromCanvas]);
  useEffect(()=>{
    if(!source||!original.current)return;
    original.current.width=source.width;original.current.height=source.height;
    original.current.getContext('2d').putImageData(source,0,0);
    if(!results&&output.current){output.current.width=source.width;output.current.height=source.height;output.current.getContext('2d').putImageData(source,0,0)}
  },[source,results,workspace]);
  const handleFile=async(e)=>{
    const file=e.target.files?.[0];if(!file)return;
    if(!file.type.startsWith('image/')){setError('Please choose an image file.');return;}
    try {
      const bitmap=await createImageBitmap(file);
      const scale=Math.min(1,1800/Math.max(bitmap.width,bitmap.height));
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.floor(bitmap.width*scale));canvas.height=Math.max(1,Math.floor(bitmap.height*scale));
      canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);
      bitmap.close();setFromCanvas(canvas,file.name);
    }catch(err){setError(err.message)}
    e.target.value='';
  };
  const run=async()=>{
    if(!source||running)return;
    setRunning(true);setError('');    setResults(null);
    await new Promise(resolve=>setTimeout(resolve,30));
    try {
      const response=await benchmark(
        source,
        mode,
        threads,
        mode === 3 ? { kernelSize, sigma } : mode === 5 ? { kernelSize: medianSize } : mode === 2 ? { amount: brightness } : undefined,
      );
      setResults(response);
    }
    catch(err){setError(err.message)}finally{setRunning(false)}
  };
  // useEffect(()=>{if(results&&output.current){output.current.width=results.image.width;output.current.height=results.image.height;output.current.getContext('2d').putImageData(results.image,0,0)}},[results]);
  
useEffect(() => {
  if (!results || !output.current) return;

  const canvas = output.current;
  const ctx = canvas.getContext('2d');

  // Set the canvas dimensions.
  canvas.width = results.image.width;
  canvas.height = results.image.height;

  // Draw the processed image.
  ctx.putImageData(results.image, 0, 0);

  // Verify that the processed image was drawn.
  const displayedImage = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );

  let maxDifference = 0;

  for (let i = 0; i < displayedImage.data.length; i++) {
    maxDifference = Math.max(
      maxDifference,
      Math.abs(
        displayedImage.data[i] - results.image.data[i]
      )
    );
  }

  console.log("Canvas rendering diagnostic:", {
    width: canvas.width,
    height: canvas.height,
    maxRenderingDifference: maxDifference
  });

}, [results,workspace]);

  const download=()=>{if(!output.current||!results)return;const link=document.createElement('a');link.download='vectorlab-processed.png';link.href=output.current.toDataURL('image/png');link.click()};
  const timingLabel = timing === 'kernelMs' ? 'Kernel execution time' : 'End-to-end execution time';
  const measured = result => result?.[timing] ?? 0;
  const fastest=results?Math.min(...results.results.map(measured)):0;
  return <div className="app">
    <header className="topbar"><a className="brand" href="#"><span className="brandmark"><Layers size={21}/></span><span>vector<span className="brandaccent">lab</span><small> / COMPUTE STUDIO</small></span></a><div className="top-right"><span className="status"><i/> LOCAL PROCESSING</span><a href="https://github.com/new" target="_blank" rel="noreferrer" className="headerlink"><Github size={17}/> Publish on GitHub</a></div></header>
    <main><div className="hero"><div className="eyebrow"><span className="eyedot"/> PARALLEL COMPUTING PLAYGROUND <span className="version">V 0.1</span></div><h1>See the speed.<br/><span>Understand the compute.</span></h1><p>Process real images with scalar C, SIMD128 and parallel Web Workers. Same pixels, different execution strategies. Benchmarked in your browser.</p><div className="mini-facts"><span><Cpu size={15}/> WebAssembly</span><span><Zap size={15}/> SIMD128</span><span><Layers size={15}/> Multithreading</span></div></div>
      <div className="lab-nav" role="tablist" aria-label="VectorLab workspaces"><button role="tab" aria-selected={workspace==='studio'} className={workspace==='studio'?'active':''} onClick={()=>setWorkspace('studio')}><ImageIcon size={16}/> Image Studio</button><button role="tab" aria-selected={workspace==='lab'} className={workspace==='lab'?'active':''} onClick={()=>setWorkspace('lab')}><Activity size={16}/> Benchmark Lab</button></div>
      {workspace==='studio' ? <>
      <div className="layout"><section className="workspace"><div className="sectionhead"><div><div className="sectiontag">01 / INPUT & OUTPUT</div><h2>Image workspace</h2></div><button className="secondary" onClick={()=>fileInput.current?.click()}><UploadCloud size={16}/> Upload image</button><input ref={fileInput} type="file" accept="image/*" hidden onChange={handleFile}/></div>
        <div className="imagegrid"><div className="imagecard"><div className="imghead"><span>ORIGINAL</span><span className="muted">{source?.width} × {source?.height}</span></div><div className="canvaswrap"><canvas ref={original}/></div><div className="imgfoot"><ImageIcon size={14}/><span title={sourceName}>{sourceName}</span></div></div><div className="imagecard"><div className="imghead"><span>PROCESSED</span><span className="processed-tag">{results?MODES[mode].label:'Awaiting run'}</span></div><div className="canvaswrap"><canvas ref={output}/>{!results&&<div className="placeholder"><Zap size={23}/><span>Ready to process</span></div>}</div><div className="imgfoot"><span>{results?(mode===3?'Blur rendered with selected parameters':mode===4?'Sobel edges rendered (fixed 3×3)':'Output rendered by the selected filter'):'The output will appear here'}</span><button className="icon-btn" disabled={!results} onClick={download} title="Save processed PNG"><Download size={16}/></button></div></div></div>
        <div className="controls"><div className="control-title"><div className="sectiontag">02 / CONFIGURATION</div><h2>Experiment settings</h2></div><div className="control-row"><label>Image operation<select value={mode} onChange={e=>{setMode(Number(e.target.value));setResults(null)}}>{MODES.map(x=><option value={x.value} key={x.value}>{x.label}</option>)}</select><small>{MODES[mode].summary}</small></label>
    {mode === 5 && <label>Median kernel size<select value={medianSize} onChange={e=>{setMedianSize(Number(e.target.value));setResults(null)}}>{[3,5,7].map(k=><option value={k} key={k}>{k} × {k}</option>)}</select><small>Odd window · independent RGB medians</small></label>}
    {mode === 2 && <label>Brightness ({brightness > 0 ? '+' : ''}{brightness})<input type="range" min="-100" max="100" step="5" value={brightness} onChange={e=>{setBrightness(Number(e.target.value));setResults(null)}}/><small>Negative darkens · positive brightens</small></label>}
    {mode === 3 && <label>Kernel size<select value={kernelSize} onChange={e=>{setKernelSize(Number(e.target.value));setResults(null)}}>{[3,5,7,9,11,13,15,17,19,21,23,25,27,29,31].map(size=><option value={size} key={size}>{size} × {size}</option>)}</select><small>Odd-sized convolution window</small></label>}</div>{mode === 3 && <div className="control-row filter-row"><label>Sigma<input type="range" min="0.5" max="10" step="0.5" value={sigma} onChange={e=>{setSigma(Number(e.target.value));setResults(null)}}/><small>{sigma.toFixed(1)} · blur radius</small></label><label>Parallel workers<select value={threads} onChange={e=>{setThreads(Number(e.target.value));setResults(null)}}>{[2,4,6,8].map(n=><option key={n} value={n}>{n} workers</option>)}</select><small>Workers used for scalar and SIMD runs</small></label></div>}{mode !== 3 && <div className="control-row"><label>Parallel workers<select value={threads} onChange={e=>{setThreads(Number(e.target.value));setResults(null)}}>{[2,4,6,8].map(n=><option key={n} value={n}>{n} workers</option>)}</select><small>Number of simultaneous browser workers</small></label></div>}<button className="run" onClick={run} disabled={running||!source}>{running?<><RefreshCw className="spin" size={18}/> Running benchmark...</>:<><Zap size={18} fill="currentColor"/> Run benchmark <ArrowRight size={18}/></>}</button>{error&&<div className="error"><AlertTriangle size={16}/>{error}</div>}</div>
      </section><aside className="insights"><div className="sectionhead"><div><div className="sectiontag">03 / PERFORMANCE</div><h2>Benchmark results</h2></div><Activity size={19} className="subtle"/></div><div className="benchmark-box">{results?<><label className="timing-select">Timing methodology<select value={timing} onChange={e=>setTiming(e.target.value)}><option value="kernelMs">Kernel execution time</option><option value="e2eMs">End-to-end execution time</option></select></label><div className="leader"><span>FASTEST MODE · {timingLabel}</span><strong>{results.results.find(x=>measured(x)===fastest)?.label}</strong><small>{fastest.toFixed(3)} ms measured</small></div><div className="bars">{results.results.map((result,i)=><div className="baritem" key={i}><div className="barlabel"><strong>{result.label}</strong><span>{measured(result).toFixed(3)} ms</span></div><div className="track"><div className={measured(result)===fastest?'fill best':'fill'} style={{width:`${Math.max(2,100*measured(result)/Math.max(...results.results.map(measured)))}%`}}/></div><small>{result.detail}</small></div>)}</div><div className="speedup"><span>SIMD vs Scalar</span><strong>{(measured(results.results[0])/measured(results.results[1])).toFixed(2)}×</strong><span>Parallel Scalar vs Scalar</span><strong>{(measured(results.results[0])/measured(results.results[2])).toFixed(2)}×</strong><span>Parallel SIMD vs Scalar</span><strong>{(measured(results.results[0])/measured(results.results[3])).toFixed(2)}×</strong></div><div className="verified"><CheckCircle2 size={16}/> Correctness verified · maximum channel difference: {results.maxChannelDifference ?? 0}</div></>:<div className="empty-state"><div className="empty-icon"><Activity size={29}/></div><strong>No benchmark data yet</strong><p>Run the experiment to compare execution times and verify output correctness.</p><div className="emptyskeleton"/><div className="emptyskeleton short"/><div className="emptyskeleton"/></div>}</div><div className="method"><div className="sectiontag">HOW IT WORKS</div><div className="methodrow"><span>01</span><div><strong>Scalar WASM</strong><p>Processes one pixel at a time using compiled C.</p></div></div><div className="methodrow"><span>02</span><div><strong>SIMD WASM</strong><p>Uses 128-bit vectors, processing four RGBA pixels per iteration.</p></div></div><div className="methodrow"><span>03</span><div><strong>Parallel workers</strong><p>Splits image rows across multiple workers running scalar WASM.</p></div></div></div></aside></div>
      </> : <BenchmarkLab source={source} sourceName={sourceName}/>}
      <footer><span>VECTORLAB / BROWSER-BASED PARALLEL IMAGE PROCESSING</span><span>Benchmarks are device-dependent · Parallel timing includes message transfer overhead</span></footer>
    </main></div>
}

createRoot(document.getElementById('root')).render(<App/>);
