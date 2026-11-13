// 包完整性回归测试：把「改包名忘改引用」这类错误挡在发布前。
// 这条测试的由来：1.3.0 重命名 bundle 后，client.js 的模块 id 仍是旧包名，
// 导致前端半边永远不被加载（设置页空白），而宿主半边照常工作、单测全绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('client.js 注册的模块 id 必须等于包名', () => {
  const src = read('client.js');
  const match = src.match(/__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/);
  assert.ok(match, 'client.js 必须以 window.__ModuleLoader__.load({id:...}) 开头');
  assert.equal(
    match[1],
    pkg.name,
    `client.js 的模块 id (${match[1]}) 与包名 (${pkg.name}) 不一致：宿主按包名认领前端模块，不一致则该插件的前端半边永远不会 apply`,
  );
});

test('cordis.patch.yml 挂载的 name 必须等于包名', () => {
  const patch = read('cordis.patch.yml');
  const match = patch.match(/name:\s*'([^']+)'/);
  assert.ok(match, 'cordis.patch.yml 必须包含 name 字段');
  assert.equal(match[1], pkg.name, `cordis.patch.yml 的 name (${match[1]}) 与包名 (${pkg.name}) 不一致`);
});

test('package.json 里不得残留 @local/ 之类的旧包名', () => {
  for (const file of ['client.js', 'cordis.patch.yml', 'index.js', 'service.js', 'README.md']) {
    const body = read(file);
    for (const stale of ['@local/dsh-doubao-client']) {
      assert.ok(!body.includes(stale), `${file} 仍引用旧包名 ${stale}`);
    }
  }
});

test('exports 指向的文件必须存在', () => {
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key.includes('*')) continue; // locale/*.json
    assert.ok(fs.existsSync(path.join(dir, target)), `exports["${key}"] 指向不存在的文件 ${target}`);
  }
});

test('bundle patch 与 client 声明齐备', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(dir, pkg.dsh.bundle.patch)), 'bundle patch 文件不存在');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.ok(fs.existsSync(path.join(dir, pkg.exports['./client'])), 'client 入口文件不存在');
});

test('版本号在 package.json 与 service.js 间一致', () => {
  const svc = read('service.js');
  const match = svc.match(/version:\s*'([\d.]+)'/);
  assert.ok(match, 'service.js 必须声明 version');
  assert.equal(match[1], pkg.version, `service.js (${match[1]}) 与 package.json (${pkg.version}) 版本不一致`);
});

test('locale 文件齐备且带 meta.title', () => {
  for (const locale of ['zh', 'en']) {
    const dict = JSON.parse(read(`locale/${locale}.json`));
    assert.ok(dict.meta && typeof dict.meta.title === 'string' && dict.meta.title.length > 0, `${locale}.json 缺少 meta.title`);
    assert.ok(typeof dict.meta.description === 'string' && dict.meta.description.length > 0, `${locale}.json 缺少 meta.description`);
  }
});

test('插件不包含原生任务运行时字段（安全边界）', () => {
  for (const file of ['renderer.js', 'adapter.js', 'bridge.js', 'protocol.js']) {
    const body = read(file);
    for (const forbidden of ['agent_task_param', 'sandbox_id', 'client_env_id', 'enable_sandbox', 'local_device_id']) {
      assert.ok(!body.includes(forbidden), `${file} 出现被禁止的原生任务字段 ${forbidden}`);
    }
  }
});

test('插件不读取任何凭据/密钥文件（安全边界）', () => {
  for (const file of ['index.js', 'service.js', 'adapter.js', 'bridge.js', 'cdp.js', 'renderer.js', 'protocol.js', 'usage.js']) {
    const body = read(file);
    for (const forbidden of ['cookies', 'encrypted_key', 'Local State', 'Login Data', 'os_crypt']) {
      assert.ok(!body.includes(forbidden), `${file} 出现疑似凭据读取 ${forbidden}`);
    }
  }
});
