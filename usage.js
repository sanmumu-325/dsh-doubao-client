import { constants } from 'node:fs';
import { mkdir, open, opendir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

const DAY = 86_400_000;
const OFFSET = 8 * 60 * 60 * 1000;
const FILE = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const queues = new Map();
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'totalTokens'];
const CHAR_KEYS = ['input', 'output', 'total'];
const STATUSES = ['success', 'error', 'cancelled'];

function fail(message, code = 'ERR_USAGE_INVALID') {
  return Object.assign(new Error(message), { code });
}

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw fail(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function numberOrNull(value, name) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw fail(`${name} must be a finite nonnegative number or null`);
  }
  return value;
}

function countOrNull(value, name) {
  const result = numberOrNull(value, name);
  if (result !== null && !Number.isSafeInteger(result)) throw fail(`${name} must be an integer`);
  return result;
}

function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
    throw fail(`${name} must be a nonempty single-line string (maximum ${max} characters)`);
  }
  return value;
}

function object(value, name) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(`${name} must be an object`);
  return value;
}

function date(value) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw fail('Invalid timestamp');
  return result;
}

function dayKey(value) {
  return new Date(value.getTime() + OFFSET).toISOString().slice(0, 10);
}

function firstDay(today, days) {
  return new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * DAY).toISOString().slice(0, 10);
}

function normalize(entry, now, persisted = false) {
  entry = object(entry, 'entry');
  const chars = object(entry.chars, 'chars');
  const usage = object(entry.serverUsage, 'serverUsage');
  if (!STATUSES.includes(entry.status)) throw fail('status must be success, error or cancelled');
  const timestamp = entry.timestamp ?? (persisted ? undefined : now);
  if (timestamp === undefined) throw fail('Missing timestamp');
  const result = {
    id: text(entry.id ?? (persisted ? '' : randomUUID()), 'id', 200),
    timestamp: date(timestamp).toISOString(),
    model: text(entry.model, 'model', 200),
    status: entry.status,
    duration: numberOrNull(entry.duration, 'duration'),
    chars: Object.fromEntries(CHAR_KEYS.map(key => [key, countOrNull(chars[key], `chars.${key}`)])),
    serverUsage: Object.fromEntries(TOKEN_KEYS.map(key => [key, countOrNull(usage[key], `serverUsage.${key}`)])),
  };
  // Character totals may be calculated; server token totals are NEVER inferred.
  if (result.chars.total === null && result.chars.input !== null && result.chars.output !== null) {
    result.chars.total = countOrNull(result.chars.input + result.chars.output, 'chars.total');
  }
  return result;
}

function emptyStats() {
  return {
    requests: 0,
    statusCounts: { success: 0, error: 0, cancelled: 0 },
    duration: null,
    chars: { input: null, output: null, total: null },
    serverUsage: { inputTokens: null, outputTokens: null, totalTokens: null },
    estimate: { inputTokens: null, outputTokens: null, totalTokens: null },
    coverage: {
      duration: 0,
      chars: { input: 0, output: 0, total: 0 },
      serverUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      estimate: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    },
  };
}

function addKnown(target, coverage, key, value) {
  if (value === null) return;
  const sum = (target[key] ?? 0) + value;
  if (!Number.isSafeInteger(sum)) throw fail('Aggregate exceeds safe integer range', 'ERR_USAGE_OVERFLOW');
  target[key] = sum;
  coverage[key] += 1;
}

function add(stats, row, ratio) {
  stats.requests += 1;
  stats.statusCounts[row.status] += 1;
  if (row.duration !== null) {
    const sum = (stats.duration ?? 0) + row.duration;
    if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) throw fail('Duration aggregate overflow', 'ERR_USAGE_OVERFLOW');
    stats.duration = sum;
    stats.coverage.duration += 1;
  }
  for (const key of CHAR_KEYS) addKnown(stats.chars, stats.coverage.chars, key, row.chars[key]);
  for (const key of TOKEN_KEYS) addKnown(stats.serverUsage, stats.coverage.serverUsage, key, row.serverUsage[key]);
  for (let i = 0; i < CHAR_KEYS.length; i += 1) {
    const chars = row.chars[CHAR_KEYS[i]];
    addKnown(stats.estimate, stats.coverage.estimate, TOKEN_KEYS[i], chars === null ? null : Math.ceil(chars / ratio));
  }
}

function bucket() {
  return { totals: emptyStats(), byModel: Object.create(null) };
}

function addToBucket(target, row, ratio) {
  add(target.totals, row, ratio);
  target.byModel[row.model] ??= emptyStats();
  add(target.byModel[row.model], row, ratio);
}

/**
 * Standalone, zero-dependency request metadata ledger. All methods return promises.
 * Use a dedicated directory. Same-process instances for that directory share a queue;
 * multiple OS processes writing the same directory are intentionally unsupported.
 * `all` means retained data, NOT a lifetime total: default 90 UTC+8 calendar days.
 * Files are bounded (default 1 MiB/day). Capacity errors reject rather than drop rows.
 * Unknown input properties (including prompt, response, credentials) are never saved.
 * Missing measurements are null; known partial sums have explicit coverage counts.
 * Estimates use ceil(chars / charsPerToken) per request, never populate serverUsage.
 */
