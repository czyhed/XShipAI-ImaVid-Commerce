import test from 'node:test';
import assert from 'node:assert/strict';
import {
 PRESENTER_DEFAULT_SPEAKER,
 PRESENTER_IMAGE_DESCRIPTION,
 buildPresenterPrompt,
 checkPresenterInput,
 presenterDialogueLimit,
 presenterImagePrompt,
 presenterHoldPrompt,
 sanitizePresenterLine,
} from '../shared/creation-presenter.mjs';

const person = '11111111-1111-4111-8111-111111111111';
const product = '22222222-2222-4222-8222-222222222222';
const product2 = '33333333-3333-4333-8333-333333333333';
const product3 = '44444444-4444-4444-8444-444444444444';

test('presenter dialogue limit follows four Chinese characters per second', () => {
 assert.equal(presenterDialogueLimit(5), 20);
 assert.equal(presenterDialogueLimit(6), 24);
 assert.equal(presenterDialogueLimit(8), 32);
 assert.equal(presenterDialogueLimit('7'), 28);
});

test('presenter lines drop markup, emoji, quotes and line breaks before truncating', () => {
 assert.equal(sanitizePresenterLine('“这款杯子很好用。”', 6), '这款杯子很好用。');
 assert.equal(sanitizePresenterLine('第一行\n第二行\t第三行', 6), '第一行 第二行 第三行');
 assert.equal(sanitizePresenterLine('好用的杯子😀👍', 6), '好用的杯子');
 assert.equal(sanitizePresenterLine('<d>[Chinese] 你好</d>', 5), '[Chinese] 你好');
 const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
 assert.equal([...sanitizePresenterLine(long, 5)].length, 20);
});

test('presenter input defaults to 8s, 768P, 9:16 and lipsync, and requires a person image', () => {
 assert.match(checkPresenterInput({}).error, /人物图片/);
 const ok = checkPresenterInput({ personAssetId: person, dialogueText: '大家好，我是主播。' }, { productId: null });
 assert.equal(ok.error, undefined);
 assert.deepEqual([ok.input.duration, ok.input.resolution, ok.input.ratio, ok.input.dubMode], [8, '768P', '9:16', 'lipsync']);
 assert.equal(ok.input.personSource, 'upload');
 assert.equal(ok.input.style, 'handheld');
 assert.equal(ok.input.title, '人物口播');
});

test('presenter input enforces 5-10 seconds, product references and a non-empty line', () => {
 const base = { personAssetId: person, productAssetIds: [product], dialogueText: '这款杯子很好用。' };
 assert.match(checkPresenterInput({ ...base, duration: 4 }, { productId: 'p' }).error, /5–10/);
 assert.match(checkPresenterInput({ ...base, duration: 11 }, { productId: 'p' }).error, /5–10/);
 assert.match(checkPresenterInput({ ...base, duration: 6.5 }, { productId: 'p' }).error, /5–10/);
 assert.match(checkPresenterInput({ ...base, productAssetIds: [] }, { productId: 'p' }).error, /商品参考图/);
 assert.match(checkPresenterInput({ ...base, productAssetIds: [product, product2, product3, person] }, { productId: 'p' }).error, /最多 3 张/);
 assert.match(checkPresenterInput({ ...base, dialogueText: '   ' }, { productId: 'p' }).error, /台词/);
 assert.match(checkPresenterInput({ ...base, productAssetIds: ['not-a-uuid'] }, { productId: 'p' }).error, /编号无效/);
 const ok = checkPresenterInput({ ...base, duration: 8, dubMode: 'post', productAssetIds: [product, product2] }, { productId: 'p' });
 assert.equal(ok.error, undefined);
 assert.equal(ok.input.dubMode, 'post');
 assert.equal(ok.input.duration, 8);
});

