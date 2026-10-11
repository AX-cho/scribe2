// ONNX Runtime requires a contiguous weights buffer. Fill one allocation from
// bounded file slices, avoiding Response.arrayBuffer()'s stream accumulation.
export async function readModelBuffer(file, blockSize = 4 * 1024 * 1024) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0) throw Error('Invalid local model file');
  const result = new Uint8Array(file.size);
  for (let offset = 0; offset < file.size; offset += blockSize) {
    const end = Math.min(file.size, offset + blockSize);
    const block = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    if (block.length !== end - offset) throw Error('Incomplete local model read');
    result.set(block, offset);
  }
  return result;
}
