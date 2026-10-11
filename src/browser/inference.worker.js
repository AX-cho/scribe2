import * as ort from 'onnxruntime-web/webgpu';
import { env } from '../../vendor/transformers/src/env.js';
import { Nemotron3DiarizationProcessor } from '../../vendor/transformers/src/models/nemotron3_diarization/processing_nemotron3_diarization.js';
import { Nemotron3DiarizationForAudioFrameClassification } from '../../vendor/transformers/src/models/nemotron3_diarization/modeling_nemotron3_diarization.js';
import { readModelBuffer } from './model-buffer';
import { NemotronBrowserASR } from './nemotron';
import { CaptionUpdates, processCaptionBatch } from './caption-updates';

// Defence in depth: CSP also confines all network requests to this static origin.
let modelFiles = {};
let assetBase;
const localFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input, self.location.href);
  const method = options?.method || (input instanceof Request ? input.method : 'GET');
  if (url.origin !== self.location.origin || !['GET', 'HEAD'].includes(method)) throw Error('Only local asset reads are allowed');
  if (url.pathname.startsWith('/models/')) {
    const file = modelFiles[decodeURIComponent(url.pathname.slice('/models/'.length))];
    return Promise.resolve(file ? new Response(method === 'HEAD' ? null : file, { headers: { 'Content-Length': String(file.size) } }) : new Response(null, { status:404 }));
  }
  if (!assetBase || !url.href.startsWith(new URL('ort/', assetBase).href)) throw Error('Unexpected asset request');
  return localFetch(input, { ...options, redirect: 'error' });
};
env.fetch = globalThis.fetch;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = false;
env.useFSCache = false;
let asr, model, processor, cache = null, pcm = new Float32Array(), base = 0, cursor = 0;
let role = 'both', lastWordCount = 0, lastWordText = '', threads = 1;
let updates = new CaptionUpdates(), totalSamples = 0, elapsedMs = 0, active = false;
const send = (type, value = {}) => postMessage({ type, ...value });
const status = message => send('status', { message });
function reset() {
  cache = null; pcm = new Float32Array(); base = cursor = totalSamples = elapsedMs = 0;
  updates = new CaptionUpdates(); asr?.startStream(101); lastWordCount = 0; lastWordText = ''; active = true;
}
async function diarize(flush) {
  while (true) {
    const first = cursor === 0;
    const start = first ? 0 : processor.audio_chunk_start(cursor);
    const count = first ? processor.num_samples_first_audio_chunk : processor.num_samples_per_audio_chunk;
    const available = base + pcm.length - start;
    if (available < count && !flush) break;
    if (available <= (first ? 0 : processor.feature_extractor.config.win_length)) break;
    const last = flush && available < count;
    const samples = pcm.slice(start - base, start - base + (last ? available : count));
    const inputs = await processor(samples, { is_streaming: true, is_first_audio_chunk: first, is_last_audio_chunk: last });
    const outputs = await model({ ...inputs, speaker_cache: cache });
    cache = outputs.speaker_cache;
    if (role === 'diar') {
      const logits = Float32Array.from(outputs.logits.data);
      postMessage({ type: 'activity', frames: outputs.logits.dims[1], logits: logits.buffer }, [logits.buffer]);
    } else updates.addActivity(outputs.logits.data, outputs.logits.dims[1]);
    outputs.logits.dispose(); inputs.input_features.dispose(); inputs.attention_mask.dispose();
    cursor += processor.num_mel_frames_per_step;
    const next = processor.audio_chunk_start(cursor);
    const remove = Math.max(0, Math.min(pcm.length, next - base));
    pcm = pcm.slice(remove); base += remove;
    if (last) break;
  }
}
function captions() {
  if (role === 'diar') return;
  if (role === 'asr') {
    const words = asr.words;
    if (words.length === lastWordCount && (words.at(-1)?.text || '') === lastWordText) return;
    const from = Math.max(0, lastWordCount - 1);
    send('words', { from, words: words.slice(from) });
    lastWordCount = words.length; lastWordText = words.at(-1)?.text || '';
    return;
  }
  const patch = updates.update(asr.words);
  if (patch) send('captions', patch);
}
let chain = Promise.resolve();
self.onmessage = ({ data }) => {
  chain = chain.then(async () => {
    if (data.type === 'load') {
      modelFiles = data.modelFiles || {};
      assetBase = data.assetBase;
      if (!assetBase || new URL(assetBase).origin !== self.location.origin) throw Error('Invalid asset origin');
      const device = data.device || 'wasm';
      if (!['wasm','webgpu'].includes(device)) throw Error('Invalid execution device');
      if (device === 'webgpu') {
        const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter || adapter.info?.isFallbackAdapter) throw Error('Hardware WebGPU is unavailable. Choose CPU explicitly to continue.');
      }
      role = data.role || 'both';
      if (!['both','asr','diar'].includes(role)) throw Error('Invalid inference role');
      threads = self.crossOriginIsolated ? Math.max(1, Math.min(data.threads || 1, navigator.hardwareConcurrency || 1)) : 1;
      for (const runtime of [ort.env, env.backends.onnx]) {
        runtime.wasm.wasmPaths = new URL('ort/', assetBase).href; runtime.wasm.numThreads = threads; runtime.wasm.proxy = false;
      }
      if (role !== 'diar') {
        asr = new NemotronBrowserASR();
        await asr.load(status, { device, threads, readModel: name => readModelBuffer(modelFiles['asr/' + name]), wasmPaths: new URL('ort/', assetBase).href, jointMode: data.jointMode || 'argmax' });
      }
      if (role !== 'asr') {
        status('Loading local speaker model');
        processor = await Nemotron3DiarizationProcessor.from_pretrained('diar', { local_files_only: true });
        processor.set_streaming_mode('low_latency');
        model = await Nemotron3DiarizationForAudioFrameClassification.from_pretrained('diar', { device, dtype: 'q8', local_files_only: true });
      }
      if (device === 'webgpu' && ort.env.webgpu.device) ort.env.webgpu.device.lost.then(info => { active = false; send('error', { message: `GPU device lost: ${info.message || info.reason}. Reload models or choose CPU.` }); });
      send('ready', { threads, role, device });
    } else if (data.type === 'start') reset();
    else if (data.type === 'audio' && active) {
      const started = performance.now();
      const samples = new Float32Array(data.samples);
      totalSamples += samples.length;
      if (role !== 'asr') {
        const joined = new Float32Array(pcm.length + samples.length); joined.set(pcm); joined.set(samples, pcm.length); pcm = joined;
      }
      // ASR and diarization advance continuously, without waiting for silence.
      if (role === 'both') await processCaptionBatch(asr, samples, false, captions, diarize);
      else if (role === 'asr') { await asr.pushAudio(samples, false, captions); captions(); }
      else await diarize(false);
      elapsedMs += performance.now() - started;
      send('ack', { samples: samples.length, audioSeconds: totalSamples / 16000, elapsedMs });
    } else if (data.type === 'stop' && active) {
      const started = performance.now();
      if (role === 'both') await processCaptionBatch(asr, new Float32Array(), true, captions, diarize);
      else if (role === 'asr') { await asr.pushAudio(new Float32Array(), true, captions); captions(); }
      else await diarize(true);
      elapsedMs += performance.now() - started;
      pcm = new Float32Array(); cache = null; active = false; send('stopped', { elapsedMs, metrics: asr?.metrics, audioSeconds: totalSamples / 16000 });
    }
  }).catch(error => { active = false; pcm = new Float32Array(); cache = null; send('error', { message: error.message || String(error) }); });
};
