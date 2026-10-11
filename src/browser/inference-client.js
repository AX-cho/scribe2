import { CaptionUpdates } from './caption-updates.js';

// One budget for both runtimes. numThreads includes each worker's calling thread.
export function threadPlan(mode, hardware = 1, isolated = false, device = 'wasm') {
  const cores = Math.max(1, Math.floor(Number(hardware) || 1));
  const budget = isolated ? Math.min(4, cores) : 1;
  if (device === 'webgpu') return { mode:'parallel', asr:1, diar:Math.max(1,budget-1), budget:Math.max(2,budget) };
  if (mode !== 'parallel' || budget < 2) return { mode:'sequential', both:budget, budget };
  return { mode:'parallel', asr:budget - 1, diar:1, budget };
}
export class InferenceClient {
  constructor({ device = 'wasm', mode = 'sequential', jointMode = 'argmax', hardware = globalThis.navigator?.hardwareConcurrency, isolated = globalThis.crossOriginIsolated, workerFactory = () => new Worker(new URL('./inference.worker.js', import.meta.url), { type:'module' }) } = {}) {
    if (!['wasm','webgpu'].includes(device)) throw Error('Invalid execution device');
    this.device = device;
    this.plan = threadPlan(mode, hardware, isolated, device);
    this.jointMode = jointMode;
    this.onmessage = null; this.onerror = null; this.closed = false;
    this.updates = new CaptionUpdates(); this.words = []; this.acked = 0; this.sentSamples = 0;
    this.members = (this.plan.mode === 'parallel' ? ['asr','diar'] : ['both']).map(role => {
      const member = { role, worker:workerFactory(), ready:false, stopped:false, processed:0, elapsedMs:0 };
      member.worker.onmessage = event => this.receive(member,event.data);
      member.worker.onerror = event => this.fail(event.message || 'Inference worker failed');
      return member;
    });
  }
  emit(data) { if (!this.closed) this.onmessage?.({ data }); }
  fail(message) { this.emit({ type:'error', message }); this.terminate(); }
  receive(member,data) {
    if (this.closed || member.disabled) return;
    if (data.type === 'error') return this.fail(data.message);
    if (data.type === 'ready') {
      member.ready = true;
      if (this.members.every(m=>m.ready)) this.emit({ type:'ready', plan:this.plan, device:this.device });
    } else if (data.type === 'words' || data.type === 'activity') {
      if (data.type === 'words') {
        this.words.length = data.from;
        this.words.push(...data.words);
      } else {
        this.updates.addActivity(new Float32Array(data.logits),data.frames);
        this.emit({type:'diar-progress',lagSeconds:Math.max(0,this.sentSamples / 16000 - this.updates.frameEnd / 100)});
      }
      const patch = this.updates.update(this.words);
      if (patch) this.emit({ type:'captions', ...patch });
    } else if (data.type === 'ack') {
      member.processed += data.samples; member.elapsedMs = data.elapsedMs;
      const completed = this.device === 'webgpu' ? this.members.find(m=>m.role==='asr').processed : Math.min(...this.members.map(m=>m.processed));
      const samples = completed - this.acked;
      if (samples > 0) {
        this.acked = completed;
        this.emit({ type:'ack', samples, audioSeconds:completed / 16000, elapsedMs:Math.max(...this.members.map(m=>m.elapsedMs)) });
      }
    } else if (data.type === 'stopped') {
      member.stopped = true; member.elapsedMs = data.elapsedMs; member.metrics = data.metrics;
      if (this.members.every(m=>m.stopped || m.disabled)) this.emit({ type:'stopped', plan:this.plan, stages:this.members.map(({role,elapsedMs,metrics})=>({role,elapsedMs,metrics})) });
    } else this.emit(data);
  }
  postMessage(data) {
    if (this.closed) return;
    if (data.type === 'start') {
      this.updates = new CaptionUpdates(); this.words = []; this.acked = 0; this.sentSamples = 0;
      if (this.members.some(m=>m.disabled)) {
        this.updates.speakerDetectionEnded = true;
        this.emit({type:'warning',message:'Speaker detection is stopped. Live words continue; refresh to restart speaker detection.'});
      }
      for (const member of this.members) { member.processed = member.elapsedMs = 0; member.stopped = false; }
    }
    if (data.type === 'audio') {
      // Transfer ownership; only the second worker needs an independent copy.
      this.sentSamples += data.samples.byteLength / 4;
      if (this.device === 'webgpu') {
        const diar = this.members.find(m=>m.role==='diar');
        if (!diar.disabled && this.sentSamples - diar.processed > 15 * 16000) {
          diar.disabled = true; diar.worker.terminate(); this.updates.speakerDetectionEnded = true;
          this.emit({type:'warning',message:'Speaker detection fell more than 15 seconds behind and has stopped. Live words continue; refresh to restart speaker detection.'});
        }
      }
      const activeMembers = this.members.filter(m=>!m.disabled);
      const buffers = activeMembers.map((_,i)=> i === activeMembers.length-1 ? data.samples : data.samples.slice(0));
      activeMembers.forEach((m,i)=>m.worker.postMessage({ ...data, samples:buffers[i] },[buffers[i]]));
    } else {
      for (const member of this.members.filter(m=>!m.disabled)) member.worker.postMessage(data.type === 'load' ? { ...data, role:member.role, threads:this.plan[member.role], jointMode:this.jointMode, device:this.device } : data);
    }
  }
  terminate() {
    this.closed = true;
    this.members.forEach(m=>m.worker.terminate());
    this.words = []; this.updates = null;
  }
}
