import test from 'node:test';
import assert from 'node:assert/strict';
import { TEMPLATES, renderTemplate } from '../web/src/lib/templates.js';

// seedVersion 2 = 主图直出三套模板；后续再加版本时同步更新这里。
const POSTER = TEMPLATES.filter(template => template.seedVersion === 2);
const byId = id => POSTER.find(template => template.id === id);

test('主图模板提供主视觉、卖点宫格、规格参数三套', () => {
 assert.deepEqual(POSTER.map(template => template.id), ['tpl-poster-hero', 'tpl-poster-features', 'tpl-poster-specs']);
 assert.deepEqual(POSTER.map(template => template.name), ['主图 · 主视觉（左文右图）', '主图 · 卖点宫格 2×2', '主图 · 规格参数图']);
 for (const template of POSTER) assert.equal(template.category, '主图');
});

test('三套模板都按 3:4 竖版出图，尺寸能被播种逻辑识别', () => {
 for (const template of POSTER) {
  assert.equal(template.compat.ratio, '3:4');
  assert.equal(template.compat.size.replace(/\s/g, '').replace('×', 'x'), '1024x1536');
  // creation-lifecycle 只用形如 1024x1536 的尺寸生成 params.size。
  assert.match(template.compat.size.replace(/\s/g, '').replace('×', 'x'), /^\d+x\d+$/);
 }
});

test('提示词里出现的占位符都有定义，反之亦然', () => {
 for (const template of POSTER) {
  const used = [...template.prompt.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
  const defined = template.placeholders.map(item => item.name);
  assert.equal(new Set(used).size, used.length, `${template.id} 有重复占位符`);
  assert.deepEqual([...new Set(used)].sort(), [...new Set(defined)].sort(), `${template.id} 占位符与定义不一致`);
 }
});

test('三套模板都要求完整中文且禁止多余文字', () => {
 for (const template of POSTER) {
  assert.match(template.prompt, /简体中文/);
  assert.match(template.prompt, /不得出现列表之外/);
  assert.match(template.prompt, /保留包装/);
 }
});

test('模板可用示例文案直接渲染成完整提示词', () => {
 for (const template of POSTER) {
  const values = Object.fromEntries(template.placeholders.map(item => [item.name, item.example]));
  const prompt = renderTemplate(template, values);
  assert.equal(/\{\{/.test(prompt), false, `${template.id} 仍残留占位符`);
  assert.ok(prompt.length > 200);
 }
});

test('规格参数模板只允许已确认的参数值', () => {
 const template = byId('tpl-poster-specs');
 assert.ok(template);
 assert.match(template.compat.note, /不要编造/);
 assert.ok(template.placeholders.some(item => item.name === '参数值1'));
});
