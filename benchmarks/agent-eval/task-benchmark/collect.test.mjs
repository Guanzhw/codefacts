import test from 'node:test';
import assert from 'node:assert/strict';
import { auditTrace, blindId, hasReturnedLocation, gradingView, assertCollectedIdentity, collectedUsage } from './collect.mjs';
import { summarizeCampaign } from './summary.mjs';
import { hash } from './rpc.mjs';

const p='mcp__repo__';
const call=(name,step,id)=>({name:p+name,step,callId:id});
const result=(id,text,isError=false)=>({message:{toolCallId:id,isError,content:[{type:'text',text}]}});

test('ordinary excludes native invocation even under the expected namespace',()=>{
  const receipt={headerAudit:true,toolCalls:[call('source_read',1,'a'),call('codefacts_explore',2,'b')],
    toolResults:[result('b','src/main.rs:10')]};
  const a=auditTrace(receipt,{arm:'ordinary',condition:'guided-use'},['src/main.rs']);
  assert.equal(a.traceAudit.valid,false);
  assert.equal(a.toolCalls.native,1);
});

test('guided first step may contain both ordinary and native source inspection',()=>{
  const receipt={headerAudit:true,toolCalls:[call('source_search',1,'a'),call('codefacts_explore',1,'b')],
    toolResults:[result('b','### symbol — src/main.rs:10\n```rust\nfn example() {}\n```')]};
  const a=auditTrace(receipt,{arm:'codefacts022',condition:'guided-use'},['src/main.rs']);
  assert.equal(a.traceAudit.adherent,true);
  assert.equal(a.nativeSourceBearingResults,1);
});

test('empty, errored or later-only native use does not satisfy guided adherence',()=>{
  for(const text of ['No matching symbols','src/main.rs:10']){
    const receipt={headerAudit:true,toolCalls:[call('source_search',1,'a'),call('codegraph_explore',2,'b')],
      toolResults:[result('b',text,text.startsWith('src'))]};
    const a=auditTrace(receipt,{arm:'codegraph',condition:'guided-use'},['src/main.rs']);
    assert.equal(a.traceAudit.adherent,false);
  }
});

test('natural source-only choice is valid for a treatment',()=>{
  const receipt={headerAudit:true,toolCalls:[call('source_read',1,'a')],toolResults:[result('a','text')]};
  const a=auditTrace(receipt,{arm:'codefacts017',condition:'natural-choice'},['src/main.rs']);
  assert.equal(a.traceAudit.adherent,true);
  assert.equal(a.toolCalls.native,0);
});

test('blind identifiers contain no reversible arm or task label',()=>{
  const a=blindId(), b=blindId();
  assert.match(a,/^sample-[0-9a-f-]{36}$/);
  assert.notEqual(a,b);
});

test('query echo with no returned facts never satisfies source-bearing use',()=>{
  assert.equal(hasReturnedLocation(result('x',JSON.stringify({query:'src/main.rs:10',results:[]})).message,['src/main.rs']),false);
  assert.equal(hasReturnedLocation(result('x',JSON.stringify({results:[{evidence:{file_path:'src/main.rs',start_line:10,end_line:12}}]})).message,['src/main.rs']),true);
});

test('native Markdown symbol match tables provide attributable source locations',()=>{
  const text='## matches\n|at|id|symbol|\n|---|---|---|\n|index.js:345-348|method:index.js:hasRoute:345|`method Router.prototype.hasRoute`|';
  assert.equal(hasReturnedLocation(result('x',text).message,['index.js']),true);
  assert.equal(hasReturnedLocation(result('x','|at|query|\n|query|index.js:345|').message,['index.js']),false);
});

test('grading view neutralizes explicit tool and absolute-root identifiers',()=>{
  const root='D:\\bench\\codefacts022-r1\\source';
  const raw='CodeFacts 0.2.2 shows '+root+'\\index.js:10 and codegraph_explore.';
  const view=gradingView(raw,root);
  assert.doesNotMatch(view,/codefacts|codegraph|0\.2\.2|D:\\/i);
  assert.match(view,/index\.js:10/);
  assert.match(raw,/CodeFacts/);
});

test('collected exact usage is accepted by the summary and incomplete usage remains a lower bound',()=>{
  const base={id:'a',taskId:'task',arm:'ordinary',condition:'guided-use',repetition:1,status:'completed',
    wallMs:100,setupMs:0,toolCalls:{ordinary:1,native:0,nativeSuccessful:0},
    traceAudit:{valid:true,adherent:true,reasons:[]},
    grade:{criteria:['C1','C2','C3','C4'].map(id=>({id,pass:true})),criticalFalseClaim:false,fullyCorrect:true,reviewer:'independent',locked:true}};
  const exact=collectedUsage({exactTurnUsage:{uncachedInputTokens:7,outputTokens:3,totalTokens:10},knownUsageLowerBound:{totalTokens:10}});
  assert.equal(Object.hasOwn(exact,'knownUsageLowerBound'),false);
  const summary=summarizeCampaign({schemaVersion:1,suiteId:'fixture',metadata:{},runs:[{...base,...exact}]});
  assert.equal(summary.groups[0].tokens.authoritativeTotal,10);
  assert.deepEqual(collectedUsage({exactTurnUsage:null,knownUsageLowerBound:{totalTokens:4}}),{usage:null,knownUsageLowerBound:{totalTokens:4}});
  assert.deepEqual(collectedUsage({exactTurnUsage:null,knownUsageLowerBound:{uncachedInputTokens:0,outputTokens:0,totalTokens:0},usageAvailability:'unavailable'}),{usage:null,knownUsageLowerBound:null});
});

test('collection preserves infrastructure failures while rejecting a different frozen identity',()=>{
  const frozen={id:'f'},slot={id:'s',arm:'ordinary'};
  const meta={freezeHash:hash(frozen),slot,status:'infrastructure-failed'};
  assert.doesNotThrow(()=>assertCollectedIdentity(meta,frozen,slot));
  assert.throws(()=>assertCollectedIdentity({...meta,freezeHash:'changed'},frozen,slot),/different frozen/);
  assert.throws(()=>assertCollectedIdentity(meta,frozen,{...slot,id:'other'}),/different frozen/);
});
