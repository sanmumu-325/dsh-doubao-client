import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createWindowsStartup, isLocalExecutable, trustedSignature, WINDOWS_QUERIES } from './startup-windows.js';
const signature = { status: 'Valid', subject: 'CN=北京春田知韵科技有限公司, O=北京春田知韵科技有限公司, SERIALNUMBER=91110102MACQD9K640, C=CN' };
test('only local absolute Doubao paths and pinned valid publisher accepted', () => {
  for (const p of ['Doubao.exe', '\\\\server\\Doubao.exe', 'C:Doubao.exe', 'C:\\Doubao.exe:stream', 'C:\\other.exe']) assert.equal(isLocalExecutable(p), false);
  assert.equal(isLocalExecutable('C:\\Apps\\Doubao.exe'), true);
  assert.equal(trustedSignature(signature), true);
  assert.equal(trustedSignature({ ...signature, status: 'UnknownError' }), false);
  assert.equal(trustedSignature({ ...signature, subject: 'O=Other' }), false);
});
test('fixed native queries carry paths in environment, never command interpolation', async () => {
  const calls = [];
  const windows = createWindowsStartup({ run: async (...args) => { calls.push(args); return { stdout: JSON.stringify(signature) }; } });
  const value = 'C:\\中文用户;$x\\Doubao.exe';
  assert.equal((await windows.validate(value)).valid, true);
  const [exe, args, options] = calls[0];
  assert.match(exe, /^[A-Za-z]:/);
  assert.ok(exe.endsWith('\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
  assert.match(args.at(-1), /\[Console\]::OutputEncoding=\[System.Text.Encoding\]::UTF8/);
  assert.equal(options.encoding, 'utf8');
  assert.equal(args.includes('-ExecutionPolicy'), false);
  assert.equal(args.join(' ').includes(value), false);
  assert.equal(options.env.DSH_DOUBAO_PATH, value);
  assert.match(WINDOWS_QUERIES.validate, /ReparsePoint/);
  assert.match(WINDOWS_QUERIES.validate, /DriveType -ne \[IO\.DriveType\]::Fixed/);
  assert.ok(WINDOWS_QUERIES.validate.indexOf('DriveType') < WINDOWS_QUERIES.validate.indexOf('Get-Item'));
  assert.match(WINDOWS_QUERIES.processes, /-Property Name,ExecutablePath/);
});
test('discovery includes fixed app subdirectory variants and trusted SystemRoot executable', async () => {
  const calls = [];
  const windows = createWindowsStartup({ env: { SystemRoot: 'D:\\Windows', LOCALAPPDATA: 'C:\\用户' }, run: async (...args) => { calls.push(args); return { stdout: '[]' }; } });
  const discovered = await windows.discover();
  assert.equal(calls[0][0], 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(discovered.candidates.some(c => c.path === 'C:\\用户\\Doubao\\app\\Doubao.exe'));
  assert.match(WINDOWS_QUERIES.installs, /Combine\(\$_\.InstallLocation,'app','Doubao.exe'\)/);
});
test('port verification fails closed on unknown owner, wildcard or unsigned executable', async () => {
  for (const owner of [{ address: '0.0.0.0', name: 'Doubao.exe', path: 'C:\\Doubao.exe' }, { address: '127.0.0.1', name: 'evil.exe', path: 'C:\\Doubao.exe' }]) {
    const windows = createWindowsStartup({ run: async () => ({ stdout: JSON.stringify([owner]) }) });
    assert.equal((await windows.inspectPort(9222)).state, 'conflict');
  }
  const windows = createWindowsStartup({ run: async () => { throw new Error('access denied'); } });
  await assert.rejects(windows.inspectPort(9222), { code: 'PORT_QUERY_FAILED' });
});
test('launch uses fixed arguments without shell and never kills a process', async () => {
  let observed;
  const windows = createWindowsStartup({ spawnProcess: (...args) => { observed = args; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; } });
  await windows.launch('C:\\Doubao.exe', 9222);
  assert.deepEqual(observed, ['C:\\Doubao.exe', ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1'], { shell: false, detached: true, windowsHide: true }]);
});
