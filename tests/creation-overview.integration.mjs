import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestPostgres } from './support/postgres.mjs';
import { CreationStore } from '../server/creation-store.mjs';
import { CreationOverview } from '../server/creation-overview.mjs';
let db,store,overview;
test.before(async()=>{db=await startTestPostgres();store=new CreationStore(db.pool);overview=new CreationOverview(store);});
test.after(async()=>{await db?.stop();});
test('workspace overview counts persisted products and excludes other workspaces',async()=>{
 await store.create('overview-a','product',{name:'保温杯',facts:{material:'钢'}});
 await store.create('overview-b','product',{name:'另一工作区'});
 const result=await overview.get('overview-a');
 assert.equal(result.metrics.products,1);
});
test('workspace overview reports task outcomes, recent projects and actual costs with unknown preserved',async()=>{
 const project=await store.create('overview-runs','project',{name:'新品主图',tasks:[{id:'a'},{id:'b'}],edges:[]});
 await db.pool.query(`INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status,usage,created_at) VALUES(gen_random_uuid(),$1,$2,'a',gen_random_uuid(),'{}','succeeded',$3,now()), (gen_random_uuid(),$1,$2,'a',gen_random_uuid(),'{}','failed',NULL,now()-interval '1 hour'), (gen_random_uuid(),$1,$2,'b',gen_random_uuid(),'{}','unknown',NULL,now())`,['overview-runs',project.id,{costMicros:1230000,currency:'CNY'}]);
 const result=await overview.get('overview-runs');
 assert.equal(result.metrics.projects,1);
 // 任务 a 只按最新一条运行记录计数：重试成功后不再计入失败。
 assert.equal(result.metrics.tasks,2);
 assert.equal(result.metrics.succeeded,1);
 assert.equal(result.metrics.failed,0);
 assert.equal(result.metrics.unknown,1);
 // 费用仍按全部运行记录累计。
 assert.equal(result.costs.unknown,2);
 assert.deepEqual(result.costs.totals,[{currency:'CNY',costMicros:1230000}]);
 assert.equal(result.projects[0].id,project.id);
 assert.equal(result.runs.length,2);
 assert.equal(result.runs.find(r=>r.taskId==='a').status,'succeeded');
 assert.equal(result.runs.find(r=>r.status==='unknown').costMicros,null);
});
test('workspace overview hides runs whose project was trashed or whose task was removed',async()=>{
 const kept=await store.create('overview-stale','project',{name:'保留项目',tasks:[{id:'keep'}],edges:[]});
 const trashed=await store.create('overview-stale','project',{name:'已删除项目',tasks:[{id:'gone'}],edges:[]});
 const removed=await store.create('overview-stale','project',{name:'节点已移除',tasks:[],edges:[]});
 await db.pool.query(`UPDATE sj_creation_records SET trashed_at=now() WHERE id=$1`,[trashed.id]);
 await db.pool.query(`INSERT INTO sj_creation_runs(id,workspace_id,project_id,task_id,request_key,input,status) VALUES(gen_random_uuid(),$1,$2,'keep',gen_random_uuid(),'{}','failed'),(gen_random_uuid(),$1,$3,'gone',gen_random_uuid(),'{}','failed'),(gen_random_uuid(),$1,$4,'removed',gen_random_uuid(),'{}','failed')`,['overview-stale',kept.id,trashed.id,removed.id]);
 const result=await overview.get('overview-stale');
 assert.deepEqual(result.runs.map(r=>r.taskId),['keep']);
 assert.equal(result.metrics.failed,1);
});
test('chat and planning usage contributes to costs without exposing other workspaces',async()=>{
 await db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES(gen_random_uuid(),'overview-text','model.complete',$1),(gen_random_uuid(),'other','model.complete',$2)`,[{stage:'product',usage:{costMicros:456,currency:'USD'}},{usage:{costMicros:999,currency:'USD'}}]);
 const result=await overview.get('overview-text');
 assert.deepEqual(result.costs.totals,[{currency:'USD',costMicros:456}]);
 assert.equal(result.costs.unknown,0);
});


test('project permanent deletion preserves cost totals through minimal retained audit records',async()=>{
 await db.pool.query(`INSERT INTO sj_creation_audit(id,workspace_id,action,detail) VALUES(gen_random_uuid(),'overview-retained','creation.retained-cost',$1)`,[{runId:'removed',usage:{costMicros:790,currency:'CNY'}}]);
 const result=await overview.get('overview-retained');
 assert.deepEqual(result.costs.totals,[{currency:'CNY',costMicros:790}]);
});
