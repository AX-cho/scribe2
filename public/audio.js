// A continuous linear resampler keeps its fractional position between input chunks.
// The worklet adds a low-pass filter before downsampling higher microphone rates.
export class PCMResampler {
  constructor(inputRate, outputRate = 16000) {
    this.ratio = inputRate / outputRate;
    this.position = 0;
    this.pending = new Float32Array();
  }
  push(input) {
    const joined = new Float32Array(this.pending.length + input.length);
    joined.set(this.pending); joined.set(input, this.pending.length);
    const samples = [];
    while (this.position + 1 < joined.length) {
      const index = Math.floor(this.position), fraction = this.position - index;
      const value = joined[index] * (1 - fraction) + joined[index + 1] * fraction;
      samples.push(Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767)));
      this.position += this.ratio;
    }
    const consumed = Math.min(Math.floor(this.position), joined.length);
    this.pending = joined.slice(consumed);
    this.position -= consumed;
    return Int16Array.from(samples);
  }
}
