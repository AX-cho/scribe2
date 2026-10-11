import chunks from '../../config/browser-model-chunks.json' with { type: 'json' };
import manifest from '../../config/browser-models.json' with { type: 'json' };

export const modelEntries = manifest.flatMap(model => model.files.filter(file => file.rfilename !== 'README.md').map(file => ({
  ...file, path: `${model.directory}/${file.rfilename}`,
  url: `https://huggingface.co/${model.id}/resolve/${model.sha}/${file.rfilename}`,
})));
export const modelDownloadMB = Math.ceil(modelEntries.reduce((n, file) => n + file.size, 0) / 1e6);
export const MODEL_CACHE = 'scribe-verified-models-v1';

async function digest(bytes, algorithm = 'SHA-256') {
  const hash = await crypto.subtle.digest(algorithm, bytes);
  return Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
}
function chunkPlan(entry) {
  const plan = chunks.files[entry.path];
  return plan?.sha256 === entry.lfs?.sha256 ? plan : null;
}
async function verifyBlock(bytes, entry, index) {
  const plan = chunkPlan(entry);
  if (plan) {
    if (await digest(bytes) !== plan.hashes[index]) throw Error(`Integrity check failed: ${entry.path}, block ${index + 1}`);
  } else {
    const data = entry.lfs ? bytes : await new Blob([new TextEncoder().encode(`blob ${entry.size}\0`), bytes]).arrayBuffer();
    if (await digest(data, entry.lfs ? 'SHA-256' : 'SHA-1') !== (entry.lfs?.sha256 || entry.blobId)) throw Error(`Integrity check failed: ${entry.path}`);
  }
}
export async function verifyModelFile(file, entry) {
  if (file.size !== entry.size) throw Error(`Wrong file size: ${entry.path}`);
  const size = chunkPlan(entry) ? chunks.blockSize : entry.size;
  if (size > chunks.blockSize) throw Error('Large model has no block integrity manifest');
  for (let offset = 0, index = 0; offset < file.size; offset += size, index++) {
    await verifyBlock(await file.slice(offset, offset + size).arrayBuffer(), entry, index);
  }
}

// Queue one verified block at a time, with backpressure from browser storage.
export function verifiedStream(body, entry, status = () => {}, signal) {
  const reader = body.getReader();
  const blockSize = chunkPlan(entry) ? chunks.blockSize : entry.size;
  if (blockSize > chunks.blockSize) throw Error('Large model has no block integrity manifest');
  let block = new Uint8Array(blockSize), used = 0, total = 0, index = 0;
  let pending, pendingOffset = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          signal?.throwIfAborted();
          if (!pending) {
            const result = await reader.read();
            if (result.done) {
              if (total !== entry.size) throw Error(`Wrong file size: ${entry.path}`);
              if (used) { const last = block.subarray(0, used); await verifyBlock(last, entry, index); controller.enqueue(last); }
              controller.close(); return;
            }
            pending = result.value; pendingOffset = 0;
            if (total + pending.length > entry.size) throw Error(`Download exceeds expected size: ${entry.path}`);
          }
          const count = Math.min(block.length - used, pending.length - pendingOffset);
          block.set(pending.subarray(pendingOffset, pendingOffset + count), used);
          used += count; total += count; pendingOffset += count;
          if (pendingOffset === pending.length) pending = null;
          if (used === block.length) {
            await verifyBlock(block, entry, index++);
            controller.enqueue(block); block = new Uint8Array(blockSize); used = 0;
            status(`Downloading and verifying ${entry.path}: ${Math.floor(100 * total / entry.size)}%`);
            return;
          }
        }
      } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 });
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
  let cache;
  try { cache = await storage?.open(MODEL_CACHE); } catch { /* Storage may be unavailable; inference can still run. */ }
  if (!cache) throw Error('Browser storage is unavailable. Enable site storage or use Import models.');
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
      try {
        await cache.put(entry.url, new Response(verifiedStream(response.body, entry, status, signal), {
          headers: { 'Content-Length': String(entry.size), 'Content-Type': 'application/octet-stream' },
        }));
        const stored = await cache.match(entry.url);
        if (!stored) throw Error('Browser did not save the model. Check available storage.');
        blob = await stored.blob();
        await verifyModelFile(blob, entry);
      } catch (error) {
        await cache.delete(entry.url).catch(() => {});
        if (error.name === 'QuotaExceededError') throw Error('Not enough browser storage. Free space or use Import models. Completed files remain saved.');
        throw error;
      }
    }
    selected[entry.path] = blob;
  }
  signal?.throwIfAborted();
  return { files: selected, saved: true };
}
