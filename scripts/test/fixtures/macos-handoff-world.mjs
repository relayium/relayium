// Test data only. The certified macOS publication handoff, end to end, on the
// accepted root world (`macos-certified/world.mjs`, imported read-only): its
// real Git objects, its genuine `produce`/`witness` proof chain and its main
// producer run. This file adds only what the publisher run leaves behind —
// the preflight's actual `decide` record and its upload, the notarize-stage
// readback and notarized artifact, a frozen release-metadata candidate commit,
// its dispatched gate, main and the release surfaces — as GitHub-shaped API
// answers. No network, no native runner, no publication claim.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import * as E from '../../release/macos-evidence.mjs';
import {ARTIFACT_PATHS,DERIVED_FILES,RELEASE_PAYLOAD,decisionArtifactName,emitHandoff,verifyHandoff} from '../../release/macos-handoff.mjs';
import {CONTROL_FILES,LANES,SelectAll,selectLanes} from '../../ci/select-lanes.mjs';
import {CANDIDATE_PATHS} from '../../../web/scripts/macos-release-candidate.mjs';
import {certifiedWorld,isolatedGitEnvironment} from './macos-certified/world.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const iso=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');
const clone=v=>structuredClone(v);
export const PUBLISHER_RUN=36995000100, GATE_RUN=36995000200, NOTARIZED_ID=11200000100, DECISION_ID=11200000101, GATE_WORKFLOW_ID=9;
export const VERSION='1.4.5';

/** A stored ZIP of regular files; the parsers under test are the shipped ones. */
export function storedZip(entries){
 const locals=[],centrals=[];let offset=0;
 const crc32=E.crc32;
 for(const {name,data} of entries){
  const n=Buffer.from(name,'utf8'),raw=Buffer.from(data),crc=crc32(raw);
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);
  local.writeUInt32LE(raw.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(n.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE((3<<8)|20,4);central.writeUInt16LE(20,6);
  central.writeUInt32LE(crc,16);central.writeUInt32LE(raw.length,20);central.writeUInt32LE(raw.length,24);central.writeUInt16LE(n.length,28);
  central.writeUInt32LE((0o100644<<16)>>>0,38);central.writeUInt32LE(offset,42);
  locals.push(local,n,raw);centrals.push(central,n);offset+=30+n.length+raw.length;
 }
 const cd=Buffer.concat(centrals),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);
 end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,cd,end]);
}

/** Plumbing Git in the world checkout through a private index: the working tree is never touched. */
function plumbing(checkout,index){
 const env={...isolatedGitEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_INDEX_FILE:index,
  GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',
  GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_AUTHOR_DATE:'1790000100 +0000',GIT_COMMITTER_DATE:'1790000100 +0000'};
 return (args,input)=>{const r=spawnSync('git',args,{cwd:checkout,env,input,encoding:'buffer',maxBuffer:64*1024*1024});
  if(r.status!==0)throw new Error(`fixture Git ${args.join(' ')}: ${r.stderr}`);return r.stdout;};
}

/** The lanes BASE's selector requires for these paths (the selector, not the verifier under test). */
function selectedLanes(paths,workflowsDir){
 if(paths.some(p=>CONTROL_FILES.includes(p)))return new Set(LANES.map(l=>l.id));
 try{return selectLanes(paths,{workflowsDir});}catch(error){if(error instanceof SelectAll)return new Set(LANES.map(l=>l.id));throw error;}
}

/**
 * The whole certified handoff world. `gateJobs(selected)` returns the honest
 * dispatched gate graph as `[name, conclusion]` pairs (built by the test from
 * the repository's own files, not by the module under test).
 * `decisionMs`: how long before `now` the publisher preflight decided.
 */
