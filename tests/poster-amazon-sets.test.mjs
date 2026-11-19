import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, POSTER_SETS, renderTemplate } from '../web/src/lib/templates.js';

// seedVersion 3 = 套图（1:1）模板 + AI 安排的三套预设方案。
const SET_TEMPLATES = TEMPLATES.filter(template => template.seedVersion === 3);
const byId = id => TEMPLATES.find(template => template.id === id);
const EXPECTED = ['tpl-amz-white', 'tpl-amz-benefits', 'tpl-amz-specs', 'tpl-amz-scene', 'tpl-amz-detail'];

test('套图模板包含白底首图、卖点、规格、场景、细节五套', () => {
 assert.deepEqual(SET_TEMPLATES.map(template => template.id), EXPECTED);
 for (const template of SET_TEMPLATES) {
  assert.equal(template.category, '主图');
  assert.equal(template.taskType, 'poster');
  assert.equal(template.compat.ratio, '1:1');
  assert.equal(template.compat.size.replace(/\s/g, '').replace('×', 'x'), '1024x1024');
 }
});

test('白底首图模板不允许出现任何文字', () => {
 const template = byId('tpl-amz-white');
 assert.ok(template);
 assert.deepEqual(template.placeholders, []);
 assert.equal(/\{\{/.test(template.prompt), false);
 assert.match(template.prompt, /纯白背景/);
 assert.match(template.prompt, /不得出现任何文字/);
 assert.match(template.prompt, /85%/);
});

test('其余模板的占位符与定义一一对应', () => {
 for (const template of SET_TEMPLATES.filter(item => item.placeholders.length)) {
  const used = [...template.prompt.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
  const defined = template.placeholders.map(item => item.name);
  assert.equal(new Set(used).size, used.length, `${template.id} 有重复占位符`);
  assert.deepEqual([...new Set(used)].sort(), [...new Set(defined)].sort(), `${template.id} 占位符与定义不一致`);
 }
});

test('四套预设方案各有三张；除图文三图外，第一张固定为白底首图', () => {
 assert.deepEqual(POSTER_SETS.map(set => set.id), ['poster-convert', 'poster-scene', 'poster-text', 'poster-launch']);
 for (const set of POSTER_SETS) {
  assert.equal(set.slots.length, 3, `${set.id} 不是三张`);
  if (set.id === 'poster-text') assert.ok(set.slots.every(slot => slot.templateId !== 'tpl-amz-white'), '图文三图三张都必须带字');
  else assert.equal(set.slots[0].templateId, 'tpl-amz-white', `${set.id} 首图必须是白底无字`);
  assert.equal(new Set(set.slots.map(slot => slot.templateId)).size, 3, `${set.id} 三张模板应各不相同`);
  for (const slot of set.slots) {
   assert.ok(byId(slot.templateId), `${set.id} 引用了不存在的模板 ${slot.templateId}`);
   assert.ok(slot.title && slot.dimension && slot.hint);
  }
  assert.ok(set.brief.length > 80, `${set.id} 的预设描述太短`);
  assert.match(set.brief, /1024×1024/);
  assert.match(set.brief, /不得编造/);
  assert.match(set.tagline, /·/);
 }
});

test('按 AI 填写的 copy 渲染时，必填占位符全部被替换', () => {
 for (const template of SET_TEMPLATES) {
  const required = template.placeholders.filter(item => item.required);
  const values = Object.fromEntries(required.map(item => [item.name, item.example]));
  const prompt = renderTemplate(template, values);
  for (const item of required) assert.equal(prompt.includes(`{{${item.name}}}`), false, `${template.id} 的必填占位符 ${item.name} 未替换`);
  assert.ok(prompt.length > 150);
 }
});

test('可省略占位符缺失时使用默认值，不留下空引号', () => {
 const template = byId('tpl-amz-benefits');
 const values = { 主标题: '三步收纳', 卖点一标题: '加厚防潮', 卖点一说明: '双层密封不返潮', 卖点二标题: '一按开盖', 卖点二说明: '单手轻松打开', 卖点三标题: '可叠放', 卖点三说明: '同规格更省空间' };
 const prompt = renderTemplate(template, values);
 assert.ok(prompt.includes('#2F6BD8'), '主色应回落到默认品牌蓝');
 assert.equal(/\{\{/.test(prompt), false);
});
