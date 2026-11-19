import { useCallback, useEffect, useState } from 'react';
import { canAdmin } from '../lib/auth.js';
import { ConfirmDialog } from './ui.jsx';
import { VIDEO_RESOLUTIONS, DEFAULT_POINT_PRICES } from '../../../shared/creation-video-parameters.mjs';
import './CreationModels.css';

const capabilities={text:'文本',vision:'读图理解',image:'生图',video:'视频'};
const stages={product:'商品聊天',planning:'AI 规划',image:'生图',video:'视频'};
const isVoice=channel=>channel?.adapter==='volcengine-tts';
const isKling=channel=>channel?.adapter==='kling';
const isLipSync=channel=>channel?.adapter==='kling'||channel?.adapter==='aliyun-lipsync';
const empty={models:[],channels:[],defaults:{},etag:''};
const selection=model=>model.channelId+'::'+model.modelId;
const isH3=channel=>channel.adapter==='minimax-h3'||channel.executorConfig?.video==='minimax-h3';
const pointLabel=value=>Number.isInteger(value)?String(value):value.toFixed(2).replace(/0$/,'');
const noop=()=>{};

// H3 视频渠道详情：可用 / 预占 / 总积分与分辨率单价表（保存到渠道 executorConfig.pointPrices）。
function VideoChannelPanel({channel,admin,busy,onSave}) {
 const [balance,setBalance]=useState(null),[problem,setProblem]=useState(''),[loading,setLoading]=useState(false);
 const saved={...DEFAULT_POINT_PRICES,...(channel.executorConfig?.pointPrices||{})};
 const [prices,setPrices]=useState(()=>Object.fromEntries(VIDEO_RESOLUTIONS.map(r=>[r,String(saved[r])])));
 const [priceError,setPriceError]=useState('');
 useEffect(()=>{setPrices(Object.fromEntries(VIDEO_RESOLUTIONS.map(r=>[r,String(saved[r])])));},[JSON.stringify(saved)]);
 const refresh=useCallback(async()=>{
  setLoading(true);setProblem('');
  try{
   const response=await fetch('/api/model-hub/video/balance?channelId='+encodeURIComponent(channel.id));const result=await response.json();
   if(!response.ok)throw new Error(result.error?.message||'积分余额查询失败。');
   setBalance(result.balance);
  }catch(e){setBalance(null);setProblem(e.message);}
  finally{setLoading(false);}
 },[channel.id]);
 useEffect(()=>{refresh();},[refresh]);
 function save(){
  const next={};
  for(const resolution of VIDEO_RESOLUTIONS){
   const value=Number(prices[resolution]);
   if(prices[resolution]===''||!Number.isFinite(value)||value<0){setPriceError(`${resolution} 单价需要是不小于 0 的数字。`);return;}
   next[resolution]=value;
  }
  setPriceError('');
  onSave({...(channel.executorConfig||{}),pointPrices:next});
 }
 const dirty=VIDEO_RESOLUTIONS.some(r=>Number(prices[r])!==saved[r]||prices[r]==='');
 return <div className="cm-video" aria-label={'视频渠道详情 '+channel.name}>
  <div className="cm-points"><strong>积分</strong>
   {balance?<><span>可用 <b>{pointLabel(balance.available)}</b></span><span>预占 <b>{pointLabel(balance.reserved)}</b></span><span>总积分 <b>{pointLabel(balance.total)}</b></span></>:<span className={problem?'cm-unavailable':'cm-muted'}>{problem?'积分余额不可用：'+problem:loading?'正在查询积分余额…':'余额未知'}</span>}
   <button type="button" aria-label={'刷新积分 '+channel.name} disabled={loading} onClick={refresh}>{loading?'查询中…':'刷新'}</button></div>
  <div className="cm-prices"><strong>每秒积分单价</strong>
   {VIDEO_RESOLUTIONS.map(resolution=><label key={resolution}>{resolution}<input type="number" min="0" step="0.5" aria-label={resolution+' 单价'} value={prices[resolution]} disabled={!admin||busy} onChange={e=>setPrices({...prices,[resolution]:e.target.value})}/></label>)}
   {admin&&<button type="button" disabled={busy||!dirty} onClick={save}>保存单价</button>}</div>
  {priceError&&<div className="cm-error" role="alert">{priceError}</div>}
 </div>;
}

