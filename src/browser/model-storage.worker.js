// Safari supports synchronous OPFS writes in dedicated workers. Each message
// contains at most one verified block, and is acknowledged after the disk write.
let directory, handle, name, offset = 0, expected = 0;
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'open') {
      directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('scribe-models-v2', {create:true});
      name = data.name; expected = data.size;
      await directory.removeEntry(name + '.ready').catch(() => {});
      handle = await (await directory.getFileHandle(name, {create:true})).createSyncAccessHandle();
      await handle.truncate(0); offset = 0;
    } else if (data.type === 'write') {
      const bytes = new Uint8Array(data.bytes);
      if (!handle || bytes.length > 4194304 || offset + bytes.length > expected) throw Error('Invalid model write');
      let written = 0;
      while (written < bytes.length) {
        const count = handle.write(bytes.subarray(written), {at:offset + written});
        if (!count) throw Error('Model storage write failed');
        written += count;
      }
      offset += written;
    } else if (data.type === 'finish') {
      if (offset !== expected) throw Error('Incomplete model file');
      await handle.flush(); await handle.close(); handle = null;
      const marker = await (await directory.getFileHandle(name + '.ready', {create:true})).createSyncAccessHandle();
      try { await marker.truncate(0); marker.write(new Uint8Array([1])); await marker.flush(); } finally { await marker.close(); }
    }
    postMessage({ok:true});
  } catch (error) {
    try { await handle?.close(); } catch {}
    handle = null;
    postMessage({error:error.message, name:error.name});
  }
};
