import { afterEach, expect, it, vi } from "vitest";
import { uploadFileResumable, uploadBufferPeak } from "./stored-file";
import { decodeKey, importStoreKey, StoreDecryptor, STORE_CHUNK_SIZE, FRAME_OVERHEAD, cipherSizeFor } from "./store-crypto";
import { saveSpeedPref } from "./transfer-control";
import { UPLOAD_PIPELINE_V1 } from "./upload-pipeline";

afterEach(()=>{vi.unstubAllGlobals();saveSpeedPref({mode:"fast",capBytesPerSec:1048576});});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{"Content-Type":"application/json"}});

function fixture(capability:unknown=UPLOAD_PIPELINE_V1) {
  const requests: Wire[]=[];
  let active=0,maxActive=0,finalized=0,reads=0,gets=0;
  let staleStatus: number | undefined;
  let retained=new Uint8Array();
  const plain=Uint8Array.from({length:STORE_CHUNK_SIZE*3+11},(_,i)=>(i*31)&255);
  const real=new File([plain],"pipeline.bin");
  const file={name:real.name,size:real.size,slice:(a:number,b:number)=>{reads++;return real.slice(a,b);}} as File;
  const append=(start:number,body:Uint8Array)=>{
    expect(start).toBe(retained.length);
    const next=new Uint8Array(retained.length+body.length);next.set(retained);next.set(body,retained.length);retained=next;
  };
  class Wire {
    upload={onprogress:null as ((e:ProgressEvent)=>void)|null,onload:null as (()=>void)|null};
    onload:(()=>void)|null=null;onerror:(()=>void)|null=null;onabort:(()=>void)|null=null;onreadystatechange:(()=>void)|null=null;
    status=0;readyState=0;responseText="";withCredentials=false;url="";headers:Record<string,string>={};
    body=new Uint8Array();start=0;ended=false;
    open(method:string,url:string){expect(method).toBe("PATCH");this.url=url;}
    setRequestHeader(name:string,value:string){this.headers[name]=value;}
    getResponseHeader(){return null;}
    send(body:Uint8Array){
      expect(this.url).toBe("/api/uploads/pipe1");expect(this.withCredentials).toBe(true);
      expect(this.headers["X-Relayium-Upload-Pipeline"]).toBe(UPLOAD_PIPELINE_V1);
      this.start=Number(this.headers["Content-Range"].match(/^bytes (\d+)-/)![1]);
      this.body=body.slice();active++;maxActive=Math.max(maxActive,active);requests.push(this);
      queueMicrotask(()=>{if(!this.ended){this.upload.onprogress?.(new ProgressEvent("progress",{loaded:body.length,total:body.length,lengthComputable:true}));this.upload.onload?.();}});
    }
    abort(){if(!this.ended){this.ended=true;active--;this.onabort?.();}}
    answer(received:number){if(!this.ended){this.ended=true;active--;this.status=200;this.readyState=2;this.onreadystatechange?.();this.responseText=JSON.stringify({received});this.readyState=4;this.onload?.();}}
    fail(){if(!this.ended){this.ended=true;active--;this.onerror?.();}}
  }
  vi.stubGlobal("XMLHttpRequest",Wire);
  vi.stubGlobal("fetch",async(input:string,init?:RequestInit)=>{
    const method=init?.method??"GET";
    if(method==="POST" && input.startsWith("/api/uploads?"))return json({uploadId:"pipe1",chunkSize:STORE_CHUNK_SIZE,uploadPipeline:capability});
    if(method==="GET") {gets++;expect(active,"resync preceded request drain").toBe(0);const received=staleStatus??retained.length;staleStatus=undefined;return json({received});}
    if(method==="PATCH"){
      expect(active).toBe(0);
      const start=Number((init!.headers as Record<string,string>)["Content-Range"].match(/^bytes (\d+)-/)![1]);
      if(start<retained.length)return json({received:retained.length});
      append(start,(init!.body as Uint8Array).slice());return json({received:retained.length});
    }
    if(method==="POST" && input.endsWith("/finalize")){
      expect(active,"finalize raced a request").toBe(0);expect(retained.length).toBe(cipherSizeFor([file]));finalized++;return json({id:"pipe1",expiresAt:9});
    }
    throw new Error(`unexpected ${method} ${input}`);
  });
  return {requests,plain,file,append,staleStatus:(n:number)=>{staleStatus=n;},retained:()=>retained,active:()=>active,maxActive:()=>maxActive,finalized:()=>finalized,reads:()=>reads,gets:()=>gets};
}

