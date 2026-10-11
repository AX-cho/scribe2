import manifest from '../../config/browser-models.json';

export async function validateModelFiles(files, status = () => {}, entries = manifest) {
  const selected = Object.create(null);
  const required = entries.flatMap(model => model.files.filter(file => file.rfilename !== 'README.md').map(file => ({ ...file, path: `${model.directory}/${file.rfilename}` })));
  for (const entry of required) {
    const matches = files.filter(file => {
      const path = file.webkitRelativePath || file.name;
      return path === entry.path || path.endsWith(`/${entry.path}`);
    });
    if (matches.length !== 1) throw Error(`Select exactly one copy of ${entry.path}`);
    if (matches[0].size !== entry.size) throw Error(`Wrong file size: ${entry.path}`);
    selected[entry.path] = matches[0];
  }
  // Validate sequentially to limit peak memory. Nothing is persisted or uploaded.
  for (const entry of required) {
    status(`Verifying ${entry.path}…`);
    const file = selected[entry.path];
    const bytes = await (entry.lfs ? file : new Blob([new TextEncoder().encode(`blob ${file.size}\0`), file])).arrayBuffer();
    const digest = await crypto.subtle.digest(entry.lfs ? 'SHA-256' : 'SHA-1', bytes);
    const hash = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
    if (hash !== (entry.lfs?.sha256 || entry.blobId)) throw Error(`Integrity check failed: ${entry.path}`);
  }
  return selected;
}
