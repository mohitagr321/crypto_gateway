import { useEffect, useRef } from 'react';

/**
 * Scroll-reveal for the public marketing pages.
 *
 * Attach the returned ref to a container; every descendant carrying `.reveal`
 * gets `.is-visible` the first time it enters the viewport (see the .reveal
 * rules in index.css). One IntersectionObserver per container rather than one
 * per element, and each element is unobserved once shown — the animation is a
 * one-shot, so nothing keeps running as the user scrolls back up.
 *
 * Chosen over an animation library on purpose: the public bundle is the first
 * thing a prospective merchant downloads, and this is ~20 lines against ~30KB.
 *
 * Reduced motion is handled in CSS (the `.reveal` rules collapse to "visible,
 * no transition"), so this still runs and simply has no visible effect.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const targets = Array.from(root.querySelectorAll<HTMLElement>('.reveal'));
    if (targets.length === 0) return;

    // No IntersectionObserver (very old browser, or a test environment): show
    // everything rather than leaving the page blank.
    if (typeof IntersectionObserver === 'undefined') {
      targets.forEach((el) => el.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      // Trigger slightly before the element is fully on screen so the motion
      // reads as "already there" rather than "popped in late".
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return ref;
}

/**
 * Inline style for staggering siblings: `style={revealDelay(i)}`.
 * Capped so a long list never leaves the last item waiting noticeably.
 */
export function revealDelay(index: number, stepMs = 70): React.CSSProperties {
  return { transitionDelay: `${Math.min(index * stepMs, 420)}ms` };
}
