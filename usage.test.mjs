import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageLedger } from './usage.js';

const NOW = '2026-11-13T01:02:03.000Z';
const SHARD = 'usage-2026-11-13.jsonl';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-usage-ledger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, ledger: createUsageLedger({ directory, now: () => new Date(NOW), ...options }) };
}

function entry(overrides = {}) {
  return { model: 'doubao-test', status: 'success', ...overrides };
}

test('empty ledger reports null measurements, not invented zero usage', async t => {
  const { ledger } = await fixture(t);
  const result = await ledger.summary();
  assert.equal(result.today.date, '2026-11-13');
  assert.equal(result.timezone, 'UTC+08:00');
  assert.equal(result.all.totals.requests, 0);
  assert.deepEqual(result.all.totals.serverUsage, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.deepEqual(result.all.totals.estimate, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.equal(result.all.totals.duration, null);
  assert.equal(result.diagnostics.complete, true);
});

test('record persists only metadata allowlist and snapshots caller-owned data', async t => {
  const { directory, ledger } = await fixture(t);
  const original = entry({
    id: 'request-1', duration: 20.5,
    chars: { input: 9, output: 7, secret: 'DO_NOT_SAVE' },
    serverUsage: { inputTokens: 3, credential: 'DO_NOT_SAVE' },
    prompt: 'DO_NOT_SAVE', response: 'DO_NOT_SAVE', credential: 'DO_NOT_SAVE',
  });
  const pending = ledger.record(original);
  original.model = 'mutated';
  original.chars.input = 999;
  const row = await pending;
  assert.deepEqual(Object.keys(row), ['id', 'timestamp', 'model', 'status', 'duration', 'chars', 'serverUsage']);
  assert.equal(row.timestamp, NOW);
  assert.equal(row.model, 'doubao-test');
  assert.deepEqual(row.chars, { input: 9, output: 7, total: 16 });
  assert.deepEqual(row.serverUsage, { inputTokens: 3, outputTokens: null, totalTokens: null });
  const content = await readFile(join(directory, SHARD), 'utf8');
  assert.equal(content.includes('DO_NOT_SAVE'), false);
  assert.deepEqual(JSON.parse(content), row);
});

test('actual server tokens and character estimates stay strictly separate', async t => {
  const { ledger } = await fixture(t);
  await ledger.record(entry({ chars: { input: 9, output: 7 }, serverUsage: { inputTokens: 100, outputTokens: 50 } }));
  await ledger.record(entry({ chars: { input: 4 }, serverUsage: { totalTokens: 800 } }));
  const { totals } = (await ledger.summary()).all;
  assert.deepEqual(totals.serverUsage, { inputTokens: 100, outputTokens: 50, totalTokens: 800 });
  assert.deepEqual(totals.estimate, { inputTokens: 4, outputTokens: 2, totalTokens: 4 });
  assert.deepEqual(totals.coverage.serverUsage, { inputTokens: 1, outputTokens: 1, totalTokens: 1 });
  assert.deepEqual(totals.coverage.chars, { input: 2, output: 1, total: 1 });
  assert.deepEqual(totals.coverage.estimate, { inputTokens: 2, outputTokens: 1, totalTokens: 1 });
  const result = await ledger.summary();
  assert.equal(result.estimate.isEstimate, true);
  assert.equal(result.estimate.charsPerToken, 4);
});

test('explicit zero measurements remain known zero with coverage', async t => {
  const { ledger } = await fixture(t);
  await ledger.record(entry({ duration: 0, chars: { input: 0, output: 0 }, serverUsage: { totalTokens: 0 } }));
  const totals = (await ledger.summary()).all.totals;
  assert.equal(totals.duration, 0);
  assert.equal(totals.chars.total, 0);
  assert.equal(totals.serverUsage.totalTokens, 0);
  assert.equal(totals.serverUsage.inputTokens, null);
  assert.equal(totals.coverage.serverUsage.totalTokens, 1);
});

test('UTC+8 day boundary, model/status grouping, custom ratio and days filter', async t => {
  const { ledger } = await fixture(t, { charsPerToken: 2 });
  await ledger.record(entry({ timestamp: '2026-11-12T15:59:59.999Z', model: 'old', status: 'error' }));
  await ledger.record(entry({ timestamp: '2026-11-12T16:00:00.000Z', model: 'new', chars: { total: 5 } }));
  await ledger.record(entry({ model: '__proto__', status: 'cancelled' }));
  const result = await ledger.summary();
  assert.equal(result.today.totals.requests, 2);
  assert.equal(result.all.totals.requests, 3);
  assert.deepEqual(result.all.totals.statusCounts, { success: 1, error: 1, cancelled: 1 });
  assert.equal(result.today.byModel.new.estimate.totalTokens, 3);
  assert.equal(result.all.byModel.__proto__.requests, 1);
  assert.equal(Object.getPrototypeOf(result.all.byModel), null);
  const filtered = await ledger.summary({ days: 1 });
  assert.equal(filtered.all.totals.requests, 2);
  assert.deepEqual(filtered.window, { from: '2026-11-13', through: '2026-11-13', days: 1 });
});

test('concurrent requests and same-directory instances serialize writes; summary is a barrier', async t => {
  const { directory, ledger } = await fixture(t);
  const other = createUsageLedger({ directory, now: () => new Date(NOW) });
  const writes = Array.from({ length: 100 }, (_, i) => (i % 2 ? ledger : other).record(entry({ id: `r-${i}` })));
  const summary = ledger.summary();
  await Promise.all(writes);
  assert.equal((await summary).all.totals.requests, 100);
  const lines = (await readFile(join(directory, SHARD), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(lines.map(row => row.id)).size, 100);
  assert.deepEqual(lines.map(row => row.id), Array.from({ length: 100 }, (_, i) => `r-${i}`));
});

test('restart retains cumulative records and does not need process-local state', async t => {
  const { directory, ledger } = await fixture(t);
  await ledger.record(entry({ duration: 10, serverUsage: { totalTokens: 12 } }));
  const restarted = createUsageLedger({ directory, now: () => new Date(NOW) });
  await restarted.record(entry({ duration: 11, serverUsage: { totalTokens: 13 } }));
  const result = await restarted.summary();
  assert.equal(result.all.totals.requests, 2);
  assert.equal(result.all.totals.duration, 21);
  assert.equal(result.all.totals.serverUsage.totalTokens, 25);
});

test('malformed tail is counted, isolated before the next write, and valid rows survive', async t => {
  const { directory, ledger } = await fixture(t);
  await ledger.record(entry({ id: 'first' }));
  await appendFile(join(directory, SHARD), '{"interrupted":');
  const before = await ledger.summary();
  assert.equal(before.all.totals.requests, 1);
  assert.equal(before.diagnostics.corruptLines, 1);
  assert.equal(before.diagnostics.incompleteTailFiles, 1);
  assert.equal(before.diagnostics.complete, false);
  await ledger.record(entry({ id: 'last' }));
  const after = await ledger.summary();
  assert.equal(after.all.totals.requests, 2);
  assert.equal(after.diagnostics.corruptLines, 1);
  assert.equal(after.diagnostics.incompleteTailFiles, 0);
});

test('schema-invalid lines and wrong-shard timestamps are counted as corrupt', async t => {
  const { directory, ledger } = await fixture(t);
  await ledger.record(entry());
  const valid = JSON.parse(await readFile(join(directory, SHARD), 'utf8'));
  await appendFile(join(directory, SHARD), [
    'not-json',
    JSON.stringify({ ...valid, serverUsage: { totalTokens: -2 } }),
    JSON.stringify({ ...valid, timestamp: '2026-11-11T00:00:00Z' }),
    JSON.stringify({ ...valid, status: 'unknown' }),
    '',
  ].join('\n'));
  const result = await ledger.summary();
  assert.equal(result.all.totals.requests, 1);
  assert.equal(result.diagnostics.corruptLines, 4);
});

test('valid unterminated final JSON row is retained and reported as incomplete framing', async t => {
  const { directory, ledger } = await fixture(t);
  await ledger.record(entry());
  const content = await readFile(join(directory, SHARD), 'utf8');
  await writeFile(join(directory, SHARD), content.trimEnd());
  const result = await ledger.summary();
  assert.equal(result.all.totals.requests, 1);
  assert.equal(result.diagnostics.corruptLines, 0);
  assert.equal(result.diagnostics.incompleteTailFiles, 1);
  await ledger.record(entry());
  assert.equal((await ledger.summary()).all.totals.requests, 2);
});

test('retention deletes only old owned shards and bounds all to retained days', async t => {
  let clock = '2026-11-11T01:00:00Z';
  const { directory, ledger } = await fixture(t, { retentionDays: 2, now: () => new Date(clock) });
  await ledger.record(entry());
  clock = '2026-11-12T01:00:00Z';
  await ledger.record(entry());
  await writeFile(join(directory, 'unrelated.txt'), 'keep');
  clock = '2026-11-13T01:00:00Z';
  await ledger.record(entry());
  const names = await readdir(directory);
  assert.equal(names.includes('usage-2026-11-11.jsonl'), false);
  assert.equal(names.includes('unrelated.txt'), true);
  assert.equal(names.filter(name => name.endsWith('.jsonl')).length, 2);
  assert.equal((await ledger.summary()).all.totals.requests, 2);
  await assert.rejects(ledger.record(entry({ timestamp: '2026-11-10T00:00:00Z' })), { code: 'ERR_USAGE_OUTSIDE_WINDOW' });
  await assert.rejects(ledger.record(entry({ timestamp: '2026-11-14T00:00:00Z' })), { code: 'ERR_USAGE_OUTSIDE_WINDOW' });
});

test('daily capacity rejects explicitly, queue recovers, and oversized reads are skipped', async t => {
  const { directory, ledger } = await fixture(t, { maxFileBytes: 512 });
  await ledger.record(entry());
  await assert.rejects(ledger.record(entry()), { code: 'ERR_USAGE_CAPACITY' });
  assert.ok((await stat(join(directory, SHARD))).size <= 512);
  assert.equal((await ledger.summary()).all.totals.requests, 1);
  await writeFile(join(directory, SHARD), 'x'.repeat(513));
  const result = await ledger.summary();
  assert.equal(result.all.totals.requests, 0);
  assert.equal(result.all.totals.serverUsage.totalTokens, null);
  assert.equal(result.diagnostics.skippedOversizedFiles, 1);
  assert.equal(result.diagnostics.complete, false);
  await assert.rejects(ledger.record(entry()), { code: 'ERR_USAGE_CAPACITY' });
});

test('invalid input is rejected without persisting rows or poisoning the queue', async t => {
  const { directory, ledger } = await fixture(t);
  for (const invalid of [
    null, undefined, [], 'not-an-entry',
    entry({ status: 'ok' }), entry({ model: '' }), entry({ model: 'x\ny' }),
    entry({ timestamp: 'not-a-date' }), entry({ duration: -1 }),
    entry({ chars: { input: 1.5 } }), entry({ serverUsage: { totalTokens: Infinity } }),
    entry({ chars: [] }), entry({ id: 'x'.repeat(201) }),
  ]) await assert.rejects(ledger.record(invalid), { code: 'ERR_USAGE_INVALID' });
  await assert.rejects(ledger.summary({ days: 0 }), { code: 'ERR_USAGE_INVALID' });
  await assert.rejects(ledger.summary({ days: 91 }), { code: 'ERR_USAGE_INVALID' });
  assert.equal((await readdir(directory)).length, 0);
  await ledger.record(entry());
  assert.equal((await ledger.summary()).all.totals.requests, 1);
});

test('configuration validates limits up front', () => {
  for (const options of [
    {}, { directory: 'x', retentionDays: 91 }, { directory: 'x', maxFileBytes: 100 },
    { directory: 'x', charsPerToken: 0 }, { directory: 'x', now: 123 },
  ]) assert.throws(() => createUsageLedger(options), { code: 'ERR_USAGE_INVALID' });
});

test('clock rollback refuses future shards rather than silently omitting persisted usage', async t => {
  const { directory, ledger } = await fixture(t);
  await ledger.record(entry());
  const earlier = createUsageLedger({ directory, now: () => new Date('2026-11-12T01:00:00Z') });
  await assert.rejects(earlier.summary(), { code: 'ERR_USAGE_FUTURE_FILE' });
});

test('summary aggregate overflow is explicit instead of silently losing precision', async t => {
  const { ledger } = await fixture(t);
  await ledger.record(entry({ serverUsage: { totalTokens: Number.MAX_SAFE_INTEGER } }));
  await ledger.record(entry({ serverUsage: { totalTokens: 1 } }));
  await assert.rejects(ledger.summary(), { code: 'ERR_USAGE_OVERFLOW' });
});
