// One ordered reading surface. Refinement changes a turn's content, never its
// placement in a separate "final" panel. Sources are deliberately not layout keys.
export function conversationTurns(session, previous = []) {
  const pieces = [
    ...(session?.segments || []).map(segment => ({ speaker: segment.speaker || null, text: segment.text, draft: false, segmentId: segment.id })),
    ...(session?.partialRuns?.length ? session.partialRuns : session?.partial ? [{ speaker: null, text: session.partial }] : [])
      .map(run => ({ ...run, speaker: run.speaker || null, draft: true })),
  ];
  const turns = [];
  for (const piece of pieces) {
    if (!piece.text?.trim()) continue;
    let turn = turns.at(-1);
    // An unidentified fragment continues the current reading turn. Keep its
    // original attribution on the piece; this is a display assumption only.
    // Every snapshot is regrouped so a later identified change still splits.
    const speaker = piece.speaker == null ? turn?.speaker ?? null : String(piece.speaker);
    if (turn && turn.speaker === null && speaker !== null) turn.speaker = speaker;
    if (!turn || turn.speaker !== speaker) {
      turn = { speaker, pieces: [], text: '', draft: false };
      turns.push(turn);
    }
    const text = piece.text.trim();
    turn.pieces.push({ ...piece, text });
    turn.text += (turn.text && !/^[,.;:!?]/.test(text) ? ' ' : '') + text;
    turn.draft ||= piece.draft;
  }
  // Stable ordinal keys keep DOM nodes and reading anchors through partial ->
  // refined transitions. A real speaker-boundary correction can change layout;
  // the viewport preserves the reader's anchor, and Hold text freezes all edits.
  return turns.map((turn, index) => ({ ...turn, id: previous[index]?.id || `turn-${index}` }));
}

export const timeLabel = seconds => `${String(Math.floor((seconds || 0) / 60)).padStart(2, '0')}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;

export function readPreference(key, fallback) {
  try { const value = localStorage.getItem(`scribe.${key}`); return value == null ? fallback : JSON.parse(value); }
  catch { return fallback; }
}
export function savePreference(key, value) {
  try { localStorage.setItem(`scribe.${key}`, JSON.stringify(value)); } catch {}
}
