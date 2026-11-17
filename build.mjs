import { build } from 'esbuild';

await build({
  entryPoints: ['app.js'],
  outfile: 'app.bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: false,
  minify: false,
  loader: {
    '.json': 'json',
  },
  logLevel: 'info',
});
