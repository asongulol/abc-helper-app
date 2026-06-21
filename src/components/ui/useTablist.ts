'use client';

import { type KeyboardEvent, useId } from 'react';

/**
 * ARIA tablist wiring for the common "one rendered panel at a time" pattern: a
 * row of tab buttons over a single panel whose contents swap with the active
 * tab. Returns prop-getters that supply the roles, roving tabindex, and
 * Arrow/Home/End keyboard navigation a tablist needs.
 *
 * Because only the active panel is in the DOM, every tab's `aria-controls`
 * points at the one shared panel id and the panel is `aria-labelledby` the
 * active tab. Spread `panelProps()` onto whichever element renders for the
 * active tab.
 *
 *   const tabs = useTablist(KEYS, active, setActive);
 *   <div role="tablist" aria-label="…">
 *     {KEYS.map((k) => <button {...tabs.tabProps(k)}>…</button>)}
 *   </div>
 *   {active === 'x' && <section {...tabs.panelProps()}>…</section>}
 *
 * (Set role="tablist" inline — a spread role hides it from a11y lint.)
 */
export function useTablist<K extends string>(
  keys: readonly K[],
  active: K,
  onChange: (key: K) => void,
) {
  const base = useId();
  const tabId = (k: K) => `${base}-tab-${k}`;
  const panelId = `${base}-panel`;

  const onKeyDown = (e: KeyboardEvent) => {
    const i = keys.indexOf(active);
    if (i < 0) return;
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % keys.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (i - 1 + keys.length) % keys.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = keys.length - 1;
    else return;
    e.preventDefault();
    const nextKey = keys[next];
    if (nextKey === undefined) return;
    onChange(nextKey);
    // Roving tabindex: move focus to the now-selected tab once it re-renders.
    requestAnimationFrame(() => document.getElementById(tabId(nextKey))?.focus());
  };

  return {
    tabProps: (k: K) => ({
      role: 'tab' as const,
      id: tabId(k),
      'aria-selected': k === active,
      'aria-controls': panelId,
      tabIndex: k === active ? 0 : -1,
      onClick: () => onChange(k),
      onKeyDown,
    }),
    panelProps: () => ({
      role: 'tabpanel' as const,
      id: panelId,
      'aria-labelledby': tabId(active),
      tabIndex: 0,
    }),
  };
}