test('presenter prompt references the person and product tags without writing dialogue', () => {
 const prompt = buildPresenterPrompt({ style: 'handheld', personTag: '{{ref:p}}', productTags: ['{{ref:a}}', '{{ref:b}}'], productName: '保温杯' });
 assert.match(prompt, /人物外观严格参考 \{\{ref:p\}\}/);
 assert.match(prompt, /商品外观严格参考 \{\{ref:a\}\}、\{\{ref:b\}\}/);
 assert.match(prompt, /半身中景/);
 assert.match(prompt, /头顶上方留出空白/);
 assert.match(prompt, /脸部完整可见|脸部清晰/);
 assert.match(prompt, /不能挡住脸/);
 assert.match(prompt, /不遮挡面部/);
 assert.match(prompt, /双手自然持握商品/);
 assert.doesNotMatch(prompt, /大家好|<d>/);
 assert.match(prompt, /不出现价格、销量、认证、功效结论/);
 const tabletop = buildPresenterPrompt({ style: 'tabletop', personTag: '{{ref:p}}', productTags: ['{{ref:a}}'] });
 assert.match(tabletop, /站在桌边/);
 const inUse = buildPresenterPrompt({ style: 'in-use', personTag: '{{ref:p}}', productTags: [] , productName: '保温杯' });
 assert.match(inUse, /正在自然地使用商品/);
 assert.match(inUse, /商品是「保温杯」/);
});

test('virtual presenter image prompt isolates the person and forbids text', () => {
 const prompt = presenterImagePrompt('短发男性，浅蓝衬衫');
 assert.match(prompt, /短发男性，浅蓝衬衫/);
 assert.match(prompt, /正面半身/);
 assert.match(prompt, /整张脸从额头到下巴完整可见/);
 assert.match(prompt, /人物约占画面高度的 80%/);
 assert.match(prompt, /不是特写/);
 assert.match(prompt, /不要出现文字、水印、logo/);
 assert.match(presenterImagePrompt(''), new RegExp(PRESENTER_IMAGE_DESCRIPTION.slice(0, 8)));
 assert.equal(PRESENTER_DEFAULT_SPEAKER, 'zh_female_xiaohe_uranus_bigtts');
});

test('createPresenter adds person and product input nodes, reference edges, a video node and a shot', async () => {
 const { CreationProjects } = await import('../server/creation-projects.mjs');
 const { randomUUID } = await import('node:crypto');
 const projectId = randomUUID(), productId = randomUUID(), workflowId = randomUUID();
 const personAssetId = randomUUID(), productAssetId = randomUUID();
 const assets = {
  [personAssetId]: { id: personAssetId, kind: 'asset', mime: 'image/png', role: 'result', name: '人物定妆' },
  [productAssetId]: { id: productAssetId, kind: 'asset', mime: 'image/jpeg', role: 'creative', name: '保温杯', productId },
 };
 let saved = {
  id: projectId, kind: 'project', revision: 1, name: '测试项目', productId, productSnapshot: { name: '保温杯', facts: { 材质: '不锈钢' } },
  tasks: [{ id: randomUUID(), workflowId, kind: 'prompt', title: '脚本', prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 } }],
  edges: [], workflows: [{ id: workflowId, title: '创作任务' }], voiceRoles: [],
 };
 const service = new CreationProjects({
  async change(_workspace, _id, _expected, fn) { saved = await fn(saved, {}); return saved; },
  async get(_workspace, id) { return assets[id] || null; },
 }, {});
 service.detail = async () => ({ project: saved, runs: [], dubStates: {}, cost: {} });
 service.validateReferences = async () => {};

 const result = await service.createPresenter('w', projectId, {
  personAssetId, personSource: 'generated', productAssetIds: [productAssetId], style: 'in-use', duration: 7,
  resolution: '480P', ratio: '9:16', dubMode: 'lipsync', dialogueText: '这款保温杯我每天都在用，装热水很稳。',
 });
 assert.ok(result.created?.taskId);
 const added = saved.tasks.slice(1);
 assert.equal(added.length, 3, 'person image + product image + video');
 const video = added.find(task => task.kind === 'video');
 const person = added.find(task => task.title === '人物参考');
 const product = added.find(task => task.title === '商品参考 1');
 assert.deepEqual([video.videoMode, video.presenterAssetId, video.presenterSource, video.presenterStyle], ['reference', personAssetId, 'generated', 'in-use']);
 assert.deepEqual([video.params.duration, video.params.resolution, video.params.ratio], [7, '480P', '9:16']);
 assert.equal(video.dialogue[0].text, '这款保温杯我每天都在用，装热水很稳。');
 assert.equal(video.dialogue[0].language, 'zh');
 assert.equal(video.dubMode, 'lipsync');
 assert.match(video.prompt, new RegExp(`\{\{ref:${person.id}\}\}`));
 assert.match(video.prompt, new RegExp(`\{\{ref:${product.id}\}\}`));
 assert.match(video.prompt, /正在自然地使用商品/);
 assert.equal(saved.edges.length, 2);
 assert.ok(saved.edges.every(edge => edge.target === video.id && edge.targetHandle === 'refImage' && edge.sourceHandle === 'image'));
 assert.equal(saved.storyboard.shots.length, 1);
 assert.equal(saved.storyboard.shots[0].nodeId, video.id);
 assert.equal(saved.storyboard.shots[0].title, '人物口播');
 assert.equal(saved.voiceRoles.length, 1);
 assert.equal(saved.voiceRoles[0].name, '主播');
 assert.equal(video.dialogue[0].roleId, saved.voiceRoles[0].id);
});

