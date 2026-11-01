#!/usr/bin/env python3
"""Apply the Sobel patch to the inspected VectorLab main branch. Idempotent."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent

def replace_once(data, old, new, name):
    if new in data:
        return data
    if data.count(old) != 1:
        raise SystemExit(f"{name}: expected one matching anchor, found {data.count(old)}; source changed. No changes saved to that file.")
    return data.replace(old, new, 1)

def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding='utf-8')
    print('Updated:', path)

p=Path('wasm/filters.c')
s=p.read_text(encoding='utf-8')
if 'void sobel_scalar(' not in s:
    addition=(ROOT/'sobel_impl.c.inc').read_text(encoding='utf-8')
    s=replace_once(s, '// Numerically stable approximation for freestanding wasm builds without libm.',
       addition+'\n// Numerically stable approximation for freestanding wasm builds without libm.', str(p))
    # clampi is currently declared after the gaussian_exp function, so move its definition before Sobel.
    clamp='static inline int clampi(int x,int a,int b){return x<a?a:(x>b?b:x);}\n'
    if s.count(clamp)!=1: raise SystemExit('Could not find clampi definition')
    s=s.replace(clamp,'')
    s=s.replace('// Fixed 3x3 Sobel edge detection',clamp+'\n// Fixed 3x3 Sobel edge detection',1)
    write(p,s)

p=Path('scripts/build-wasm.sh'); s=p.read_text(encoding='utf-8')
s=replace_once(s,'  -Wl,--export=gaussian_blur_simd \\\n',
               '  -Wl,--export=gaussian_blur_simd \\\n  -Wl,--export=sobel_scalar \\\n  -Wl,--export=sobel_simd \\\n',str(p))
write(p,s)

p=Path('src/runner.worker.js'); s=p.read_text(encoding='utf-8')
s=replace_once(s,
"const gaussian = technique === 'gaussian-scalar' || technique === 'gaussian-simd';",
"const gaussian = technique === 'gaussian-scalar' || technique === 'gaussian-simd';\n    const sobel = technique === 'sobel-scalar' || technique === 'sobel-simd';",str(p))
s=replace_once(s,'if (gaussian && (!Number.isInteger(width)',
               'if ((gaussian || sobel) && (!Number.isInteger(width)',str(p))
s=replace_once(s,'const memoryNeeded = gaussian ? dstOffset + needed : srcOffset + needed;',
               'const memoryNeeded = (gaussian || sobel) ? dstOffset + needed : srcOffset + needed;',str(p))
s=replace_once(s,'const outputBytes = gaussian ? new Uint8Array(wasm.memory.buffer, dstOffset, needed) : bytes;',
               'const outputBytes = (gaussian || sobel) ? new Uint8Array(wasm.memory.buffer, dstOffset, needed) : bytes;',str(p))
s=replace_once(s,
"? (technique === 'gaussian-simd' ? wasm.gaussian_blur_simd : wasm.gaussian_blur_scalar)\n      : (technique === 'simd' ? wasm.process_simd : wasm.process_scalar);",
"? (technique === 'gaussian-simd' ? wasm.gaussian_blur_simd : wasm.gaussian_blur_scalar)\n      : sobel ? (technique === 'sobel-simd' ? wasm.sobel_simd : wasm.sobel_scalar)\n      : (technique === 'simd' ? wasm.process_simd : wasm.process_scalar);",str(p))
old_call = 'if (gaussian) fn(srcOffset, dstOffset, width, height, mode.kernelSize, mode.sigma);\n      else fn(srcOffset, needed / 4, mode);'
new_call = 'if (gaussian) fn(srcOffset, dstOffset, width, height, mode.kernelSize, mode.sigma);\n      else if (sobel) fn(srcOffset, dstOffset, width, height);\n      else fn(srcOffset, needed / 4, mode);'
if old_call in s:
    if s.count(old_call) != 2:
        raise SystemExit('Expected two Gaussian call sites in worker')
    s=s.replace(old_call,new_call)
write(p,s)

p=Path('src/processing.js'); s=p.read_text(encoding='utf-8')
s=replace_once(s,"  { value: 3, label: 'Gaussian blur', summary: 'Configurable Gaussian convolution · Scalar / SIMD / Workers' },",
               "  { value: 3, label: 'Gaussian blur', summary: 'Configurable Gaussian convolution · Scalar / SIMD / Workers' },\n  { value: 4, label: 'Sobel edge detection', summary: 'Fixed 3×3 grayscale edge detector · Scalar / SIMD / Workers' },",str(p))
s=replace_once(s,'  const gaussian = mode === 3;','  const gaussian = mode === 3;\n  const sobel = mode === 4;',str(p))
s=replace_once(s,"const scalarTechnique = gaussian ? 'gaussian-scalar' : 'scalar';",
               "const scalarTechnique = gaussian ? 'gaussian-scalar' : sobel ? 'sobel-scalar' : 'scalar';",str(p))
s=replace_once(s,"const simdTechnique = gaussian ? 'gaussian-simd' : 'simd';",
               "const simdTechnique = gaussian ? 'gaussian-simd' : sobel ? 'sobel-simd' : 'simd';",str(p))
s=replace_once(s,'const partition = gaussian\n      ? gaussianPartition(image, n, config.kernelSize >> 1)',
               'const partition = (gaussian || sobel)\n      ? gaussianPartition(image, n, gaussian ? config.kernelSize >> 1 : 1)',str(p))
# Remove the misplaced main-branch diagnostic referencing `simd` inside parallel(), which causes ReferenceError.
start=s.find('      let changedPixels = 0;')
if start>=0:
    end=s.find('      return {\n        image: merged,',start)
    if end<0: raise SystemExit('Could not locate end of misplaced diagnostics')
    s=s[:start]+s[end:]
s=s.replace('`Gaussian implementations disagree: ` +','`Implementations disagree: ` +')
s=s.replace('    if (delta > tolerance) throw new Error(`Implementations disagree (maximum channel difference ${delta}).`);\n','')
write(p,s)

p=Path('src/main.jsx'); s=p.read_text(encoding='utf-8')
s=replace_once(s,"{results?(results.gaussian?'Blur rendered with selected parameters':'Pixel-identical across all 3 modes'):'The output will appear here'}",
 "{results?(mode===3?'Blur rendered with selected parameters':mode===4?'Sobel edges rendered (fixed 3×3)':'Output rendered by the selected filter'):'The output will appear here'}",str(p))
write(p,s)

source=ROOT/'tests/sobel.test.js'
dest=Path('tests/sobel.test.js')
if not dest.exists():
    write(dest,source.read_text(encoding='utf-8'))
print('\nSobel patch applied. Rebuild public/filters.wasm before running tests.')
