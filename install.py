#!/usr/bin/env python3
"""Apply VectorLab enhancements to the inspected GitHub main branch checkout.
Backs up every changed file and validates all insertion anchors before writing.
"""
from pathlib import Path
import shutil
import sys
ROOT=Path(__file__).resolve().parent

def replace_once(s,old,new,path):
    count=s.count(old)
    if count!=1:raise RuntimeError(f'{path}: expected one matching anchor, found {count}: {old[:100]!r}')
    return s.replace(old,new,1)

def update(path, transform):
    p=ROOT/path
    if not p.is_file():raise RuntimeError(f'Missing {path}; run installer from the project root')
    return p,transform(p.read_text(encoding='utf-8'))

try:
    p=ROOT/'wasm/filters.c'
    code=p.read_text(encoding='utf-8')
    if 'median_filter_simd' in code:raise RuntimeError('Patch already installed. Do not run twice.')
    additions=(ROOT/'new_filters.c.inc').read_text(encoding='utf-8')
    staged={p:code.rstrip()+'\n\n'+additions}
    p,s=update('scripts/build-wasm.sh',lambda s: replace_once(s,'  -Wl,--export=__heap_base \\',
      ''.join(f'  -Wl,--export={name} \\\n' for name in ['median_filter_scalar','median_filter_simd','histogram_count_scalar','histogram_count_simd','histogram_apply_scalar','histogram_apply_simd','brightness_custom_scalar','brightness_custom_simd'])+'  -Wl,--export=__heap_base \\', 'scripts/build-wasm.sh'))
    staged[p]=s.lstrip('\n')

    p,s=update('src/runner.worker.js',lambda s:s)
    addition=(ROOT/'worker_addition.js.inc').read_text(encoding='utf-8')
    s=replace_once(s,'self.onmessage = ({ data }) => {',addition+'''\nself.onmessage = ({ data }) => {
  if (data.kind === 'histogram-count' || data.kind === 'histogram-apply') {
    if (!wasm) return;
    histogramRequest(data).catch(error => postMessage({kind:'error',message:error.message}));
    return;
  }''','src/runner.worker.js')
    s=replace_once(s,"const sobel = technique === 'sobel-scalar' || technique === 'sobel-simd';", "const sobel = technique === 'sobel-scalar' || technique === 'sobel-simd';\n    const median = technique === 'median-scalar' || technique === 'median-simd';\n    const brightness = technique === 'brightness-scalar' || technique === 'brightness-simd';",'src/runner.worker.js')
    s=replace_once(s,'(gaussian || sobel) &&','(gaussian || sobel || median) &&','src/runner.worker.js')
    s=replace_once(s,'(gaussian || sobel) ? dstOffset + needed : srcOffset + needed','(gaussian || sobel || median) ? dstOffset + needed : srcOffset + needed','src/runner.worker.js')
    s=replace_once(s,'(gaussian || sobel) ? new Uint8Array','(gaussian || sobel || median) ? new Uint8Array','src/runner.worker.js')
    s=replace_once(s,"      : sobel ? (technique === 'sobel-simd' ? wasm.sobel_simd : wasm.sobel_scalar)","      : sobel ? (technique === 'sobel-simd' ? wasm.sobel_simd : wasm.sobel_scalar)\n      : median ? (technique === 'median-simd' ? wasm.median_filter_simd : wasm.median_filter_scalar)\n      : brightness ? (technique === 'brightness-simd' ? wasm.brightness_custom_simd : wasm.brightness_custom_scalar)",'src/runner.worker.js')
    # Both the warm-up and timed loops dispatch Sobel. Patch both deliberately.
    marker='else if (sobel) fn(srcOffset, dstOffset, width, height);\n      else fn(srcOffset, needed / 4, mode);'
    if s.count(marker) != 2:
        raise RuntimeError(f'src/runner.worker.js: expected two Sobel dispatch sites, found {s.count(marker)}')
    replacement=('else if (sobel) fn(srcOffset, dstOffset, width, height);\n'
                 '      else if (median) fn(srcOffset, dstOffset, width, height, mode.kernelSize);\n'
                 '      else if (brightness) fn(srcOffset, needed / 4, mode.amount);\n'
                 '      else fn(srcOffset, needed / 4, mode);')
    s=s.replace(marker,replacement)
    staged[p]=s

    p,s=update('src/processing.js',lambda s:s)
    s="import { benchmarkHistogram } from './histogram.js';\n"+s
    s=replace_once(s,"  { value: 2, label: 'Brightness +40', summary: 'Saturating addition per channel' },","  { value: 2, label: 'Brightness adjustment', summary: 'Configurable signed brightness with saturating arithmetic' },",'src/processing.js')
    s=replace_once(s,"  { value: 4, label: 'Sobel edge detection', summary: 'Fixed 3×3 grayscale edge detector · Scalar / SIMD / Workers' },","  { value: 4, label: 'Sobel edge detection', summary: 'Fixed 3×3 grayscale edge detector · Scalar / SIMD / Workers' },\n  { value: 5, label: 'Median filter', summary: 'Custom 3×3 / 5×5 / 7×7 RGB median filtering' },\n  { value: 6, label: 'Histogram equalization', summary: 'Global grayscale CDF equalization with parallel histogram merging' },",'src/processing.js')
    s=replace_once(s,'  const sobel = mode === 4;','  const sobel = mode === 4;\n  const medianFilter = mode === 5;\n  const brightness = mode === 2;','src/processing.js')
    s=replace_once(s,"  } : mode;\n  if (gaussian", "  } : medianFilter ? { kernelSize: Number(options.kernelSize ?? 3) }\n    : brightness ? { amount: Number(options.amount ?? 40) } : mode;\n  if (mode === 6) return benchmarkHistogram(image, workersCount);\n  if (medianFilter && (![3,5,7].includes(config.kernelSize))) throw new Error('Median kernel must be 3, 5, or 7');\n  if (brightness && (!Number.isInteger(config.amount) || config.amount < -100 || config.amount > 100)) throw new Error('Brightness must be between -100 and 100');\n  if (gaussian", 'src/processing.js')
    s=replace_once(s,"const scalarTechnique = gaussian ? 'gaussian-scalar' : sobel ? 'sobel-scalar' : 'scalar';","const scalarTechnique = gaussian ? 'gaussian-scalar' : sobel ? 'sobel-scalar' : medianFilter ? 'median-scalar' : brightness ? 'brightness-scalar' : 'scalar';",'src/processing.js')
    s=replace_once(s,"const simdTechnique = gaussian ? 'gaussian-simd' : sobel ? 'sobel-simd' : 'simd';","const simdTechnique = gaussian ? 'gaussian-simd' : sobel ? 'sobel-simd' : medianFilter ? 'median-simd' : brightness ? 'brightness-simd' : 'simd';",'src/processing.js')
    s=replace_once(s,'const partition = (gaussian || sobel)','const partition = (gaussian || sobel || medianFilter)','src/processing.js')
    s=replace_once(s,'gaussian ? config.kernelSize >> 1 : 1','gaussian ? config.kernelSize >> 1 : medianFilter ? config.kernelSize >> 1 : 1','src/processing.js')
    staged[p]=s

    p,s=update('src/main.jsx',lambda s:s)
    s=replace_once(s,'  const [sigma,setSigma]=useState(1);','  const [sigma,setSigma]=useState(1);\n  const [medianSize,setMedianSize]=useState(3);\n  const [brightness,setBrightness]=useState(40);','src/main.jsx')
    s=replace_once(s,'mode === 3 ? { kernelSize, sigma } : undefined,','mode === 3 ? { kernelSize, sigma } : mode === 5 ? { kernelSize: medianSize } : mode === 2 ? { amount: brightness } : undefined,','src/main.jsx')
    anchor='</select><small>{MODES[mode].summary}</small></label>{mode === 3 &&'
    added='''</select><small>{MODES[mode].summary}</small></label>
    {mode === 5 && <label>Median kernel size<select value={medianSize} onChange={e=>{setMedianSize(Number(e.target.value));setResults(null)}}>{[3,5,7].map(k=><option value={k} key={k}>{k} × {k}</option>)}</select><small>Odd window · independent RGB medians</small></label>}
    {mode === 2 && <label>Brightness ({brightness > 0 ? '+' : ''}{brightness})<input type="range" min="-100" max="100" step="5" value={brightness} onChange={e=>{setBrightness(Number(e.target.value));setResults(null)}}/><small>Negative darkens · positive brightens</small></label>}
    {mode === 3 &&'''
    s=replace_once(s,anchor,added,'src/main.jsx')
    staged[p]=s

    testfile=ROOT/'tests/new_filters.test.js'
    new_hist=ROOT/'histogram.js'
    if not testfile.is_file() or not new_hist.is_file():raise RuntimeError('Missing new_filters.test.js or histogram.js from ZIP')
    for dest,source in [(ROOT/'tests/new_filters.test.js',testfile),(ROOT/'src/histogram.js',new_hist)]:
        if dest!=source:staged[dest]=source.read_text(encoding='utf-8')
    backup=ROOT/'vectorlab_patch_backup'
    backup.mkdir(exist_ok=True)
    for path in staged:
        if path.is_file():
            target=backup/path.relative_to(ROOT)
            target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(path,target)
    for path,content in staged.items():
        path.parent.mkdir(parents=True,exist_ok=True)
        with path.open('w',encoding='utf-8',newline='\n') as f:f.write(content)
        print('Updated:',path.relative_to(ROOT))
    print('Backup:',backup)
    print('Next: rebuild WASM in Ubuntu, then npm test and Vite build.')
except Exception as ex:
    print('INSTALL FAILED:',ex,file=sys.stderr)
    sys.exit(1)