export default function CreationModels({backend,notify=noop}) {
 const [catalog,setCatalog]=useState(empty),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
 const [section,setSection]=useState('catalog');
 const [error,setError]=useState(''),[channelFilter,setChannelFilter]=useState(''),[search,setSearch]=useState('');
 const [editingChannel,setEditingChannel]=useState(null),[editingModel,setEditingModel]=useState(null),[confirmChannel,setConfirmChannel]=useState(null),[confirmModel,setConfirmModel]=useState(null);
 const admin=canAdmin(backend.session);
 const request=useCallback(async(path='',body,method='GET')=>{
  const response=await fetch('/api/model-hub'+path,{method,headers:{...(method==='GET'?{}:{'X-CSRF-Token':backend.csrf||backend.session?.csrfToken||'','If-Match':catalog.etag}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error?.message||'模型配置请求失败。');
  return result;
 },[backend.csrf,backend.session?.csrfToken,catalog.etag]);
 const load=useCallback(async()=>{
  const response=await fetch('/api/model-hub');const result=await response.json();
  if(!response.ok)throw new Error(result.error?.message||'模型目录读取失败。');
  setCatalog(result);return result;
 },[]);
 useEffect(()=>{load().catch(e=>{setError(e.message);notify(e.message,'error');}).finally(()=>setLoading(false));},[load,notify]);
 async function change(path,body,method='POST',done,message='模型配置已保存') {
  if(busy)return;setBusy(true);setError('');
  try {await request(path,body,method);await load();done?.();notify(message);}
  catch(e){if(editingChannel||editingModel)setError(e.message);else notify(e.message,'error');await load().catch(()=>{});}
  finally{setBusy(false);}
 }
 // 模型正被哪些环节当作默认模型（这些环节不解绑就不允许删除）。
 const defaultStages=model=>Object.entries(stages).filter(([stage])=>catalog.defaults[stage]?.channelId===model.channelId&&catalog.defaults[stage]?.modelId===model.modelId).map(([,label])=>label);
 const visible=catalog.models.filter(m=>(!channelFilter||m.channelId===channelFilter)&&(!search||[m.name,m.modelId].join(' ').toLowerCase().includes(search.toLowerCase())));
 const compatible=(m,stage)=>m.available&&m.enabled&&m.channelEnabled&&m.capabilities.includes(stage==='product'||stage==='planning'?'text':stage)&&m.executorCapabilities.includes(stage==='product'||stage==='planning'?'text':stage);
 function openChannel(channel={}) {const savedOss=channel.executorConfig?.oss||{};setEditingChannel({...channel,apiKey:'',accessKey:'',secretKey:'',ossBucket:savedOss.bucket||'',ossRegion:savedOss.region||'',ossAccessKeyId:'',ossAccessKeySecret:'',ossClear:false,adapter:channel.adapter||'openai-compatible',executorConfig:channel.executorConfig||{},enabled:channel.enabled??true});setError('');}
 async function checkVoice(channel) {
  if(busy)return;setBusy(true);setError('');
  try{const result=await request('/channels/'+channel.id+'/test',{},'POST');notify(result.message||'配置格式正确');}
  catch(e){notify(e.message,'error');}
  finally{setBusy(false);}
 }
 async function saveChannel(event) {
  event.preventDefault();const {id,name,adapter,baseUrl,apiKey,accessKey,secretKey,executorConfig,enabled}=editingChannel;
  // OSS 中转是选填：留空的字段由服务端沿用已保存的值，四项最终都要齐全；勾「清除」就删掉配置。
  let oss;
  if(adapter==='aliyun-lipsync')oss=editingChannel.ossClear?null:{bucket:editingChannel.ossBucket,region:editingChannel.ossRegion,accessKeyId:editingChannel.ossAccessKeyId,accessKeySecret:editingChannel.ossAccessKeySecret};
  // 切换协议时去掉上一个协议专属的展示配置，避免被服务端判为无效执行器配置。
  const config=adapter==='aliyun-lipsync'?executorConfig:Object.fromEntries(Object.entries(executorConfig||{}).filter(([key])=>key!=='oss'));
  await change('/channels'+(id?'/'+id:''),{name,adapter,baseUrl,...(adapter==='kling'?(accessKey||secretKey?{accessKey,secretKey}:{}):apiKey?{apiKey}:{}),...(oss!==undefined?{oss}:{}),executorConfig:config,enabled},id?'PATCH':'POST',()=>setEditingChannel(null));
 }
 return <section className="cm-root" aria-busy={busy}>
  <header className="cm-header"><h2>模型中心</h2><div className="cm-actions"><button type="button" title="刷新目录视图" aria-label="刷新目录视图" onClick={()=>load().catch(e=>{setError(e.message);notify(e.message,'error');})} disabled={busy}>↻</button>{admin&&<button type="button" onClick={()=>openChannel()}>新增渠道</button>}</div></header>
  <nav className="cm-tabs" aria-label="模型中心视图">{[['catalog','模型目录'],['channels','渠道管理'],['defaults','环节默认']].map(([id,label])=><button key={id} type="button" aria-pressed={section===id} onClick={()=>setSection(id)}>{label}</button>)}</nav>
  {section==='defaults'&&<div className="cm-defaults"><label>语音配音<select aria-label="语音配音默认渠道" value={catalog.defaults.voice?.channelId||''} disabled={!admin||busy} onChange={e=>{if(e.target.value)change('/defaults',{stage:'voice',channelId:e.target.value,modelId:'voice'});}}><option value="">未配置</option>{catalog.channels.filter(c=>isVoice(c)&&c.enabled).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>对口型<select aria-label="对口型默认渠道" value={catalog.defaults.lipsync?.channelId||''} disabled={!admin||busy||!catalog.channels.some(c=>isLipSync(c)&&c.enabled)} onChange={e=>{if(e.target.value)change('/defaults',{stage:'lipsync',channelId:e.target.value,modelId:'lipsync'});}}><option value="">{catalog.channels.some(c=>isLipSync(c)&&c.enabled)?'未配置':'暂无可用渠道'}</option>{catalog.channels.filter(c=>isLipSync(c)&&c.enabled).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{!catalog.channels.some(c=>isLipSync(c)&&c.enabled)&&<small className="cm-muted">先在「渠道管理」新增阿里云百炼对口型或可灵渠道</small>}</label>{Object.entries(stages).map(([stage,label])=>{
   const selected=catalog.defaults[stage],value=selected?selection(selected):'';
   const options=catalog.models.filter(m=>compatible(m,stage));
   const missing=value&&!options.some(m=>selection(m)===value);
   return <label key={stage}>{label}<select aria-label={label+'默认模型'} value={value} disabled={!admin||busy} onChange={e=>{const model=catalog.models.find(m=>selection(m)===e.target.value);if(model)change('/defaults',{stage,channelId:model.channelId,modelId:model.modelId});}}><option value="">未配置</option>{missing&&<option value={value}>当前默认不可用：{selected.modelId}</option>}{options.map(m=><option key={selection(m)} value={selection(m)}>{catalog.channels.find(c=>c.id===m.channelId)?.name} / {m.name}</option>)}</select></label>;
  })}</div>}
  {section==='channels'&&<div className="cm-channels">{catalog.channels.map(channel=><div className="cm-channel-block" key={channel.id}><div className="cm-channel">
   <div><strong>{channel.name}</strong><span className={channel.enabled?'cm-status':'cm-muted'}>{channel.enabled?'启用':'停用'}</span><small>{channel.adapter} · {channel.keyHint}</small><span className="cm-url">{channel.baseUrl}</span>{isVoice(channel)&&<small>资源 ID：{channel.executorConfig?.resourceId||'seed-tts-2.0'}（按字符计量，不换算金额）</small>}{isH3(channel)&&<span className="cm-hint">请前往「模型目录」手动添加模型，勾选「视频」{admin&&<button type="button" onClick={()=>setSection('catalog')}>前往模型目录</button>}</span>}</div>
   {admin&&<div className="cm-actions">{isVoice(channel)?<button disabled={busy} aria-label={'检查配置 '+channel.name} title="只校验配置格式，不调用付费合成" onClick={()=>checkVoice(channel)}>检查配置</button>:<button disabled={busy||channel.adapter==='minimax-h3'||isLipSync(channel)} title={channel.adapter==='minimax-h3'?'H3 使用手工模型 ID':isLipSync(channel)?'对口型渠道没有模型目录':'同步供应商模型目录'} onClick={()=>change('/channels/'+channel.id+'/sync',{})}>同步目录</button>}<button disabled={busy} aria-label={'编辑渠道 '+channel.name} onClick={()=>openChannel(channel)}>编辑</button><button disabled={busy} onClick={()=>change('/channels/'+channel.id,{enabled:!channel.enabled},'PATCH')}>{channel.enabled?'停用':'启用'}</button><button className="cm-danger" disabled={busy} onClick={()=>setConfirmChannel(channel)}>删除</button></div>}
  </div>{isH3(channel)&&<VideoChannelPanel channel={channel} admin={admin} busy={busy} onSave={executorConfig=>change('/channels/'+channel.id,{executorConfig},'PATCH')}/>}</div>)}</div>}
  {section==='catalog'&&<><div className="cm-toolbar"><label>渠道<select aria-label="筛选渠道" value={channelFilter} onChange={e=>setChannelFilter(e.target.value)}><option value="">全部渠道</option>{catalog.channels.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><input type="search" aria-label="搜索模型" placeholder="搜索模型名称或 ID" value={search} onChange={e=>setSearch(e.target.value)}/><span>{visible.length} 个模型</span>{admin&&<button disabled={busy||!catalog.channels.length} onClick={()=>setEditingModel({channelId:channelFilter||catalog.channels[0]?.id,modelId:'',name:'',enabled:false,capabilities:[],manual:true,isNew:true})}>手工添加模型</button>}</div>
  <div className="cm-table-scroll"><table className="cm-table"><thead><tr><th>模型</th><th>渠道</th><th>人工能力</th><th>执行器支持</th><th>状态</th>{admin&&<th>操作</th>}</tr></thead><tbody>{visible.map(model=>{
   const used=defaultStages(model);
   return <tr key={selection(model)}><td><strong>{model.name}</strong>{model.name!==model.modelId&&<small>{model.modelId}</small>}{model.manual&&<small>手工 ID</small>}</td><td>{catalog.channels.find(c=>c.id===model.channelId)?.name||'已删除渠道'}</td><td>{model.capabilities.map(c=>capabilities[c]).join('、')||'未指定'}</td><td>{model.executorCapabilities.map(c=>capabilities[c]).join('、')||'未接入'}</td><td><span className={!model.available||!model.channelEnabled?'cm-unavailable':model.enabled?'cm-status':'cm-muted'}>{!model.available?'目录已消失':!model.channelEnabled?'渠道不可用':model.enabled?'已启用':'未启用'}</span></td>{admin&&<td className="cm-row-actions"><button disabled={busy||!model.channelEnabled} aria-label={'配置 '+model.modelId} onClick={()=>setEditingModel({...model})}>配置</button>{model.manual&&<button className="cm-danger" disabled={busy||used.length>0} title={used.length?`正作为「${used.join('、')}」的默认模型，请先到「环节默认」切换掉再删除`:'删除这个手工添加的模型'} aria-label={'删除模型 '+model.modelId} onClick={()=>setConfirmModel(model)}>删除</button>}</td>}</tr>;
  })}</tbody></table></div>
  {!visible.length&&<p className="cm-empty">{loading?'正在读取模型目录…':'暂无模型'}</p>}</>}
  {editingChannel&&<div className="cm-backdrop"><form className="cm-dialog b-drawer" role="dialog" aria-modal="true" aria-labelledby="cm-channel-title" onSubmit={saveChannel}><header><h3 id="cm-channel-title">{editingChannel.id?'编辑渠道':'新增渠道'}</h3><button type="button" aria-label="关闭渠道" disabled={busy} onClick={()=>setEditingChannel(null)}>×</button></header>
   {error&&<div className="cm-error" role="alert">{error}</div>}<label>渠道名称<input required maxLength={40} value={editingChannel.name||''} onChange={e=>setEditingChannel({...editingChannel,name:e.target.value})}/></label>
   <label>接口协议<select value={editingChannel.adapter} onChange={e=>setEditingChannel({...editingChannel,adapter:e.target.value,executorConfig:e.target.value==='volcengine-tts'?{resourceId:'seed-tts-2.0'}:{},baseUrl:e.target.value==='volcengine-tts'?'https://openspeech.bytedance.com':e.target.value==='kling'?'https://api-beijing.klingai.com':e.target.value==='aliyun-lipsync'?'https://dashscope.aliyuncs.com':editingChannel.baseUrl})}><option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option><option value="minimax-h3">MiniMax H3</option><option value="volcengine-tts">火山引擎语音</option><option value="kling">可灵（AccessKey + SecretKey）</option><option value="aliyun-lipsync">阿里云百炼对口型（VideoRetalk，按秒后付费）</option></select></label>
   {isVoice(editingChannel)?<label>资源 ID<select aria-label="资源 ID" value={editingChannel.executorConfig.resourceId||'seed-tts-2.0'} onChange={e=>setEditingChannel({...editingChannel,executorConfig:{resourceId:e.target.value}})}><option value="seed-tts-2.0">seed-tts-2.0（系统 2.0 音色）</option><option value="seed-icl-2.0">seed-icl-2.0（复刻与设计音色）</option></select></label>:isLipSync(editingChannel)?null:<label>Base URL<input type="url" required value={editingChannel.baseUrl||''} onChange={e=>setEditingChannel({...editingChannel,baseUrl:e.target.value})}/></label>}
   {isKling(editingChannel)?<><label>AccessKey<input type="password" autoComplete="new-password" required={!editingChannel.id} placeholder={editingChannel.id?'留空保留原密钥':''} value={editingChannel.accessKey||''} onChange={e=>setEditingChannel({...editingChannel,accessKey:e.target.value})}/></label><label>SecretKey<input type="password" autoComplete="new-password" required={!editingChannel.id} placeholder={editingChannel.id?'留空保留原密钥':''} value={editingChannel.secretKey||''} onChange={e=>setEditingChannel({...editingChannel,secretKey:e.target.value})}/></label><small className="cm-muted">地址固定为可灵北京节点；两个密钥加密保存，列表只显示末四位。编辑时需要同时重新填写两项。对口型按生成秒数计费，需要先购买资源包。</small></>:<label>API Key<input type="password" autoComplete="new-password" required={!editingChannel.id} placeholder={editingChannel.id?'留空保留原密钥':''} value={editingChannel.apiKey} onChange={e=>setEditingChannel({...editingChannel,apiKey:e.target.value})}/></label>}
   {isVoice(editingChannel)&&<small className="cm-muted">地址固定为火山引擎语音服务；密钥加密保存，列表只显示末四位。</small>}
   {editingChannel.adapter==='aliyun-lipsync'&&<small className="cm-muted">地址固定为百炼北京区域；填百炼 API Key（DashScope），按生成视频秒数后付费，无需购买资源包。</small>}
   {editingChannel.adapter==='aliyun-lipsync'&&<details className="cm-oss"><summary>OSS 中转（选填；服务器没有公网 443 时必填）</summary>
    <p className="cm-muted">阿里云要从公网下载底片和配音。若平台服务器对外只开放了非标准端口，阿里云会连不上。填好下面四项后，平台会先把这两个文件上传到你自己的私有 Bucket，再用 1 小时有效的签名链接交给阿里云，不公开桶，也不需要改动服务器防火墙。</p>
    {editingChannel.id&&editingChannel.executorConfig?.oss&&!editingChannel.ossClear&&<p className="cm-status">已保存 OSS：{editingChannel.executorConfig.oss.bucket} · {editingChannel.executorConfig.oss.region} · {editingChannel.executorConfig.oss.keyHint}。下面的输入框留空即保持原配置。</p>}
    <label>Bucket<input value={editingChannel.ossBucket||''} placeholder="例如 my-lipsync" onChange={e=>setEditingChannel({...editingChannel,ossBucket:e.target.value,ossClear:false})}/></label>
    <label>地域<input value={editingChannel.ossRegion||''} placeholder="例如 oss-cn-beijing" onChange={e=>setEditingChannel({...editingChannel,ossRegion:e.target.value,ossClear:false})}/></label>
    <label>AccessKey ID<input type="password" autoComplete="new-password" placeholder={editingChannel.executorConfig?.oss?.keyHint?'已保存，留空保持不变':''} value={editingChannel.ossAccessKeyId||''} onChange={e=>setEditingChannel({...editingChannel,ossAccessKeyId:e.target.value,ossClear:false})}/></label>
    <label>AccessKey Secret<input type="password" autoComplete="new-password" placeholder={editingChannel.executorConfig?.oss?.keyHint?'已保存，留空保持不变':''} value={editingChannel.ossAccessKeySecret||''} onChange={e=>setEditingChannel({...editingChannel,ossAccessKeySecret:e.target.value,ossClear:false})}/></label>
    {editingChannel.id&&<label className="cm-check"><input type="checkbox" checked={Boolean(editingChannel.ossClear)} onChange={e=>setEditingChannel({...editingChannel,ossClear:e.target.checked})}/>清除已保存的 OSS 配置</label>}
   </details>}
   {editingChannel.adapter==='openai-compatible'&&<label>改图传输<select value={editingChannel.executorConfig.editTransport||'multipart'} onChange={e=>setEditingChannel({...editingChannel,executorConfig:{...editingChannel.executorConfig,editTransport:e.target.value}})}><option value="multipart">标准 multipart</option><option value="json-data-url">JSON Data URL（OMYAI）</option></select></label>}
   {editingChannel.adapter!=='minimax-h3'&&!isVoice(editingChannel)&&!isLipSync(editingChannel)&&<><label>视频执行器<select value={editingChannel.executorConfig.video||''} onChange={e=>{const config={...editingChannel.executorConfig};if(e.target.value)config.video=e.target.value;else{delete config.video;delete config.videoBaseUrl;}setEditingChannel({...editingChannel,executorConfig:config});}}><option value="">未接入</option><option value="minimax-h3">MiniMax H3</option></select></label>{editingChannel.executorConfig.video&&<label>视频 Base URL<input type="url" value={editingChannel.executorConfig.videoBaseUrl||''} onChange={e=>setEditingChannel({...editingChannel,executorConfig:{...editingChannel.executorConfig,videoBaseUrl:e.target.value}})}/></label>}</>}
   <footer><button type="button" disabled={busy} onClick={()=>setEditingChannel(null)}>取消</button><button disabled={busy} type="submit">保存渠道</button></footer></form></div>}
  {editingModel&&<div className="cm-backdrop"><form className="cm-dialog b-drawer" role="dialog" aria-modal="true" aria-labelledby="cm-model-title" onSubmit={event=>{event.preventDefault();change('/channels/'+editingModel.channelId+'/models',editingModel,'POST',()=>setEditingModel(null));}}><header><h3 id="cm-model-title">{editingModel.isNew?'手工添加模型':'模型配置'}</h3><button type="button" disabled={busy} aria-label="关闭模型配置" onClick={()=>setEditingModel(null)}>×</button></header>
   {error&&<div className="cm-error" role="alert">{error}</div>}<label>所属渠道<select disabled={!editingModel.isNew} value={editingModel.channelId} onChange={e=>setEditingModel({...editingModel,channelId:e.target.value})}>{catalog.channels.filter(c=>!isVoice(c)&&!isKling(c)).map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
   <label>模型 ID<input required maxLength={200} readOnly={!editingModel.isNew} value={editingModel.modelId} onChange={e=>setEditingModel({...editingModel,modelId:e.target.value})}/></label>
   <label>显示名称<input maxLength={300} value={editingModel.name} onChange={e=>setEditingModel({...editingModel,name:e.target.value})}/></label>
   <label className="cm-check"><input type="checkbox" checked={editingModel.enabled} onChange={e=>setEditingModel({...editingModel,enabled:e.target.checked})}/>启用此模型</label>
   <fieldset><legend>人工能力</legend>{Object.entries(capabilities).map(([key,label])=><label className="cm-check" key={key}><input type="checkbox" checked={editingModel.capabilities.includes(key)} onChange={e=>setEditingModel({...editingModel,capabilities:e.target.checked?[...editingModel.capabilities,key]:editingModel.capabilities.filter(c=>c!==key)})}/>{label}</label>)}</fieldset>
   <div className="b-info"><strong>执行器支持（只读）</strong><p>{(editingModel.executorCapabilities||[]).map(c=>capabilities[c]).join(' · ')||'请配置渠道执行器'}</p>人工能力不会增加执行器能力。</div><footer><button type="button" disabled={busy} onClick={()=>setEditingModel(null)}>取消</button><button disabled={busy} type="submit">保存模型</button></footer></form></div>}
  <ConfirmDialog open={Boolean(confirmChannel)} title="删除渠道" message={`删除渠道「${confirmChannel?.name||''}」？原模型配置和生成记录会保留。`} confirmText="删除渠道" busy={busy} onCancel={()=>setConfirmChannel(null)} onConfirm={()=>{const channel=confirmChannel;setConfirmChannel(null);change('/channels/'+channel.id,undefined,'DELETE');}}/>
  <ConfirmDialog open={Boolean(confirmModel)} title="删除模型" message={`删除模型「${confirmModel?.name||''}」？删除后如需恢复，需要重新手工添加。`} confirmText="删除模型" busy={busy} onCancel={()=>setConfirmModel(null)} onConfirm={()=>{const model=confirmModel;setConfirmModel(null);change('/channels/'+model.channelId+'/models?modelId='+encodeURIComponent(model.modelId),undefined,'DELETE',noop,'模型已删除');}}/>
 </section>;
}
