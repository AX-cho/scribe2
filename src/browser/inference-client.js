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
  constructor({ device = 'wasm', mode = 'sequential', jointMode = 'argmax', speakerOnly = false, hardware = globalThis.navigator?.hardwareConcurrency, isolated = globalThis.crossOriginIsolated, workerFactory = () => new Worker(new URL('./inference.worker.js', import.meta.url), { type:'module' }) } = {}) {
    if (!['wasm','webgpu'].includes(device)) throw Error('Invalid execution device');
    this.device = device;
    this.speakerOnly = speakerOnly && device === 'webgpu';
    this.plan = threadPlan(mode, hardware, isolated, device);
    this.jointMode = jointMode;
    this.pendingLoads = [];
    this.onmessage = null; this.onerror = null; this.closed = false;
    this.updates = new CaptionUpdates(); this.words = []; this.acked = 0; this.sentSamples = 0; this.sessionStart = 0;
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
      const next = this.pendingLoads.shift();
      if (next) { this.emit({type:'status', message:'Speech model ready. Loading speaker detection…'}); next.member.worker.postMessage(next.data); }
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
    } else if (data.type === 'diar-batch') {
      const diar = this.members.find(m => m.role === 'diar');
      if (diar) {
        diar.batchTimings ??= [];
        diar.batchTimings.push(data.elapsedMs);
        if (diar.batchTimings.length > 200) diar.batchTimings.shift();
        this.emitDiagnostics();
      }
    } else if (data.type === 'ack') {
      member.processed += data.samples; member.elapsedMs = data.elapsedMs;
      this.emitDiagnostics();
      const completed = this.device === 'webgpu' ? this.members.find(m=>m.role=== (this.speakerOnly ? 'diar' : 'asr')).processed : Math.min(...this.members.map(m=>m.processed));
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
  emitDiagnostics() {
    if (this.device !== 'webgpu' || !this.sessionStart) return;
    const asr = this.members.find(m => m.role === 'asr');
    const diar = this.members.find(m => m.role === 'diar');
    const elapsed = Math.max((performance.now() - this.sessionStart) / 1000, 0.001);
    const stage = m => ({
      processedSeconds: m.processed / 16000,
      computeRtf: m.processed ? m.elapsedMs / (m.processed / 16000 * 1000) : null,
      effectiveSpeed: (m.processed / 16000) / elapsed,
    });
    const timings = [...(diar.batchTimings || [])].sort((a,b)=>a-b);
    this.emit({ type:'diagnostics',
      speakerOnly:this.speakerOnly,
      batchCount:timings.length,
      batchP95Ms:timings.length ? timings[Math.ceil(timings.length*.95)-1] : null,
      batchMaxMs:timings.length ? timings[ timings.length-1 ] : null,
      asr:stage(asr), diar:stage(diar),
      asrBacklogSeconds:Math.max(0,(this.sentSamples-asr.processed)/16000),
      diarBacklogSeconds:Math.max(0,(this.sentSamples-diar.processed)/16000),
      speakerStopped:Boolean(diar.disabled),
    });
  }
  postMessage(data) {
    if (this.closed) return;
    if (data.type === 'load') {
      this.pendingLoads = this.members.map(member => ({member, data: { ...data, modelFiles: data.modelFiles ? Object.fromEntries(Object.entries(data.modelFiles).filter(([path]) => member.role === 'both' || path.startsWith(member.role + '/'))) : undefined, role:member.role, threads:this.plan[member.role], jointMode:this.jointMode, device:this.device }}));
      const first = this.pendingLoads.shift();
      first.member.worker.postMessage(first.data);
      return;
    }
    if (data.type === 'start') {
      this.updates = new CaptionUpdates(); this.words = []; this.acked = 0; this.sentSamples = 0; this.sessionStart = performance.now();
      if (this.members.some(m=>m.disabled)) {
        this.updates.speakerDetectionEnded = true;
        this.emit({type:'warning',message:'Speaker detection is stopped. Live words continue; refresh to restart speaker detection.'});
      }
      for (const member of this.members) { member.processed = member.elapsedMs = 0; member.stopped = false; member.batchTimings = []; }
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
      this.emitDiagnostics();
      const activeMembers = this.members.filter(m=>!m.disabled && !(this.speakerOnly && m.role === 'asr'));
      const buffers = activeMembers.map((_,i)=> i === activeMembers.length-1 ? data.samples : data.samples.slice(0));
      activeMembers.forEach((m,i)=>m.worker.postMessage({ ...data, samples:buffers[i] },[buffers[i]]));
    } else {
      for (const member of this.members.filter(m=>!m.disabled)) member.worker.postMessage(data.type === 'load' ? { ...data, role:member.role, threads:this.plan[member.role], jointMode:this.jointMode, device:this.device } : data);
    }
  }
  terminate() {
    this.closed = true; this.pendingLoads = [];
    this.members.forEach(m=>m.worker.terminate());
    this.words = []; this.updates = null;
  }
}
