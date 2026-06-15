import Image from 'next/image';

/** Intrinsic aspect ratio (width / height) of the cropped lockup `logo.png`. */
const RATIO = 1024 / 760;

interface LogoProps {
  /** Rendered height in px (width derived from the logo's aspect ratio). */
  height?: number;
  className?: string;
  priority?: boolean;
}

/**
 * The real Aaron Anderson E.H.S. LLC brand lockup (AAA monogram + wordmark).
 * The artwork has a white background, so on dark surfaces (e.g. the navy admin
 * topbar) wrap it in a light chip.
 */
export const Logo = ({ height = 34, className, priority = false }: LogoProps) => (
  <Image
    src="/brand/logo.png"
    alt="Aaron Anderson E.H.S. LLC"
    width={Math.round(height * RATIO)}
    height={height}
    className={className}
    priority={priority}
  />
);
