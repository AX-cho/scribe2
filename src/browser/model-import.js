import manifest from '../../config/browser-models.json' with { type: 'json' };

export const modelEntries = manifest.flatMap(model => model.files.filter(file => file.rfilename !== 'README.md').map(file => ({
  ...file, path: `${model.directory}/${file.rfilename}`,
  url: `https://huggingface.co/${model.id}/resolve/${model.sha}/${file.rfilename}`,
})));
export const modelDownloadMB = Math.ceil(modelEntries.reduce((n, file) => n + file.size, 0) / 1e6);
export const MODEL_CACHE = 'scribe-verified-models-v1';

export async function verifyModelFile(file, entry) {
  if (file.size !== entry.size) throw Error(`Wrong file size: ${entry.path}`);
  const bytes = await (entry.lfs ? file : new Blob([new TextEncoder().encode(`blob ${file.size}\0`), file])).arrayBuffer();
  const digest = await crypto.subtle.digest(entry.lfs ? 'SHA-256' : 'SHA-1', bytes);
  const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== (entry.lfs?.sha256 || entry.blobId)) throw Error(`Integrity check failed: ${entry.path}`);
}

export async function validateModelFiles(files, status = () => {}, entries = modelEntries) {
  const selected = Object.create(null);
  for (const entry of entries) {
    const matches = files.filter(file => {
      const path = file.webkitRelativePath || file.name;
      return path === entry.path || path.endsWith(`/${entry.path}`);
    });
    if (matches.length !== 1) throw Error(`Select exactly one copy of ${entry.path}`);
    if (matches[0].size !== entry.size) throw Error(`Wrong file size: ${entry.path}`);
    selected[entry.path] = matches[0];
  }
  for (const entry of entries) {
    status(`Verifying ${entry.path}…`);
    await verifyModelFile(selected[entry.path], entry);
  }
  return selected;
}

export async function downloadModels(status = () => {}, { signal, fetcher = fetch, storage = globalThis.caches, entries = modelEntries } = {}) {
  const selected = Object.create(null);
  let cache, saved = true;
  try { cache = await storage?.open(MODEL_CACHE); } catch { /* Storage may be unavailable; inference can still run. */ }
  if (!cache) saved = false;
  for (const entry of entries) {
    signal?.throwIfAborted();
    let blob;
    try {
      const cached = await cache?.match(entry.url);
      if (cached) {
        status(`Verifying saved ${entry.path}…`);
        blob = await cached.blob();
        await verifyModelFile(blob, entry);
      }
    } catch { blob = null; await cache?.delete(entry.url).catch(() => {}); }
    if (!blob) {
      status(`Downloading ${entry.path}…`);
      const response = await fetcher(entry.url, { signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (!response.ok) throw Error(`Download failed (${response.status}): ${entry.path}. Retry or import your folder.`);
      const reader = response.body.getReader();
      const chunks = []; let received = 0;
      try {
        while (true) {
          signal?.throwIfAborted();
          const { value, done } = await reader.read(); if (done) break;
          received += value.byteLength;
          if (received > entry.size) throw Error(`Download exceeds expected size: ${entry.path}`);
          chunks.push(value);
          status(`Downloading ${entry.path}: ${Math.floor(100 * received / entry.size)}%`);
        }
      } finally { await reader.cancel().catch(() => {}); }
      blob = new Blob(chunks); chunks.length = 0;
      status(`Verifying ${entry.path}…`);
      await verifyModelFile(blob, entry);
      signal?.throwIfAborted();
      if (cache) try { await cache.put(entry.url, new Response(blob)); } catch { saved = false; }
    }
    selected[entry.path] = blob;
  }
  signal?.throwIfAborted();
  return { files: selected, saved };
}
