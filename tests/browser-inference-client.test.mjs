import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceClient, threadPlan } from '../src/browser/inference-client.js';
function harness(mode='parallel') {
  const workers=[], messages=[];
  const client=new InferenceClient({mode,hardware:12,isolated:true,workerFactory:()=>{
    const worker={sent:[],postMessage(data,transfer){this.sent.push({data,transfer});},terminate(){this.terminated=true;},emit(data){this.onmessage({data});}};
    workers.push(worker);return worker;
  }});
  client.onmessage=({data})=>messages.push(data);
  return {client,workers,messages};
}
test('separate runtimes share one bounded thread budget, with single-core fallback',()=>{
  assert.deepEqual(threadPlan('parallel',12,true),{mode:'parallel',asr:3,diar:1,budget:4});
  assert.deepEqual(threadPlan('parallel',2,true),{mode:'parallel',asr:1,diar:1,budget:2});
  assert.equal(threadPlan('parallel',12,false).mode,'sequential');
  assert.equal(threadPlan('parallel',1,true).both,1);
});
test('speech publishes before speaker results, while acknowledgements track the slower worker',()=>{
  const {client,workers:[asr,diar],messages}=harness();
  client.postMessage({type:'load'});
  assert.equal(asr.sent[0].data.threads,3);assert.equal(diar.sent[0].data.threads,1);
  asr.emit({type:'ready'});assert.equal(messages.length,0);
  diar.emit({type:'ready'});assert.equal(messages.at(-1).type,'ready');
  client.postMessage({type:'start'});
  asr.emit({type:'words',from:0,words:[{text:'Hello',time:.1}]});
  assert.equal(messages.at(-1).segments[0].text,'Hello');
  assert.equal(messages.at(-1).segments[0].speaker,null);
  asr.emit({type:'ack',samples:8960,elapsedMs:100});
  assert.equal(messages.filter(m=>m.type==='ack').length,0);
  const logits=new Float32Array(30*8).fill(-5);for(let f=0;f<30;f++)logits[f*8+2]=5;
  diar.emit({type:'activity',frames:30,logits:logits.buffer});
  assert.equal(messages.at(-1).segments[0].speaker,1);
  assert.equal(messages.at(-1).segments[0].id,'word-0');
  diar.emit({type:'ack',samples:4000,elapsedMs:200});
  assert.equal(messages.at(-1).samples,4000);
  diar.emit({type:'ack',samples:4960,elapsedMs:300});
  assert.equal(messages.at(-1).samples,4960);
  asr.emit({type:'stopped',elapsedMs:120});
  assert.notEqual(messages.at(-1).type,'stopped');
  diar.emit({type:'stopped',elapsedMs:320});
  assert.equal(messages.at(-1).type,'stopped');
});
test('audio is transferred to both workers and errors terminate both',()=>{
  const {client,workers,messages}=harness();
  const samples=new Float32Array([.1,.2]).buffer;
  client.postMessage({type:'audio',samples});
  assert.notEqual(workers[0].sent[0].data.samples,workers[1].sent[0].data.samples);
  for(const worker of workers)assert.deepEqual(new Float32Array(worker.sent[0].data.samples),new Float32Array(samples));
  workers[1].emit({type:'error',message:'test failure'});
  assert.equal(messages.at(-1).type,'error');
  assert.ok(workers.every(w=>w.terminated));
  const before=messages.length;workers[0].emit({type:'captions'});assert.equal(messages.length,before);
});
test('starting another conversation clears incremental words and attribution',()=>{
  const {client,workers:[asr],messages}=harness();
  asr.emit({type:'words',from:0,words:[{text:'Old',time:0}]});
  client.postMessage({type:'start'});
  asr.emit({type:'words',from:0,words:[{text:'New',time:0}]});
  assert.deepEqual(messages.at(-1).segments.map(s=>s.text),['New']);
});
test('WebGPU uses independent GPU workers and never retries on CPU',()=>{
  const workers=[],events=[];
  const client=new InferenceClient({device:'webgpu',hardware:8,isolated:true,workerFactory:()=>{
    const worker={sent:[],postMessage(data){this.sent.push(data);},terminate(){this.terminated=true;}};
    workers.push(worker);return worker;
  }});
  client.onmessage=({data})=>events.push(data);
  client.postMessage({type:'load'});
  assert.equal(workers.length,2);
  assert.equal(workers[0].sent[0].device,'webgpu');
  assert.equal(workers[0].sent[0].threads,1);
  assert.equal(workers[1].sent[0].device,'webgpu');
  assert.equal(workers[1].sent[0].threads,3);
  for(const worker of workers)worker.onmessage({data:{type:'ready'}});
  assert.equal(events.at(-1).device,'webgpu');
  workers[0].onmessage({data:{type:'ack',samples:1600,elapsedMs:10}});
  assert.equal(events.at(-1).samples,1600); // no speaker acknowledgement needed
  client.postMessage({type:'audio',samples:new Float32Array(16*16000).buffer});
  assert.equal(events.at(-1).type,'warning');
  assert.ok(workers[1].terminated); assert.ok(!workers[0].terminated);
  assert.ok(client.updates.speakerDetectionEnded);
  workers[0].onmessage({data:{type:'stopped',elapsedMs:10}});
  assert.equal(events.at(-1).type,'stopped');
  workers[0].onmessage({data:{type:'error',message:'GPU unavailable'}});
  assert.equal(events.at(-1).message,'GPU unavailable');
  assert.ok(workers.every(w=>w.terminated));
  assert.throws(()=>new InferenceClient({device:'remote'}),/Invalid execution device/);
});
