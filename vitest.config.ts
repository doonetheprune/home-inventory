import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@larder/core': r('./src/core/index.ts'),
      '@larder/web-sdk': r('./src/web/src/sdk/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'modules/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { execArgv: ['--disable-warning=ExperimentalWarning'] } },
  },
});
