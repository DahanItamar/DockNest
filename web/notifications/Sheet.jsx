import React, { useEffect, useRef } from 'react';
import './notifications.css';

// A small bottom sheet for narrow screens: closes on Escape and on a tap outside, focus moves in and goes back.
export function Sheet({ title, onClose, children }) {
  const box = useRef(null);
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.querySelector('button,[tabindex]')?.focus();
    const key = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus?.(); };
  }, []);
  return <div className="nc-sheet-wrap" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="nc-sheet" role="dialog" aria-modal="true" aria-label={title} ref={box}>
      <h2>{title}</h2>
      {children}
    </section>
  </div>;
}

// One choice per row, with a check on the chosen one. Plain rows, no boxes.
export function Choices({ label, value, options, onChange }) {
  return <div role="radiogroup" aria-label={label} className="nc-choices">
    {options.map(([id, text, extra]) => <button key={id} type="button" role="radio" aria-checked={value === id} className="nc-choice" onClick={() => onChange(id)}>
      <span>{text}</span>{extra ? <span className="nc-muted">{extra}</span> : null}{value === id ? <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg> : <i />}
    </button>)}
  </div>;
}