async function decrypted(key:string,ciphertext:Uint8Array,size:number){
  const dec=new StoreDecryptor(await importStoreKey(decodeKey(key)));const parts:Uint8Array[]=[];
  for await(const p of dec.push(ciphertext))parts.push(p);
  for await(const p of dec.end(size))parts.push(p);
  const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;
  for(const p of parts){result.set(p,at);at+=p.length;}return result;
}

it("sends the next ciphertext while confirmation is held and finalizes only after all owners finish",async()=>{
  const h=fixture();const progress:number[]=[];
  const running=uploadFileResumable([h.file],{burnAfterRead:false,ttl:0},p=>{if(p.phase==="uploading")progress.push(p.sent);});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));
  expect(h.active()).toBe(2);expect(h.retained().length).toBe(0);expect(h.finalized()).toBe(0);
  let at=0;
  while(h.retained().length<cipherSizeFor([h.file])){
    await vi.waitFor(()=>expect(h.requests.length).toBeGreaterThan(at));
    const r=h.requests[at++];h.append(r.start,r.body);r.answer(h.retained().length);
  }
  const result=await running;
  expect(h.maxActive()).toBe(2);expect(h.finalized()).toBe(1);expect(h.reads()).toBe(4);
  expect(progress).toEqual([...progress].sort((a,b)=>a-b));
  expect(uploadBufferPeak()).toBeLessThanOrEqual(2*(STORE_CHUNK_SIZE*2+FRAME_OVERHEAD));
  expect(await crypto.subtle.digest("SHA-256",await decrypted(result.key,h.retained(),h.plain.length))).toEqual(await crypto.subtle.digest("SHA-256",h.plain));
});

it("drains a successor after a lost partial answer and reuses ciphertext without another file read",async()=>{
  const h=fixture();const running=uploadFileResumable([h.file],{burnAfterRead:false,ttl:0});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));
  const first=h.requests[0];h.append(0,first.body.subarray(0,Math.floor(first.body.length/2)));first.fail();
  const result=await running;
  expect(h.requests[1].ended).toBe(true);expect(h.active()).toBe(0);expect(h.gets()).toBeGreaterThan(0);
  expect(h.finalized()).toBe(1);expect(h.reads()).toBe(4);
  expect(await crypto.subtle.digest("SHA-256",await decrypted(result.key,h.retained(),h.plain.length))).toEqual(await crypto.subtle.digest("SHA-256",h.plain));
});

it("cancels both requests without reading offsets or finalizing",async()=>{
  const h=fixture();const ac=new AbortController();
  const running=uploadFileResumable([h.file],{burnAfterRead:false,ttl:0},undefined,ac.signal);
  const rejected=expect(running).rejects.toMatchObject({name:"AbortError"});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));ac.abort();await rejected;
  expect(h.active()).toBe(0);expect(h.finalized()).toBe(0);expect(h.gets()).toBe(0);
});

it("handles a late cumulative ACK across the retained successor after a stale status read",async()=>{
  const h=fixture();const running=uploadFileResumable([h.file],{burnAfterRead:false,ttl:0});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));
  h.append(h.requests[0].start,h.requests[0].body);h.append(h.requests[1].start,h.requests[1].body);
  h.staleStatus(0);h.requests[0].fail();
  const result=await running;
  expect(h.active()).toBe(0);expect(h.finalized()).toBe(1);expect(h.reads()).toBe(4);
  expect(await crypto.subtle.digest("SHA-256",await decrypted(result.key,h.retained(),h.plain.length))).toEqual(await crypto.subtle.digest("SHA-256",h.plain));
});

it("uses the existing serial protocol for an unrecognized capability",async()=>{
  const h=fixture("unknown-v2");const result=await uploadFileResumable([h.file],{burnAfterRead:false,ttl:0});
  expect(h.requests).toHaveLength(0);expect(h.finalized()).toBe(1);
  expect(await crypto.subtle.digest("SHA-256",await decrypted(result.key,h.retained(),h.plain.length))).toEqual(await crypto.subtle.digest("SHA-256",h.plain));
});

it.each(["cap","background"] as const)("keeps %s uploads on the existing paced serial path",async(mode)=>{
  const h=fixture();saveSpeedPref({mode,capBytesPerSec:32*1024*1024});
  const result=await uploadFileResumable([h.file],{burnAfterRead:false,ttl:0});
  expect(h.requests).toHaveLength(0);expect(h.finalized()).toBe(1);
  expect(await decrypted(result.key,h.retained(),h.plain.length)).toEqual(h.plain);
});
