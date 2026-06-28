'use client';

import { useEffect, useState } from 'react';

/**
 * Floating "↑ Top" shortcut for long scroll pages. Appears once the page is
 * scrolled past a threshold and smooth-scrolls back to the top on click.
 *
 * Uses a passive scroll listener with an rAF guard, and only flips React state
 * when the visibility actually changes (no per-frame re-renders).
 */
export const BackToTop = ({ threshold = 480 }: { threshold?: number }) => {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const next = window.scrollY > threshold;
        setShow((cur) => (cur === next ? cur : next));
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll(); // set initial state (e.g. on a refresh mid-page)
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [threshold]);

  if (!show) return null;
  return (
    <button
      type="button"
      className="btn back-to-top no-print"
      aria-label="Back to top"
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
    >
      ↑ Top
    </button>
  );
};
