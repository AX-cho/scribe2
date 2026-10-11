import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const runtime = dirname(require.resolve('onnxruntime-web'));
const root = resolve('browser-dist');
await mkdir(`${root}/ort`, { recursive:true });
for (const name of await readdir(runtime)) {
  if (/^ort-wasm-simd-threaded(?:\.(?:jsep|asyncify|jspi))?\.(wasm|mjs)$/.test(name)) await cp(`${runtime}/${name}`, `${root}/ort/${name}`);
}
for (const name of ['pcm-worklet.js','audio.js']) await cp(`public/${name}`, `${root}/${name}`);
await mkdir(`${root}/licenses`, { recursive:true });
await cp('src/browser/ASR-LICENSE', `${root}/licenses/asr-reference.txt`);
await cp('vendor/transformers/LICENSE', `${root}/licenses/transformers.txt`);
await cp('vendor/PROVENANCE.json', `${root}/licenses/provenance.json`);
await cp('config/browser-models.json', `${root}/licenses/model-manifest.json`);
await writeFile(`${root}/index.html`, await readFile(`${root}/browser.html`));
await writeFile(`${root}/.nojekyll`, '');
console.log('Browser-only site built. No models, audio, or backend included.');
