import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Captions, Pause } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { conversationTurns } from '@/lib/caption-flow';

export function Conversation({ session, live, holding, heldSession, textSize, announce, onReturn, onEdit, onRename }) {
  const view = holding ? heldSession : session;
  const prior = useRef([]);
  const turns = useMemo(() => { prior.current = conversationTurns(view, prior.current); return prior.current; }, [view]);
  const scroller = useRef(null), anchor = useRef(null), programmatic = useRef(false);
  const [following, setFollowing] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  const announced = useRef('');
  const sessionId = view?.id;
  useEffect(() => { setFollowing(true); anchor.current = null; announced.current = ''; }, [sessionId]);
  function rememberAnchor() {
    const container = scroller.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    const row = [...container.querySelectorAll('[data-turn]')].find(element => element.getBoundingClientRect().bottom > top);
    anchor.current = row ? { id: row.dataset.turn, y: row.getBoundingClientRect().top } : null;
  }
  useLayoutEffect(() => {
    const container = scroller.current; if (!container) return;
    programmatic.current = true;
    if (following && !holding) container.scrollTop = container.scrollHeight;
    else if (anchor.current) {
      const row = container.querySelector(`[data-turn="${anchor.current.id}"]`);
      if (row) container.scrollTop += row.getBoundingClientRect().top - anchor.current.y;
    }
    rememberAnchor();
    const frame = requestAnimationFrame(() => { programmatic.current = false; });
    return () => cancelAnimationFrame(frame);
  }, [turns, following, holding, textSize]);
  const announcementText = (view?.segments || []).map(s => `${view.speakers?.[s.speaker] || (s.speaker ? `Speaker ${s.speaker}` : 'Speaker not identified')}: ${s.text}`).join(' ');
  useEffect(() => {
    if (!announce || holding) return;
    const text = announcementText;
    const timer = setTimeout(() => {
      if (text === announced.current) return;
      const addition = text.startsWith(announced.current) ? text.slice(announced.current.length).trim() : text.split(/\s+/).slice(announced.current.split(/\s+/).length).join(' ');
      announced.current = text; if (addition) setAnnouncement(addition);
    }, 1500);
    return () => clearTimeout(timer);
  }, [announcementText, announce, holding]);
  const returnToLive = () => { setFollowing(true); onReturn(); };
  const scroll = () => {
    if (programmatic.current) return;
    const node = scroller.current;
    setFollowing(node.scrollHeight - node.scrollTop - node.clientHeight < 48);
    rememberAnchor();
  };
  return <div className="conversation-surface">
    <div id="transcript" className={`caption-scroll caption-size-${textSize}`} ref={scroller} tabIndex={0} role="region" aria-label="Conversation transcript" aria-describedby="reading-help" aria-live="off" onScroll={scroll} onWheel={event => { if (event.deltaY < 0) setFollowing(false); }} onKeyDown={event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) setFollowing(false); }}>
      <p id="reading-help" className="sr-only">Captions appear in conversation order and are corrected in place. Scroll to review. Hold text pauses visual updates without stopping the microphone.</p>
      {!turns.length ? <div className="caption-empty"><span className="empty-caption-icon" aria-hidden="true"><Captions size={36}/></span><h2>{live ? 'Listening. Your words will appear here.' : 'A clear place for the conversation.'}</h2><p>{live ? 'Speak naturally. Speaker labels will appear as voices are recognised.' : 'Choose your microphone, then start captions. Words appear here and improve in place.'}</p><div className="reading-example" aria-hidden="true"><span className="example-line"/><span className="example-line short"/></div></div> : <p className="caption-flow segment-text">
        {turns.map((turn, index) => {
          const name = view.speakers?.[turn.speaker] || (turn.speaker ? `Speaker ${turn.speaker}` : 'Speaker ?');
          return <span key={turn.id} data-turn={turn.id} className={`inline-turn voice-${Number(turn.speaker || 0) % 5}`}>
            {index > 0 && ' '}<strong className="inline-speaker">[{name}]</strong>{' '}
            {turn.pieces.map((piece, pieceIndex) => <span key={pieceIndex} className={piece.draft ? 'caption-draft' : undefined}>{pieceIndex > 0 && !/^[,.;:!?]/.test(piece.text) ? ' ' : ''}{piece.text.replace(/\s+/gu, ' ')}</span>)}
          </span>;
        })}
      </p>}

    </div>
    {(holding || !following) && <div className="return-bar"><span>{holding ? <><Pause size={16}/> Text held · listening {live ? 'continues' : 'stopped'}</> : 'You’re reviewing earlier captions'}</span><Button onClick={returnToLive} className="return-live"><ArrowDown size={16}/>{live ? 'Return to live' : 'Show latest text'}</Button></div>}
    <div className="sr-only" role="log" aria-live={announce ? 'polite' : 'off'} aria-relevant="text" aria-atomic="true">{announcement}</div>
  </div>;
}
