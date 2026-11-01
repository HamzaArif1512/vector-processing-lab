#!/usr/bin/env python3
"""Install Benchmark Lab on exact feat/median-and-histogram source snapshot, without touching other branches."""
from pathlib import Path
import hashlib
import shutil
import sys

ROOT=Path(__file__).resolve().parent
TARGET=ROOT
BRANCH_FILES={
    'src/main.jsx':'6d243c6d36223c831dbc62c26be333f9b2bf940b',
    'src/runner.worker.js':'a7cada0578a9a0888db77cd7a7d161e551c399d1',
}

def git_blob(contents):
    return hashlib.sha1(f'blob {len(contents)}\0'.encode()+contents).hexdigest()

def exactly(content,old,new,path,expected=1):
    count=content.count(old)
    if count!=expected:
        raise ValueError(f'{path}: expected {expected} anchor(s), found {count}: {old[:85]!r}')
    return content.replace(old,new)

def main_patch(s):
    path='src/main.jsx'
    s=exactly(s,"import './styles.css';", "import './styles.css';\nimport BenchmarkLab from './benchmark/BenchmarkLab.jsx';",path)
    s=exactly(s,"  const [source, setSource] = useState(null);", "  const [workspace,setWorkspace]=useState('studio');\n  const [source, setSource] = useState(null);",path)
    # Restores canvas content when switching back from Benchmark Lab to Studio.
    s=exactly(s,"  },[source,results]);","  },[source,results,workspace]);",path)
    s=exactly(s,"}, [results]);","}, [results,workspace]);",path)
    marker='      <div className="layout"><section className="workspace">'
    replacement='''      <div className="lab-nav" role="tablist" aria-label="VectorLab workspaces"><button role="tab" aria-selected={workspace==='studio'} className={workspace==='studio'?'active':''} onClick={()=>setWorkspace('studio')}><ImageIcon size={16}/> Image Studio</button><button role="tab" aria-selected={workspace==='lab'} className={workspace==='lab'?'active':''} onClick={()=>setWorkspace('lab')}><Activity size={16}/> Benchmark Lab</button></div>
      {workspace==='studio' ? <>
      <div className="layout"><section className="workspace">'''
    s=exactly(s,marker,replacement,path)
    marker='      <footer><span>VECTORLAB / BROWSER-BASED PARALLEL IMAGE PROCESSING</span>'
    replacement='''      </> : <BenchmarkLab source={source} sourceName={sourceName}/>}
      <footer><span>VECTORLAB / BROWSER-BASED PARALLEL IMAGE PROCESSING</span>'''
    s=exactly(s,marker,replacement,path)
    return s

def worker_patch(s):
    path='src/runner.worker.js'
    s=exactly(s,'const {kind,buffer,simd,lut,repetitions=7}=data;', 'const {kind,buffer,simd,lut,repetitions=7,warmups=1}=data;',path)
    s=exactly(s,'  run();\n  const times=[];', '  for(let i=0;i<warmups;i++)run();\n  const times=[];',path)
    s=exactly(s,"postMessage({kind:'result',buffer:output,kernelMs:times[Math.floor(times.length/2)]},[output]);", "postMessage({kind:'result',buffer:output,kernelMs:times[Math.floor(times.length/2)],times},[output]);",path)
    s=exactly(s,'const { buffer, mode, technique, width, height, repetitions = 7 } = data;', 'const { buffer, mode, technique, width, height, repetitions = 7, warmups = 1 } = data;',path)
    s=exactly(s,'    warmup();\n    const times = [];', '    for(let i=0;i<warmups;i++)warmup();\n    const times = [];',path)
    return s

def main():
    changes={}
    for p,sha in BRANCH_FILES.items():
        file=TARGET/p
        if not file.is_file():raise ValueError(f'{p} missing: extract into the root containing package.json')
        contents=file.read_bytes()
        actual=git_blob(contents.replace(b"\r\n",b"\n"))
        if actual!=sha:raise ValueError(f'{p} does not match inspected feat/median-and-histogram branch (expected {sha}, found {actual}). No files changed. Commit/revert local edits or manually merge. Do not run on main.')
        source=contents.decode('utf-8')
        changes[p]=main_patch(source) if p.endswith('main.jsx') else worker_patch(source)
    if not (TARGET/'src/histogram.js').is_file():raise ValueError('src/histogram.js missing: this is not the requested branch.')
    if not (TARGET/'package.json').is_file():raise ValueError('package.json missing')
    src=ROOT/'_payload/benchmark'
    if not src.is_dir():raise ValueError('Missing src/benchmark package files in extracted ZIP')
    for file in src.iterdir():
        destination=TARGET/'src/benchmark'/file.name
        if destination.exists():raise ValueError(f'{destination} already exists. Installer is one-time only.')
    tests=[TARGET/'tests/benchmark-core.test.js',TARGET/'tests/benchmark-engine.test.js']
    for test in tests:
        if test.exists():raise ValueError(f'{test} already exists.')
    backup=TARGET/'vectorlab_benchmark_backup'
    if backup.exists():raise ValueError('vectorlab_benchmark_backup already exists. Refusing to overwrite prior backup.')
    # Validation complete, apply changes using staging. Preserve LF on all edited files.
    backup.mkdir()
    for p in changes:
        target=TARGET/p
        dest=backup/p;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(target,dest)
    for p,content in changes.items():
        with (TARGET/p).open('w',encoding='utf-8',newline='\n') as f:f.write(content)
    (TARGET/'src/benchmark').mkdir(exist_ok=True)
    for file in src.iterdir():shutil.copy2(file,TARGET/'src/benchmark'/file.name)
    for test in tests:
        test.parent.mkdir(exist_ok=True)
        shutil.copy2(ROOT/'_payload/tests'/test.name,test)
    print('SUCCESS: Benchmark Lab installed on feat/median-and-histogram snapshot.')
    print('Modified: src/main.jsx, src/runner.worker.js')
    print('Added: src/benchmark/* and tests/benchmark-*.test.js')
    print('No C or WASM rebuild required. Original files backed up to vectorlab_benchmark_backup/')
    print('Next: npm test ; node ".\\node_modules\\vite\\bin\\vite.js" build')
if __name__=='__main__':
    try: main()
    except Exception as e:
        print('INSTALL FAILED:',str(e),file=sys.stderr)
        sys.exit(1)