export function createUsageLedger({
  directory,
  retentionDays = 90,
  maxFileBytes = 1024 * 1024,
  charsPerToken = 4,
  now = () => new Date(),
} = {}) {
  text(directory, 'directory', 32_000);
  integer(retentionDays, 'retentionDays', 1, 90);
  integer(maxFileBytes, 'maxFileBytes', 256, 4 * 1024 * 1024);
  if (typeof charsPerToken !== 'number' || !Number.isFinite(charsPerToken) || charsPerToken <= 0) {
    throw fail('charsPerToken must be positive and finite');
  }
  if (typeof now !== 'function') throw fail('now must be a function');
  const root = resolve(directory);
  // Windows resolves paths case-insensitively; serialize equivalent spellings too.
  const queueKey = process.platform === 'win32' ? root.toLowerCase() : root;

  function serialized(operation) {
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const running = previous.catch(() => {}).then(operation);
    queues.set(queueKey, running);
    void running.finally(() => {
      if (queues.get(queueKey) === running) queues.delete(queueKey);
    }).catch(() => {});
    return running;
  }

  async function filesFor(today) {
    await mkdir(root, { recursive: true });
    const cutoff = firstDay(today, retentionDays);
    const files = [];
    let inspected = 0;
    const directoryHandle = await opendir(root);
    for await (const item of directoryHandle) {
      if (++inspected > 1024) throw fail('Ledger directory has too many entries; use a dedicated directory', 'ERR_USAGE_DIRECTORY_LIMIT');
      const match = FILE.exec(item.name);
      if (!match) continue;
      if (!item.isFile()) throw fail('Ledger shard must be a regular file', 'ERR_USAGE_UNSAFE_FILE');
      const day = match[1];
      if (day < cutoff) await unlink(join(root, item.name));
      else if (day <= today) files.push({ day, path: join(root, item.name) });
      else throw fail('Ledger contains a future-dated shard; clock may have moved backwards', 'ERR_USAGE_FUTURE_FILE');
    }
    if (files.length > retentionDays) throw fail('Unexpected number of ledger shards', 'ERR_USAGE_DIRECTORY_LIMIT');
    return files.sort((a, b) => a.day.localeCompare(b.day));
  }

  return {
    record(entry) {
      // Snapshot input synchronously so caller mutations cannot inject later content.
      let row;
      try { row = normalize(entry, date(now())); } catch (error) { return Promise.reject(error); }
      return serialized(async () => {
        const today = dayKey(date(now()));
        const day = dayKey(date(row.timestamp));
        if (day < firstDay(today, retentionDays) || day > today) {
          throw fail('timestamp must fall within the retained UTC+8 calendar-day window', 'ERR_USAGE_OUTSIDE_WINDOW');
        }
        await filesFor(today);
        const path = join(root, `usage-${day}.jsonl`);
        const handle = await open(path, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw fail('Ledger shard must be a regular file', 'ERR_USAGE_UNSAFE_FILE');
          let prefix = '';
          if (stat.size > maxFileBytes) throw fail('Daily ledger capacity exceeded', 'ERR_USAGE_CAPACITY');
          if (stat.size) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, stat.size - 1);
            // Isolate an interrupted JSON fragment instead of concatenating new JSON.
            if (last[0] !== 10) prefix = '\n';
          }
          const bytes = Buffer.from(`${prefix}${JSON.stringify(row)}\n`, 'utf8');
          if (stat.size + bytes.length > maxFileBytes) throw fail('Daily ledger capacity exceeded', 'ERR_USAGE_CAPACITY');
          let written = 0;
          while (written < bytes.length) {
            const result = await handle.write(bytes, written, bytes.length - written, stat.size + written);
            if (!result.bytesWritten) throw fail('Ledger write made no progress', 'ERR_USAGE_WRITE');
            written += result.bytesWritten;
          }
          await handle.sync();
        } finally { await handle.close(); }
        return row;
      });
    },

    summary({ days = retentionDays } = {}) {
      try { integer(days, 'days', 1, retentionDays); } catch (error) { return Promise.reject(error); }
      return serialized(async () => {
        const todayDate = dayKey(date(now()));
        const cutoff = firstDay(todayDate, days);
        const files = (await filesFor(todayDate)).filter(file => file.day >= cutoff);
        const result = {
          schemaVersion: 1,
          timezone: 'UTC+08:00',
          retentionDays,
          window: { from: cutoff, through: todayDate, days },
          estimate: { method: 'ceil(characters / charsPerToken) per request', charsPerToken, isEstimate: true },
          today: { date: todayDate, ...bucket() },
          all: bucket(),
          diagnostics: { filesRead: 0, corruptLines: 0, skippedOversizedFiles: 0, incompleteTailFiles: 0, complete: true },
        };
        for (const file of files) {
          const handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let content;
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw fail('Ledger shard must be a regular file', 'ERR_USAGE_UNSAFE_FILE');
            if (stat.size > maxFileBytes) {
              result.diagnostics.skippedOversizedFiles += 1;
              result.diagnostics.complete = false;
              continue;
            }
            // Explicit bounded read, even if an unsupported external writer grows it.
            const buffer = Buffer.alloc(stat.size);
            let read = 0;
            while (read < buffer.length) {
              const chunk = await handle.read(buffer, read, buffer.length - read, read);
              if (!chunk.bytesRead) break;
              read += chunk.bytesRead;
            }
            content = buffer.subarray(0, read).toString('utf8');
          } finally { await handle.close(); }
          result.diagnostics.filesRead += 1;
          if (content && !content.endsWith('\n')) result.diagnostics.incompleteTailFiles += 1;
          for (const line of content.split('\n')) {
            if (!line.trim()) continue;
            let row;
            try {
              row = normalize(JSON.parse(line), undefined, true);
              if (dayKey(date(row.timestamp)) !== file.day) throw fail('Wrong shard date');
            } catch {
              result.diagnostics.corruptLines += 1;
              result.diagnostics.complete = false;
              continue;
            }
            addToBucket(result.all, row, charsPerToken);
            if (file.day === todayDate) addToBucket(result.today, row, charsPerToken);
          }
        }
        return result;
      });
    },
  };
}
