import * as nativeFS from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { endpointURL, discoverTarget as nativeDiscoverTarget } from './cdp.js';
import { createWindowsStartup } from './startup-windows.js';

export function createDesktopStartup({ endpoint = 'http://127.0.0.1:19226', directory, platform = process.platform, windows = createWindowsStartup(), discoverTarget = nativeDiscoverTarget, fs = nativeFS, startTimeoutMs = 35000, diagnosticsTimeoutMs = 12000, readyCacheMs = 30000, pollIntervalMs = 250 } = {}) {
  let settings = { executablePath: '', consentGranted: false, autoStart: false };
  let loading, readyCache, revokedInMemory = false, disposed = false, flight, permissionVersion = 0, pendingConfigurations = 0, mutation = Promise.resolve();
  const lifetime = new AbortController();
  const file = directory ? path.join(directory, 'startup.json') : null;
  const supported = platform === 'win32';
  const setup = (state, code, message, candidates = [], executablePath = settings.executablePath) => ({ supported, state, code, message, executablePath, candidates: candidates.map(({ path, source }) => ({ path, source })), consentGranted: settings.consentGranted, autoStart: settings.autoStart, endpoint, checkedAt: new Date().toISOString() });
  async function checkChain(target, allowMissing = false) {
    let cursor = path.resolve(target);
    while (true) {
      try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Symbolic links are not permitted for startup settings'); }
      catch (e) { if (!(allowMissing && e.code === 'ENOENT')) throw e; }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
  function load() {
    if (loading) return loading;
    loading = (async () => {
      if (!file) return;
      await checkChain(file, true);
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 16384) throw Object.assign(new Error('Startup settings must be a regular file no larger than 16 KiB'), { code: 'INVALID_SETTINGS' });
        const text = await fs.readFile(file, 'utf8');
        if (Buffer.byteLength(text) > 16384) throw Object.assign(new Error('Startup settings exceed 16 KiB'), { code: 'INVALID_SETTINGS' });
        let saved;
        try { saved = JSON.parse(text); } catch { throw Object.assign(new Error('Startup settings contain invalid JSON'), { code: 'INVALID_SETTINGS' }); }
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || Object.keys(saved).some(k => !['executablePath', 'consent', 'autoStart'].includes(k)) || typeof saved.executablePath !== 'string' || saved.executablePath.length > 32767 || ![null, 'LOCAL_DEBUGGING'].includes(saved.consent) || typeof saved.autoStart !== 'boolean') throw Object.assign(new Error('Startup settings have an invalid schema'), { code: 'INVALID_SETTINGS' });
        settings = { executablePath: saved.executablePath, consentGranted: !revokedInMemory && saved.consent === 'LOCAL_DEBUGGING', autoStart: !revokedInMemory && saved.consent === 'LOCAL_DEBUGGING' && saved.autoStart };
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
    })().catch(e => { loading = undefined; throw e; });
    return loading;
  }
  async function save(next, guard) {
    guard();
    if (file) {
      await checkChain(file, true);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await checkChain(directory);
      guard();
      const temporary = path.join(directory, `.startup-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify({ executablePath: next.executablePath, consent: next.consentGranted ? 'LOCAL_DEBUGGING' : null, autoStart: next.autoStart }), { flag: 'wx', mode: 0o600 });
        await checkChain(file, true);
        guard();
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
    guard();
    settings = next;
  }
  function validEndpoint() {
    try { const u = endpointURL(endpoint); return Number(u.port || 80); }
    catch { throw Object.assign(new Error('Only a literal loopback HTTP debugging origin is allowed'), { code: 'INVALID_ENDPOINT' }); }
  }
  const inspectionMessages = { INVALID_ENDPOINT: 'Debugging endpoint must be a literal loopback HTTP origin, without credentials or extra URL components.', PORT_QUERY_FAILED: 'Windows could not verify the debugging port owner. Check local inspection permissions; startup is blocked.', INVALID_SETTINGS: 'Stored startup settings are malformed or too large. Correct or remove the local startup settings before granting permission again.', EACCES: 'Windows denied access to local startup settings or inspection. No automatic startup is allowed.', EPERM: 'Windows denied access to local startup settings or inspection. No automatic startup is allowed.' };
  function diagnose(parentSignal) { return boundedObservation(fullObservation, parentSignal); }
  function boundedObservation(operation, parentSignal) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), diagnosticsTimeoutMs);
    const signal = AbortSignal.any([lifetime.signal, deadline.signal, ...(parentSignal ? [parentSignal] : [])]);
    return new Promise(resolve => {
      const finish = value => { clearTimeout(timer); signal.removeEventListener('abort', aborted); resolve(value); };
      const aborted = () => finish(setup('unknown', deadline.signal.aborted ? 'DIAGNOSTICS_TIMEOUT' : 'CANCELLED', deadline.signal.aborted ? 'Local startup diagnostics exceeded the time limit; no client was started. Retry diagnostics or choose the installed executable explicitly.' : 'Startup observation cancelled.'));
      if (signal.aborted) return aborted();
      signal.addEventListener('abort', aborted, { once: true });
      operation(signal).then(finish, () => finish(setup('unknown', signal.aborted ? 'CANCELLED' : 'DIAGNOSTICS_FAILED', 'Local debugging channel could not be verified.')));
    });
  }
  async function readonlyObservation(signal) {
    signal.throwIfAborted();
    const cached = readyCache;
    if (cached && cached.epoch === permissionVersion && Date.now() - cached.checked < readyCacheMs && pendingConfigurations === 0) {
      try {
        const target = await discoverTarget(endpoint, signal);
        signal.throwIfAborted();
        if (readyCache === cached && cached.epoch === permissionVersion && pendingConfigurations === 0 && target.id === cached.target.id && target.url === cached.target.url && target.webSocketDebuggerUrl === cached.target.webSocketDebuggerUrl) return setup('ready', 'READY', 'Verified local Doubao debugging channel is ready.', cached.result.candidates, cached.result.executablePath);
      } catch { signal.throwIfAborted(); }
      readyCache = undefined;
    }
    return diagnose(signal);
  }
  async function fullObservation(signal) {
    const observedPermissionVersion = permissionVersion;
    readyCache = undefined;
    if (!supported) return setup('unsupported', 'UNSUPPORTED_PLATFORM', 'Automatic startup is supported only on Windows.');
    if (disposed) return setup('unknown', 'DISPOSED', 'Startup controller disposed.');
    try {
      await load();
      signal?.throwIfAborted();
      const port = validEndpoint();
      const found = await windows.discover();
      signal.throwIfAborted();
      const candidates = [...(settings.executablePath ? [{ path: settings.executablePath, source: 'configured' }] : []), ...found.candidates];
      const owner = await windows.inspectPort(port);
      signal?.throwIfAborted();
      if (owner.state === 'conflict') return setup('port-conflict', 'PORT_CONFLICT', 'The debugging port is not exclusively owned by a verified local Doubao client.', candidates);
      if (!['free', 'owned'].includes(owner.state)) return setup('unknown', 'PORT_QUERY_FAILED', 'Debugging port ownership is unknown.', candidates);
      if (owner.state === 'owned') {
        const validation = await windows.validate(owner.path);
        signal.throwIfAborted();
        if (!validation.valid) return setup('port-conflict', 'UNTRUSTED_PORT_OWNER', 'Debugging port owner could not be verified.', candidates);
        try {
          const target = await discoverTarget(endpoint, signal);
          signal.throwIfAborted();
          if (!/^doubao:\/\/doubao-chat\//.test(target.url)) throw new Error('Unexpected renderer');
          const result = setup('ready', 'READY', 'Verified local Doubao debugging channel is ready.', candidates, owner.path);
          if (observedPermissionVersion === permissionVersion && typeof target.id === 'string' && typeof target.webSocketDebuggerUrl === 'string') readyCache = { result, target: { id: target.id, url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl }, checked: Date.now(), epoch: permissionVersion };
          return result;
        } catch { return setup('running-no-channel', 'NO_CHAT_TARGET', 'Open the Doubao chat window. If debugging is disabled, exit Doubao normally before starting it with local debugging.', candidates, owner.path); }
      }
      let selected = '';
      if (settings.executablePath) {
        const result = await windows.validate(settings.executablePath);
        signal.throwIfAborted();
        if (!result.valid) return setup('invalid-path', result.code ?? 'INVALID_PATH', 'Configured executable failed local path or publisher verification.', candidates);
        selected = settings.executablePath;
      } else {
        for (const candidate of candidates) {
          const result = await windows.validate(candidate.path);
          signal.throwIfAborted();
          if (result.valid) { selected = candidate.path; break; }
        }
      }
      if (found.running) return setup('running-no-channel', 'RUNNING_NO_CHANNEL', 'Doubao is already running without a verified debugging channel. Exit it normally yourself; this integration will not terminate it.', candidates, selected);
      if (!selected) return setup('not-installed', 'NOT_INSTALLED', 'No verified Doubao installation was found. Choose the installed Doubao.exe.', candidates);
      return setup('not-running', 'NOT_RUNNING', 'Doubao is installed but is not running with local debugging.', candidates, selected);
    } catch (e) {
      return setup('unknown', signal?.aborted ? 'CANCELLED' : e.code ?? 'DIAGNOSTICS_FAILED', signal?.aborted ? 'Startup observation cancelled.' : inspectionMessages[e.code] ?? 'Unable to safely inspect the Doubao installation, publisher, or port ownership; startup is blocked.');
    }
  }
  function configure(patch = {}) {
    const revoke = patch.consent === 'REVOKE';
    const disableInMemory = () => { settings = { ...settings, consentGranted: false, autoStart: false }; };
    if (revoke) { revokedInMemory = true; disableInMemory(); }
    readyCache = undefined;
    const version = ++permissionVersion;
    const guard = () => { if (disposed || permissionVersion !== version) throw Object.assign(new Error('Configuration cancelled'), { code: 'CONFIGURATION_CANCELLED' }); };
    pendingConfigurations++;
    const run = mutation.then(async () => {
      if (disposed) return setup('unknown', 'DISPOSED', 'Startup controller disposed.');
      try {
        await load();
        if (revokedInMemory) disableInMemory();
        if (patch.consent !== undefined && !['LOCAL_DEBUGGING', 'REVOKE'].includes(patch.consent)) throw new Error('Invalid consent');
        if (patch.autoStart !== undefined && typeof patch.autoStart !== 'boolean') throw new Error('Invalid autoStart');
        if (patch.executablePath !== undefined && typeof patch.executablePath !== 'string') throw new Error('Invalid executable path');
        const next = { ...settings };
        if (patch.executablePath !== undefined) {
          if (patch.executablePath && !(await windows.validate(patch.executablePath)).valid) return setup('invalid-path', 'INVALID_PATH', 'Executable failed local path or publisher verification.');
          next.executablePath = patch.executablePath;
        }
        if (patch.consent === 'LOCAL_DEBUGGING') next.consentGranted = true;
        if (patch.autoStart !== undefined) next.autoStart = patch.autoStart;
        if (patch.consent === 'REVOKE') { next.consentGranted = false; next.autoStart = false; }
        if (!next.consentGranted) next.autoStart = false;
        await save(next, guard);
        if (patch.consent === 'LOCAL_DEBUGGING') revokedInMemory = false;
        return diagnose();
      } catch (error) {
        if (revokedInMemory) disableInMemory();
        return setup('unknown', error.code === 'CONFIGURATION_CANCELLED' ? error.code : 'CONFIGURATION_FAILED', error.code === 'CONFIGURATION_CANCELLED' ? 'Startup configuration cancelled before commit because the controller was disposed or a newer configuration was requested.' : revoke ? 'Automatic startup and consent are disabled in this process, but revocation could not be persisted to disk. Repair the local settings before reloading; the previous on-disk authorization may remain.' : 'Unable to safely persist startup settings.');
      }
    });
    const completed = run.finally(() => { pendingConfigurations--; });
    mutation = completed.then(() => {}, () => {});
    return completed;
  }
  async function performStart({ signal, consent, executablePath } = {}, automatic = false) {
    let permissionAtInspection = permissionVersion;
    const permissionChanged = () => setup('not-running', 'CONSENT_REQUIRED', 'Startup permissions changed while startup was pending. Retry only after reviewing the current settings.');
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(() => deadline.abort(), startTimeoutMs);
    const combined = AbortSignal.any([lifetime.signal, deadline.signal, ...(signal ? [signal] : [])]);
    const operation = (async () => { try {
      combined.throwIfAborted();
      await mutation;
      combined.throwIfAborted();
      if (!supported) return diagnose(combined);
      await load();
      combined.throwIfAborted();
      if (permissionAtInspection !== permissionVersion) return permissionChanged();
      let configuredCurrent;
      if (!automatic && (consent !== undefined || executablePath !== undefined)) {
        permissionAtInspection++;
        const configured = await configure({ ...(consent !== undefined ? { consent } : {}), ...(executablePath !== undefined ? { executablePath } : {}) });
        combined.throwIfAborted();
        if (['CONFIGURATION_FAILED', 'CONFIGURATION_CANCELLED', 'INVALID_PATH', 'DISPOSED'].includes(configured.code)) return configured;
        configuredCurrent = configured;
      }
      if (permissionAtInspection !== permissionVersion) return permissionChanged();
      let current = configuredCurrent ?? await (automatic ? readonlyObservation(combined) : diagnose(combined));
      combined.throwIfAborted();
      if (current.state !== 'not-running') return current;
      if (!settings.consentGranted || (automatic && !settings.autoStart)) return setup('not-running', 'CONSENT_REQUIRED', 'Explicit local-debugging consent and automatic-start permission are required as applicable.', current.candidates, current.executablePath);
      combined.throwIfAborted();
      // Revalidate both executable and port immediately before the one allowed spawn.
      const verified = await windows.validate(current.executablePath);
      combined.throwIfAborted();
      if (!verified.valid) return setup('invalid-path', verified.code ?? 'INVALID_PATH', 'Executable verification changed before launch.', current.candidates);
      const portOwner = await windows.inspectPort(validEndpoint());
      combined.throwIfAborted();
      if (portOwner.state !== 'free') return diagnose(combined);
      const processState = await windows.discover();
      combined.throwIfAborted();
      if (processState.running) return diagnose(combined);
      if (pendingConfigurations > 0 || permissionAtInspection !== permissionVersion || !settings.consentGranted || (automatic && !settings.autoStart)) return setup('not-running', 'CONSENT_REQUIRED', 'Startup permission was revoked before launch.', current.candidates, current.executablePath);
      await windows.launch(current.executablePath, validEndpoint());
      combined.throwIfAborted();
      while (!combined.aborted) {
        current = await diagnose(combined);
        if (current.state === 'ready' || current.state === 'port-conflict') return current;
        await new Promise(resolve => { const finish = () => { clearTimeout(timer); combined.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, pollIntervalMs); combined.addEventListener('abort', finish, { once: true }); });
      }
      return setup('unknown', signal?.aborted || disposed ? 'CANCELLED' : 'START_TIMEOUT', 'Startup observation ended. The client was not terminated.', current.candidates, current.executablePath);
    } catch { return setup('unknown', signal?.aborted || disposed ? 'CANCELLED' : 'START_FAILED', 'Startup could not be completed safely. The client was not terminated.'); } })();
    // Native inspection has its own finite timeout; this outer bound also protects
    // callers from slow dependencies. The aborted operation checks again before spawn.
    return new Promise(resolve => {
      const aborted = () => { clearTimeout(deadlineTimer); resolve(setup('unknown', signal?.aborted || disposed ? 'CANCELLED' : 'START_TIMEOUT', 'Startup observation ended. The client was not terminated.')); };
      if (combined.aborted) aborted();
      else combined.addEventListener('abort', aborted, { once: true });
      operation.then(value => { clearTimeout(deadlineTimer); combined.removeEventListener('abort', aborted); resolve(value); });
    });
  }
  function start(options = {}, automatic = false) {
    if (flight) return flight;
    flight = performStart(options, automatic).finally(() => { flight = null; });
    return flight;
  }
  return { diagnostics: () => diagnose(), observe: ({ signal } = {}) => boundedObservation(readonlyObservation, signal), configure, start: options => start(options), ensure: options => start(options, true), dispose() { disposed = true; lifetime.abort(); } };
}
