import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import '../styles/creation-presenter.css';
import { HOLD_PROMPT_OPTIONS, PRESENTER_DEFAULT_DURATION, presenterHoldPrompt, PRESENTER_DURATIONS, PRESENTER_IMAGE_DESCRIPTION, PRESENTER_STYLES, PRESENTER_STYLE_LABEL, presenterDialogueLimit } from '../../../shared/creation-presenter.mjs';
import { VIDEO_RESOLUTIONS } from '../../../shared/creation-video-parameters.mjs';
import { estimateVideoPoints, pointText } from '../lib/video-node.js';

// 人物口播：把“人物图 + 商品图 + 台词 + 5–8 秒参数”变成一条参考模式视频分镜。
// 生图与建分镜都走服务端；本组件只负责收集输入、轮询人物图任务、提交创建。
export default function PresenterWizard({ backend, projectId, detail, editor, flush, accept, writable, notify, fileUrl, creationRequest, onClose, onCreated }) {
 const base = `/api/creation/projects/${projectId}`;
 const project = detail?.project || {};
 const [person, setPerson] = useState(null);
 const [personSource, setPersonSource] = useState('upload');
 const [uploading, setUploading] = useState(false);
 const [imagePrompt, setImagePrompt] = useState(PRESENTER_IMAGE_DESCRIPTION);
 const [imageBusy, setImageBusy] = useState(false);
 const [imageTask, setImageTask] = useState(null);
 const [assets, setAssets] = useState([]);
 const [assetsLoading, setAssetsLoading] = useState(true);
 const [picked, setPicked] = useState([]);
 const [text, setText] = useState('');
 const [hint, setHint] = useState('');
 const [scriptBusy, setScriptBusy] = useState(false);
 const [hold, setHold] = useState(null);
 const [holdCandidates, setHoldCandidates] = useState([]);
 const [holdPrompt, setHoldPrompt] = useState('chest');
 const [holdExtra, setHoldExtra] = useState('');
 const [holdBusy, setHoldBusy] = useState(false);
 const [holdTask, setHoldTask] = useState(null);
 const holdRef = useRef(null);
 const [duration, setDuration] = useState(PRESENTER_DEFAULT_DURATION);
 const [style, setStyle] = useState('handheld');
 const [dubMode, setDubMode] = useState('lipsync');
 const [resolution, setResolution] = useState('1080P');
 const [ratio, setRatio] = useState('9:16');
 const [error, setError] = useState('');
 const [busy, setBusy] = useState(false);
 const personRef = useRef(null), productRef = useRef(null), dialogueRef = useRef(null);
 const limit = presenterDialogueLimit(duration);

 // 校验失败时同时给出全局提示与分区定位；重复点击同一条件也会再次提示，不会“没反应”。
 const fail = message => { setError(message); notify?.(message, 'error'); };
 const failAt = (message, ref) => {
  fail(message);
  ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
 };

 useEffect(() => {
  let alive = true;
  setAssetsLoading(true);
  const query = new URLSearchParams({ role: 'creative,result', type: 'image', limit: '100', match: 'any' });
  if (project.productId) query.set('productId', project.productId);
  query.set('projectId', projectId);
  creationRequest(backend, `/api/creation/assets?${query}`).then(data => {
   if (!alive) return;
   const list = (data.items || []).filter(asset => !asset.trashedAt && !asset.deletionPending && asset.mime?.startsWith('image/'));
   setAssets([...new Map(list.map(asset => [asset.id, asset])).values()]);
  }).catch(e => { if (alive) fail(e.message); }).finally(() => { if (alive) setAssetsLoading(false); });
  return () => { alive = false; };
 }, [backend, creationRequest, projectId, project.productId]);

 // 人物定妆图：服务端立即提交生图运行；这里等待运行成功或失败。
 useEffect(() => {
  if (!imageTask) return;
  const run = (editor.runs || []).filter(item => item.taskId === imageTask).at(-1);
  if (!run) return;
  if (run.status === 'succeeded' && run.output?.assetId) {
   const generated = { id: run.output.assetId, taskId: imageTask, name: '人物定妆', mime: run.output.mime || 'image/png', derivedFrom: { kind: 'presenter-portrait' } };
   setPerson(generated);
   setPersonSource('generated');
   setAssets(old => [generated, ...old.filter(asset => asset.id !== generated.id)]);
   setImageTask(null);
   setImageBusy(false);
   notify?.('人物图已生成，可以继续选择商品参考图');
  } else if (['failed', 'cancelled'].includes(run.status)) {
   setImageTask(null);
   setImageBusy(false);
   fail(run.error?.message || (run.status === 'cancelled' ? '人物图生成已取消。' : '人物图生成失败，请修改描述后重试。'));
  }
 }, [editor.runs, imageTask, notify]);

 // 手拿商品图：等待运行结束，成功的结果加入候选并默认选用最新一张。
 useEffect(() => {
  if (!holdTask) return;
  const run = (editor.runs || []).filter(item => item.taskId === holdTask).at(-1);
  if (!run) return;
  if (run.status === 'succeeded' && run.output?.assetId) {
   const generated = { id: run.output.assetId, taskId: holdTask, name: '手拿商品图', mime: run.output.mime || 'image/png', derivedFrom: { kind: 'presenter-held' } };
   setHoldCandidates(old => [generated, ...old.filter(asset => asset.id !== generated.id)]);
   setHold(generated);
   setHoldTask(null);
   setHoldBusy(false);
   notify?.('手拿商品图已生成，请放大检查手指和商品后再创建');
  } else if (['failed', 'cancelled'].includes(run.status)) {
   setHoldTask(null);
   setHoldBusy(false);
   fail(run.error?.message || (run.status === 'cancelled' ? '手拿商品图生成已取消。' : '手拿商品图生成失败，请换持物方式后重试。'));
  }
 }, [editor.runs, holdTask, notify]);

 const channel = (editor.channels || []).find(item => item.id === editor.defaults?.video?.channelId);
 const points = estimateVideoPoints({ duration, resolution }, channel?.executorConfig);
 const voiceConfigured = Boolean(editor.voiceConfigured);
 const limitText = useMemo(() => `${[...text].length} / ${limit} 字`, [text, limit]);
 // 已生成的数字人单独归组：既支持从素材库直接选用，也避免它们混进商品参考图。
 const presenterTaskIds = useMemo(() => {
  const tasks = [...(detail?.project?.tasks || []), ...(editor.tasks || [])];
  return new Set(tasks.filter(task => task && (task.presenterPortrait === true || task.title === '人物定妆')).map(task => task.id));
 }, [detail?.project?.tasks, editor.tasks]);
 const heldTaskIds = useMemo(() => {
  const tasks = [...(detail?.project?.tasks || []), ...(editor.tasks || [])];
  return new Set(tasks.filter(task => task && task.presenterHeld === true).map(task => task.id));
 }, [detail?.project?.tasks, editor.tasks]);
 const isHeldAsset = asset => asset.derivedFrom?.kind === 'presenter-held' || (asset.taskId && heldTaskIds.has(asset.taskId));
 const isPresenterAsset = asset => asset.derivedFrom?.kind === 'presenter-portrait' || (asset.taskId && presenterTaskIds.has(asset.taskId)) || /^人物定妆/.test(asset.name || '');
 const presenterAssets = useMemo(() => assets.filter(asset => !isHeldAsset(asset) && isPresenterAsset(asset)), [assets, presenterTaskIds, heldTaskIds]);
 const productAssets = useMemo(() => assets.filter(asset => !isPresenterAsset(asset) && !isHeldAsset(asset)), [assets, presenterTaskIds, heldTaskIds]);
 // 历史上生成过的手拿商品图也列入候选，刷新或重开弹窗后不必重新生成。
 useEffect(() => {
  const old = assets.filter(isHeldAsset);
  if (old.length) setHoldCandidates(list => [...list, ...old.filter(asset => !list.some(item => item.id === asset.id))]);
 }, [assets, heldTaskIds]);
 useEffect(() => {
  if (presenterAssets.length) setPicked(old => old.filter(id => !presenterAssets.some(asset => asset.id === id)));
 }, [presenterAssets]);
 // 创建条件用清单直接说明，避免只看到一个置灰按钮却不知道还缺什么。
 const missing = [];
 if (!writable) missing.push('可编辑权限');
 if (!person) missing.push(personSource === 'generated' ? '人物图（点上方「生成人物图」）' : '人物图（先上传照片）');
 if (project.productId && !picked.length && !hold) missing.push('商品参考图');
 if (!text.trim()) missing.push('台词（可直接填写或点「AI 起草台词」）');

 const uploadPerson = async file => {
  if (!file || !writable) return;
  setUploading(true); setError('');
  try {
   const asset = await editor.uploadAsset(file);
   setPerson(asset); setPersonSource('upload');
  } catch (e) { fail(e.message); }
  finally { setUploading(false); }
 };
 const uploadProduct = async file => {
  if (!file || !writable) return;
  setUploading(true); setError('');
  try {
   const asset = await editor.uploadAsset(file);
   setAssets(old => [...new Map([asset, ...old].map(item => [item.id, item])).values()]);
   setPicked(old => old.includes(asset.id) || old.length >= 3 ? old : [...old, asset.id]);
   if (picked.length >= 3) fail('商品参考图最多 3 张。');
  } catch (e) { fail(e.message); }
  finally { setUploading(false); }
 };
 const pick = id => {
  setError('');
  if (picked.includes(id)) setPicked(picked.filter(item => item !== id));
  else if (picked.length >= 3) fail('商品参考图最多 3 张。');
  else setPicked([...picked, id]);
 };
 const generatePerson = async () => {
  if (!writable || imageBusy) return;
  setImageBusy(true); setError('');
  try {
   await flush?.();
   const data = await creationRequest(backend, base + '/presenter-image', { prompt: imagePrompt });
   accept?.(data);
   const taskId = data.created?.taskId || null;
   setImageTask(taskId);
   if (!taskId) { setImageBusy(false); fail('没有拿到人物图任务编号，请重试。'); }
  } catch (e) { setImageBusy(false); fail(e.message); }
 };
 const generateHeld = async () => {
  if (!writable || holdBusy) return;
  if (!person) { failAt('请先在第 1 步选择或生成人物图。', personRef); return; }
  if (!picked.length) { failAt('请先在第 2 步选择至少一张商品参考图。', productRef); return; }
  if (holdPrompt === 'custom' && !holdExtra.trim()) { fail('选择自定义时请填写补充说明。'); return; }
  setHoldBusy(true); setError('');
  try {
   await flush?.();
   const data = await creationRequest(backend, base + '/presenter-held-image', { personAssetId: person.id, productAssetIds: picked, holdPrompt, extra: holdExtra });
   accept?.(data);
   const taskId = data.created?.taskId || null;
   setHoldTask(taskId);
   if (!taskId) { setHoldBusy(false); fail('没有拿到手拿商品图任务编号，请重试。'); }
  } catch (e) { setHoldBusy(false); fail(e.message); }
 };
 const writeScript = async () => {
  if (scriptBusy) return;
  setScriptBusy(true); setError('');
  try {
   const data = await creationRequest(backend, base + '/presenter-script', { duration, style, instructions: hint });
   setText(data.text || '');
   if (!data.text) fail('台词生成失败，请重试。');
  } catch (e) { fail(e.message); }
  finally { setScriptBusy(false); }
 };
 const submit = async () => {
  if (busy) return;
  setError('');
  if (!writable) { fail('当前账号没有编辑权限，无法创建。'); return; }
  if (!person) { failAt(personSource === 'generated' ? '请先点「生成人物图」，等人物图生成完成后再创建。' : '请先上传一张人物照片。', personRef); return; }
  if (project.productId && !picked.length && !hold) { failAt('请至少选择一张商品参考图。', productRef); return; }
  const line = [...text].slice(0, limit).join('').trim();
  if (!line) { failAt('请填写台词，或点「AI 起草台词」自动生成。', dialogueRef); return; }
  setBusy(true);
  try {
   await flush?.();
   const data = await creationRequest(backend, base + '/presenter', {
    personAssetId: person.id, holdAssetId: hold?.id || '', personSource, productAssetIds: picked, style, duration, resolution, ratio, dubMode, dialogueText: line,
   });
   accept?.(data);
   notify?.('人物口播分镜已创建；请先合成配音，再生成视频');
   onCreated?.(data);
  } catch (e) { fail(e.message); }
  finally { setBusy(false); }
 };

 return createPortal(
  <div className="cp-modal-backdrop presenter-backdrop" role="dialog" aria-modal="true" aria-label="人物口播" onClick={event => { if (event.target === event.currentTarget && !busy) onClose?.(); }}>
   <div className="cp-modal presenter-modal">
    <header>
     <div><h2>人物口播</h2><p className="v3-note">先生成「人物手拿商品」的静态图，再以它为首帧生成约 8 秒口播分镜；商品外观以参考图为准。</p></div>
     <button type="button" className="presenter-close" aria-label="关闭" disabled={busy} onClick={onClose}>×</button>
    </header>
    {error && <div className="v3-alert" role="alert">{error}<button type="button" aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}

    <section className="presenter-section" ref={personRef}>
     <h3>1. 出镜人物</h3>
     <div className="presenter-tabs" role="tablist" aria-label="人物来源">
      <button type="button" role="tab" aria-selected={personSource === 'upload'} className={personSource === 'upload' ? 'on' : ''} onClick={() => setPersonSource('upload')}>上传真人照片</button>
      <button type="button" role="tab" aria-selected={personSource === 'generated'} className={personSource === 'generated' ? 'on' : ''} onClick={() => setPersonSource('generated')}>AI 生成虚拟人物</button>
     </div>
     <div className="presenter-person">
      <div className="presenter-person-frame">{person ? <img src={fileUrl?.(person.id) || ''} alt="已选择的人物参考" /> : <span>{personSource === 'generated' ? '尚未生成' : '尚未上传'}</span>}</div>
      <div className="presenter-person-body">
       {personSource === 'upload' ? <>
        <label className="v3-btn small presenter-file">选择人物照片<input type="file" accept="image/*" disabled={!writable || uploading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; uploadPerson(file); }} /></label>
        <p className="v3-note">正面半身、五官清晰、光线均匀的照片效果最好；仅用于本项目的生成参考。</p>
       </> : <>
        <label className="v3-field"><span>人物外观描述<span className="count">{imagePrompt.length} / 2000</span></span><textarea rows={3} maxLength={2000} value={imagePrompt} disabled={!writable || imageBusy} onChange={event => setImagePrompt(event.target.value)} placeholder="例如：30 岁左右的亚洲男性，短发，浅蓝衬衫，亲和自然" /></label>
        <div className="presenter-inline">
         <button type="button" className="v3-btn small primary" disabled={!writable || imageBusy || !imagePrompt.trim()} onClick={generatePerson}>{imageBusy ? '人物图生成中…' : person ? '重新生成人物图' : '生成人物图'}</button>
         {imageBusy && <span className="v3-note" role="status">正在调用生图模型，完成后会自动填入左侧预览；可以先去选商品图。</span>}
        </div>
       </>}
       {person && <button type="button" className="v3-btn small" disabled={!writable || imageBusy} onClick={() => setPerson(null)}>清除人物</button>}
      </div>
     </div>
     {presenterAssets.length > 0 && <div className="presenter-portraits">
      <span className="presenter-portraits-label">从已生成的数字人中选择</span>
      <div className="presenter-portraits-grid">
       {presenterAssets.map(asset => <button type="button" key={asset.id} className={`presenter-portrait${person?.id === asset.id ? ' on' : ''}`} aria-pressed={person?.id === asset.id} title={asset.name || '人物定妆'} onClick={() => { setPerson(asset); setPersonSource('generated'); setError(''); }}>
        <img src={fileUrl?.(asset.id) || ''} alt={asset.name || '人物定妆'} loading="lazy" />
        <span>{asset.name || '人物定妆'}</span>
       </button>)}
      </div>
     </div>}
    </section>

    <section className="presenter-section" ref={productRef}>
     <h3>2. 商品参考图 <small>{picked.length} / 3</small></h3>
     {project.productId ? <p className="v3-note">从商品创作图或本项目图片中选择 1–3 张；模型会按参考图保持商品大致外观。</p> : <p className="v3-note">项目未关联商品，可以不上传商品图，只生成人物口播。</p>}
     {assetsLoading ? <p className="v3-note" role="status">正在加载商品图片…</p> : <div className="presenter-assets">
      {productAssets.map(asset => <button type="button" key={asset.id} className={`presenter-asset${picked.includes(asset.id) ? ' on' : ''}`} aria-pressed={picked.includes(asset.id)} title={asset.name} onClick={() => pick(asset.id)}>
       <img src={fileUrl?.(asset.id) || ''} alt={asset.name || '商品参考图'} loading="lazy" />
       <span>{asset.name || '未命名图片'}</span>
       {picked.includes(asset.id) && <b aria-hidden="true">✓</b>}
      </button>)}
      {!productAssets.length && <p className="v3-note">商品还没有可用图片，可以直接上传一张。</p>}
     </div>}
     <label className="v3-btn small presenter-file">上传商品图<input type="file" accept="image/*" disabled={!writable || uploading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; uploadProduct(file); }} /></label>
    </section>

    <section className="presenter-section" ref={holdRef}>
     <h3>3. 手拿商品图 <small>{hold ? '已确认 1 张' : holdCandidates.length ? `${holdCandidates.length} 张候选` : '未生成'}</small></h3>
     <p className="v3-note">把第 1 步的人物和第 2 步的商品交给改图模型，合成「人物手里拿着商品」的静态图；视频会以这张图开场，手和商品位置由它固定。人物图需要露出双手（半身、手在胸前）。</p>
     <div className="presenter-grid">
      <label>提示词选择<select value={holdPrompt} disabled={!writable || holdBusy} onChange={event => setHoldPrompt(event.target.value)}>{HOLD_PROMPT_OPTIONS.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>
     </div>
     <label className="v3-field"><span>补充说明（可选）<span className="count">{holdExtra.length} / 500</span></span><textarea rows={2} maxLength={500} value={holdExtra} disabled={!writable || holdBusy} onChange={event => setHoldExtra(event.target.value)} placeholder="例如：瓶身标签朝向镜头；右手托住瓶底" /></label>
     <details className="presenter-prompt-preview"><summary>查看将发送给模型的完整提示词</summary><pre>{presenterHoldPrompt(holdPrompt, holdExtra)}</pre></details>
     <div className="presenter-inline">
      <button type="button" className="v3-btn small primary" disabled={!writable || holdBusy} onClick={generateHeld}>{holdBusy ? '手拿商品图生成中…' : holdCandidates.length ? '再生成一张候选' : '生成手拿商品图'}</button>
      {holdBusy && <span className="v3-note" role="status">正在调用改图模型，完成后会出现在下方候选里。</span>}
      {hold && <button type="button" className="v3-btn small" disabled={busy} onClick={() => setHold(null)}>取消选用</button>}
     </div>
     {holdCandidates.length > 0 && <div className="presenter-portraits-grid">
      {holdCandidates.map(asset => <button type="button" key={asset.id} className={`presenter-portrait${hold?.id === asset.id ? ' on' : ''}`} aria-pressed={hold?.id === asset.id} title="放大检查：手指数量、商品是否完整、有没有穿模" onClick={() => { setHold(asset); setError(''); }}>
       <img src={fileUrl?.(asset.id) || ''} alt="手拿商品候选图" loading="lazy" />
       <span>{hold?.id === asset.id ? '✓ 已选用' : '点击选用'}</span>
      </button>)}
     </div>}
     <p className="v3-note">选用前请放大检查：每只手五根手指、商品完整且不遮脸、没有穿模。不满意可换持物方式再生成。不选用也能创建，但会退回到「人物 + 商品参考」的一次性生成，手和商品更容易漂移。</p>
    </section>

    <section className="presenter-section" ref={dialogueRef}>
     <h3>4. 口播台词 <small>{limitText}</small></h3>
     <label className="v3-field"><span>人物第一人称台词</span><textarea rows={3} maxLength={limit} value={text} disabled={!writable || busy} onChange={event => setText(event.target.value)} placeholder="例如：这款杯子我用了两周，保温真的稳，早上装的热水到下午还是温的。" /></label>
     <div className="presenter-inline">
      <input className="presenter-hint" aria-label="想突出的卖点（可选）" maxLength={200} value={hint} disabled={!writable || scriptBusy} onChange={event => setHint(event.target.value)} placeholder="想让台词突出什么？（可选）" />
      <button type="button" className="v3-btn small" disabled={!writable || scriptBusy} onClick={writeScript}>{scriptBusy ? 'AI 起草中…' : 'AI 起草台词'}</button>
     </div>
     <p className="v3-note">AI 只会使用商品资料里已有的事实；价格、认证、销量、功效结论需要你人工确认后再写。</p>
    </section>

    <section className="presenter-section">
     <h3>5. 生成设置</h3>
     <div className="presenter-grid">
      <label>时长<select value={duration} disabled={!writable || busy} onChange={event => setDuration(Number(event.target.value))}>{PRESENTER_DURATIONS.map(value => <option key={value} value={value}>{value} 秒</option>)}</select></label>
      <label>展示方式<select value={style} disabled={!writable || busy} onChange={event => setStyle(event.target.value)}>{PRESENTER_STYLES.map(value => <option key={value} value={value}>{PRESENTER_STYLE_LABEL[value]}</option>)}</select></label>
      <label>配音方式<select value={hold ? 'post' : dubMode} disabled={!writable || busy || Boolean(hold)} onChange={event => setDubMode(event.target.value)}><option value="lipsync">口型同步</option><option value="post">后期配音（不对口型）</option></select></label>
      <label>分辨率<select value={resolution} disabled={!writable || busy} onChange={event => setResolution(event.target.value)}>{VIDEO_RESOLUTIONS.filter(value => ['480P', '768P', '1080P'].includes(value)).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>画面比例<select value={hold ? 'adaptive' : ratio} disabled={!writable || busy || Boolean(hold)} onChange={event => setRatio(event.target.value)}>{hold && <option value="adaptive">跟随手拿商品图</option>}<option value="9:16">9:16 竖屏</option><option value="16:9">16:9 横屏</option><option value="1:1">1:1 方形</option></select></label>
      <div className="presenter-cost"><span>视频预估</span><strong>{points === null ? '—' : pointText(points)}</strong><small>不含语音合成</small></div>
     </div>
     {!voiceConfigured && <p className="vn-warn" role="status">还没有配置火山引擎语音渠道：可以创建分镜，但暂时不能合成台词配音。</p>}
     {hold
      ? <p className="v3-note">已选手拿商品图：视频以它为首帧、比例跟随该图，构图和脸部大小保持不变；先后期配音，再在本镜预览点「只改嘴」做真实口型。</p>
      : <p className="v3-note">口型同步会先把台词合成为参考音频，再让 H3 按音频说话；首次使用建议先用 480P 做样片验证效果。</p>}
    </section>

    <footer className="presenter-actions">
     {missing.length
      ? <span className="presenter-missing" role="status">创建前还需：{missing.join('、')}</span>
      : <span className="v3-note">创建后会自动选中新分镜并展开「台词与配音」；先点「合成配音」，再点「生成本镜」。</span>}
     <button type="button" className="v3-btn" disabled={busy} onClick={onClose}>取消</button>
     <button type="button" className="v3-btn primary" disabled={!writable || busy || imageBusy || uploading} onClick={submit}>{busy ? '创建中…' : '创建口播分镜'}</button>
    </footer>
   </div>
  </div>, document.body);
}
