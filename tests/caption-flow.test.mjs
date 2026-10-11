import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationTurns } from '../src/lib/caption-flow.js';

test('live captions refine within the same ordered turn, without a second text area', () => {
  const live = conversationTurns({ partialRuns: [{ speaker: '1', text: 'We can meet tomorow' }] });
  const refined = conversationTurns({ segments: [{ id: 'new-model-id', speaker: '1', text: 'We can meet tomorrow.' }], partialRuns: [{ speaker: '1', text: ' After lunch' }] }, live);
  assert.equal(refined.length, 1);
  assert.equal(refined[0].id, live[0].id);
  assert.equal(refined[0].text, 'We can meet tomorrow. After lunch');
  assert.equal(refined[0].pieces[0].draft, false);
  assert.equal(refined[0].pieces[1].draft, true);
});
test('speaker changes remain explicit and continuation is not repeated', () => {
  const turns = conversationTurns({ segments: [{ speaker: '1', text: 'Ready?' }], partialRuns: [{ speaker: '2', text: 'Yes.' }, { speaker: '2', text: ' Let’s go.' }] });
  assert.deepEqual(turns.map(t => t.speaker), ['1', '2']);
  assert.equal(turns[1].text, 'Yes. Let’s go.');
});

test('unidentified fragments continue the existing speaker paragraph, including refined text', () => {
  const session = {
    segments: [{ id: 'a', speaker: '1', text: 'The original paragraph.' }, { id: 'b', speaker: null, text: 'Two words' }],
    partialRuns: [{ speaker: '1', text: 'and the rest.' }],
  };
  const before = JSON.stringify(session);
  const turns = conversationTurns(session);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speaker, '1');
  assert.equal(turns[0].text, 'The original paragraph. Two words and the rest.');
  assert.equal(turns[0].pieces[1].speaker, null);
  assert.equal(JSON.stringify(session), before); // Display grouping never rewrites attribution.
});
test('later speaker evidence splits a provisional continuation into a new turn', () => {
  const segments = [{ id: 'a', speaker: '1', text: 'Are you ready?' }];
  const initial = conversationTurns({ segments, partialRuns: [{ speaker: null, text: 'Yes I am.' }] });
  assert.equal(initial.length, 1);
  const revised = conversationTurns({ segments, partialRuns: [{ speaker: '2', text: 'Yes I am.' }] }, initial);
  assert.equal(revised.length, 2);
  assert.equal(revised[0].id, initial[0].id);
  assert.equal(revised[0].text, 'Are you ready?');
  assert.equal(revised[1].speaker, '2');
  assert.equal(revised[1].text, 'Yes I am.');
});
test('initial unidentified words join the first identified speaker without a separate paragraph', () => {
  const initial = conversationTurns({ partial: 'So you' });
  const identified = conversationTurns({ partialRuns: [{ speaker: null, text: 'So you' }, { speaker: 1, text: 'were ready.' }] }, initial);
  assert.equal(identified.length, 1);
  assert.equal(identified[0].speaker, '1');
  assert.equal(identified[0].id, initial[0].id);
  assert.equal(identified[0].text, 'So you were ready.');
});