test('createPresenter with a hold image locks framing: first frame, post dub, adaptive ratio', async () => {
 const { CreationProjects } = await import('../server/creation-projects.mjs');
 const { randomUUID } = await import('node:crypto');
 const projectId = randomUUID(), workflowId = randomUUID(), holdAssetId = randomUUID(), productId = randomUUID();
 const assets = { [holdAssetId]: { id: holdAssetId, kind: 'asset', mime: 'image/png', role: 'result', name: '手拿商品图', projectId, derivedFrom: { kind: 'presenter-held' } } };
 let saved = {
  id: projectId, kind: 'project', revision: 1, name: '持物测试', productId, productSnapshot: { name: '保温杯' },
  tasks: [], edges: [], workflows: [{ id: workflowId, title: '创作任务' }], voiceRoles: [],
 };
 const service = new CreationProjects({
  async change(_workspace, _id, _expected, fn) { saved = await fn(saved, {}); return saved; },
  async get(_workspace, id) { return assets[id] || null; },
 }, {});
 service.detail = async () => ({ project: saved, runs: [], dubStates: {}, cost: {} });
 service.validateReferences = async () => {};
 await service.createPresenter('w', projectId, {
  holdAssetId, duration: 8, resolution: '768P', ratio: '16:9', dubMode: 'lipsync', dialogueText: '这款保温杯我每天都在用。',
 });
 const video = saved.tasks.find(task => task.kind === 'video');
 assert.deepEqual([video.videoMode, video.dubMode, video.params.ratio], ['frames', 'post', 'adaptive']);
 assert.equal(saved.edges.length, 1);
 assert.equal(saved.edges[0].targetHandle, 'first');
 assert.match(video.prompt, /不推近、不拉远、不缩放/);
});

