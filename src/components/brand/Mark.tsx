import Image from 'next/image';

/** Aspect ratio of the light AAA mark `mark-light.png`. */
const RATIO = 280 / 160;

interface MarkProps {
  /** Rendered height in px (width derived from the mark's aspect ratio). */
  height?: number;
  className?: string;
  priority?: boolean;
}

/**
 * The AAA monogram with the two outer A's in WHITE (center A + arc in gold) —
 * the brand mark for DARK surfaces (navy admin topbar / portal header). Ported
 * from the legacy app's header asset. The full navy/gold lockup is `Logo`, used
 * on light surfaces (login cards).
 */
export const Mark = ({ height = 38, className, priority = false }: MarkProps) => (
  <Image
    src="/brand/mark-light.png"
    alt="Aaron Anderson E.H.S. LLC"
    width={Math.round(height * RATIO)}
    height={height}
    className={className}
    priority={priority}
  />
);
