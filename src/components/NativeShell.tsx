import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { haptic } from '../lib/device';
import { Icon } from './Icon';

/**
 * Native-app touches for the shell:
 *  - useCollapsingTitle: the page's large title collapses into the top bar once it scrolls away (iOS large titles).
 *  - useTabNavigate: tab switches use the View Transitions API (cross-fade + slide) where the browser supports it.
 *  - PullToRefresh: drag down at the top of a page to reload, with a spring-back indicator (touch devices only).
 */

export function useCollapsingTitle(pathname: string): string | null {
  const [title, setTitle] = useState<string | null>(null);
  useEffect(() => {
    setTitle(null);
    let obs: IntersectionObserver | null = null;
    const t = setTimeout(() => {
      const h1 = document.querySelector<HTMLElement>('.content .x-hero h1, .content .page-head h1');
      if (!h1) return;
      const appbar = document.querySelector<HTMLElement>('.appbar');
      const top = appbar ? appbar.getBoundingClientRect().height : 56;
      obs = new IntersectionObserver(([e]) => setTitle(e.isIntersecting ? null : h1.dataset.title || h1.textContent?.trim() || null), {
        rootMargin: `-${Math.round(top)}px 0px 0px 0px`,
      });
      obs.observe(h1);
    }, 50);
    return () => {
      clearTimeout(t);
      obs?.disconnect();
    };
  }, [pathname]);
  return title;
}

type DocWithVT = Document & { startViewTransition?: (cb: () => void) => unknown };

export function useTabNavigate() {
  const navigate = useNavigate();
  return useCallback(
    (e: MouseEvent<HTMLAnchorElement>, to: string) => {
      const doc = document as DocWithVT;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let new-tab clicks through
      haptic(4);
      if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      e.preventDefault();
      doc.startViewTransition(() => flushSync(() => navigate(to)));
    },
    [navigate],
  );
}

const THRESHOLD = 72;

export function PullToRefresh({ onRefresh, children }: { onRefresh: () => Promise<void>; children: ReactNode }) {
  const [pull, setPull] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const start = useRef<number | null>(null);
  const armed = useRef(false);

  useEffect(() => {
    const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
    if (!touch) return;
    const onStart = (e: TouchEvent) => {
      if (refreshing || window.scrollY > 0 || document.querySelector('.sheet-root, .nd-root')) return;
      start.current = e.touches[0].clientY;
      armed.current = false;
    };
    const onMove = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0].clientY - start.current;
      if (dy <= 0 || window.scrollY > 0) {
        setPull(0);
        return;
      }
      const eased = Math.min(110, dy * 0.5);
      setPull(eased);
      if (eased >= THRESHOLD && !armed.current) {
        armed.current = true;
        haptic(8);
      }
    };
    const onEnd = async () => {
      if (start.current === null) return;
      start.current = null;
      if (armed.current) {
        setRefreshing(true);
        setPull(56);
        try {
          await onRefresh();
        } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else setPull(0);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
    };
  }, [onRefresh, refreshing]);

  return (
    <>
      <div className={`ptr ${refreshing ? 'spinning' : ''}`} style={{ transform: `translateY(${pull - 48}px)`, opacity: pull ? Math.min(1, pull / THRESHOLD) : 0 }} aria-hidden={!refreshing}>
        <span className="ptr-ico" style={{ transform: refreshing ? undefined : `rotate(${pull * 3}deg)` }}>
          <Icon name="down" size={18} strokeWidth={2.75} />
        </span>
        {refreshing && <span className="sr" role="status">Refreshing</span>}
      </div>
      <div className="ptr-content" style={pull ? { transform: `translateY(${pull * 0.4}px)`, transition: start.current === null ? undefined : 'none' } : undefined}>
        {children}
      </div>
    </>
  );
}
