import test from 'node:test';
import assert from 'node:assert/strict';
import {readModelBuffer} from '../src/browser/model-buffer.js';
test('model reads use bounded slices and preserve bytes without whole-file arrayBuffer',async()=>{
  const expected=Uint8Array.from({length:1025},(_,i)=>i%256);
  const blob=new Blob([expected]);let largest=0;
  const result=await readModelBuffer({size:blob.size,slice(a,b){largest=Math.max(largest,b-a);return blob.slice(a,b);},arrayBuffer(){throw Error('Whole file must not be read');}},128);
  assert.deepEqual(result,expected);assert.equal(largest,128);
});
test('model loading rejects truncated reads',async()=>{
  await assert.rejects(readModelBuffer({size:10,slice(){return new Blob(['x']);}}),/Incomplete/);
});
