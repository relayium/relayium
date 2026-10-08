// Test data only. Actual Git objects and shipped produce/witness/readers;
// no network, checkout-history dependency, or native runner claims.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {deflateRawSync} from 'node:zlib';
import * as F from '../../../ci/ci-evidence.mjs';
import * as E from '../../../release/macos-evidence.mjs';
import {LANES as SELECTOR_LANES} from '../../../ci/select-lanes.mjs';
import {TOOLCHAIN_SCHEMA,TOOLCHAIN_REGISTRY_FILE,loadToolchainRegistry,toolchainDigest} from '../../../ci/ci-evidence-toolchain.mjs';
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const REPO='relayium/relayium', REPO_ID=1282331342;
const REGISTRY=F.loadRegistry(readFileSync(join(repoRoot,F.REGISTRY_FILE),'utf8'));
const TOOLREG=loadToolchainRegistry(readFileSync(join(repoRoot,TOOLCHAIN_REGISTRY_FILE),'utf8'));
const crc32=F.crc32;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const iso=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const clone=v=>structuredClone(v);
export const isolatedGitEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const gitEnv={...isolatedGitEnvironment(),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',
 GIT_AUTHOR_NAME:'fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'fixture',
 GIT_COMMITTER_EMAIL:'fixture@example.invalid',GIT_AUTHOR_DATE:'1790000000 +0000',GIT_COMMITTER_DATE:'1790000000 +0000'};
function git(args,cwd){const r=spawnSync('git',args,{cwd,env:gitEnv,encoding:'buffer',maxBuffer:64*1024*1024});
 if(r.status!==0)throw new Error(`fixture Git ${args.join(' ')}: ${r.stderr}`);return r.stdout;}
let checkoutHeld=false;

