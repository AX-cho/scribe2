export const MODEL_DIRECTORY = 'scribe-models-v2';
export const modelKey = entry => entry.lfs?.sha256 || entry.blobId;
export async function openModelStore() {
  if (!navigator.storage?.getDirectory) throw Error('Private file storage is unavailable. Use Import models or a supported browser outside private browsing.');
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(MODEL_DIRECTORY, {create:true});
  async function remove(entry) {
    const key = modelKey(entry);
    await directory.removeEntry(key + '.ready').catch(() => {});
    await directory.removeEntry(key).catch(() => {});
  }
  return {
    async has(entry) {
      try { await directory.getFileHandle(modelKey(entry) + '.ready'); return true; }
      catch (error) { if (error.name === 'NotFoundError') return false; throw error; }
    },
    async read(entry) {
      if (!await this.has(entry)) return null;
      return (await directory.getFileHandle(modelKey(entry))).getFile();
    },
    remove,
    async write(entry, stream, signal) {
      const worker = new Worker(new URL('./model-storage.worker.js', import.meta.url), {type:'module'});
      const reader = stream.getReader();
      let pending;
      worker.onmessage = ({data}) => { const call = pending; pending = null; if (data.error) call?.reject(Object.assign(Error(data.error), {name:data.name})); else call?.resolve(); };
      worker.onerror = event => { pending?.reject(Error(event.message || 'Model storage worker failed')); pending = null; };
      const send = (data, transfer = []) => new Promise((resolve, reject) => {
        try { signal?.throwIfAborted(); pending = {resolve,reject}; worker.postMessage(data,transfer); }
        catch (error) { pending = null; reject(error); }
      });
      const abort = () => { pending?.reject(signal.reason); pending = null; worker.terminate(); void reader.cancel(signal.reason).catch(() => {}); };
      signal?.addEventListener('abort',abort,{once:true});
      try {
        await send({type:'open',name:modelKey(entry),size:entry.size});
        while (true) {
          signal?.throwIfAborted();
          const {value,done} = await reader.read(); if (done) break;
          const bytes = value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value : value.slice();
          await send({type:'write',bytes:bytes.buffer},[bytes.buffer]);
        }
        await send({type:'finish'});
        return await this.read(entry);
      } catch (error) {
        worker.terminate(); await remove(entry); throw error;
      } finally {
        signal?.removeEventListener('abort',abort); worker.terminate();
        await reader.cancel().catch(() => {});
      }
    },
  };
}
export async function deleteModelStore() {
  const root = await navigator.storage?.getDirectory?.();
  try { await root?.removeEntry(MODEL_DIRECTORY, {recursive:true}); }
  catch (error) { if (error.name !== 'NotFoundError') throw error; }
}
