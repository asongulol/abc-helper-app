import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration.
 *
 * Resolves the `@/` path alias (mirrors tsconfig.json `paths`) so unit tests can
 * import domain code the same way application code does. Tests live under `tests/`
 * and mirror the `src/` layout (see CLAUDE.md).
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws when imported outside an RSC bundle; make it a no-op so server modules
      // (e.g. the invoice PDF renderer) can be exercised under Vitest.
      'server-only': fileURLToPath(new URL('./tests/_shims/empty.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    globals: false,
  },
});