test('generateDialogue writes first-person lines for presenter shots and keeps their lipsync mode', async () => {
 const { CreationProjects } = await import('../server/creation-projects.mjs');
 const { randomUUID } = await import('node:crypto');
 const projectId = randomUUID(), workflowId = randomUUID(), presenterId = randomUUID(), narratorId = randomUUID();
 const personAssetId = randomUUID(), productId = randomUUID();
 let saved = {
  id: projectId, kind: 'project', revision: 1, name: '台词测试', productId, productSnapshot: { name: '保温杯' },
  tasks: [
   { id: presenterId, workflowId, kind: 'video', title: '人物口播', prompt: '人物介绍商品', params: { duration: 6 }, subject: 'product', position: { x: 0, y: 0 }, videoMode: 'reference', dubMode: 'lipsync', presenterAssetId: personAssetId, dialogue: [] },
   { id: narratorId, workflowId, kind: 'video', title: '旁白镜头', prompt: '商品特写', params: { duration: 6 }, subject: 'product', position: { x: 340, y: 0 }, videoMode: 'text', dubMode: 'post', dialogue: [] },
  ],
  edges: [], workflows: [{ id: workflowId, title: '创作任务' }], voiceRoles: [],
  storyboard: { script: '保温杯短视频', shots: [
   { id: randomUUID(), title: '人物口播', description: '主播手持保温杯', nodeId: presenterId },
   { id: randomUUID(), title: '旁白镜头', description: '杯身特写', nodeId: narratorId },
  ] },
 };
 const service = new CreationProjects({
  async change(_workspace, _id, _expected, fn) { saved = await fn(saved, {}); return saved; },
 }, {});
 service.detail = async () => ({ project: saved, runs: [], dubStates: {}, cost: {} });
 service.hub = {
  async complete({ system }) {
   const presenter = system.includes('第一人称');
   return { text: JSON.stringify({ lines: [
    { taskId: presenterId, text: presenter ? '这款保温杯我每天都在用。' : '他是主播。' },
    { taskId: narratorId, text: presenter ? '这是主播。' : '杯身采用不锈钢材质。' },
   ] }), usage: {} };
  },
 };

 await service.generateDialogue('w', projectId, { taskIds: [presenterId, narratorId] });
 const presenter = saved.tasks.find(task => task.id === presenterId);
 const narrator = saved.tasks.find(task => task.id === narratorId);
 assert.equal(presenter.dialogue[0].text, '这款保温杯我每天都在用。');
 assert.equal(presenter.dubMode, 'lipsync');
 assert.equal(narrator.dialogue[0].text, '杯身采用不锈钢材质。');
 assert.equal(narrator.dubMode, 'post');
 assert.equal(saved.voiceRoles.length, 2);
 const presenterRole = saved.voiceRoles.find(role => role.name === '主播');
 assert.equal(presenter.dialogue[0].roleId, presenterRole.id);
 assert.ok(saved.voiceRoles.find(role => role.name === '旁白'));
});

test('presenterImage creates a generate node and starts an image run', async () => {
 const { CreationProjects } = await import('../server/creation-projects.mjs');
 const { randomUUID } = await import('node:crypto');
 const projectId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
 let saved = {
  id: projectId, kind: 'project', revision: 1, name: '定妆照测试', productSnapshot: { name: '保温杯' },
  tasks: [{ id: randomUUID(), workflowId, kind: 'prompt', title: '脚本', prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 } }],
  edges: [], workflows: [{ id: workflowId, title: '创作任务' }], voiceRoles: [],
 };
 const service = new CreationProjects({
  async change(_workspace, _id, _expected, fn) { saved = await fn(saved, {}); return saved; },
 }, {});
 service.preview = async (_workspace, _id, body) => ({ canStart: true, previewToken: 'token', scope: [{ taskId: body.taskIds[0], action: 'generate' }] });
 service.start = async (_workspace, _id, body) => ({ project: saved, runs: [{ id: runId, taskId: body.taskIds[0], status: 'queued', input: { kind: 'image' }, output: null }] });

 const result = await service.presenterImage('w', projectId, { prompt: '短发男性，浅蓝衬衫' });
 const node = saved.tasks.find(task => task.kind === 'generate');
 assert.ok(node, 'generate node is stored');
 assert.match(node.prompt, /短发男性，浅蓝衬衫/);
 assert.match(node.prompt, /不要出现文字、水印、logo/);
 assert.equal(node.params.size, '1024x1024');
 assert.equal(result.created.taskId, node.id);
 assert.equal(result.created.runId, runId);
});

