import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const [rootArg, outputArg]=process.argv.slice(2);
const root=resolve(rootArg), output=resolve(outputArg);
mkdirSync(output,{recursive:true});
const preload=new URL('./probe-hooks.mjs',import.meta.url).href;
const cases=[
  ['token','test/core.test.mjs','OpenCode token stats include child sessions exactly once'],
  ['config','test/core.test.mjs','terminal launch is enabled by default and supports an explicit startup opt-out'],
  ['log','test/core.test.mjs','runtime events write JSONL under meta logs with redaction'],
  ['runtime','test/core.test.mjs','OpenCode runtime environment resolves project and user agent extensions'],
  ['instructions','test/core.test.mjs','provider runtime environments classify instruction files as runtime extensions'],
  ['zstd','test/codex-provider.test.mjs','Codex reads the official compressed rollout representation'],
  ['zstd-bound','test/codex-provider.test.mjs','Codex rejects compressed rollouts over the provider-owned output bound'],
];
const rows=[];
function verify(id,file,name,mode,label,xdg='present') {
  const dir=join(output,label),temp=join(dir,'temp');mkdirSync(temp,{recursive:true});
  mkdirSync(join(temp,'unrelated-sibling'));
  const sentinels=[join(temp,'keep.txt'),join(temp,'unrelated-sibling','keep.txt')];
  for(const p of sentinels)writeFileSync(p,'untouched\n');
  const probeLog=join(dir,'probe.jsonl');
  const env={...process.env,TEMP:temp,TMP:temp,TMPDIR:temp,CF_PROBE_MODE:mode,CF_PROBE_LOG:probeLog};
  if(xdg==='absent') delete env.XDG_CONFIG_HOME; else env.XDG_CONFIG_HOME=join(dir,'initial-xdg');
  const r=spawnSync(process.execPath,['--import',preload,'--test','--test-reporter=tap',`--test-name-pattern=^${name}$`,file],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});
  const log=`${r.stdout||''}\n${r.stderr||''}`;writeFileSync(join(dir,'test.log'),log);
  const probes=existsSync(probeLog)?readFileSync(probeLog,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse):[];
  const expected=mode==='normal'?null:({assertion:'CF_EVAL_ASSERTION_FAILURE','writer-setup':'CF_EVAL_WRITER_SETUP_FAILURE','file-setup':'CF_EVAL_FILE_SETUP_FAILURE'})[mode];
  const row={id,label,mode,exitCode:r.status,expectedSentinel:expected,expectedExit:r.status===(mode==='normal'?0:1),injection:mode==='normal'||(probes.some(p=>p.injectionFired&&p.injection?.sentinel===expected)&&log.includes(expected)),created:probes.flatMap(p=>p.created),sentinelsPreserved:sentinels.every(p=>existsSync(p)&&readFileSync(p,'utf8')==='untouched\n'),environmentRestored:probes.length>0&&probes.every(p=>JSON.stringify(p.initialXdgConfigHome)===JSON.stringify(p.finalXdgConfigHome)),writersClosed:probes.every(p=>p.writers.every(w=>w.closed)),closedBeforeRemoval:probes.every(p=>p.removeCalls.every(c=>c.openWriters.length===0)),writerObserved:probes.some(p=>p.writers.length>0),probeCount:probes.length};
  row.removed=row.created.length===1&&row.created.every(c=>!c.existsAtExit&&!existsSync(c.path));
  row.passed=row.expectedExit&&row.injection&&row.removed&&row.sentinelsPreserved&&row.environmentRestored&&row.writersClosed&&row.closedBeforeRemoval&&(mode!=='writer-setup'||row.writerObserved);
  rows.push(row);console.log(`${label}: ${row.passed?'PASS':'FAIL'} exit=${r.status}, created=${row.created.length}, removed=${row.removed}, writersClosed=${row.writersClosed}`);
}
for(let pass=1;pass<=2;pass++) for(const c of cases)verify(...c,'normal',`normal-${pass}-${c[0]}`);
for(const c of cases)verify(...c,'assertion',`assertion-${c[0]}`);
verify(...cases[3],'assertion','assertion-runtime-xdg-absent','absent');
verify(...cases[0],'writer-setup','writer-setup-token');
verify(...cases[1],'file-setup','file-setup-config');
const fullTemp=join(output,'full-files-temp');mkdirSync(fullTemp);
const full=spawnSync(process.execPath,['--test','--test-reporter=tap','test/core.test.mjs','test/codex-provider.test.mjs'],{cwd:root,env:{...process.env,TEMP:fullTemp,TMP:fullTemp,TMPDIR:fullTemp},encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:8*1024*1024});
writeFileSync(join(output,'full-files.log'),`${full.stdout}\n${full.stderr}`);
const result={root,node:process.version,platform:process.platform,rows,fullFiles:{exitCode:full.status,passed:Number(full.stdout?.match(/# pass (\d+)/)?.[1]??0),failed:Number(full.stdout?.match(/# fail (\d+)/)?.[1]??0)},automatic:{Q1:full.status===0&&rows.every(r=>r.sentinelsPreserved),Q2:rows.filter(r=>r.mode==='normal').every(r=>r.passed),Q3:rows.filter(r=>r.mode==='assertion').every(r=>r.passed),Q4:rows.filter(r=>r.mode.endsWith('setup')).every(r=>r.passed)}};
writeFileSync(join(output,'acceptance.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({fullFiles:result.fullFiles,automatic:result.automatic}));
