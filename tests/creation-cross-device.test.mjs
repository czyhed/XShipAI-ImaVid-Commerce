import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from '../server/http.mjs';
import { businessWorkspaceId, creationWorkspaceId } from '../server/access.mjs';

// WP2 跨设备核对：不依赖浏览器存储、不启动 Docker。
// 1. SJ_AUTH=off 时业务空间为 null，创作记录统一落到共享的 'local'。
// 2. 不带 Cookie 的全新会话从注入的服务端列表服务读取数据。
// 3. 根路径服务 web/dist 的 React 应用；旧原型入口在活动应用中返回 410。
// 4. 旧原型记录模块不再直接读写浏览器存储。

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PRODUCT_ID = '33333333-3333-4333-8333-333333333333';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const STAMP = '2026-11-14T00:00:00.000Z';

const project = {
  id: PROJECT_ID, name: '跨设备项目', revision: 3, createdAt: STAMP, updatedAt: STAMP, taskCount: 1,
};
const product = { id: PRODUCT_ID, name: '跨设备商品', revision: 2, createdAt: STAMP, updatedAt: STAMP };
const asset = {
  id: ASSET_ID, kind: 'asset', role: 'creative', name: '跨设备素材.png',
  mime: 'image/png', revision: 1, createdAt: STAMP, updatedAt: STAMP,
};

function fakeServices(calls) {
  return {
    // 仅需为真，用于触发「旧原型入口退役」分支。
    creationStore: {},
    creationProjects: {
      async list(workspace, page) {
        calls.push(['projects', workspace, page.limit]);
        return { projects: [project], total: 1 };
      },
      async detail(workspace, id) {
        calls.push(['project-detail', workspace, id]);
        return { project: { ...project, tasks: [{ id: 'task-1', title: '任务一' }] }, runs: [] };
      },
    },
    creationProducts: {
      async list(workspace, page) {
        calls.push(['products', workspace, page.limit]);
        return { items: [product], total: 1 };
      },
    },
    creationLifecycle: {
      store: {
        async page(workspace, options) {
          calls.push(['assets', workspace, options.limit]);
          return { records: [asset], total: 1 };
        },
      },
    },
  };
}

test('SJ_AUTH=off keeps one shared local workspace for every browser', () => {
  assert.equal(businessWorkspaceId({}), null);
  assert.equal(creationWorkspaceId({}), 'local');
  const account = { auth: {}, session: { user: { workspaceId: 'workspace-shared' } } };
  assert.equal(businessWorkspaceId(account), 'workspace-shared');
  assert.equal(creationWorkspaceId(account), 'workspace-shared');
});

test('a cookie-less fresh session reads projects, products, assets and tasks from server services', async t => {
  const calls = [];
  const server = createServer({ ...fakeServices(calls), root: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // 两次独立请求都不带 Cookie，等价于两个没有 localStorage 的全新浏览器。
  for (let session = 0; session < 2; session += 1) {
    const projects = await fetch(`${origin}/api/creation/projects`);
    assert.equal(projects.status, 200);
    assert.deepEqual((await projects.json()).projects.map(item => item.id), [PROJECT_ID]);

    const products = await fetch(`${origin}/api/creation/products`);
    assert.equal(products.status, 200);
    assert.deepEqual((await products.json()).items.map(item => item.id), [PRODUCT_ID]);

    const assets = await fetch(`${origin}/api/creation/assets`);
    assert.equal(assets.status, 200);
    assert.deepEqual((await assets.json()).items.map(item => item.id), [ASSET_ID]);

    const detail = await fetch(`${origin}/api/creation/projects/${PROJECT_ID}`);
    assert.equal(detail.status, 200);
    assert.deepEqual((await detail.json()).project.tasks.map(task => task.title), ['任务一']);
  }

  assert.deepEqual(calls.map(([, workspace]) => workspace), Array(8).fill('local'));
});

test('root serves the built React app and retires the legacy prototype entry', async t => {
  const calls = [];
  const server = createServer({ ...fakeServices(calls), root: new URL('../', import.meta.url) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /id="root"/);
  assert.match(html, /\/assets\/app-[A-Za-z0-9_-]{8}\.js/);

  for (const path of ['/prototype/prototype.html', '/generation.js']) {
    const retired = await fetch(origin + path);
    assert.equal(retired.status, 410, path);
  }
});

test('legacy record modules no longer touch browser storage', async () => {
  for (const file of ['products.js', 'review.js']) {
    const source = await readFile(new URL(`../web/src/lib/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/, file);
  }
});
