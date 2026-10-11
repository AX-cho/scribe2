// Included only by an explicit SCRIBE_BROWSER_BENCHMARK=1 build. Test audio is
// passed through Chrome's debugging pipe, never uploaded to any HTTP endpoint.
import { InferenceClient } from './inference-client';
import { applyCaptionPatch } from './caption-updates';
window.runCpuBenchmark = async ({ mode, jointMode, device = 'wasm', realtime = false, pcmBase64 }) => {
  const bytes = Uint8Array.from(atob(pcmBase64),c=>c.charCodeAt(0));
  const pcm = new Int16Array(bytes.buffer);
  const client = new InferenceClient({mode,jointMode,device});
  let session={segments:[]}, start, firstCaptionMs, done, fail;
  const stopped = new Promise((resolve,reject)=>{done=resolve;fail=reject;});
  const progress = { mode,jointMode,device,state:'loading', audioSeconds:pcm.length/16000 };
  window.cpuBenchmarkProgress=progress;
  let ready;
  const loaded=new Promise(resolve=>{ready=resolve;});
  const warnings = []; let maxDiarLag = 0;
  let waiting = null, sentSamples = 0, ackedSamples = 0;
  client.onmessage=({data})=>{
    if(data.type==='warning') warnings.push(data.message);
    if(data.type==='diar-progress') maxDiarLag = Math.max(maxDiarLag, data.lagSeconds);
    if(data.type==='error') { fail(Error(data.message)); ready(); waiting?.(); }
    if(data.type==='ready') {progress.plan=data.plan;ready();}
    if(data.type==='captions') {
      session=applyCaptionPatch(session,data);
      if(firstCaptionMs===undefined && session.segments.length) firstCaptionMs=performance.now()-start;
    }
    if(data.type==='ack') {ackedSamples += data.samples; progress.processedSeconds=data.audioSeconds;waiting?.();waiting=null;}
    if(data.type==='stopped') done(data);
  };
  try {
    client.postMessage({type:'load'});
    // Attach rejection handler immediately, including model-load failures.
    await Promise.race([loaded,stopped]);
    start=performance.now(); progress.state='running';client.postMessage({type:'start'});
    // Bounded three-second pipeline permits ASR to advance while speaker
    // inference is busy, as it does with a continuous microphone stream.
    for(let offset=0;offset<pcm.length;offset+=8960){
      while(sentSamples-ackedSamples >= 48000) {
        const ack=new Promise(resolve=>{waiting=resolve;});
        await Promise.race([ack,stopped]);
      }
      if (realtime) await new Promise(resolve=>setTimeout(resolve,Math.max(0,((offset+Math.min(8960,pcm.length-offset))/16000)*1000-(performance.now()-start))));
      const samples=Float32Array.from(pcm.subarray(offset,offset+8960),x=>x/32768);
      sentSamples += samples.length;
      client.postMessage({type:'audio',samples:samples.buffer});
    }
    client.postMessage({type:'stop'});
    const result=await stopped;
    const wallMs=performance.now()-start;
    const report={mode,jointMode,device,realtime,warnings,maxDiarLag,plan:progress.plan,audioSeconds:pcm.length/16000,wallMs,firstCaptionMs,speed:(pcm.length/16000)/(wallMs/1000),stages:result.stages,segments:session.segments};
    progress.state='complete';return report;
  } finally {client.terminate();}
};