test('hold-image prompt keeps identity, shows hands and honours the chosen preset', () => {
 const chest = presenterHoldPrompt('chest', '瓶身标签朝向镜头');
 assert.match(chest, /第 1 张图里这位人物/);
 assert.match(chest, /双手和手中的商品完整入镜/);
 assert.match(chest, /头顶上方留出/);
 assert.match(chest, /不被画面任何边缘裁切/);
 assert.match(chest, /约占画面高度的 80%/);
 assert.match(chest, /胸前偏下/);
 assert.match(chest, /补充要求：瓶身标签朝向镜头/);
 assert.match(presenterHoldPrompt('both'), /双手在胸前捧着/);
 assert.doesNotMatch(presenterHoldPrompt('custom'), /持物方式/);
 assert.match(presenterHoldPrompt('unknown'), /胸前偏下/);
});

test('with a hold image the video prompt uses it as the only visual basis and ignores product tags', () => {
 const prompt = buildPresenterPrompt({ holdTag: '{{ref:h}}', personTag: '{{ref:h}}', productTags: ['{{ref:a}}'] });
 assert.match(prompt, /\{\{ref:h\}\} 作为首帧/);
 assert.match(prompt, /镜头固定/);
 assert.doesNotMatch(prompt, /商品外观严格参考/);
 const ok = checkPresenterInput({ holdAssetId: product, personAssetId: person, productAssetIds: [product2], dialogueText: '你好。' }, { productId: 'p' });
 assert.equal(ok.error, undefined);
 assert.deepEqual(ok.input.productAssetIds, []);
 assert.equal(ok.input.holdAssetId, product);
});

test('presenterHeldImage builds an edit node with person first and product images, then starts a run', async () => {
 const { CreationProjects } = await import('../server/creation-projects.mjs');
 const { randomUUID } = await import('node:crypto');
 const projectId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
 let saved = {
  id: projectId, kind: 'project', revision: 1, name: '持物图测试', productSnapshot: { name: '保温杯' },
  tasks: [{ id: randomUUID(), workflowId, kind: 'prompt', title: '脚本', prompt: '', params: {}, subject: 'concept', position: { x: 0, y: 0 } }],
  edges: [], workflows: [{ id: workflowId, title: '创作任务' }], voiceRoles: [],
 };
 const assets = new Map([[person, 'creative'], [product, 'creative']].map(([id, role]) => [id, { id, kind: 'asset', role, mime: 'image/png' }]));
 const service = new CreationProjects({
  async change(_workspace, _id, _expected, fn) { saved = await fn(saved, {}); return saved; },
  async get(_workspace, id) { return assets.get(id) || null; },
 }, {});
 service.preview = async (_workspace, _id, body) => ({ canStart: true, previewToken: 'token', scope: [{ taskId: body.taskIds[0], action: 'edit' }] });
 service.start = async (_workspace, _id, body) => ({ project: saved, runs: [{ id: runId, taskId: body.taskIds[0], status: 'queued', input: { kind: 'edit' }, output: null }] });

 await assert.rejects(service.presenterHeldImage('w', projectId, { personAssetId: person, productAssetIds: [product], holdPrompt: 'nope' }), /持物方式/);
 const result = await service.presenterHeldImage('w', projectId, { personAssetId: person, productAssetIds: [product], holdPrompt: 'chest', extra: '标签朝前' });
 const node = saved.tasks.find(task => task.kind === 'edit');
 assert.ok(node?.presenterHeld);
 assert.equal(node.sourceAssetId, person);
 assert.match(node.prompt, /补充要求：标签朝前/);
 const sources = saved.edges.filter(edge => edge.target === node.id).map(edge => saved.tasks.find(task => task.id === edge.source).sourceAssetId);
 assert.deepEqual(sources, [person, product]);
 assert.equal(result.created.taskId, node.id);
});
