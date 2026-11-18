// Rename past streams: PUT /api/sessions/:id renames the live stream or an archived one,
// keeping the archive and its .meta.json cache in sync. Synthetic loopback data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/server.mjs';

const MCP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp.mjs');

const ARCHIVED = '2026-01-02T03-04-05-006Z';
const at = ms => new Date(ms).toISOString();

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'antena-session-rename-'));
  const dataDir = path.join(root, 'data');
  const sessions = path.join(dataDir, 'sessions');
  await mkdir(sessions, { recursive: true });
  const archived = { id: ARCHIVED, title: 'Old title', startedAt: at(1_700_000_000_000), endedAt: at(1_700_000_600_000),
    events: [{ id: 'e1', type: 'follow', at: at(1_700_000_001_000), vars: { user: 'ana' }, text: 'ana' }], notes: [], goalOffsets: {}, extra: 'keep' };
  await writeFile(path.join(sessions, ARCHIVED + '.json'), JSON.stringify(archived));
  await writeFile(path.join(sessions, ARCHIVED + '.meta.json'), JSON.stringify({ id: ARCHIVED, title: 'Old title', startedAt: archived.startedAt, endedAt: archived.endedAt, events: 1 }));
  await writeFile(path.join(dataDir, 'session-current.json'), JSON.stringify({ id: 'live-1', title: 'Live', startedAt: at(Date.now() - 60000), events: [], notes: [], goalOffsets: {} }));
  const app = await createApp({ dataDir, mediaDir: path.join(root, 'media'), log: () => {} });
  t.after(async () => {
    app.viewers.halt(); await app.youtube.quiescePoll().catch(() => {}); await app.chat.quiesceChat().catch(() => {});
    await app.drainAutoSession().catch(() => {}); await app.drainChatMetrics().catch(() => {});
    await app.session.flush().catch(() => {}); await app.closeHttp().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const readArchive = async () => JSON.parse(await readFile(path.join(sessions, ARCHIVED + '.json'), 'utf8'));
  const readMeta = async () => JSON.parse(await readFile(path.join(sessions, ARCHIVED + '.meta.json'), 'utf8'));
  return { app, base, dataDir, sessions, request, readArchive, readMeta, archived };
}

test('S1/S2: renaming an archived stream updates the archive, its meta cache, the list and the summary', async t => {
  const f = await fixture(t);
  const r = await f.request('PUT', `/api/sessions/${ARCHIVED}`, { title: 'New title' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, id: ARCHIVED, title: 'New title' });
  const archive = await f.readArchive();
  assert.deepEqual(archive, { ...f.archived, title: 'New title' });   // only the title changes
  assert.equal((await f.readMeta()).title, 'New title');
  const list = await f.request('GET', '/api/sessions');
  assert.equal(list.body.past.find(s => s.id === ARCHIVED).title, 'New title');
  assert.equal(list.body.current.title, 'Live');   // the live stream is untouched
  const summary = await f.request('GET', `/api/session/summary?format=json&id=${ARCHIVED}`);
  assert.equal(summary.body.title, 'New title');
});

test('S2: PUT /api/sessions/:id with the live id renames the live stream like PUT /api/session', async t => {
  const f = await fixture(t);
  const r = await f.request('PUT', '/api/sessions/live-1', { title: 'Renamed live' });
  assert.equal(r.status, 200);
  assert.equal(f.app.session.data.title, 'Renamed live');
  assert.equal((await f.readArchive()).title, 'Old title');
});

test('S2: a missing title stores an empty string, as PUT /api/session does', async t => {
  const f = await fixture(t);
  const r = await f.request('PUT', `/api/sessions/${ARCHIVED}`, {});
  assert.equal(r.status, 200);
  assert.equal((await f.readArchive()).title, '');
  assert.equal((await f.readMeta()).title, '');
});

test('S2: unknown and unsafe ids are rejected and leave stored files unchanged', async t => {
  const f = await fixture(t);
  const before = await readdir(f.sessions);
  const archiveBefore = await f.readArchive(), metaBefore = await f.readMeta();
  const unknown = await f.request('PUT', '/api/sessions/2020-01-01T00-00-00-000Z', { title: 'x' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /No existe ese directo/);
  const unsafe = await f.request('PUT', '/api/sessions/bad.id', { title: 'x' });
  assert.equal(unsafe.status, 400);
  assert.deepEqual(await readdir(f.sessions), before);
  assert.deepEqual(await f.readArchive(), archiveBefore);
  assert.deepEqual(await f.readMeta(), metaBefore);
});

test('S2: a stream still being archived cannot be renamed yet', async t => {
  const f = await fixture(t);
  f.app.session.pendingArchive = { data: { id: 'pending-1', title: 'p' } };
  const r = await f.request('PUT', '/api/sessions/pending-1', { title: 'x' });
  f.app.session.pendingArchive = null;
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'Ese directo aún se está archivando; vuelve a intentarlo en unos segundos.');
});

test('regression: PUT /api/session still renames the live stream', async t => {
  const f = await fixture(t);
  const r = await f.request('PUT', '/api/session', { title: 'Via old route' });
  assert.equal(r.status, 200);
  assert.equal(f.app.session.data.title, 'Via old route');
});

/** Minimal stdio JSON-RPC client for the real MCP server. */
function mcp(t, url) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ANTENA_URL: url, ANTENA_NO_EMBED: '1' } });
  t.after(() => { child.stdin.end(); child.kill(); });
  let buf = '', id = 0; const waiters = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiters.get(m.id)?.(m); } });
  const rpc = (method, params) => new Promise(r => { const n = ++id; waiters.set(n, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  return { rpc, call: async (name, args) => (await rpc('tools/call', { name, arguments: args })).result };
}

test('S4: MCP renombrar_directo renames an archived stream by id and still renames the current one without id', async t => {
  const f = await fixture(t);
  const c = mcp(t, f.base);
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  const tool = (await c.rpc('tools/list')).result.tools.find(x => x.name === 'renombrar_directo');
  assert.ok(tool.inputSchema.properties.id, 'renombrar_directo exposes an optional id');
  assert.deepEqual(tool.inputSchema.required, ['titulo']);
  const archived = await c.call('renombrar_directo', { titulo: 'Via MCP', id: ARCHIVED });
  assert.ok(!archived.isError, archived.content?.[0]?.text);
  assert.equal((await f.readArchive()).title, 'Via MCP');
  assert.equal((await f.readMeta()).title, 'Via MCP');
  const current = await c.call('renombrar_directo', { titulo: 'Current via MCP' });
  assert.ok(!current.isError, current.content?.[0]?.text);
  assert.equal(f.app.session.data.title, 'Current via MCP');
  assert.equal((await f.readArchive()).title, 'Via MCP');
});

test('S1: when the meta cache cannot be written, it is removed so the list falls back to the renamed archive', async t => {
  const { Session } = await import('../src/session.mjs');
  const { writeJson } = await import('../src/json-file.mjs');
  const root = await mkdtemp(path.join(tmpdir(), 'antena-session-rename-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, 'sessions');
  await mkdir(sessions);
  const data = { id: ARCHIVED, title: 'Old title', startedAt: at(1_700_000_000_000), endedAt: at(1_700_000_600_000), events: [], notes: [], goalOffsets: {} };
  await writeFile(path.join(sessions, ARCHIVED + '.json'), JSON.stringify(data));
  await writeFile(path.join(sessions, ARCHIVED + '.meta.json'), JSON.stringify({ id: ARCHIVED, title: 'Old title', events: 0 }));
  const writer = (file, value, opts) => file.endsWith('.meta.json') ? Promise.reject(new Error('meta fail')) : writeJson(file, value, opts);
  const s = new Session(root, { writer });
  assert.deepEqual(await s.rename(ARCHIVED, 'New title'), { id: ARCHIVED, title: 'New title' });
  assert.equal(JSON.parse(await readFile(path.join(sessions, ARCHIVED + '.json'), 'utf8')).title, 'New title');
  assert.deepEqual(await readdir(sessions), [ARCHIVED + '.json']);
  assert.equal((await s.list()).find(x => x.id === ARCHIVED).title, 'New title');
});