const FIXTURE_COMPONENTS = {
  image: (runner) => ({
    "ubuntu-latest": { runner_os: "Linux", runner_arch: "X64", image_os: "ubuntu24", image_version: "20260928.1", os_release: "ubuntu 24.04" },
    "macos-15": { runner_os: "macOS", runner_arch: "ARM64", image_os: "macos15", image_version: "20260929.0102", os_release: "macOS 15.7 (24G222)" },
    "windows-latest": { runner_os: "Windows", runner_arch: "X64", image_os: "win25", image_version: "20260928.1", os_release: "10.0.26100.6584" },
  })[runner],
  go: (runner) => ({ version: "go1.26.3", goos: { "macos-15": "darwin", "windows-latest": "windows" }[runner] ?? "linux",
    goarch: runner === "macos-15" ? "arm64" : "amd64", cgo_enabled: "1", cc: runner === "macos-15" ? "clang" : "gcc",
    cc_path: runner === "macos-15" ? "/usr/bin/clang" : "/usr/bin/x86_64-linux-gnu-gcc-13",
    cc_target: { "macos-15": "arm64-apple-darwin24.6.0", "windows-latest": "x86_64-w64-mingw32" }[runner] ?? "x86_64-linux-gnu",
    cc_version: runner === "macos-15" ? "Apple clang version 17.0.0 (clang-1700.3.19.1)" : "gcc (Ubuntu 13.3.0-6ubuntu2~24.04) 13.3.0" }),
  node: () => ({ version: "v24.9.0", npm: "11.6.0" }),
  java: () => ({ version: "17.0.16", build: "17.0.16+8" }),
  "android-sdk": () => ({ "platforms;android-37.0": "1", "build-tools;36.0.0": "36.0.0" }),
  chrome: () => ({ pinned: false, path: "/usr/bin/google-chrome", real_path: "/opt/google/chrome/google-chrome", sha256: "c".repeat(64), version: "Google Chrome 141.0.7390.54" }),
  xcode: () => ({ installed: [{ app: "/Applications/Xcode_26.0.1.app", version: "26.0.1", build: "17A400", macosx_sdk: "26.0", iphonesimulator_sdk: "26.0" },
    { app: "/Applications/Xcode_16.4.app", version: "16.4", build: "16F6", macosx_sdk: "15.5", iphonesimulator_sdk: "18.5" }],
  default_developer_dir: "/Applications/Xcode_16.4.app/Contents/Developer",
  used: { app: "/Applications/Xcode_16.4.app", version: "16.4", build: "16F6" } }),
  destination: (runner, p) => ({ rule: p.destination, program_sha256: TOOLREG.destinations[p.destination].sha256,
    interpreter: { path: "/usr/bin/python3", version: "Python 3.9.6" },
    selected: { name: "iPhone 17 Pro", device_type: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", listing_position: 1,
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0", runtime_version: "26.0", runtime_build: "23A339" } }),
};
const fixtureToolchain = (profile) => {
  const p = TOOLREG.profiles[profile];
  return Object.fromEntries(p.components.map((c) => [c, FIXTURE_COMPONENTS[c](p.runner, p)]));
};
function makeCert({ role, profile, lane, jobId, index = 0, total = 1, runId, attempt, sha, workflowRef, toolchain, capturedAt }) {
  const t = toolchain ?? fixtureToolchain(profile);
  return {
    schema: TOOLCHAIN_SCHEMA,
    binding: { role, profile, lane, job: jobId, repository_id: REPO_ID, run_id: runId, run_attempt: attempt, sha,
      workflow_ref: workflowRef, github_job: role === "source" ? jobId : "evidence", job_index: index, job_total: total },
    toolchain: t,
    digest: toolchainDigest(profile, t),
    audit: { captured_at: capturedAt, developer_dir: "", matrix: "", simulator_udid: "" },
  };
}

function zipOf(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data);
    const flags = e.flags ?? 0x0008;
    const usize = e.usize ?? data.length;
    const csize = e.csize ?? body.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(name.length, 26);
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize >>> 0, 8); dd.writeUInt32LE(usize >>> 0, 12);
    const local = Buffer.concat([lh, name, body, dd]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize >>> 0, 20); ch.writeUInt32LE(usize >>> 0, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE((e.ext ?? 0o100644) * 0x10000 >>> 0, 38); ch.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([ch, name]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}


export async function certifiedWorld({now=new Date(),sourceAgeMs=2*3600000,witnessAgeMs=3600000}={}) {
 const at=Math.floor(new Date(now).getTime()/1000)*1000;assert(Number.isFinite(at));
 const directory=mkdtempSync(join(tmpdir(),'relayium-certified-world-'));
 const checkout=join(directory,'checkout');mkdirSync(checkout);
 let disposed=false;
 try {
  git(['init','-q','--object-format=sha1','-b','fixture'],checkout);
  const scope=await import(pathToFileURL(join(repoRoot,F.SCOPE_FILE)).href);
  const listing=git(['ls-files','-z','--','.github','scripts','web/e2e',F.SCOPE_FILE,
   ...scope.RELEASE_ARTIFACT_FILES,'web/native-releases.json','README.md','apps/README.md'],repoRoot).toString().split('\0').filter(Boolean);
  // New test helper and source paths are not yet in the product index.
  for(const path of ['scripts/test/fixtures/macos-certified/world.mjs','scripts/release/macos-handoff.mjs',
   'scripts/test/macos-handoff-test.mjs']) if(!listing.includes(path))listing.push(path);
  for(const path of listing){mkdirSync(dirname(join(checkout,path)),{recursive:true});cpSync(join(repoRoot,path),join(checkout,path));}
  const testPath='apps/mac/Tests/CertifiedWorldTests.swift';mkdirSync(dirname(join(checkout,testPath)),{recursive:true});
  writeFileSync(join(checkout,testPath),'// synthetic native test input\n');
  git(['add','-A'],checkout);const baseTree=git(['write-tree'],checkout).toString().trim();
  const baseSha=git(['commit-tree',baseTree,'-m','fixture base'],checkout).toString().trim();
  writeFileSync(join(checkout,testPath),'// synthetic native test input\n// eligible change\n');
  git(['add','-A'],checkout);const tree=git(['write-tree'],checkout).toString().trim();
  const sha=git(['commit-tree',tree,'-p',baseSha,'-m','fixture candidate'],checkout).toString().trim();
  git(['update-ref','refs/heads/fixture',sha],checkout);git(['checkout','-q',sha],checkout);
  const runGit=args=>git(args,checkout);
  const sourceId=36995000001,mainId=36995000002,proofId=11200000001,witnessId=11200000002,signedId=11200000003;
  const sourceAt=at-sourceAgeMs,witnessAt=at-witnessAgeMs,captureAt=witnessAt-60000;
  const sourceRef=`refs/heads/internal-candidate/${sha}`;
  const source={id:sourceId,run_attempt:1,head_sha:sha,head_branch:`internal-candidate/${sha}`,event:'workflow_dispatch',
   path:'.github/workflows/merge-gate.yml',status:'completed',conclusion:'success',created_at:iso(sourceAt-1800000),
   run_started_at:iso(sourceAt-1800000),updated_at:iso(sourceAt),repository:{id:REPO_ID,full_name:REPO,fork:false},
   head_repository:{id:REPO_ID,full_name:REPO,fork:false},pull_requests:[],
   referenced_workflows:Object.values(REGISTRY.lanes).map(l=>({path:`${REPO}/.github/workflows/${l.workflow}@${sha}`,sha,ref:sourceRef}))};
  const main={id:mainId,run_attempt:1,head_sha:sha,head_branch:'main',event:'push',path:E.PRODUCER_WORKFLOW,
   workflow_id:321216057,status:'completed',conclusion:'success',created_at:iso(captureAt-30000),
   run_started_at:iso(captureAt-30000),updated_at:iso(witnessAt+600000),repository:clone(source.repository),head_repository:clone(source.head_repository)};
  let jobId=100;const sourceJobs=[{id:jobId++,name:'select',status:'completed',conclusion:'success',labels:['ubuntu-latest'],run_attempt:1,head_sha:sha}];
  for(const [laneId,lane] of Object.entries(REGISTRY.lanes)){
   sourceJobs.push({id:jobId++,name:`${laneId} / evidence`,status:'completed',conclusion:'success',labels:['ubuntu-latest'],run_attempt:1,head_sha:sha});
   for(const entry of Object.values(lane.jobs))for(const check of entry.checks)sourceJobs.push({id:jobId++,name:`${laneId} / ${check}`,
    status:'completed',conclusion:'success',labels:[laneId==='macos'&&check==='contract'?'ubuntu-latest':entry.runner],run_attempt:1,head_sha:sha});
  }
  sourceJobs.push({id:9999,name:'merge-gate',status:'completed',conclusion:'success',labels:['ubuntu-latest'],run_attempt:1,head_sha:sha});
  for(const {id} of SELECTOR_LANES)if(!REGISTRY.lanes[id])sourceJobs.push({id:jobId++,name:`${id} / evidence`,status:'completed',conclusion:'success',labels:['ubuntu-latest'],run_attempt:1,head_sha:sha});
  for(const job of sourceJobs)job.run_id=sourceId;
  const artifacts=[],zipBytes=new Map();let certId=11300000000;
  function addArtifact(id,name,bytes,run,created,expires){const a={id,name,expired:false,digest:`sha256:${hash(bytes)}`,size_in_bytes:bytes.length,
   created_at:iso(created),expires_at:iso(expires),workflow_run:{id:run.id,head_sha:run.head_sha,repository_id:REPO_ID,head_repository_id:REPO_ID,head_branch:run.head_branch}};
   artifacts.push(a);zipBytes.set(id,Buffer.from(bytes));return a;}
  for(const [laneId,lane] of Object.entries(REGISTRY.lanes))for(const [jobId,entry] of Object.entries(lane.jobs)){
   const t=TOOLREG.lanes[laneId]?.jobs?.[jobId];if(entry.mode==='fresh'||!t||t.uncertifiable)continue;
   entry.checks.forEach((_,index)=>{const c=makeCert({role:'source',profile:t.profile,lane:laneId,jobId,index,total:entry.checks.length,
    runId:sourceId,attempt:1,sha,workflowRef:`${REPO}/.github/workflows/merge-gate.yml@${sourceRef}`,capturedAt:iso(sourceAt-1200000)});
    addArtifact(++certId,`relayium-ci-evidence-toolchain-${laneId}-${jobId}-${index}-attempt-1`,
     zipOf([{name:'toolchain.json',data:JSON.stringify(c)}]),source,sourceAt-1100000,sourceAt+7*86400000);});
  }
  addArtifact(++certId,'relayium-ci-evidence-web-tags-attempt-1',zipOf([{name:'tags.txt',data:''}]),source,sourceAt-1100000,sourceAt+7*86400000);
  const calls=[],counters=new Map();const hooks=new Map();let producing=false,onMain=false;
  const counted=route=>{calls.push(route);const n=(counters.get(route)??0)+1;counters.set(route,n);return n;};
  function runBody(run){return run.id===sourceId&&producing?{...run,status:'in_progress',conclusion:null}:run;}
  const step=(name,start,end,conclusion='success',number=1)=>({name,number,status:'completed',conclusion,
   started_at:conclusion==='skipped'?null:iso(start),completed_at:conclusion==='skipped'?null:iso(end)});
  const job=(id,name,labels,start,end,names)=>({id,name,run_id:mainId,run_attempt:1,head_sha:sha,status:'completed',conclusion:'success',
   labels,started_at:iso(start),completed_at:iso(end),steps:names.map((n,i)=>step(n,start,end,'success',i+1))});
  const mainJobs=[];
  mainJobs.push(job(501,'contract',['ubuntu-latest'],captureAt-20000,captureAt-10000,E.REQUIRED_STEPS.contract));
  for(const [index,id] of E.CERTIFIABLE_JOBS.entries()){
   const name=id==='test'?'test':id==='ui-smoke/app-shell'?'ui-smoke (app-shell, RelayiumUITests/AppShellUITests, 30)':
    'ui-smoke (device-inbox, RelayiumUITests/DeviceInboxUITests,RelayiumUITests/SubscriptionUITests,Re...';
   const j=job(502+index,name,['ubuntu-latest'],witnessAt+2000,witnessAt+3000,E.WITNESS_STEPS);
   j.steps.push(...E.REQUIRED_STEPS[id].map((n,i)=>step(n,0,0,'skipped',E.WITNESS_STEPS.length+i+1)));mainJobs.push(j);
  }
  mainJobs.push(job(505,'signed-build',['macos-15'],witnessAt+4000,witnessAt+600000,E.REQUIRED_STEPS['signed-build']));
  mainJobs.push(job(506,'screen',['ubuntu-latest'],captureAt-25000,captureAt-22000,[]));
  const certify=job(507,'certify-macos',['macos-15'],captureAt-1000,captureAt+12000,E.CERTIFY_STEPS);
  certify.steps=[step(E.CERTIFY_STEPS[0],captureAt-1000,captureAt, 'success',1),
   step(E.CERTIFY_STEPS[1],captureAt,captureAt+10000,'success',2),step(E.CERTIFY_STEPS[2],captureAt+10000,captureAt+11000,'success',3)];mainJobs.push(certify);
  const evidence=job(508,'evidence',['ubuntu-latest'],witnessAt-3000,witnessAt+2000,E.CERTIFIED_EVIDENCE_STEPS);
  evidence.steps=[step(E.CERTIFIED_EVIDENCE_STEPS[0],witnessAt-2000,witnessAt,'success',1),
   step(E.CERTIFIED_EVIDENCE_STEPS[1],witnessAt,witnessAt+1000,'success',2),step(E.CERTIFIED_EVIDENCE_STEPS[2],witnessAt+1000,witnessAt+2000,'success',3)];mainJobs.push(evidence);
  const originalRuns=new Map([[sourceId,new Map([[1,clone(source)]])],[mainId,new Map([[1,clone(main)]])]]);
  const attemptJobs=new Map([[sourceId,new Map([[1,sourceJobs]])],[mainId,new Map([[1,mainJobs]])]]);
  const prefix=`repos/${REPO}/`;
  async function get(input){
   const route=input.replace(/^\//,'');const n=counted(route);const hook=hooks.get(route);if(hook){const value=await hook(n);if(value!==undefined)return clone(value);}
   const u=new URL('https://fixture.invalid/'+route),p=u.pathname.slice(1),q=u.searchParams;let m;
   const paged=(key,list)=>({total_count:list.length,[key]:clone(list.slice((Number(q.get('page')??1)-1)*Number(q.get('per_page')??100),Number(q.get('page')??1)*Number(q.get('per_page')??100)))});
   if(p===prefix+`commits/${sha}/pulls`)return [];
   if(p===prefix+'actions/workflows/merge-gate.yml/runs')return paged('workflow_runs',[runBody(source)]);
   if(p===prefix+'actions/workflows/macos.yml')return {id:321216057,path:E.PRODUCER_WORKFLOW,state:'active'};
   if(p===prefix+'actions/workflows/321216057/runs')return paged('workflow_runs',[main]);
   if(p===prefix+'git/matching-refs/tags')return [];
   if(p===prefix+'git/ref/heads/main')return {object:{sha:onMain?sha:baseSha,type:'commit'}};
   if(p===prefix+`git/ref/heads/internal-candidate/${sha}`)return {object:{sha,type:'commit'}};
   if(p===prefix+`contents/.github/workflows/macos.yml`){const bytes=runGit(['show',`${q.get('ref')}:`+E.PRODUCER_WORKFLOW]);
    return {path:E.PRODUCER_WORKFLOW,encoding:'base64',content:bytes.toString('base64'),sha:runGit(['rev-parse',`${q.get('ref')}:`+E.PRODUCER_WORKFLOW]).toString().trim()};}
   if((m=/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?$/.exec(p))){const run=Number(m[1])===sourceId?source:Number(m[1])===mainId?main:null;
    if(run&&!m[2])return clone(runBody(run));
    if(run&&originalRuns.get(run.id)?.has(Number(m[2])))return clone(originalRuns.get(run.id).get(Number(m[2])));}
   if((m=/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(p))){const list=attemptJobs.get(Number(m[1]))?.get(Number(m[2]));
    if(!list)throw Object.assign(new Error('fixture attempt has no jobs'),{status:404});
    return paged('jobs',producing&&Number(m[1])===sourceId?list.map(j=>j.name==='merge-gate'?{...j,status:'in_progress',conclusion:null}:j):list);}
   if((m=/actions\/runs\/(\d+)\/artifacts$/.exec(p)))return paged('artifacts',artifacts.filter(a=>a.workflow_run.id===Number(m[1])&&(!q.has('name')||a.name===q.get('name'))));
   if((m=/actions\/artifacts\/(\d+)$/.exec(p))){const a=artifacts.find(a=>a.id===Number(m[1]));if(a)return clone(a);}
   if((m=/git\/commits\/([0-9a-f]{40})$/.exec(p))){const text=runGit(['cat-file','commit',m[1]]).toString().split('\n\n')[0];
    return {sha:m[1],tree:{sha:/^tree (.+)$/m.exec(text)[1]},parents:[...text.matchAll(/^parent (.+)$/gm)].map(x=>({sha:x[1]}))};}
   if((m=/git\/trees\/([0-9a-f]{40})$/.exec(p))){const list=runGit(['ls-tree',...(q.get('recursive')==='1'?['-r','-t']:[]),'-z',m[1]]).toString().split('\0').filter(Boolean);
    return {sha:m[1],truncated:false,tree:list.map(x=>{const [mode,type,sha]=x.slice(0,x.indexOf('\t')).split(' ');return {path:x.slice(x.indexOf('\t')+1),mode,type,sha};})};}
   if((m=/git\/blobs\/([0-9a-f]{40})$/.exec(p))){const b=runGit(['cat-file','blob',m[1]]);return {sha:m[1],encoding:'base64',content:b.toString('base64'),size:b.length};}
   if((m=/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(p))){const parts=runGit(['diff-tree','-r','-z','--no-commit-id','--no-renames','--name-status',m[1],m[2]]).toString().split('\0').filter(Boolean);const files=[];
    for(let i=0;i<parts.length;i+=2)files.push({filename:parts[i+1],status:{A:'added',D:'removed',M:'modified',T:'changed'}[parts[i]]});
    const ahead=Number(runGit(['rev-list','--count',`${m[1]}..${m[2]}`]).toString()),behind=Number(runGit(['rev-list','--count',`${m[2]}..${m[1]}`]).toString());
    return {status:ahead?(behind?'diverged':'ahead'):(behind?'behind':'identical'),ahead_by:ahead,behind_by:behind,files};}
   throw Object.assign(new Error(`unrouted fixture GET ${route}`),{status:404});
  }
  const api={get,async download(input){const route=input.replace(/^\//,'');const n=counted('DOWNLOAD '+route);const hook=hooks.get('DOWNLOAD '+route);
   if(hook){const value=await hook(n);if(value!==undefined)return Buffer.from(value);}const id=Number(/artifacts\/(\d+)\/zip$/.exec(route)?.[1]);
   if(!zipBytes.has(id))throw Object.assign(new Error('fixture missing ZIP'),{status:404});return Buffer.from(zipBytes.get(id));}};
  const fApi={json:get,download:api.download};
  const needs={select:{result:'success'},compat:{result:'success'},'repo-hygiene':{result:'success'}},selected={};
  for(const {id} of SELECTOR_LANES){needs[id]={result:'success'};selected[id]='true';}
  const eventPath=join(directory,'push.json');writeFileSync(eventPath,JSON.stringify({ref:'refs/heads/main',before:baseSha,after:sha,created:false,deleted:false,forced:false,repository:{id:REPO_ID}}));
  const sourceEnv={GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:sourceRef,GITHUB_REPOSITORY:REPO,GITHUB_REPOSITORY_ID:String(REPO_ID),
   GITHUB_SHA:sha,GITHUB_WORKFLOW_SHA:sha,GITHUB_RUN_ID:String(sourceId),GITHUB_RUN_ATTEMPT:'1',GITHUB_WORKFLOW_REF:`${REPO}/.github/workflows/merge-gate.yml@${sourceRef}`,
   CI_EVIDENCE_DISPATCH_MODE:'internal-full-candidate',CI_EVIDENCE_DISPATCH_BASE:baseSha,CI_EVIDENCE_DISPATCH_HEAD:sha,
   CI_EVIDENCE_NEEDS:JSON.stringify(needs),CI_EVIDENCE_SELECTED:JSON.stringify(selected)};
  const readFile=path=>readFileSync(join(checkout,path)),loadScope=()=>import(pathToFileURL(join(checkout,F.SCOPE_FILE)).href),workflowsDir=join(checkout,'.github/workflows');
  producing=true;const proof=await F.produce({env:sourceEnv,api:fApi,git:runGit,registry:REGISTRY,now:()=>new Date(sourceAt-1000),workflowsDir,readFile,loadScope});producing=false;
  addArtifact(proofId,'relayium-ci-evidence-proof-attempt-1',zipOf([{name:'ci-evidence.json',data:JSON.stringify(proof)}]),source,sourceAt,sourceAt+7*86400000);
  onMain=true;
  const mainEnv={GITHUB_EVENT_NAME:'push',GITHUB_REF:'refs/heads/main',GITHUB_REPOSITORY:REPO,GITHUB_REPOSITORY_ID:String(REPO_ID),GITHUB_SHA:sha,
   GITHUB_RUN_ID:String(mainId),GITHUB_RUN_ATTEMPT:'1',GITHUB_EVENT_PATH:eventPath,GITHUB_WORKFLOW_REF:`${REPO}/.github/workflows/macos.yml@refs/heads/main`};
  const currentCertificates=new Map(Object.keys(TOOLREG.profiles).map(profile=>[profile,makeCert({role:'current',profile,lane:'-',jobId:'-',runId:mainId,
   attempt:1,sha,workflowRef:mainEnv.GITHUB_WORKFLOW_REF,capturedAt:iso(captureAt+5000)})]));
  const witness=await F.witness({env:mainEnv,api:fApi,git:runGit,registry:REGISTRY,laneId:'macos',now:()=>new Date(witnessAt),workflowsDir,readFile,loadScope,
   toolchainRegistry:TOOLREG,currentCertificates});
  addArtifact(witnessId,'relayium-ci-evidence-witness-macos-attempt-1',zipOf([{name:'macos.json',data:JSON.stringify(witness)}]),main,witnessAt+1000,at+30*86400000);
  const dmg=Buffer.from('synthetic signed payload; native signature verified separately'),tool=Buffer.from('synthetic generate_appcast');
  const provenance={schema:E.PROVENANCE_SCHEMA,repository:REPO,repositoryId:String(REPO_ID),sha,ref:'refs/heads/main',event:'push',runId:String(mainId),runAttempt:'1',
   workflowRef:mainEnv.GITHUB_WORKFLOW_REF,workflowSha:sha,releaseVersion:'',channel:'direct',arch:'arm64',teamId:E.TEAM_ID,version:'1.4.5',build:'42',
   shareExtensionVersion:'1.4.5',shareExtensionBuild:'42',toolchain:{xcode:'Xcode 16.4 Build version 16F6',swift:'swift 6.1',macos:'15.6 (24G84)',runnerImage:'macos15/20260921'},
   signedBuildSource:'built',signedDmgSha256:hash(dmg),dmgSha256:hash(dmg),generateAppcastSha256:hash(tool)};
  addArtifact(signedId,`relayium-macos-signed-${sha}-ci`,zipOf([{name:'Relayium.dmg',data:dmg},{name:'Relayium.dmg.sha256',data:hash(dmg)+'  Relayium.dmg\n'},
   {name:'provenance.json',data:JSON.stringify(provenance)},{name:'release-tools/generate_appcast',data:tool}]),main,witnessAt+500000,at+14*86400000);
  return {repository:REPO,repositoryId:REPO_ID,baseSha,sha,tree,checkout,directory,now:new Date(at),source,sourceJobs,main,mainJobs,artifacts,zipBytes,proof,witness,
   api,fApi,calls,counters,hooks,runGit,originalRuns,attemptJobs,provenance,dmgSha256:hash(dmg),
   reset(){calls.length=0;counters.clear();hooks.clear();},
   async inCheckout(fn){assert(!disposed,'fixture disposed');assert(!checkoutHeld,'fixture checkout is already held');checkoutHeld=true;const prior=process.cwd();
    const ambientGit=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.startsWith('GIT_')));
    for(const key of Object.keys(ambientGit))delete process.env[key];
    try{process.chdir(checkout);return await fn();}finally{process.chdir(prior);
     for(const key of Object.keys(process.env))if(key.startsWith('GIT_'))delete process.env[key];
     Object.assign(process.env,ambientGit);checkoutHeld=false;}},
   dispose(){assert(!checkoutHeld,'cannot dispose during a fixture operation');if(!disposed){rmSync(directory,{recursive:true,force:true});disposed=true;}}};
 }catch(error){rmSync(directory,{recursive:true,force:true});throw error;}
}
