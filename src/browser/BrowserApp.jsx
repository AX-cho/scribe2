import { useEffect, useRef, useState } from 'react';
import { Captions, Mic, Square, Pause, Play, Plus, Minus, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Conversation } from '@/components/Conversation';
import { applyCaptionPatch } from './caption-updates';
import { validateModelFiles, downloadModels, modelDownloadMB, MODEL_CACHE } from './model-import';
import { InferenceClient } from './inference-client';

export default function BrowserApp() {
  const modelInput = useRef(), downloadController = useRef();
  const [downloading, setDownloading] = useState(false);
  const [modelFiles, setModelFiles] = useState(null);
  const [checking, setChecking] = useState(false);
  async function download() {
    const controller = new AbortController(); downloadController.current = controller;
    setChecking(true); setDownloading(true); setModelFiles(null); setError('');
    try {
      const result = await downloadModels(setStatus, { signal: controller.signal });
      setModelFiles(result.files);
      setStatus(result.saved ? 'Models verified and saved on this device. Ready to load.' : 'Models verified. Ready to load; browser storage was unavailable or full.');
    } catch (error) {
      setStatus(controller.signal.aborted ? 'Download cancelled. Verified files remain saved for the next attempt.' : 'Download failed. Retry or import your model folder.');
      if (!controller.signal.aborted) setError(error.message);
    } finally { setChecking(false); setDownloading(false); downloadController.current = null; }
  }
  async function clearModelCache() {
    try { await caches.delete(MODEL_CACHE); setStatus('Saved model downloads removed.'); }
    catch (error) { setError(error.message); }
  }
  async function importModels(event) {
    setChecking(true); setModelFiles(null); setError('');
    try { setModelFiles(await validateModelFiles([...event.target.files], setStatus)); setStatus('Models verified. Ready to load.'); }
    catch (error) { setError(error.message); setStatus('Import failed. Choose the approved model folder.'); }
    finally { setChecking(false); event.target.value = ''; }
  }
  const worker = useRef(), capture = useRef(), pending = useRef(0), liveRef = useRef(false);
  const [phase, setPhase] = useState('unloaded'), [status, setStatus] = useState('Download the approved models or import your model folder to begin.');
  const [error, setError] = useState(''), [devices, setDevices] = useState([]), [device, setDevice] = useState('');
  const [session, setSession] = useState({ id: 'browser', segments: [] }), [holding, setHolding] = useState(false), [held, setHeld] = useState(null);
  const [size, setSize] = useState(28), [contrast, setContrast] = useState(false), [announce, setAnnounce] = useState(false);
  const [level, setLevel] = useState(0), [lag, setLag] = useState(0), [speed, setSpeed] = useState(null);
  const [deviceMode, setDeviceMode] = useState('webgpu');
  const executionLabel = deviceMode === 'webgpu' ? 'WebGPU speech + speakers' : 'browser CPU';
  const [cpuMode, setCpuMode] = useState('sequential');
  const sizes = [20, 24, 28, 32, 40];
  const live = phase === 'listening';
  async function enumerate() {
    const list = await navigator.mediaDevices.enumerateDevices();
    setDevices(list.filter(d => d.kind === 'audioinput'));
  }
  function release() {
    liveRef.current = false;
    const current = capture.current; capture.current = null;
    current?.stream.getTracks().forEach(track => track.stop());
    current?.node?.disconnect(); current?.source?.disconnect(); current?.context.close().catch(() => {});
    setLevel(0);
  }
  function fail(message) {
    release(); worker.current?.terminate(); worker.current = null;
    pending.current = 0; setLag(0); setPhase('unloaded'); setError(message); setStatus('Stopped. Load models to try again.');
  }
  useEffect(() => {
    enumerate().catch(() => {});
    navigator.mediaDevices?.addEventListener('devicechange', enumerate);
    const cleanup = () => { downloadController.current?.abort(); release(); worker.current?.terminate(); };
    window.addEventListener('pagehide', cleanup);
    return () => { cleanup(); window.removeEventListener('pagehide', cleanup); navigator.mediaDevices?.removeEventListener('devicechange', enumerate); };
  }, []);
  function load() {
    setError(''); setPhase('loading'); setStatus('Loading models into browser memory…');
    worker.current?.terminate();
    const next = new InferenceClient({ mode:cpuMode, device:deviceMode, jointMode:'logits' }); worker.current = next;
    next.onerror = event => fail(event.message || 'Browser inference worker failed');
    next.onmessage = ({ data }) => {
      if (data.type === 'status') setStatus(data.message);
      if (data.type === 'ready') { setPhase('ready'); setCpuMode(data.plan.mode); setStatus(`Ready · ${executionLabel} · ${data.plan.mode === 'parallel' ? 'separate workers' : 'shared worker'}`); }
      if (data.type === 'error') fail(data.message);
      if (data.type === 'warning') setError(data.message);
      if (data.type === 'captions') {
        setSession(previous => applyCaptionPatch(previous, data));
      }
      if (data.type === 'ack') { setSpeed(data.elapsedMs && data.audioSeconds ? data.audioSeconds / (data.elapsedMs / 1000) : null); pending.current = Math.max(0, pending.current - data.samples); setLag(pending.current / 16000); }
      if (data.type === 'stopped') { setPhase('ready'); setStatus(`Conversation ended · ${executionLabel}`); }
    };
    next.postMessage({ type: 'load', modelFiles, assetBase: new URL('.', document.baseURI).href });
  }
  async function selectMicrophones() {
    try {
      setError(''); const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop()); await enumerate();
    } catch (e) { setError(e.message); }
  }
  async function start() {
    setPhase('starting'); setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: device ? { exact: device } : undefined, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const context = new AudioContext();
      capture.current = { stream, context };
      await context.audioWorklet.addModule(new URL('./pcm-worklet.js', document.baseURI).href);
      const source = context.createMediaStreamSource(stream);
      const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 7200; filter.Q.value = 0.707;
      const node = new AudioWorkletNode(context, 'pcm-capture');
      const mute = context.createGain(); mute.gain.value = 0;
      Object.assign(capture.current, { source, node });
      source.connect(filter).connect(node).connect(mute).connect(context.destination);
      pending.current = 0; setLag(0); setSpeed(null); setSession({ id: 'browser', segments: [] }); setHolding(false); setHeld(null);
      worker.current.postMessage({ type: 'start' });
      liveRef.current = true;
      node.port.onmessage = ({ data }) => {
        if (!data.pcm || !liveRef.current) return;
        const pcm = new Int16Array(data.pcm), samples = Float32Array.from(pcm, x => x / 32768);
        const rms = Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
        setLevel(Math.min(5, Math.ceil(rms * 60)));
        pending.current += samples.length;
        setLag(pending.current / 16000);
        if (pending.current > 15 * 16000) { fail('This device cannot keep up. Captions stopped after 15 seconds of pending audio; the microphone is off and pending audio was discarded.'); return; }
        worker.current.postMessage({ type: 'audio', samples: samples.buffer }, [samples.buffer]);
      };
      await context.resume(); await enumerate();
      setPhase('listening'); setStatus(`Listening · ${executionLabel}`);
    } catch (e) { release(); setPhase('ready'); setError(e.message); }
  }
  async function stop() {
    setPhase('stopping'); setStatus('Finishing pending captions…');
    const current = capture.current;
    if (current?.node) {
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 500);
        const receive = current.node.port.onmessage;
        current.node.port.onmessage = event => {
          receive(event);
          if (event.data.flushed) { clearTimeout(timeout); resolve(); }
        };
        current.node.port.postMessage('flush');
      });
    }
    release(); worker.current?.postMessage({ type: 'stop' });
  }
  const toggleHold = () => { if (!holding) setHeld(structuredClone(session)); setHolding(!holding); };
  return <div className={`app-shell ${contrast ? 'high-contrast' : ''}`}>
    <a className="skip-link" href="#transcript">Skip to conversation captions</a>
    <header className="app-header"><div className="brand"><span className="brand-symbol"><Captions aria-hidden="true"/></span><span>Scribe<span className="brand-subtitle">Local browser edition</span></span></div><span className="local-badge"><ShieldCheck size={18} aria-hidden="true"/>On this device</span></header>
    <main className="workspace">
      <section className="conversation-heading" aria-label="Conversation controls"><div><p className="eyebrow">HERE, TOGETHER</p><h1>Stay in the conversation.</h1><p className="heading-description">One reading flow. Voices marked in place.</p></div><div className="session-controls">
        {phase === 'unloaded' || phase === 'loading' ? <Button id="load-models" disabled={phase === 'loading' || checking || !modelFiles} onClick={load}>{phase === 'loading' ? 'Loading models…' : 'Load local models'}</Button> : <Button id="record" className="listen-button" disabled={!['ready', 'listening'].includes(phase)} onClick={live ? stop : start}>{live ? <Square size={18}/> : <Mic size={18}/>}<span id="record-label">{live ? 'Stop captions' : phase === 'ready' ? 'Start captions' : 'Please wait…'}</span></Button>}
      </div></section>
      {error && <div className="notice-panel notice-error" role="alert"><p>{error}</p></div>}
      {lag > 2 && live && <div className="notice-panel" role="status"><p>Captions are {lag.toFixed(1)} seconds behind. This device is processing pending speech.</p></div>}
      <div className="workspace-grid"><section className="caption-panel" aria-labelledby="caption-title">
        <div className="caption-panel-header"><div className="caption-heading"><h2 id="caption-title">Conversation</h2><span id="studio-status" className="listening-status" role="status">{status}</span></div></div>
        <div className="reading-toolbar"><div className="type-controls" role="group" aria-label="Caption text size"><Button variant="ghost" size="icon" aria-label="Decrease caption text size" disabled={size === 20} onClick={() => setSize(sizes[sizes.indexOf(size) - 1])}><Minus size={17}/></Button><span className="text-size-label">Aa {size}</span><Button variant="ghost" size="icon" aria-label="Increase caption text size" disabled={size === 40} onClick={() => setSize(sizes[sizes.indexOf(size) + 1])}><Plus size={17}/></Button></div><Button variant="outline" onClick={toggleHold} disabled={!session.segments.length} aria-pressed={holding}>{holding ? <Play size={16}/> : <Pause size={16}/>}{holding ? 'Resume text' : 'Hold text'}</Button></div>
        <Conversation session={session} live={live} holding={holding} heldSession={held} textSize={size} announce={announce} onReturn={() => setHolding(false)}/>
        <div className="caption-footer"><span>Speaker labels may change. Overlapping speech and word boundaries can be uncertain.</span></div>
      </section><aside className="conversation-tools" aria-label="Caption settings">
        <section className="tool-section"><h2>Models on your device</h2><p id="model-help" className="input-description">Download about {modelDownloadMB} MB from Hugging Face, or import your browser-models folder containing asr/ and diar/. Both options verify the approved model files. Audio stays here.</p><Button id="download-models" disabled={phase !== 'unloaded' || checking} aria-describedby="model-help" onClick={download}>Download models</Button>{' '}<Button id="import-models" variant="outline" disabled={phase !== 'unloaded' || checking} aria-describedby="model-help" onClick={() => modelInput.current?.click()}>Import models</Button><input ref={modelInput} id="model-folder" type="file" webkitdirectory="" multiple hidden disabled={phase !== 'unloaded' || checking} onChange={importModels}/>{downloading && <Button variant="outline" onClick={() => downloadController.current?.abort()}>Cancel download</Button>}<p className="input-description">Downloads are saved in this browser when storage permits. After refreshing, Download models reuses and verifies saved files. Imports are not saved. The model host receives download requests; no files or audio are uploaded.</p><Button variant="ghost" disabled={checking} onClick={clearModelCache}>Delete saved models</Button></section><section className="tool-section"><div className="tool-heading"><Mic size={18}/><h2>Your microphone</h2></div><label htmlFor="microphone">Audio input</label><select id="microphone" data-slot="native-select" value={device} disabled={['listening', 'starting', 'stopping'].includes(phase)} onChange={e => setDevice(e.target.value)}><option value="">System default</option>{devices.filter(d => d.deviceId).map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>)}</select><p className="input-description">Choose the microphone closest to the conversation. Stop captions before switching.</p><Button variant="outline" disabled={live} onClick={selectMicrophones}>Show microphone names</Button><div className="signal-line"><span className={`signal-bars level-${level}`} aria-hidden="true">{[1,2,3,4,5].map(n => <i key={n}/>)}</span><span>{live ? level ? 'Audio detected' : 'No microphone signal' : 'Microphone off'}</span></div></section>
        <section className="tool-section"><h2 className="tool-heading">Reading comfort</h2><Button variant="outline" aria-pressed={contrast} onClick={() => setContrast(!contrast)}>High contrast</Button><p><label><input type="checkbox" checked={announce} onChange={e => setAnnounce(e.target.checked)}/> Announce captions to screen readers</label></p><Button variant="ghost" disabled={phase !== 'ready' && phase !== 'unloaded'} onClick={() => { setSession({ id: 'browser', segments: [] }); setHeld(null); setHolding(false); }}>Clear conversation</Button></section>
        <section className="privacy-card"><ShieldCheck size={20} aria-hidden="true"/><div><h2>Audio stays in this browser</h2><p>No inference server, recording, or audio uploads. Refresh clears the conversation. Models are imported or downloaded on request; app code loads from this website. Only model files may be saved, never conversations.</p></div></section>
        <section className="tool-section"><label htmlFor="execution-device">Processing</label><select id="execution-device" data-slot="native-select" value={deviceMode} disabled={phase !== 'unloaded'} onChange={event => setDeviceMode(event.target.value)}><option value="webgpu">WebGPU speech + speakers</option><option value="wasm">CPU only</option></select><p className="input-description">Speech encoding and speaker detection use this device’s GPU in separate workers. Token decoding stays on CPU. No automatic CPU fallback. CPU uses one thread without cross-origin isolation.</p><label htmlFor="cpu-mode">Worker scheduling</label><select id="cpu-mode" data-slot="native-select" value={deviceMode === 'webgpu' ? 'parallel' : cpuMode} disabled={phase !== 'unloaded' || deviceMode === 'webgpu'} onChange={event => setCpuMode(event.target.value)}><option value="sequential">Shared worker</option><option value="parallel">Separate workers (experimental)</option></select><p className="input-description">WebGPU always runs speech and speaker detection in separate workers, so speech does not wait for speaker labels. Both models share GPU capacity. CPU-only scheduling can be chosen before loading models.</p></section>
        <p className="small-note">Experimental · English captions · Nemotron ASR int4 + diarization q8. Processing speed depends on the device. {speed !== null && <span id="cpu-speed">Processing: {speed.toFixed(2)}× real time (1× keeps pace).</span>}</p>
      </aside></div>
    </main>
  </div>;
}
