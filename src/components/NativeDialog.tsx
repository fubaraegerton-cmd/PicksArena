import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { haptic } from '../lib/device';

/**
 * Native-style replacements for window.confirm / window.prompt: an action sheet that slides up
 * from the bottom on phones and a centred dialog on larger screens. Promise-based:
 *   if (await askConfirm({ title, message, confirmLabel, destructive: true })) …
 *   const v = await askPrompt({ title, label, defaultValue, inputMode: 'decimal' }); // null = cancelled
 */

interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}
interface PromptOpts extends ConfirmOpts {
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  inputMode?: 'text' | 'decimal' | 'numeric';
  required?: boolean;
}
type Pending = { kind: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void } | { kind: 'prompt'; opts: PromptOpts; resolve: (v: string | null) => void };

let show: ((p: Pending) => void) | null = null;

export function askConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => (show ? show({ kind: 'confirm', opts, resolve }) : resolve(window.confirm(opts.message ?? opts.title))));
}

export function askPrompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => (show ? show({ kind: 'prompt', opts, resolve }) : resolve(window.prompt(opts.message ?? opts.title, opts.defaultValue))));
}

export function DialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState('');
  const [closing, setClosing] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    show = (p) => {
      setValue(p.kind === 'prompt' ? p.opts.defaultValue ?? '' : '');
      setClosing(false);
      setPending(p);
      haptic(6);
    };
    return () => {
      show = null;
    };
  }, []);

  useEffect(() => {
    if (pending?.kind === 'prompt') setTimeout(() => input.current?.focus(), 60);
  }, [pending]);

  if (!pending) return null;

  const finish = (ok: boolean) => {
    const p = pending;
    setClosing(true);
    setTimeout(() => {
      setPending(null);
      if (p.kind === 'confirm') p.resolve(ok);
      else p.resolve(ok ? value : null);
    }, 180);
    if (ok && p.opts.destructive) haptic([10, 40, 10]);
  };
  const o = pending.opts;
  const canSubmit = pending.kind === 'confirm' || !(pending.opts as PromptOpts).required || value.trim() !== '';

  return createPortal(
    <div className={`nd-root ${closing ? 'closing' : ''}`} onKeyDown={(e) => e.key === 'Escape' && finish(false)}>
      <div className="nd-scrim" onClick={() => finish(false)} />
      <form
        className="nd-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="nd-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) finish(true);
        }}
      >
        <div className="nd-grab" aria-hidden>
          <span />
        </div>
        <h2 id="nd-title" className="nd-title">
          {o.title}
        </h2>
        {o.message && <p className="nd-message">{o.message}</p>}
        {pending.kind === 'prompt' && (
          <label className="field nd-field">
            {(o as PromptOpts).label && <span>{(o as PromptOpts).label}</span>}
            <input
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode={(o as PromptOpts).inputMode ?? 'text'}
              placeholder={(o as PromptOpts).placeholder}
              aria-label={(o as PromptOpts).label ?? o.title}
            />
          </label>
        )}
        <div className="nd-actions">
          <button type="submit" className={`nd-btn primary ${o.destructive ? 'destructive' : ''}`} disabled={!canSubmit} autoFocus={pending.kind === 'confirm'}>
            {o.confirmLabel ?? 'OK'}
          </button>
          <button type="button" className="nd-btn" onClick={() => finish(false)}>
            {o.cancelLabel ?? 'Cancel'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
