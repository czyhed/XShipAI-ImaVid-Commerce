import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

// Actual App / CreationProducts, HTTP mocked at the browser boundary. No DB,
// Docker, credentials, provider calls, or existing server is used.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = await mkdtemp(path.join(os.tmpdir(), 'creation-chat-composer-'));
const pngChunk=(type,data)=>{const tag=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([size,tag,data,checksum]);};
const pngHeader=Buffer.alloc(13);pngHeader.writeUInt32BE(1,0);pngHeader.writeUInt32BE(1,4);pngHeader[8]=8;pngHeader[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),pngChunk('IHDR',pngHeader),pngChunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255]))),pngChunk('IEND',Buffer.alloc(0))]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const scenarios = [
  ['next-draft', 'Ctrl+V uploads an image; sending clears immediately, permits editing and uploads, ignores repeat send, and success preserves the next draft'],
  ['failure-overflow', 'Delayed failure preserves both sets of eight attachments, blocks sending over eight, and permits explicit removal'],
  ['upload-limit', 'Eight pending image uploads reserve all slots; repeated paste cannot upload a ninth image'],
  ['upload-navigation', 'Uploading alone prompts before product switches, app navigation and reload; abandoned results never attach to another product'],
  ['recognition-retry', 'Known recognition failure retains input and attachments, and explicit retry uses a new request key'],
  ['network-retry', 'Unconfirmed HTTP failure preserves the same unchanged request key; changed draft gets a different key'],
  ['text-keyboard', 'Plain-text Ctrl+V stays native, Shift+Enter inserts newline, empty input and IME Enter do not submit'],
];
await writeFile(path.join(evidence, 'scenarios.md'), '# Never and always\nNever silently discard a draft or attachment. Never duplicate an in-flight chat. Always reserve pending upload slots and warn before abandoning uploads.\n\n' + scenarios.map(([id, text]) => `- ${id}: ${text}`).join('\n') + '\n');
const results = [];
let vite, browser;
try {
  vite = await createServer({configFile:false, envFile:false, root:path.join(root,'web'), cacheDir:path.join(evidence,'vite-cache'), plugins:[react()], server:{host:'127.0.0.1', port:0}});
  await vite.listen();
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({headless:true, channel:process.env.PLAYWRIGHT_CHANNEL || 'msedge'});
  async function scenario(id, run, {existing = true} = {}) {
    const context = await browser.newContext({viewport:{width:1360,height:1000}, permissions:['clipboard-read','clipboard-write']});
    const page = await context.newPage();
    const events = [], failures = [], requests = [], uploads = [], chats = [], assets = new Map();
    const products = new Map();
    const makeProduct = (id, name) => ({id, kind:'product', name, revision:1, facts:{}, evidenceIds:[], creativeAssetIds:[], messages:[], suggestions:[], updatedAt:new Date().toISOString()});
    if (existing) products.set('p1', makeProduct('p1','测试商品'));
    products.set('p2', makeProduct('p2','另一个商品'));
    let uploadGate = null;
    const state = {page, chats, uploads, products, holdUploads(){uploadGate=deferred();return uploadGate;}};
    page.on('pageerror', e => events.push(e.message));
    page.on('console', m => {if(m.type()==='error') events.push(m.text());});
    await context.route('**/api/**', async route => {
      const request=route.request(), url=new URL(request.url()), pathname=url.pathname, method=request.method();
      requests.push({method,path:pathname});
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      try {
        if(pathname==='/api/session')return json({mode:'local-single-user',csrfToken:'mock-chat-csrf'});
        if(method!=='GET')assert.equal(request.headers()['x-csrf-token'],'mock-chat-csrf');
        if(pathname==='/api/creation/products'&&method==='GET')return json({items:[...products.values()],total:products.size,nextOffset:null});
        if(/^\/api\/creation\/products\/[^/]+$/.test(pathname)&&method==='GET')return json({product:products.get(pathname.split('/').at(-1))});
        if(pathname==='/api/creation/assets/upload'){
          assert.equal(url.searchParams.get('role'),'evidence');
          assert.equal(url.searchParams.get('mime'),'image/png');
          assert.deepEqual(request.postDataBuffer(),png);
          const asset={id:`a${uploads.length+1}`,name:url.searchParams.get('name'),mime:'image/png',role:'evidence',productId:url.searchParams.get('productId')};
          uploads.push(asset);const gate=uploadGate;if(gate)await gate.promise;assets.set(asset.id,asset);return json({asset});
        }
        if(/^\/api\/creation\/assets\/[^/]+\/file$/.test(pathname))return route.fulfill({status:200,contentType:'image/png',body:png});
        if(/^\/api\/creation\/assets\/[^/]+$/.test(pathname))return json({asset:assets.get(pathname.split('/').at(-1))});
        if(pathname==='/api/creation/assets')return json({items:[],total:0,nextOffset:null});
        if(/^\/api\/creation\/products(?:\/[^/]+)?\/chat$/.test(pathname)){
          const body=request.postDataJSON(),gate=deferred();
          assert.ok(body.requestKey);assert.ok(body.evidenceIds.length<=8);
          const call={path:pathname,body,finish:gate.resolve};chats.push(call);
          const result=await gate.promise;
          if(result==='http-failure')return json({error:{code:'MOCK_UNAVAILABLE',message:'模拟网络失败，请重试'}},503);
          const productId=pathname.split('/').length===6?pathname.split('/')[4]:'p1';
          const product=products.get(productId)||makeProduct(productId,'测试商品');
          const replay=product.messages.find(m=>m.id===body.requestKey);
          if(replay){assert.equal(replay.text,body.text.trim());assert.deepEqual(replay.evidenceIds,body.evidenceIds);}
          else {
            product.revision++;product.evidenceIds=[...new Set([...product.evidenceIds,...body.evidenceIds])];
            product.messages.push({id:body.requestKey,role:'user',text:body.text.trim(),evidenceIds:body.evidenceIds,status:result==='recognition-failure'?'failed':'completed'});
            if(result!=='recognition-failure')product.messages.push({id:`reply-${body.requestKey}`,role:'assistant',text:'资料已整理',evidenceIds:[]});
            products.set(productId,product);
          }
          const failed=result==='recognition-failure'||replay?.status==='failed';
          return json({product,...(failed?{error:{code:'RECOGNITION_FAILED',message:'识别未完成，消息与附件已保存。可补充新消息后继续。'}}:{})});
        }
        failures.push(`Unexpected API: ${method} ${pathname}`);return json({error:{message:'Unexpected mock API'}},500);
      }catch(error){failures.push(error.stack);await json({error:{message:error.message}},500).catch(()=>{});}
    });
    const composer=page.getByRole('textbox',{name:'商品聊天',exact:true}),send=page.getByRole('button',{name:'发送资料',exact:true}),attached=page.locator('.cp-attachments .cp-attachment');
    Object.assign(state,{composer,send,attached});
    state.pasteImage=async()=>{
      await composer.focus();
      await page.evaluate(async encoded=>{const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([bytes],{type:'image/png'})})]);},png.toString('base64'));
      await page.keyboard.press('Control+V');
    };
    state.addFiles=async(count,prefix='图')=>page.locator('.cp-composer input[type=file]').setInputFiles(Array.from({length:count},(_,index)=>({name:`${prefix}-${index+1}.png`,mimeType:'image/png',buffer:png})));
    state.screenshot=async(name)=>page.screenshot({path:path.join(evidence,`${id}-${name}.png`),fullPage:true});
    try {
      await page.goto(`${base}/?screen=products${existing?'&productId=p1':''}`);await expect(composer).toBeVisible();
      await run(state);
      assert.deepEqual(failures,[]);
      const unexpected=events.filter(e=>!e.includes('503 (Service Unavailable)'));assert.deepEqual(unexpected,[]);
      await state.screenshot('passed');results.push({id,status:'pass'});console.log(`PASS ${id}`);
    }catch(error){
      await state.screenshot('failed').catch(()=>{});results.push({id,status:'fail',error:error.stack});console.error(`FAIL ${id}: ${error.message}`);
    }finally{
      await writeFile(path.join(evidence,`${id}.json`),JSON.stringify({events,failures,requests,uploads,chats:chats.map(({body,path})=>({body,path}))},null,2));
      uploadGate?.resolve();for(const call of chats)call.finish('success');await context.close();
    }
  }
  await scenario('next-draft',async({page,composer,send,attached,pasteImage,chats,uploads,screenshot})=>{
    await composer.fill('第一条');await pasteImage();await expect(attached).toHaveCount(1);assert.match(uploads[0].name,/^粘贴图片-.*\.png$/);
    await send.click();await expect.poll(()=>chats.length).toBe(1);await expect(composer).toHaveValue('');await expect(composer).toBeEnabled();
    await expect(page.locator('.cp-composer input[type=file]')).toBeEnabled();await expect(page.locator('.cp-thread')).toContainText('第一条');
    await composer.fill('下一条保留');await pasteImage();await expect(attached).toHaveCount(1);
    await composer.press('Enter');await composer.press('Enter');assert.equal(chats.length,1);await expect(send).toBeDisabled();await screenshot('inflight');
    chats[0].finish('success');await expect(send).toBeEnabled();await expect(composer).toHaveValue('下一条保留');await expect(attached).toHaveCount(1);
    await expect(page.locator('.cp-user')).toHaveCount(1);await send.click();await expect.poll(()=>chats.length).toBe(2);
    assert.equal(chats[1].body.text,'下一条保留');assert.deepEqual(chats[1].body.evidenceIds,[uploads[1].id]);assert.notEqual(chats[0].body.requestKey,chats[1].body.requestKey);
    chats[1].finish('success');await expect(composer).toHaveValue('');await expect(attached).toHaveCount(0);await expect(page.locator('.cp-user')).toHaveCount(2);
  },{existing:false});
  await scenario('failure-overflow',async({page,composer,send,attached,addFiles,chats,screenshot})=>{
    await composer.fill('失败原文');await addFiles(8,'原图');await expect(attached).toHaveCount(8);await send.click();await expect.poll(()=>chats.length).toBe(1);
    await composer.fill('下一条');await addFiles(8,'新图');await expect(attached).toHaveCount(8);chats[0].finish('recognition-failure');
    await expect(composer).toHaveValue('失败原文\n下一条');await expect(attached).toHaveCount(16);await expect(send).toBeDisabled();await screenshot('all-preserved');
    for(let i=1;i<=8;i++)await page.getByRole('button',{name:`移除 原图-${i}.png`,exact:true}).click();
    await expect(attached).toHaveCount(8);await expect(send).toBeEnabled();await send.click();await expect.poll(()=>chats.length).toBe(2);
    assert.notEqual(chats[0].body.requestKey,chats[1].body.requestKey);assert.equal(chats[1].body.evidenceIds.length,8);chats[1].finish('success');await expect(attached).toHaveCount(0);
  });
  await scenario('upload-limit',async({page,composer,send,attached,pasteImage,uploads,holdUploads,screenshot})=>{
    const gate=holdUploads();for(let i=0;i<8;i++){await pasteImage();await expect.poll(()=>uploads.length).toBe(i+1);}
    await expect(send).toBeDisabled();await pasteImage();await expect(page.getByRole('alert')).toContainText('最多 8 张');assert.equal(uploads.length,8);await screenshot('reserved');
    gate.resolve();await expect(attached).toHaveCount(8);await expect(send).toBeEnabled();await pasteImage();assert.equal(uploads.length,8);await expect(attached).toHaveCount(8);
    await composer.fill('八图仍可发送');
  });
  await scenario('upload-navigation',async({page,composer,send,attached,pasteImage,uploads,holdUploads,screenshot})=>{
    const gate=holdUploads();await pasteImage();await expect.poll(()=>uploads.length).toBe(1);await expect(send).toContainText('图片上传中');
    async function rejectDialog(action,type='confirm'){let seen=0;const handler=async dialog=>{seen++;assert.equal(dialog.type(),type);await dialog.dismiss();};page.on('dialog',handler);await action();page.off('dialog',handler);assert.equal(seen,1,`Expected ${type} protection`);}
    await rejectDialog(()=>page.getByRole('button',{name:/另一个商品/}).click());await expect(page.getByRole('heading',{name:'测试商品',exact:true})).toBeVisible();
    await rejectDialog(()=>page.locator('.topnav-menu').getByRole('button',{name:'素材',exact:true}).click());await expect(composer).toBeVisible();
    await rejectDialog(()=>page.reload({timeout:1500}).catch(error=>{if(!/ERR_ABORTED|Timeout/.test(error.message))throw error;}),'beforeunload');await screenshot('protected');
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:/另一个商品/}).click();await expect(page.getByRole('heading',{name:'另一个商品',exact:true})).toBeVisible();
    gate.resolve();await expect(attached).toHaveCount(0);await pasteImage();await expect(attached).toHaveCount(1);assert.equal(uploads[1].productId,'p2');
  });
  await scenario('recognition-retry',async({composer,send,attached,addFiles,chats,page})=>{
    await composer.fill('识别失败内容');await addFiles(1);await expect(attached).toHaveCount(1);await send.click();await expect.poll(()=>chats.length).toBe(1);chats[0].finish('recognition-failure');
    await expect(composer).toHaveValue('识别失败内容');await expect(attached).toHaveCount(1);await expect(send).toBeEnabled();await send.click();await expect.poll(()=>chats.length).toBe(2);
    assert.notEqual(chats[0].body.requestKey,chats[1].body.requestKey,'Known terminal recognition failure must not replay the old failed message forever');chats[1].finish('success');await expect(page.locator('.cp-typing')).toHaveCount(0);
  });
  await scenario('network-retry',async({composer,send,chats,page})=>{
    await composer.fill('网络失败内容');await send.click();await expect.poll(()=>chats.length).toBe(1);chats[0].finish('http-failure');await expect(composer).toHaveValue('网络失败内容');await expect(send).toBeEnabled();
    await send.click();await expect.poll(()=>chats.length).toBe(2);assert.equal(chats[1].body.requestKey,chats[0].body.requestKey);chats[1].finish('http-failure');await expect(send).toBeEnabled();
    await composer.fill('修改后的消息');await send.click();await expect.poll(()=>chats.length).toBe(3);assert.notEqual(chats[2].body.requestKey,chats[1].body.requestKey);chats[2].finish('success');await expect(page.locator('.cp-typing')).toHaveCount(0);
  });
  await scenario('text-keyboard',async({page,composer,send,chats,uploads})=>{
    await expect(send).toBeDisabled();await composer.press('Enter');assert.equal(chats.length,0);
    await composer.focus();await page.evaluate(()=>navigator.clipboard.writeText('纯文本 中文 "引号"'));await page.keyboard.press('Control+V');await expect(composer).toHaveValue('纯文本 中文 "引号"');assert.equal(uploads.length,0);
    await composer.press('Shift+Enter');await composer.pressSequentially('second line');await expect(composer).toHaveValue('纯文本 中文 "引号"\nsecond line');
    await composer.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});assert.equal(chats.length,0);
    await composer.press('Enter');await expect.poll(()=>chats.length).toBe(1);chats[0].finish('success');await expect(page.locator('.cp-typing')).toHaveCount(0);
    await page.setViewportSize({width:375,height:900});assert.deepEqual(page.viewportSize(),{width:375,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  });
  await writeFile(path.join(evidence,'result.json'),JSON.stringify({results,evidence},null,2));
  await writeFile(path.join(evidence,'scenarios.md'),'# Never and always\nNo silent draft loss, no duplicate in-flight submit, pending uploads reserve slots, leaving unsaved work requires confirmation.\n\n'+scenarios.map(([id,text])=>`- ${results.find(r=>r.id===id)?.status}: ${id}: ${text}; evidence ${id}.json / ${id}-passed.png (or failed.png)`).join('\n')+'\n');
  console.log(`Evidence: ${evidence}`);assert.ok(results.every(r=>r.status==='pass'),'Chat composer browser regression failed');
}finally{await browser?.close();await vite?.close();}
