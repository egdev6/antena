// TEMPORARY diagnostic for #282 (do not merge): times each phase of opening and closing Chrome on
// the CI runner and records every profile-removal attempt, to find where close-chrome hangs.
import { test } from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { closeChrome, findChrome, openChromePage } from './helpers/react-browser.mjs';
import { evaluateChrome } from './helpers/chrome-dom.mjs';

test('diag #282: phase timings of open/evaluate/close/profile removal', { timeout: 180000 }, async t => {
  const bin = await findChrome();
  if (!bin) return t.skip('Chrome is not available');
  t.diagnostic(`platform=${process.platform} node=${process.version} bin=${bin}`);
  const realRm = fs.rm;
  const rmCalls = [];
  fs.rm = async (p, opts) => {
    const start = Date.now();
    try { const r = await realRm(p, opts); rmCalls.push({ ms: Date.now() - start, ok: true }); return r; }
    catch (e) { rmCalls.push({ ms: Date.now() - start, ok: false, code: e.code }); throw e; }
  };
  syncBuiltinESMExports();
  t.after(() => { fs.rm = realRm; syncBuiltinESMExports(); });
  for (let i = 1; i <= 3; i++) {
    rmCalls.length = 0;
    const t0 = Date.now();
    const chrome = await openChromePage(bin, 'about:blank');
    const tOpen = Date.now();
    await evaluateChrome(chrome.cdp, '1 + 1');
    const tEval = Date.now();
    let closeError = null;
    try { await closeChrome(chrome); } catch (e) { closeError = String(e.message).slice(0, 300); }
    const tClose = Date.now();
    let profileLeft = true;
    try { await fs.stat(chrome.profile); } catch { profileLeft = false; }
    let leftover = [];
    if (profileLeft) {
      try { leftover = (await fs.readdir(chrome.profile, { recursive: true })).slice(0, 15); } catch (e) { leftover = ['readdir:' + e.code]; }
    }
    t.diagnostic(`run ${i}: open=${tOpen - t0}ms eval=${tEval - tOpen}ms close=${tClose - tEval}ms exit=${chrome.child.exitCode}/${chrome.child.signalCode} closeError=${closeError} profileLeft=${profileLeft} rm=${JSON.stringify(rmCalls)} leftover=${JSON.stringify(leftover)}`);
  }
});
