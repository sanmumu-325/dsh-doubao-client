// 前端半边的真实加载测试：在受控的假 window 里真正执行 client.js，
// 验证「模块 id = 包名」「apply 注册了 locale 与 settings.section 槽位」。
// 这条测试的由来：1.3.0 改包名后 id 未同步，宿主不认领该前端模块，
// 设置页整栏消失，而宿主半边与全部单测仍然正常。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
const source = fs.readFileSync(path.join(dir, 'client.js'), 'utf8');

function loadClientModule() {
  let loaded = null;
  const fakeWindow = { __ModuleLoader__: { load: (def) => { loaded = def; } } };
  const fakeReact = {
    createElement: (...args) => ({ type: typeof args[0], props: args[1] ?? null }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
  };
  const requireMock = (name) => {
    if (name === 'react') return fakeReact;
    throw new Error(`client.js 引入了未预期的模块: ${name}`);
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', source)(fakeWindow, requireMock);
  assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load(...)');
  loaded.__testWindow = fakeWindow;
  return loaded;
}

test('client.js 注册的模块 id 必须等于包名（宿主按此认领前端模块）', () => {
  const loaded = loadClientModule();
  assert.equal(
    loaded.id,
    pkg.name,
    `client.js 的 id (${loaded.id}) 与包名 (${pkg.name}) 不一致：宿主找不到这个前端模块，插件不会 apply，设置页不会出现`,
  );
});

test('factory 返回的 inject 声明了 slots 与 locale', () => {
  const loaded = loadClientModule();
  const mod = loaded.factory((name) => {
    if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useCallback: (fn) => fn };
    throw new Error(name);
  });
  assert.deepEqual(mod.inject, ['slots', 'locale']);
  assert.equal(typeof mod.apply, 'function');
});

test('apply 注册 zh/en 两个语言包并挂到 settings.section 槽位', () => {
  const loaded = loadClientModule();
  const mod = loaded.factory((name) => {
    if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useCallback: (fn) => fn };
    throw new Error(name);
  });

  const locales = [];
  const slots = [];
  const ctx = {
    locale: {
      register: (ns, locale, dict) => locales.push({ ns, locale, dict }),
      bind: (ns) => (key) => `${ns}:${key}`,
    },
    slots: {
      inject: (name, factory) => {
        assert.equal(name, 'settings.section');
        factory();
      },
      register: (def, component) => slots.push({ def, component }),
    },
  };

  mod.apply(ctx);

  assert.deepEqual(locales.map((l) => l.locale), ['zh', 'en'], '必须同时注册中英文，否则英文界面下会缺文案');
  assert.ok(locales.every((l) => l.ns === 'doubao-client'), '语言包命名空间必须是 doubao-client');
  assert.equal(slots.length, 1, '必须注册且只注册一个设置区块');
  const { def, component } = slots[0];
  assert.equal(def.name, 'settings.section');
  assert.equal(def.id, 'doubao-client');
  assert.equal(typeof component, 'function', '设置区块必须是一个组件');
  assert.equal(def.locale, 'doubao-client');
  assert.equal(def.label(), 'doubao-client:title', 'label 必须通过 locale 绑定解析');
});

test('中英文字典键完全对齐（缺键会让界面在另一种语言下露空）', () => {
  const loaded = loadClientModule();
  const captured = [];
  const mod = loaded.factory((name) => {
    if (name === 'react') return { createElement: () => null, useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({ current: null }), useCallback: (fn) => fn };
    throw new Error(name);
  });
  mod.apply({
    locale: { register: (ns, locale, dict) => captured.push({ locale, dict }), bind: () => () => '' },
    slots: { inject: (_n, f) => f(), register: () => {} },
  });
  const zh = captured.find((c) => c.locale === 'zh').dict;
  const en = captured.find((c) => c.locale === 'en').dict;
  const onlyZh = Object.keys(zh).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in zh));
  assert.deepEqual(onlyZh, [], `英文字典缺少这些键: ${onlyZh.join(', ')}`);
  assert.deepEqual(onlyEn, [], `中文字典缺少这些键: ${onlyEn.join(', ')}`);
});

test('设置区块只通过固定本地接口取数，不直连外部地址', () => {
  const fetchTargets = [...source.matchAll(/'(\/api\/doubao-client(?:\/setup)?)'/g)].map((m) => m[1]);
  assert.ok(fetchTargets.length > 0, '设置区块应当有取数调用');
  for (const target of fetchTargets) {
    assert.ok(target.startsWith('/'), `设置区块只能请求本机同源路径，发现: ${target}`);
  }
  const urls = [...source.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
  for (const url of urls) {
    const host = new URL(url).hostname;
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), `client.js 出现了非回环地址: ${url}`);
  }
});

test('settings.section 组件不依赖宿主注入 t prop，直接渲染可用', () => {
  const loaded = loadClientModule();
  const captured=[];
  const fakeReact = {
    createElement:(type,props,...children)=>{const node={type,props:props??{},children};captured.push(node);return node;},
    useState:(initial)=>[initial,()=>{}],
    useEffect:()=>{},
    useRef:(initial)=>({current:initial}),
    useCallback:(fn)=>fn,
  };
  const componentModule=loaded.factory(name=>{if(name==='react')return fakeReact;throw Error(name);});
  const registered=[];
  const dicts={};

  const locale={
    register:(ns,lang,dict)=>{dicts[lang]=dict;},
    bind:()=>key=>dicts.en?.[key]??dicts.zh?.[key]??key,
  };
  {
    componentModule.apply({locale,slots:{inject:(_name,factory)=>factory(),register:(def,component)=>registered.push({def,component})}});
    assert.equal(registered.length,1);
    const tree=registered[0].component();
    assert.ok(tree&&typeof tree==='object','组件应返回 React element tree');
    assert.ok(captured.some(node=>node.type==='h2'&&node.children.includes('Doubao Desktop Models')),'英文界面下设置组件应能自行解析标题，不要求 owner 传入 t');
    assert.equal(captured.some(node=>node.type==='h3'&&node.children.includes('Latest context telemetry')),false,'设置页不应再有上下文遥测卡片');
    let stateIndex=0;fakeReact.useState=initial=>[stateIndex++===0?{telemetry:{model:'mock-model',checkedAt:'2026-11-13T00:00:00Z',window:{messages:0,totalWindowSize:300000}}}:initial,()=>{}];
    captured.length=0;registered[0].component();
    assert.equal(captured.some(node=>node.type==='strong'&&node.children.includes('Latest risk control')),false,'只有遥测数据时不应显示任何遥测或风控区块');
    stateIndex=0;fakeReact.useState=initial=>[stateIndex++===0?{risk:{model:'mock-model',checkedAt:'2026-11-13T00:00:00Z'}}:initial,()=>{}];
    captured.length=0;registered[0].component();
    assert.ok(captured.some(node=>node.type==='strong'&&node.children.includes('Latest risk control')),'真实发生风控时仍应提示');
  }
});
