import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/policy/index.ts',
    'src/portal/index.ts',
    'src/evidence/index.ts',
    'src/reputation/index.ts',
    'src/tools/index.ts',
    'src/evals/index.ts',
  ],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
});
