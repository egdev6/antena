#!/usr/bin/env node
// Compila la app React (panel, prompter y dock) en app/dist con esbuild.
//   node scripts/build-app.mjs           → build de producción
//   node scripts/build-app.mjs --watch   → recompila al guardar (con `pnpm start` en otra terminal)
// El servidor sirve app/dist en /, /prompter y /dock; si no existe, sirve el panel clásico de public/.
import { build, context } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'app', 'src');
const DIST = path.join(ROOT, 'app', 'dist');
const watch = process.argv.includes('--watch');

const PAGES = {
  index: { entry: 'panel/main.tsx', title: 'antena', body: '' },
  prompter: { entry: 'prompter/main.tsx', title: 'antena · prompter', body: '' },
  dock: { entry: 'dock/main.tsx', title: 'antena · dock', body: '' },
};
const BUNDLE_NAME = { index: 'panel', prompter: 'prompter', dock: 'dock' };

const html = (name, js, css) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${PAGES[name].title}</title>
<link rel="icon" href="/brand/logo.png" type="image/png">
<meta name="viewport" content="width=device-width,initial-scale=1">
<!-- #62: CSP básica; recursos propios del mismo origen más lo imprescindible: los emotes de Twitch (static-cdn.jtvnw.net) y el IPC de Tauri 2 (ipc:/http://ipc.localhost) desde el panel/prompter/dock. Estilos en línea para el <style> del prompter. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://static-cdn.jtvnw.net; media-src 'self' blob:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost; object-src 'none'; base-uri 'self'; form-action 'self'">
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/ds/tokens.css">
${name === 'prompter' ? '<!-- el prompter mete los componentes del sistema en la capa ds: su CSS (capa egdev) los ajusta y el CSS propio del usuario, sin capa, gana a los dos -->\n<style>@import url("/ds/bundle.css") layer(ds);</style>\n' : '<link rel="stylesheet" href="/ds/bundle.css">\n'}${css ? `<link rel="stylesheet" href="/assets/${css}">\n` : ''}</head>
<body>
<div id="root"></div>
<script type="module" src="/assets/${js}"></script>
</body>
</html>
`;

const options = {
  entryPoints: Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [BUNDLE_NAME[k], path.join(SRC, p.entry)])),
  outdir: path.join(DIST, 'assets'),
  entryNames: watch ? '[name]' : '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  bundle: true, splitting: true, format: 'esm',
  minify: !watch, sourcemap: watch ? 'inline' : false,
  target: ['chrome110', 'edge110', 'safari16'],
  jsx: 'automatic', loader: { '.tsx': 'tsx', '.ts': 'ts' },
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
  // las fuentes y los tokens se sirven aparte desde public/: no se empaquetan
  external: ['/fonts/*', '/ds/*'],
  metafile: true, logLevel: 'info',
};

async function writeHtml(meta) {
  for (const name of Object.keys(PAGES)) {
    const out = Object.entries(meta.outputs).find(([, o]) => o.entryPoint && o.entryPoint.endsWith(PAGES[name].entry));
    if (!out) throw new Error('No se generó ' + name);
    const js = path.basename(out[0]);
    const css = out[1].cssBundle ? path.basename(out[1].cssBundle) : '';
    await writeFile(path.join(DIST, name + '.html'), html(name, js, css));
  }
}

await rm(DIST, { recursive: true, force: true });
await mkdir(path.join(DIST, 'assets'), { recursive: true });
if (watch) {
  const ctx = await context({ ...options, plugins: [{ name: 'html', setup(b) { b.onEnd(r => { if (r.metafile) writeHtml(r.metafile).catch(e => console.error(e)); }); } }] });
  await ctx.watch();
  console.log('Vigilando app/src… (Ctrl+C para salir)');
} else {
  const r = await build(options);
  await writeHtml(r.metafile);
  console.log('App compilada en app/dist');
}
