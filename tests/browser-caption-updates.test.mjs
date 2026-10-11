import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptionUpdates, applyCaptionPatch, processCaptionBatch } from '../src/browser/caption-updates.js';
const activity = (frames, speaker) => {
  const logits = new Float32Array(frames * 8).fill(-5);
  for (let f = 0; f < frames; f++) logits[f * 8 + speaker] = 5;
  return logits;
};

test('ASR publishes before pending diarization, including partial words and flush', async () => {
  for (const flush of [false, true]) {
    const events = []; let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const asr = { async pushAudio(samples, final, publish) { assert.equal(final, flush); events.push('asr'); publish(); return { chunks: 1 }; } };
    const work = processCaptionBatch(asr, new Float32Array(), flush, () => events.push('publish'), async () => { events.push('diar'); await gate; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['asr', 'publish', 'publish', 'diar']);
    finish(); await work;
    assert.equal(events.at(-1), 'publish');
  }
});
test('late speaker evidence patches the same word IDs without duplicating text', () => {
  const updates = new CaptionUpdates();
  const words = [{ text:'Hello', time:0.2 }, { text:'there.', time:0.5 }];
  let session = applyCaptionPatch({ segments:[] }, updates.update(words));
  assert.equal(session.segments[0].speaker, null);
  updates.addActivity(activity(100, 3), 100);
  session = applyCaptionPatch(session, updates.update(words));
  assert.deepEqual(session.segments.map(s => s.speaker), [1,1]);
  assert.deepEqual(session.segments.map(s => s.id), ['word-0','word-1']);
  assert.equal(updates.update(words), null);
  const stable = session.segments[0];
  words[1].text = 'there!';
  const patch = updates.update(words);
  assert.equal(patch.from, 1); assert.equal(patch.segments.length, 1);
  session = applyCaptionPatch(session, patch);
  assert.equal(session.segments[0], stable);
  assert.equal(session.segments.map(s => s.text).join(' '), 'Hello there!');
});
test('a boundary stays revisable until the full future context arrives', () => {
  const updates = new CaptionUpdates();
  const words = [{text:'first',time:0.1},{text:'change',time:0.98},{text:'later',time:1.2}];
  updates.addActivity(activity(96, 0),96);
  updates.update(words);
  assert.equal(updates.finalized,1);
  updates.addActivity(activity(45, 1),45);
  const patch = updates.update(words);
  assert.equal(patch.from,1);
  assert.deepEqual(updates.segments.map(s=>s.speaker),[1,2,2]);
  assert.equal(updates.finalized,2);
});
test('finalized history is not rescored or retransmitted during long conversations', () => {
  const updates = new CaptionUpdates(), words = [];
  for (let i=0;i<1000;i++) {
    updates.addActivity(activity(20,0),20);
    words.push({text:`word${i}`,time:i*0.2+0.05});
    const patch = updates.update(words);
    assert.equal(patch.from,i); assert.equal(patch.segments.length,1);
  }
  assert.equal(updates.finalized,999);
  assert.ok(updates.activity.length < 50);
  Object.defineProperty(words[0], 'time', {get(){throw Error('Rescored finalized word');}});
  assert.equal(updates.update(words),null);
});
test('resetting creates a fresh speaker mapping and transcript', () => {
  const updates = new CaptionUpdates();
  updates.addActivity(activity(50,7),50);
  assert.equal(updates.update([{text:'New',time:.1}]).segments[0].speaker,1);
  assert.throws(()=>applyCaptionPatch({segments:[]},{from:2,segments:[]}),/Invalid caption patch/);
});
