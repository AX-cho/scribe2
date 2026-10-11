// Only words whose +/-80 ms speaker window is incomplete may change attribution.
// The last word stays mutable because the ASR tokenizer can append another piece.
export class CaptionUpdates {
  constructor() {
    this.activity = [];
    this.activityBase = 0;
    this.frameEnd = 0;
    this.finalized = 0;
    this.previousSpeaker = null;
    this.speakerIds = new Map();
    this.segments = [];
    this.speakerDetectionEnded = false;
  }
  addActivity(logits, frames) {
    for (let f = 0; f < frames; f++) {
      const probs = new Array(8);
      for (let s = 0; s < 8; s++) probs[s] = 1 / (1 + Math.exp(-logits[f * 8 + s]));
      this.activity.push(probs);
    }
    this.frameEnd += frames;
  }
  update(words) {
    let previous = this.previousSpeaker, changed = Infinity;
    for (let i = this.finalized; i < words.length; i++) {
      const word = words[i], frame = Math.round(word.time * 100), scores = new Float32Array(8);
      let count = 0;
      for (let f = Math.max(this.activityBase, frame - 8); f <= Math.min(this.frameEnd - 1, frame + 8); f++) {
        const probabilities = this.activity[f - this.activityBase];
        for (let s = 0; s < 8; s++) scores[s] += probabilities[s];
        count++;
      }
      let best = 0, speaker = null;
      for (let s = 1; s < 8; s++) if (scores[s] > scores[best]) best = s;
      if (count && scores[best] / count > 0.5) {
        if (previous !== null && scores[previous] / count > 0.5 && scores[best] - scores[previous] < 0.12 * count) best = previous;
        previous = best;
        if (!this.speakerIds.has(best)) this.speakerIds.set(best, this.speakerIds.size + 1);
        speaker = this.speakerIds.get(best);
      }
      const old = this.segments[i];
      if (!old || old.text !== word.text || old.speaker !== speaker) {
        this.segments[i] = { id: `word-${i}`, text: word.text, speaker };
        changed = Math.min(changed, i);
      }
      // Finalize a contiguous prefix only. Speaker probabilities already emitted
      // by the streaming model are immutable, so this keeps the same decisions.
      if (i === this.finalized && i < words.length - 1 && (frame + 8 < this.frameEnd || this.speakerDetectionEnded)) {
        this.finalized = i + 1;
        this.previousSpeaker = previous;
      }
    }
    // Drop speaker history that no future word will consult (never store audio).
    const pendingWord = words[this.finalized];
    if (pendingWord) {
      const keepFrom = Math.max(0, Math.round(pendingWord.time * 100) - 8);
      const remove = Math.min(this.activity.length, Math.max(0, keepFrom - this.activityBase));
      if (remove) { this.activity = this.activity.slice(remove); this.activityBase += remove; }
    }
    return Number.isFinite(changed) ? { from: changed, segments: this.segments.slice(changed) } : null;
  }
}

export function applyCaptionPatch(session, patch) {
  if (!Number.isInteger(patch.from) || patch.from < 0 || patch.from > session.segments.length) throw Error('Invalid caption patch');
  return { ...session, segments: [...session.segments.slice(0, patch.from), ...patch.segments] };
}

// Keep ASR publication before speaker inference, including during stop/flush.
export async function processCaptionBatch(asr, samples, flush, publish, diarize) {
  const progress = await asr.pushAudio(samples, flush, publish);
  if (progress.chunks) publish();
  await diarize(flush);
  publish();
}
