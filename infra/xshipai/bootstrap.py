"""Reuse the test stack's authorized model settings; keys are passed over stdin only."""
from pathlib import Path
import json, subprocess, os
os.chdir('/opt/xshipai-test')
config=dict(line.split('=',1) for line in Path('config/picagent.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
channels=[
    {'id':'ch_0000000000000011','name':'XShipAI Text','adapter':'openai-compatible',
     'baseUrl':config['CONTEXT_BASE_URL'],'apiKey':config['CONTEXT_API_KEY'],
     'models':[{'modelId':config['CONTEXT_MODEL'],'capabilities':['text'],'enabled':True,'manual':True}],
     'defaults':{'product':config['CONTEXT_MODEL'],'planning':config['CONTEXT_MODEL']}},
    {'id':'ch_0000000000000012','name':'XShipAI Image','adapter':'openai-compatible',
     'baseUrl':config['IMAGE_GENERATION_BASE_URL'].rstrip('/').removesuffix('/v1')+'/v1','apiKey':config['IMAGE_GENERATION_API_KEY'],
     'executorConfig':{'editTransport':'json-data-url'},
     'models':[{'modelId':config.get('IMAGE_GENERATION_UPSTREAM_MODEL',config['IMAGE_GENERATION_MODEL']),'capabilities':['image'],'enabled':True,'manual':True}],
     'defaults':{'image':config.get('IMAGE_GENERATION_UPSTREAM_MODEL',config['IMAGE_GENERATION_MODEL'])}}
]
script="""
import {createPool} from './server/store.mjs';
import {ChannelStore,loadEncryptionKey} from './server/channels.mjs';
import {CreationStore} from './server/creation-store.mjs';
import {ModelHub} from './server/model-hub.mjs';
let input='';for await(const part of process.stdin)input+=part;
const channels=JSON.parse(input),pool=createPool();
try {
  const hub=new ModelHub(new CreationStore(pool),new ChannelStore(pool,loadEncryptionKey()));
  const catalog=await hub.init({channels});
  console.log('Configured models:',catalog.models.map(x=>x.modelId).join(', '));
  const session=await fetch('http://127.0.0.1:4173/api/session').then(r=>r.json());
  const request=async(path,body)=>{const r=await fetch('http://127.0.0.1:4173'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error(path+' HTTP '+r.status);return r.json();};
  const products=await request('/api/creation/products');
  let product=products.items.find(x=>x.name==='XShipAI 示例保温杯');
  if(!product)product=(await request('/api/creation/products',{name:'XShipAI 示例保温杯',facts:{'容量':'500ml','颜色':'米白色','说明':'部署测试数据，用于体验商品资料与项目画布。'}})).product;
  const projects=await request('/api/creation/projects');
  if(!projects.projects.some(x=>x.name==='保温杯内容创作 · 示例'))await request('/api/creation/projects',{name:'保温杯内容创作 · 示例',productId:product.id,graphVersion:4});
  console.log('Example product and project ready; no generation submitted');
} finally {await pool.end();}
"""
subprocess.run(['docker','compose','-f','compose.json','exec','-T','shangjing','node','--input-type=module','-e',script],input=json.dumps(channels).encode(),check=True)
