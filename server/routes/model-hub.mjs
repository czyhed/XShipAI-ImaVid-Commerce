import { requireAdmin, requireViewer, requireOperator } from '../access.mjs';
import { newChannelId, normalizeBaseUrl, validateChannelName, validateApiKey, validateProtocol, channelSecret } from '../channels.mjs';
import { normalizeOss, packAliyunSecret } from '../providers/oss-transfer.mjs';
import { AppError } from '../errors.mjs';
import { validateUrl } from '../providers/creation-http.mjs';
function route(method,pattern,action,{write=false,status=200}={}) {
 return {method,pattern,async handler(request){
  const {ctx,req,res,reply}=request;if(!ctx.modelHub)return false;
  if(write)requireAdmin(ctx);else requireViewer(ctx);
  const result=write?await ctx.modelHub.mutate(req.headers['if-match'],hub=>action({...request,ctx:{...ctx,modelHub:hub}})):await action(request);
  const catalog=await ctx.modelHub.catalog();res.setHeader('ETag',catalog.etag);reply(res,status,result);return true;
 }};
}
// H3 视频渠道的积分余额与 Skill 列表（只读，不改配置）。未指定渠道时使用视频环节默认渠道。
function videoRoute(path) {
 return {method:'GET',pattern:new RegExp('^/api/model-hub/video/'+path+'$'),async handler({ctx,url,res,reply}){
  if(!ctx.modelHub)return false;
  requireOperator(ctx);
  let channelId=url.searchParams.get('channelId');
  if(!channelId)channelId=(await ctx.modelHub.catalog()).defaults.video?.channelId;
  if(!channelId)throw new AppError('MODEL_NOT_CONFIGURED','请先配置视频环节的默认模型。',422);
  reply(res,200,path==='balance'?{balance:await ctx.modelHub.videoBalance(channelId)}:{skills:await ctx.modelHub.videoSkills(channelId)});return true;
 }};
}
export function routes() {return [
 videoRoute('balance'),
 videoRoute('skills'),
 route('GET',new RegExp('^/api/model-hub$'),({ctx})=>ctx.modelHub.catalog()),
 route('POST',new RegExp('^/api/model-hub/defaults$'),async({ctx,body})=>({model:await ctx.modelHub.setDefault(body.stage,body.channelId,body.modelId)}),{write:true}),
 route('POST',new RegExp('^/api/model-hub/channels$'),async({ctx,body})=>{
  const adapter=body.adapter||'openai-compatible',executorConfig=body.executorConfig||{};validateProtocol(adapter,executorConfig);
  const baseUrl=normalizeBaseUrl(body.baseUrl,adapter);validateUrl(baseUrl,{local:true});if(executorConfig.videoBaseUrl)validateUrl(executorConfig.videoBaseUrl,{local:true});
  const secret=adapter==='aliyun-lipsync'?packAliyunSecret(validateApiKey(body.apiKey),normalizeOss(body.oss)):channelSecret(adapter,body);
  const channel=await ctx.modelHub.channels.insert({id:newChannelId(),name:validateChannelName(body.name),baseUrl,apiKey:secret,adapter,executorConfig});
  // 新增火山语音渠道后，语音环节还没有默认时自动指向它。
  if(adapter==='volcengine-tts')await ctx.modelHub.ensureVoiceDefault(channel.id);
  // 新增对口型渠道（可灵 / 阿里云百炼）后，对口型环节还没有默认时自动指向它。
  if(adapter==='kling'||adapter==='aliyun-lipsync')await ctx.modelHub.ensureLipsyncDefault(channel.id);
  return {channel};
 },{write:true,status:201}),
 route('POST',new RegExp('^/api/model-hub/channels/(ch_[0-9a-f]{16})/sync$'),({ctx,match})=>ctx.modelHub.sync(match[1]),{write:true}),
 route('POST',new RegExp('^/api/model-hub/channels/(ch_[0-9a-f]{16})/models$'),async({ctx,match,body})=>({model:await ctx.modelHub.configure(match[1],body.modelId,body)}),{write:true}),
 route('DELETE',new RegExp('^/api/model-hub/channels/(ch_[0-9a-f]{16})/models$'),async({ctx,match,url})=>({removed:await ctx.modelHub.removeModel(match[1],url.searchParams.get('modelId')||'')}),{write:true}),
 route('PATCH',new RegExp('^/api/model-hub/channels/(ch_[0-9a-f]{16})$'),async({ctx,match,body})=>{
  const current=await ctx.modelHub.channels.get(match[1]);
  const adapter=body.adapter||current?.adapter;
  const patch=body.accessKey||body.secretKey||body.apiKey!==undefined?{...body,apiKey:channelSecret(adapter,body,{required:false})}:body;
  if(body.baseUrl&&!['volcengine-tts','kling'].includes(body.adapter))validateUrl(normalizeBaseUrl(body.baseUrl,body.adapter),{local:true});
  if(body.executorConfig?.videoBaseUrl)validateUrl(body.executorConfig.videoBaseUrl,{local:true});
  return {channel:await ctx.modelHub.channels.update(match[1],patch)};
 },{write:true}),
 {method:'POST',pattern:new RegExp('^/api/model-hub/channels/(ch_[0-9a-f]{16})/test$'),async handler({ctx,match,res,reply}){
  if(!ctx.modelHub)return false;
  requireAdmin(ctx);
  reply(res,200,await ctx.modelHub.testVoiceChannel(match[1]));return true;
 }},
 route('DELETE',new RegExp('^/api/model-hub/channels/(ch_[0-9a-f]{16})$'),async({ctx,match})=>({channel:await ctx.modelHub.channels.remove(match[1])}),{write:true}),
 ];}