export async function handoffWorld({now,sourceAgeMs,witnessAgeMs,decisionMs=30*60000,mode='reuse',gateJobs}={}){
 assert(typeof gateJobs==='function','handoffWorld needs the honest gate graph builder');
 const world=await certifiedWorld({now,sourceAgeMs,witnessAgeMs});
 try{
  const at=world.now.getTime(),S=world.sha,REPO=world.repository,REPO_ID=world.repositoryId;
  const decidedAt=at-decisionMs,notaryFrom=decidedAt+5*60000,notaryTo=decidedAt+20*60000;
  // 1. The publisher preflight's ACTUAL decision, through the shipped selector.
  const decision=await world.inCheckout(()=>E.decide(world.api,{mode,repository:REPO,repositoryId:REPO_ID,sha:S,ref:'refs/heads/main',
   releaseVersion:VERSION,now:decidedAt,dir:join(world.directory,'preflight-payload')}));
  assert.equal(decision.source,'reuse',`the fixture preflight did not choose reuse: ${decision.reason}`);
  assert.equal(decision.evidence.coverage.mode,E.COVERAGE_CERTIFIED,'the fixture preflight did not freeze a certified chain');
  const decisionRecord={decidedAt:new Date(decidedAt+123).toISOString(),mode,source:decision.source,reason:decision.reason,evidence:decision.evidence};
  const decisionZip=storedZip([{name:'reuse-decision.json',data:`${JSON.stringify(decisionRecord,null,2)}\n`}]);
  // 2. The notarize-stage readback of exactly that frozen evidence, through the shipped reader.
  const readback=await world.inCheckout(()=>E.readback(world.api,decision.evidence,{now:notaryFrom+60000,
   dir:join(world.directory,'notary-readback'),releaseVersion:VERSION}));
  assert.equal(E.evidenceIdentity(readback),E.evidenceIdentity(decision.evidence),'the fixture readback is not the frozen chain');
  const signedDmg=readFileSync(join(world.directory,'notary-readback/Relayium.dmg'));
  assert.equal(hash(signedDmg),world.dmgSha256,'the fixture readback did not install the signed payload');
  // 3. The frozen release-metadata candidate: one commit on S, exactly the base-owned scope.
  const index=join(world.directory,'candidate.index');const pg=plumbing(world.checkout,index);
  pg(['read-tree',S]);
  const manifest=`${JSON.stringify({macos:{version:VERSION,build:42,architectures:['arm64'],downloadUrl:`https://example.invalid/macos-v${VERSION}`}},null,2)}\n`;
  for(const path of CANDIDATE_PATHS){
   const text=path==='web/native-releases.json'?manifest:`fixture ${VERSION} metadata for ${path}\n`;
   const blob=pg(['hash-object','-w','--stdin'],Buffer.from(text)).toString().trim();
   pg(['update-index','--add','--cacheinfo',`100644,${blob},${path}`]);
  }
  const candidateTree=pg(['write-tree']).toString().trim();
  const C=pg(['commit-tree',candidateTree,'-p',S,'-m','release(mac): publish fixture metadata']).toString().trim();
  pg(['update-ref','refs/heads/fixture-candidate',C]);
  const changed=pg(['diff-tree','-r','-z','--no-commit-id','--no-renames','--name-only',S,C]).toString().split('\0').filter(Boolean);
  const selected=selectedLanes(changed,join(world.checkout,'.github/workflows'));
  // 4. The notarized artifact: the signed payload stapled (synthetically) plus the candidate's derived files.
  const notarizedDmg=Buffer.concat([signedDmg,Buffer.from('\nfixture staple; native notarization is verified separately\n')]);
  const provenance={...world.provenance,dmgSha256:hash(notarizedDmg),notarized:true,
   notarizedBy:{runId:String(PUBLISHER_RUN),runAttempt:'1',signedBuildSource:'reuse'}};
  const files=new Map([['Relayium.dmg',notarizedDmg],['Relayium.dmg.sha256',Buffer.from(`${hash(notarizedDmg)}  Relayium.dmg\n`)],
   ['provenance.json',Buffer.from(JSON.stringify(provenance))]]);
  for(const [path,rel] of Object.entries(ARTIFACT_PATHS))files.set(rel,pg(['show',`${C}:${path}`]));
  assert.deepEqual([...files.keys()].sort(),[...RELEASE_PAYLOAD].sort());
  const artifactDir=join(world.directory,'release');
  for(const [rel,bytes] of files){mkdirSync(dirname(join(artifactDir,rel)),{recursive:true});writeFileSync(join(artifactDir,rel),bytes,{flag:'wx'});}
  const notarizedZip=storedZip([...files].map(([name,data])=>({name,data})));
  // 5. The publisher run, its artifacts, gate, main and release surfaces.
  const ids={repository:{id:REPO_ID,full_name:REPO,fork:false},head_repository:{id:REPO_ID,full_name:REPO,fork:false}};
  const step=(number,name,from,to,conclusion='success')=>({number,name,status:'completed',conclusion,
   started_at:conclusion==='skipped'?null:iso(from),completed_at:conclusion==='skipped'?null:iso(to)});
  const pubJob=(id,name,labels,from,to,steps,extra={})=>({id,name,run_id:PUBLISHER_RUN,head_sha:S,run_attempt:1,status:'completed',
   conclusion:'success',labels,runner_name:`GitHub Actions ${id}`,started_at:iso(from),completed_at:iso(to),steps,...extra});
  const preflight=pubJob(9001,'preflight',['ubuntu-latest'],decidedAt-20000,decidedAt+15000,[
   step(1,'Set up job',decidedAt-20000,decidedAt-19000),step(2,'Run actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',decidedAt-19000,decidedAt-15000),
   step(3,'Fail fast on the publication contract',decidedAt-15000,decidedAt-12000),step(4,'Compare the workflows directory and the delivery mode',decidedAt-12000,decidedAt-8000),
   step(5,'Select the signed-build source',decidedAt-1000,decidedAt+3000),step(6,'Upload the signed-build source decision',decidedAt+4000,decidedAt+8000),
   step(11,'Complete job',decidedAt+14000,decidedAt+15000)]);
  const build={id:9002,name:'build',run_id:PUBLISHER_RUN,head_sha:S,run_attempt:1,status:'completed',conclusion:'skipped',labels:[],
   started_at:iso(decidedAt+16000),completed_at:iso(decidedAt+16000),steps:[]};
  const notarize=pubJob(9003,'notarize-stage',['macos-15'],notaryFrom,notaryTo,[step(1,'Set up job',notaryFrom,notaryFrom+1000),
   step(2,'Re-prove and fetch the reused signed package',notaryFrom+50000,notaryFrom+70000),step(3,'Upload notarized release candidate',notaryTo-60000,notaryTo-10000),
   step(4,'Complete job',notaryTo-1000,notaryTo)]);
  const publish=pubJob(9004,'publish',['ubuntu-latest'],notaryTo+30000,at+60000,[step(1,'Set up job',notaryTo+30000,notaryTo+31000)]);
  const state={main:S,branch:C,publisher:{attempt:1,status:['completed','success'],publish:['completed','success']},
   tag:null,releases:[],releaseById:{},assetBytes:{},latest:null,gate:{attempt:1,conclusion:'success'}};
  const publisherAttempts=new Map([[1,{run:null,jobs:[preflight,build,notarize,publish]}]]);
  const publisherRun=(n=state.publisher.attempt)=>({id:PUBLISHER_RUN,run_attempt:n,head_sha:S,head_branch:'main',event:'workflow_dispatch',
   path:'.github/workflows/macos-release.yml',workflow_id:777,status:n===state.publisher.attempt?state.publisher.status[0]:'completed',
   conclusion:n===state.publisher.attempt?state.publisher.status[1]:'success',created_at:iso(decidedAt-60000),...ids});
  const publisherJobs=n=>publisherAttempts.get(n).jobs.map(j=>j.name==='publish'&&n===state.publisher.attempt
   ?{...j,status:state.publisher.publish[0],conclusion:state.publisher.publish[1]}:j);
  const artifact=(id,name,bytes,created,expires)=>({id,node_id:`MDg6QXJ0aWZhY3Q${id}`,name,size_in_bytes:bytes.length,expired:false,
   digest:`sha256:${hash(bytes)}`,created_at:iso(created),updated_at:iso(created),expires_at:iso(expires),
   workflow_run:{id:PUBLISHER_RUN,repository_id:REPO_ID,head_repository_id:REPO_ID,head_branch:'main',head_sha:S}});
  const artifacts=[artifact(NOTARIZED_ID,`relayium-macos-${S}-${VERSION}`,notarizedZip,notaryTo-20000,at+80*86400000),
   artifact(DECISION_ID,decisionArtifactName(S,1),decisionZip,decidedAt+7000,decidedAt+90*86400000)];
  const zips=new Map([[NOTARIZED_ID,notarizedZip],[DECISION_ID,decisionZip]]);
  const branchName=`release-candidate/macos-v${VERSION}-${PUBLISHER_RUN}-1`;
  const dispatchedAt=iso(at-120000);
  const gateRun=()=>({id:GATE_RUN,run_attempt:state.gate.attempt,head_sha:C,head_branch:branchName,event:'workflow_dispatch',
   path:'.github/workflows/merge-gate.yml',workflow_id:GATE_WORKFLOW_ID,status:'completed',conclusion:state.gate.conclusion,
   created_at:iso(at-100000),check_suite_id:5005,...ids});
  const gateGraph=gateJobs(selected).map(([name,conclusion],i)=>({id:7000+i,name,status:'completed',conclusion,run_id:GATE_RUN,head_sha:C,run_attempt:1}));
  const calls=[],counters=new Map(),hooks=new Map();
  const route=input=>input.replace(/^\//,'');
  const count=r=>{calls.push(r);const n=(counters.get(r)??0)+1;counters.set(r,n);return n;};
  const paged=(key,list,q)=>{const page=Number(q.get('page')??1),per=Number(q.get('per_page')??100);
   return {total_count:list.length,[key]:clone(list.slice((page-1)*per,page*per))};};
  const prefix=`repos/${REPO}`;
  function own(r){
   const u=new URL('https://fixture.invalid/'+r),p=u.pathname.slice(1),q=u.searchParams;let m;
   if(p===prefix)return {id:REPO_ID,full_name:REPO};
   if(p===`${prefix}/git/ref/heads/main`)return {object:{sha:state.main,type:'commit'}};
   if(p===`${prefix}/git/ref/heads/${branchName}`)return state.branch?{object:{sha:state.branch,type:'commit'}}:null;
   if(p===`${prefix}/actions/runs/${PUBLISHER_RUN}`)return publisherRun();
   if((m=new RegExp(`^${prefix}/actions/runs/${PUBLISHER_RUN}/attempts/(\\d+)(/jobs)?$`).exec(p))){
    const n=Number(m[1]);if(!publisherAttempts.has(n))throw Object.assign(new Error('fixture: no such attempt'),{status:404});
    return m[2]?paged('jobs',publisherJobs(n),q):(publisherAttempts.get(n).run??publisherRun(n));}
   if(p===`${prefix}/actions/runs/${PUBLISHER_RUN}/artifacts`)return paged('artifacts',artifacts,q);
   if((m=new RegExp(`^${prefix}/actions/artifacts/(\\d+)$`).exec(p))&&zips.has(Number(m[1])))return clone(artifacts.find(a=>a.id===Number(m[1]))??null);
   if(p===`${prefix}/actions/workflows/merge-gate.yml`)return {id:GATE_WORKFLOW_ID,path:'.github/workflows/merge-gate.yml',state:'active'};
   if(p===`${prefix}/actions/workflows/${GATE_WORKFLOW_ID}/runs`)return paged('workflow_runs',[gateRun()],q);
   if(p===`${prefix}/actions/runs/${GATE_RUN}`)return gateRun();
   if(p===`${prefix}/actions/runs/${GATE_RUN}/attempts/${state.gate.attempt}/jobs`)return paged('jobs',gateGraph,q);
   if(p===`${prefix}/git/ref/tags/macos-v${VERSION}`)return state.tag;
   if(p===`${prefix}/releases`)return Number(q.get('page'))===1?clone(state.releases):[];
   if(p===`${prefix}/releases/tags/macos-v${VERSION}`)return clone(state.releases.find(r=>r.tag_name===`macos-v${VERSION}`&&!r.draft)??null);
   if(p===`${prefix}/releases/latest`)return state.latest;
   if((m=new RegExp(`^${prefix}/releases/(\\d+)$`).exec(p)))return clone(state.releaseById[m[1]]??null);
   return undefined;
  }
  async function get(input){
   const r=route(input),n=count(r),hook=hooks.get(r);
   if(hook){const v=await hook(n);if(v!==undefined)return clone(v);}
   const v=own(r);
   if(v===null)throw Object.assign(new Error(`fixture 404 ${r}`),{status:404});
   if(v!==undefined)return v;
   return world.api.get(input);
  }
  const api={get,
   async getOptional(input){try{return await get(input);}catch(error){if(error?.status===404)return null;throw error;}},
   async download(input,{accept}={}){
    const r=route(input),n=count('DOWNLOAD '+r),hook=hooks.get('DOWNLOAD '+r);
    if(hook){const v=await hook(n);if(v!==undefined)return Buffer.from(v);}
    let m=/actions\/artifacts\/(\d+)\/zip$/.exec(r);
    if(m&&zips.has(Number(m[1])))return Buffer.from(zips.get(Number(m[1])));
    m=/releases\/assets\/(\d+)$/.exec(r);
    if(m&&accept==='application/octet-stream'&&state.assetBytes[m[1]])return Buffer.from(state.assetBytes[m[1]]);
    if(m)throw Object.assign(new Error('fixture: no asset'),{status:404});
    return world.api.download(input);
   }};
  const env={GITHUB_REPOSITORY:REPO,GITHUB_REPOSITORY_ID:String(REPO_ID),GITHUB_RUN_ID:String(PUBLISHER_RUN),GITHUB_RUN_ATTEMPT:'1',
   RELEASE_VERSION:VERSION,GITHUB_SHA:S};
  return {...world,world,C,candidateTree,changed,selected,branchName,dispatchedAt,decision,decisionRecord,decisionZip,notarizedZip,files,
   artifactDir,provenance,state,publisherAttempts,artifacts,zips,gateGraph,env,api,calls,counters,hooks,
   preflight,notarize,
   reset(){calls.length=0;counters.clear();hooks.clear();world.reset();},
   /** The live publish job: in progress while it emits. */
   async emit(options={}){
    const saved=clone(state.publisher);state.publisher.status=['in_progress',null];state.publisher.publish=['in_progress',null];
    try{return await emitHandoff(api,env,{cwd:world.checkout,artifactDir,candidate:C,branch:branchName,dispatchedAt,now:at,...options});}
    finally{state.publisher=saved;}
   },
   async verify(record,stage,options={}){
    return verifyHandoff(api,record,{stage,cwd:world.checkout,artifactDir,now:at,...options});
   },
   /** What the operator's two writes produce: main at the candidate, then the identical release. */
   deliverMain(){state.main=C;},
   publishRelease(record){
    const bytes={'Relayium.dmg':files.get('Relayium.dmg'),'Relayium.dmg.sha256':files.get('Relayium.dmg.sha256'),
     'appcast.xml':files.get('release-web/public/apps/macos/appcast.xml')};
    const assets=[['Relayium.dmg',1],['Relayium.dmg.sha256',2],['appcast.xml',3]].map(([name,id])=>({id,name,state:'uploaded',size:bytes[name].length}));
    const release={id:81,tag_name:record.release.tag,draft:false,prerelease:false,name:record.releasePlan.title,body:record.releasePlan.notes,assets};
    state.tag={object:{sha:S,type:'commit'}};state.releases=[release];state.releaseById={81:release};
    state.assetBytes={1:bytes['Relayium.dmg'],2:bytes['Relayium.dmg.sha256'],3:bytes['appcast.xml']};
   },
   independentDmgSha(){return hash(readFileSync(join(artifactDir,'Relayium.dmg')));},
   derivedFiles:DERIVED_FILES};
 }catch(error){world.dispose();throw error;}
}
