/** Small inline loading spinner. Prefer skeletons for whole-card loads. */
export const Spinner = ({
  size = 'sm',
  label = 'Loading',
}: {
  size?: 'sm' | 'lg';
  label?: string;
}) => (
  <span className={size === 'lg' ? 'spinner lg' : 'spinner'} role="status" aria-label={label} />
);
