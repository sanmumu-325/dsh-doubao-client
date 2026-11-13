import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopStartup } from './startup.js';
const exe = 'C:\\Apps\\Doubao.exe';
function fixture(options = {}) {
  let launches = 0, owned = false, running = false;
  const windows = { discover: async () => ({ running, candidates: [{ path: exe, source: 'test' }] }), validate: async p => ({ valid: p === exe }), inspectPort: async () => owned ? { state: 'owned', path: exe } : { state: 'free' }, launch: async () => { launches++; owned = true; } };
  const controller = createDesktopStartup({ platform: 'win32', windows, discoverTarget: async () => ({ id: 'chat-1', url: 'doubao://doubao-chat/chat/', webSocketDebuggerUrl: 'ws://127.0.0.1:19226/devtools/page/chat-1' }), startTimeoutMs: 80, pollIntervalMs: 2, ...options });
  return { controller, windows, get launches() { return launches; }, set owned(v) { owned = v; }, set running(v) { running = v; } };
}
test('construction, diagnostics, configure and unconsented ensure do not launch; exact diagnostic shape', async () => {
  const f = fixture();
  const status = await f.controller.diagnostics();
  assert.deepEqual(Object.keys(status).sort(), ['supported', 'state', 'code', 'message', 'executablePath', 'candidates', 'consentGranted', 'autoStart', 'endpoint', 'checkedAt'].sort());
  assert.equal(status.endpoint, 'http://127.0.0.1:19226');
  assert.equal(status.state, 'not-running');
  assert.equal(status.consentGranted, false);
  await f.controller.configure({ autoStart: true });
  assert.equal((await f.controller.ensure()).code, 'CONSENT_REQUIRED');
  assert.equal(f.launches, 0);
});
test('manual consent starts once under concurrency and ensure reuses ready endpoint without consent', async () => {
  const f = fixture();
  const first = f.controller.start({ consent: 'LOCAL_DEBUGGING' });
  assert.equal(first, f.controller.start());
  assert.equal((await first).state, 'ready');
  assert.equal(f.launches, 1);
  await f.controller.configure({ consent: 'REVOKE' });
  assert.equal((await f.controller.ensure()).state, 'ready');
  assert.equal(f.launches, 1);
});
test('automatic startup requires both permissions; settings survive controller recreation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-startup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = fixture({ directory });
  await first.controller.configure({ executablePath: exe, consent: 'LOCAL_DEBUGGING' });
  assert.equal((await first.controller.ensure()).code, 'CONSENT_REQUIRED');
  await first.controller.configure({ autoStart: true });
  const second = fixture({ directory });
  assert.equal((await second.controller.ensure()).state, 'ready');
  assert.equal(second.launches, 1);
  const data = JSON.parse(await fs.readFile(path.join(directory, 'startup.json')));
  assert.deepEqual(Object.keys(data).sort(), ['autoStart', 'consent', 'executablePath']);
  await second.controller.configure({ consent: 'REVOKE' });
  const third = fixture({ directory });
  assert.equal((await third.controller.diagnostics()).consentGranted, false);
  assert.equal((await third.controller.diagnostics()).autoStart, false);
});
test('conflict, running-no-channel, changed signature, invalid endpoint never spawn', async () => {
  const conflict = fixture(); conflict.windows.inspectPort = async () => ({ state: 'conflict' });
  assert.equal((await conflict.controller.start({ consent: 'LOCAL_DEBUGGING' })).state, 'port-conflict');
  assert.equal(conflict.launches, 0);
  const running = fixture(); running.running = true;
  assert.equal((await running.controller.start({ consent: 'LOCAL_DEBUGGING' })).state, 'running-no-channel');
  assert.equal(running.launches, 0);
  const unsigned = fixture(); unsigned.windows.validate = async () => ({ valid: false, code: 'UNTRUSTED_SIGNATURE' });
  assert.equal((await unsigned.controller.start({ consent: 'LOCAL_DEBUGGING', executablePath: exe })).state, 'invalid-path');
  assert.equal(unsigned.launches, 0);
  const remote = fixture({ endpoint: 'http://example.com:9222' });
  assert.equal((await remote.controller.start({ consent: 'LOCAL_DEBUGGING' })).state, 'unknown');
  assert.equal(remote.launches, 0);
});
test('cancellation and dispose stop observing without terminating launched client; timeout is bounded', async () => {
  const cancelled = fixture(); const abort = new AbortController(); abort.abort();
  assert.equal((await cancelled.controller.start({ consent: 'LOCAL_DEBUGGING', signal: abort.signal })).code, 'CANCELLED');
  assert.equal(cancelled.launches, 0);
  const f = fixture(); f.windows.launch = async () => {};
  const result = await f.controller.start({ consent: 'LOCAL_DEBUGGING' });
  assert.equal(result.code, 'START_TIMEOUT');
  const disposed = fixture(); disposed.controller.dispose();
  assert.equal((await disposed.controller.start()).code, 'CANCELLED');
});
test('hung native dependency is bounded and cannot spawn after timeout', async () => {
  const f = fixture({ startTimeoutMs: 20 });
  let release;
  f.windows.discover = () => new Promise(resolve => { release = resolve; });
  const pending = f.controller.start({ consent: 'LOCAL_DEBUGGING' });
  assert.equal((await pending).code, 'START_TIMEOUT');
  release({ running: false, candidates: [{ path: exe, source: 'test' }] });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.launches, 0);
});
test('revalidates signatures before spawn and refuses wrong renderer URLs', async () => {
  const f = fixture();
  await f.controller.configure({ consent: 'LOCAL_DEBUGGING' });
  let checks = 0;
  f.windows.validate = async () => ({ valid: ++checks === 1 });
  assert.equal((await f.controller.start()).state, 'invalid-path');
  assert.equal(f.launches, 0);
  const wrong = fixture({ discoverTarget: async () => ({ url: 'https://example.com/' }) });
  wrong.owned = true;
  assert.equal((await wrong.controller.ensure()).state, 'running-no-channel');
  assert.equal(wrong.launches, 0);
  const unsupported = fixture({ platform: 'linux' });
  assert.equal((await unsupported.controller.start()).state, 'unsupported');
  assert.equal(unsupported.launches, 0);
});
test('diagnostics has a total deadline even for hung discovery', async () => {
  const f = fixture({ diagnosticsTimeoutMs: 15 });
  let release;
  f.windows.discover = () => new Promise(resolve => { release = resolve; });
  assert.equal((await f.controller.diagnostics()).code, 'DIAGNOSTICS_TIMEOUT');
  release({ running: false, candidates: [] });
  assert.equal(f.launches, 0);
});
test('deadline, cancellation, dispose and revocation during final pre-spawn discovery block launch', async () => {
  for (const mode of ['deadline', 'cancel', 'dispose', 'revoke', 'revoke-pending']) {
    const f = fixture({ startTimeoutMs: mode === 'deadline' ? 20 : 500 });
    await f.controller.configure({ consent: 'LOCAL_DEBUGGING', autoStart: true });
    const original = f.windows.discover;
    let calls = 0, release, entered;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    f.windows.discover = async () => {
      if (++calls === 2) return new Promise(resolve => { release = resolve; entered(); });
      return original();
    };
    const signal = new AbortController();
    const pending = f.controller.ensure({ signal: signal.signal });
    await enteredPromise;
    if (mode === 'cancel') signal.abort();
    if (mode === 'dispose') f.controller.dispose();
    if (mode === 'revoke') await f.controller.configure({ consent: 'REVOKE' });
    const revoking = mode === 'revoke-pending' ? f.controller.configure({ consent: 'REVOKE' }) : null;
    if (mode === 'deadline') assert.equal((await pending).code, 'START_TIMEOUT');
    release({ running: false, candidates: [{ path: exe, source: 'test' }] });
    const result = await pending;
    assert.equal(result.code, mode === 'deadline' ? 'START_TIMEOUT' : mode.startsWith('revoke') ? 'CONSENT_REQUIRED' : 'CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(f.launches, 0, mode);
    await revoking;
  }
});
test('concurrent load is memoized and cannot overwrite configured consent', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-startup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'startup.json'), JSON.stringify({ executablePath: '', consent: null, autoStart: false }));
  let reads = 0, release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const fake = { ...fs, readFile: async (...args) => { reads++; const value = await fs.readFile(...args); entered(); await new Promise(resolve => { release = resolve; }); return value; } };
  const f = fixture({ directory, fs: fake });
  const observation = f.controller.diagnostics();
  await enteredPromise;
  const configured = f.controller.configure({ consent: 'LOCAL_DEBUGGING', autoStart: true });
  await new Promise(resolve => setTimeout(resolve, 1));
  release();
  await observation;
  assert.equal((await configured).consentGranted, true);
  assert.equal((await f.controller.diagnostics()).consentGranted, true);
  assert.equal(reads, 1);
});
test('oversized and malformed persisted settings fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-startup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const value of ['x'.repeat(16385), 'null', '{}', '{bad json']) {
    await fs.writeFile(path.join(directory, 'startup.json'), value);
    const f = fixture({ directory });
    assert.equal((await f.controller.diagnostics()).code, 'INVALID_SETTINGS');
    assert.equal(f.launches, 0);
  }
});
test('ready cache rechecks the exact target without native calls, diagnostics and target changes revalidate', async () => {
  let target = { id: 'one', url: 'doubao://doubao-chat/chat/', webSocketDebuggerUrl: 'ws://127.0.0.1:19226/devtools/page/one' };
  const f = fixture({ discoverTarget: async () => target }); f.owned = true;
  let nativeCalls = 0;
  for (const method of ['discover', 'validate', 'inspectPort']) {
    const original = f.windows[method];
    f.windows[method] = (...args) => { nativeCalls++; return original(...args); };
  }
  assert.equal((await f.controller.diagnostics()).state, 'ready');
  const baseline = nativeCalls;
  assert.equal((await f.controller.ensure()).state, 'ready');
  assert.equal((await f.controller.observe()).state, 'ready');
  assert.equal(nativeCalls, baseline);
  target = { ...target, id: 'two', webSocketDebuggerUrl: 'ws://127.0.0.1:19226/devtools/page/two' };
  assert.equal((await f.controller.observe()).state, 'ready');
  assert.ok(nativeCalls > baseline);
  const changed = nativeCalls;
  await f.controller.diagnostics();
  assert.ok(nativeCalls > changed);
  const beforeConfigure = nativeCalls;
  await f.controller.configure({ consent: 'REVOKE' });
  assert.ok(nativeCalls > beforeConfigure);
  assert.equal(f.launches, 0);
});
test('queued revoke during diagnosis invalidates pre-await startup epoch', async () => {
  const f = fixture({ startTimeoutMs: 500 });
  await f.controller.configure({ consent: 'LOCAL_DEBUGGING', autoStart: true });
  const original = f.windows.discover;
  let release, entered, calls = 0;
  const reached = new Promise(resolve => { entered = resolve; });
  f.windows.discover = async () => { if (++calls === 1) return new Promise(resolve => { release = resolve; entered(); }); return original(); };
  const pending = f.controller.ensure();
  await reached;
  const revoked = f.controller.configure({ consent: 'REVOKE' });
  release({ running: false, candidates: [{ path: exe, source: 'test' }] });
  assert.equal((await pending).code, 'CONSENT_REQUIRED');
  await revoked;
  assert.equal(f.launches, 0);
});
test('dispose while temporary settings write is pending prevents durable authorization commit', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-startup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const fake = { ...fs, writeFile: async (...args) => { await fs.writeFile(...args); entered(); await new Promise(resolve => { release = resolve; }); } };
  const f = fixture({ directory, fs: fake });
  const pending = f.controller.configure({ consent: 'LOCAL_DEBUGGING', autoStart: true });
  await reached;
  f.controller.dispose(); release();
  assert.equal((await pending).code, 'CONFIGURATION_CANCELLED');
  await assert.rejects(fs.readFile(path.join(directory, 'startup.json')), { code: 'ENOENT' });
});
test('failed revocation persistence disables consent immediately and cannot auto-start', async t => {
  for (const failure of ['writeFile', 'rename']) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-startup-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let denied = false;
    const fake = { ...fs, [failure]: async (...args) => { if (denied) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs[failure](...args); } };
    const f = fixture({ directory, fs: fake });
    assert.equal((await f.controller.configure({ consent: 'LOCAL_DEBUGGING', autoStart: true })).consentGranted, true);
    denied = true;
    const pending = f.controller.configure({ consent: 'REVOKE' });
    const immediate = await f.controller.diagnostics();
    assert.equal(immediate.consentGranted, false);
    assert.equal(immediate.autoStart, false);
    const result = await pending;
    assert.equal(result.code, 'CONFIGURATION_FAILED');
    assert.match(result.message, /disabled in this process.*could not be persisted/);
    assert.equal(result.consentGranted, false);
    assert.equal(result.autoStart, false);
    assert.equal((await f.controller.ensure()).code, 'CONSENT_REQUIRED');
    assert.equal(f.launches, 0);
    const disk = JSON.parse(await fs.readFile(path.join(directory, 'startup.json'), 'utf8'));
    assert.equal(disk.consent, 'LOCAL_DEBUGGING');
    const unloaded = fixture({ directory, fs: fake });
    assert.equal((await unloaded.controller.configure({ consent: 'REVOKE' })).code, 'CONFIGURATION_FAILED');
    assert.equal((await unloaded.controller.ensure()).consentGranted, false);
    assert.equal(unloaded.launches, 0);
  }
});
test('manual startup reuses the just-configured diagnosis but retains final native checks', async () => {
  const f = fixture();
  let discoveries = 0, signatures = 0, ports = 0;
  for (const method of ['discover', 'validate', 'inspectPort']) {
    const original = f.windows[method];
    f.windows[method] = (...args) => { if (method === 'discover') discoveries++; if (method === 'validate') signatures++; if (method === 'inspectPort') ports++; return original(...args); };
  }
  assert.equal((await f.controller.start({ consent: 'LOCAL_DEBUGGING' })).state, 'ready');
  assert.equal(discoveries, 3);
  assert.ok(signatures >= 3);
  assert.ok(ports >= 3);
  assert.equal(f.launches, 1);
});
test('unsafe symlink settings and denied persistence fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doubao-startup-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fake = { ...fs, writeFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const f = fixture({ directory, fs: fake });
  assert.equal((await f.controller.configure({ consent: 'LOCAL_DEBUGGING', autoStart: true })).code, 'CONFIGURATION_FAILED');
  assert.equal((await f.controller.diagnostics()).consentGranted, false);
  assert.equal(f.launches, 0);
  const linked = fixture({ directory, fs: { ...fs, lstat: async () => ({ isSymbolicLink: () => true }) } });
  assert.equal((await linked.controller.configure({ consent: 'LOCAL_DEBUGGING' })).code, 'CONFIGURATION_FAILED');
  assert.equal(linked.launches, 0);
});
