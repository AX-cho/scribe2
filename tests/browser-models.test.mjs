import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadModels, validateModelFiles } from '../src/browser/model-import.js';
const body = 'approved model';
const entry = {path:'asr/test.onnx',url:'https://huggingface.co/test/resolve/pinned/test.onnx',size:body.length,lfs:{sha256:createHash('sha256').update(body).digest('hex')}};
function storage() {
  const values = new Map();
  return {values,open:async()=>({match:async key=>values.get(key)?.clone(),put:async(key,value)=>values.set(key,value),delete:async key=>values.delete(key)})};
}
test('downloads verify before caching and cached files are reused without network',async()=>{
  const cache=storage();let calls=0;
  const options={storage:cache,entries:[entry],fetcher:async(url,opts)=>{calls++;assert.equal(url,entry.url);assert.equal(opts.credentials,'omit');return new Response(body);}};
  assert.equal((await downloadModels(()=>{},options)).saved,true);
  assert.equal(await (await downloadModels(()=>{},options)).files[entry.path].text(),body);
  assert.equal(calls,1);
});
test('modified and oversized downloads are rejected and never cached',async()=>{
  for(const text of ['x'.repeat(body.length),body+'x']) {
    const cache=storage();
    await assert.rejects(downloadModels(()=>{},{storage:cache,entries:[entry],fetcher:async()=>new Response(text)}),/Integrity|exceeds/);
    assert.equal(cache.values.size,0);
  }
});
test('corrupt cached models are removed and replaced with verified downloads',async()=>{
  const cache=storage();cache.values.set(entry.url,new Response('bad'));
  const result=await downloadModels(()=>{},{storage:cache,entries:[entry],fetcher:async()=>new Response(body)});
  assert.equal(await result.files[entry.path].text(),body);
});
test('storage failure and cancellation avoid downloads',async()=>{
  await assert.rejects(downloadModels(()=>{},{storage:{open:async()=>{throw Error('quota');}},entries:[entry],fetcher:()=>{throw Error('must not fetch');}}),/storage is unavailable/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(downloadModels(()=>{},{signal:controller.signal,storage:storage(),entries:[entry],fetcher:()=>{throw Error('must not fetch');}}),{name:'AbortError'});
});
test('imports reject missing, duplicate, or modified model files',async()=>{
  const file=new File([body],entry.path);
  assert.equal((await validateModelFiles([file],()=>{},[entry]))[entry.path],file);
  await assert.rejects(validateModelFiles([],()=>{},[entry]),/exactly one/);
  await assert.rejects(validateModelFiles([file,file],()=>{},[entry]),/exactly one/);
  await assert.rejects(validateModelFiles([new File(['x'.repeat(body.length)],entry.path)],()=>{},[entry]),/Integrity/);
});
test('truncated streams and cancellation during a download leave no cached partial file',async()=>{
  const cache=storage();
  await assert.rejects(downloadModels(()=>{},{storage:cache,entries:[entry],fetcher:async()=>new Response(body.slice(0,-1))}),/Wrong file size/);
  assert.equal(cache.values.size,0);
  const controller=new AbortController();
  await assert.rejects(downloadModels(()=>{},{storage:cache,entries:[entry],signal:controller.signal,fetcher:async()=>new Response(new ReadableStream({pull(c){controller.abort();c.enqueue(new TextEncoder().encode(body));c.close();}}))}),{name:'AbortError'});
  assert.equal(cache.values.size,0);
});
