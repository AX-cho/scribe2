import { PCMResampler } from './audio.js';

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.resampler = new PCMResampler(sampleRate); this.buffer = []; this.enabled = true;
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.flush(); this.enabled = false; this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (!this.buffer.length) return;
    const pcm = Int16Array.from(this.buffer); this.buffer = [];
    this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
  }
  process(inputs) {
    if (!this.enabled) return true;
    const channel = inputs[0]?.[0]; if (!channel) return true;
    const pcm = this.resampler.push(channel);
    for (const sample of pcm) this.buffer.push(sample);
    if (this.buffer.length >= 1600) this.flush();
    return true;
  }
}
registerProcessor('pcm-capture', PCMCapture);
