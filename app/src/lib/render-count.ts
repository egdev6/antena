// Test-only render counter (#360). `__RENDER_COUNT__` is a build-time constant (scripts/build-app.mjs):
// false in every normal build, so esbuild drops this body and every call and the production bundle
// carries none of it; true only in the instrumented build that `pnpm perf` serves to its pages.
// A build that does not define it at all (some tests bundle app/src with their own esbuild call) must
// still run, hence the typeof check: there the counter is simply off.
declare const __RENDER_COUNT__: boolean | undefined;

/** Counts one render of `name` ("surface/Component") in `globalThis.__antenaRenderCounts`. */
export function countRender(name: string): void {
  if (typeof __RENDER_COUNT__ === 'undefined' || !__RENDER_COUNT__) return;
  const counts = ((globalThis as { __antenaRenderCounts?: Record<string, number> }).__antenaRenderCounts ??= {});
  counts[name] = (counts[name] ?? 0) + 1;
}
