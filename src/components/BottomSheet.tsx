import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}

/** Native-feeling bottom sheet: slides up, drag the grabber down to dismiss. */
export function BottomSheet({ open, onClose, label, children }: Props) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [dy, setDy] = useState(0);
  const drag = useRef<{ y: number; t: number } | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      const id = setTimeout(() => {
        setMounted(false);
        setClosing(false);
        setDy(0);
      }, 220);
      return () => clearTimeout(id);
    }
  }, [open, mounted]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [mounted, onClose]);

  if (!mounted) return null;

  const onDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, t: performance.now() };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    setDy(Math.max(0, e.clientY - drag.current.y));
  };
  const onUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const dist = e.clientY - drag.current.y;
    const v = dist / Math.max(1, performance.now() - drag.current.t);
    drag.current = null;
    if (dist > 120 || v > 0.6) onClose();
    else setDy(0);
  };

  return createPortal(
    <div className={`sheet-root ${closing ? 'closing' : ''}`}>
      <div className="sheet-scrim" onClick={onClose} style={{ opacity: dy ? Math.max(0, 1 - dy / 400) : undefined }} />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={dy ? { transform: `translateY(${dy}px)`, transition: 'none' } : undefined}
      >
        <div className="sheet-grab" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          <span />
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
