// 上下文窗口的诚实地约（实测结论见 README「上下文窗口：声明值 vs 实测值」）：
//   1) 有实测覆盖值 → 用实测值（source: measured）
//   2) 无实测值且未显式采信声明 → 不声明 context（source: unverified）
//      —— 因为实测发现客户端声明的 256k/300k 与真实可保留长度相差约十倍，
//         超出后上游静默丢弃开头（finish=stop、无报错），比报错更危险。
//   3) 显式 trustDeclaredWindow=true → 才使用客户端声明值（source: client-declared）
//   4) 两者都没有 → 不声明（unknown），绝不编一个数
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDoubaoAdapter, PROVIDER} from './adapter.js';

const MODEL_NO_WINDOW = {id:'0', name:'Fast', modeId:'1', agentMode:2};
const MODEL_DECLARED = {id:'9', name:'Auto', modeId:'3', agentMode:2, contextWindow:256000, itemId:10001};

function adapterWith(models, config = {}) {
  const bridge = {inspect:async()=>({models})};
  return createDoubaoAdapter({bridge, ledger:{async record(){}}, ...config});
}

test('默认不采信客户端声明值：未经实测的模型不声明窗口', async () => {
  const adapter = adapterWith([MODEL_DECLARED]);
  const resolved = await adapter.resolveModel(PROVIDER, '9');
  assert.equal(
    resolved.context,
    undefined,
    '客户端声明的 256k/300k 实测与真实能力相差约十倍，默认不能拿它当 DSH 的上限',
  );
});

test('显式采信时才使用客户端声明值', async () => {
  const adapter = adapterWith([MODEL_DECLARED], {trustDeclaredWindow:true});
  const resolved = await adapter.resolveModel(PROVIDER, '9');
  assert.equal(resolved.context.contextWindow, 256000);
});

test('实测覆盖值优先于客户端声明值', async () => {
  const adapter = adapterWith([MODEL_DECLARED], {contextWindows:{'9':20000}});
  const resolved = await adapter.resolveModel(PROVIDER, '9');
  assert.equal(resolved.context.contextWindow, 20000);
});

test('实测覆盖值即使同时采信声明也优先', async () => {
  const adapter = adapterWith([MODEL_DECLARED], {contextWindows:{'9':20000}, trustDeclaredWindow:true});
  const resolved = await adapter.resolveModel(PROVIDER, '9');
  assert.equal(resolved.context.contextWindow, 20000);
});

test('客户端没声明且无实测时不编造窗口', async () => {
  const adapter = adapterWith([MODEL_NO_WINDOW], {trustDeclaredWindow:true});
  const resolved = await adapter.resolveModel(PROVIDER, '0');
  assert.equal(resolved.context, undefined);
});

test('非法覆盖值（0 / 负数 / NaN / 字符串）不应生效', async () => {
  for (const bad of [0, -1, Number.NaN, 'abc', null]) {
    const adapter = adapterWith([MODEL_DECLARED], {contextWindows:{'9':bad}, trustDeclaredWindow:true});
    const resolved = await adapter.resolveModel(PROVIDER, '9');
    assert.equal(resolved.context.contextWindow, 256000, `非法覆盖值 ${String(bad)} 不应生效`);
  }
});
