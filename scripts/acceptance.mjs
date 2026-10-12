/** 固定留出集及实际 MCP 的发行验收；算法策略由独立文档预先冻结。 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const fixtureSha256='84c7eff40594a0357666ff245182f0ed2344e562c21728481d677e84517840f9';
export function qualityGate(baseline,current){
  for(const report of [baseline,current]){
    assert.equal(report.split,'heldout'); assert.equal(report.fixtureSha256,fixtureSha256); assert.equal(report.dimensions,512);
    assert.deepEqual(report.scenarios.map(row=>row.mode),['bm25','semantic','rrf','hybrid+graph']);
    for(const row of report.scenarios){ assert.equal(row.cases.length,28); for(const value of Object.values(row.metrics)) assert(Number.isFinite(value)); }
  }
  const before=baseline.scenarios.at(-1),after=current.scenarios.at(-1);
  assert(after.metrics.recallAt5>before.metrics.recallAt5,'Heldout Recall@5 did not improve');
  assert(after.metrics.mrrAt5>before.metrics.mrrAt5,'Heldout MRR did not improve');
  assert(after.metrics.precisionAt5>=before.metrics.precisionAt5,'Heldout Precision@5 regressed');
  assert(after.metrics.unrelatedRecallRate<=before.metrics.unrelatedRecallRate,'Unrelated recall regressed');
  for(const row of after.cases){ const old=before.cases.find(item=>item.id===row.id); assert(old); assert.deepEqual(row.relevant,old.relevant); if(row.relevant.length) assert(row.recallAt5>=old.recallAt5,'Positive-query recall regressed: '+row.id); }
  return {fixtureSha256,baseline:before.metrics,current:after.metrics};
}
export function performanceGate(baseline,current){
  assert.equal(current.scenarios.length,9); assert.equal(baseline.scenarios.length,9);
  for(const row of current.scenarios){
    const old=baseline.scenarios.find(item=>item.size===row.size&&item.mode===row.mode); assert(old);
    assert(row.initializeMs+row.firstSearchMs<=old.initializeMs+old.firstSearchMs+200,'Cold user-visible latency regressed: '+row.size+'/'+row.mode);
    assert(row.importMs<=old.importMs*1.3+100,'Import regression: '+row.size+'/'+row.mode);
    for(const item of row.cases){const previous=old.cases.find(value=>value.query===item.query);assert(previous); assert(item.p95Ms<50,'Warm MCP p95 exceeded 50ms'); assert(item.p95Ms<=previous.p95Ms*1.2+4,'Warm MCP regression: '+item.query);}
    for(const name of ['writes','concurrentReadWrite']) assert(row[name].p95Ms<=old[name].p95Ms*1.3+8,'Write/concurrent regression: '+row.size+'/'+row.mode);
    if(row.mode==='local' && row.uncachedModelQueries) assert(row.uncachedModelQueries.p95Ms<50,'Uncached real model queries exceeded 50ms');
    assert(row.peakMemory.peakBytes<1024**3,'MCP lifetime peak exceeded 1GiB');
    // 编译模式按需加载同一二进制的模型助手，固定运行时内存开销单独预算。
    assert(row.peakMemory.peakBytes<=old.peakMemory.peakBytes*1.15+96*1024**2,'Memory regression exceeded runtime overhead budget');
  }
  return {scenarios:9,warmP95LimitMs:50,coldAdditionalBudgetMs:200,modelRuntimeAdditionalBudgetMiB:96};
}
if(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href){
  const mode=process.argv[2],before=JSON.parse(readFileSync(process.argv[3],'utf8')),after=JSON.parse(readFileSync(process.argv[4],'utf8'));
  if(mode==='quality'){assert.equal(createHash('sha256').update(readFileSync('scripts/fixtures/retrieval-bilingual.json')).digest('hex'),fixtureSha256); console.log(JSON.stringify(qualityGate(before,after)));}
  else if(mode==='performance')console.log(JSON.stringify(performanceGate(before,after)));
  else throw Error('Usage: node scripts/acceptance.mjs quality|performance baseline.json current.json');
}
