import { expect, it, vi } from "vitest";
import { uploadPipeline, type PipelineOptions } from "./upload-pipeline";

function deferred<T>() {
  let resolve!: (value:T) => void;
  let reject!: (reason?:unknown) => void;
  const promise = new Promise<T>((a,b) => { resolve=a; reject=b; });
  return { promise, resolve, reject };
}
async function* source(total=12) {
  for(let i=0;i<total;i+=2) yield new Uint8Array([i,i+1]);
}
function setup(extra: Partial<PipelineOptions>={}) {
  const requests: { start:number; body:Uint8Array; sent:()=>void; ack:ReturnType<typeof deferred<{kind:"answer";received:number}|{kind:"fault"}>> }[]=[];
  let active=0, maxActive=0;
  const confirmations:number[]=[];
  const recover=vi.fn(async (floor:number)=>floor);
  const options:PipelineOptions={
    source:source(),buffer:new Uint8Array(6),target:4,total:12,
    enabled:()=>true,recover,confirmed:(n)=>confirmations.push(n),
    send:(body,start,signal,sent)=>{
      active++;maxActive=Math.max(active,maxActive);
      const ack=deferred<{kind:"answer";received:number}|{kind:"fault"}>();
      const abort=()=>ack.reject(new DOMException("aborted","AbortError"));
      signal.addEventListener("abort",abort,{once:true});
      requests.push({start,body,sent,ack});
      return ack.promise.finally(()=>{active--;signal.removeEventListener("abort",abort);});
    },...extra,
  };
  return { requests, confirmations, recover, options, active:()=>active, maxActive:()=>maxActive };
}

it("overlaps a successor with confirmation, with two buffers and two live owners",async()=>{
  const h=setup();const running=uploadPipeline(h.options);
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));
  expect([...h.requests[0].body]).toEqual([0,1,2,3]);
  // No competing send while the predecessor body is still sending.
  await Promise.resolve();expect(h.requests).toHaveLength(1);
  h.requests[0].sent();
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));
  h.requests[1].sent();
  await Promise.resolve();expect(h.requests).toHaveLength(2);
  expect(h.confirmations).toEqual([]);
  expect([...h.requests[0].body]).toEqual([0,1,2,3]);
  h.requests[0].ack.resolve({kind:"answer",received:4});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(3));
  expect([...h.requests[1].body]).toEqual([4,5,6,7]);
  expect([...h.requests[2].body]).toEqual([8,9,10,11]);
  h.requests[1].ack.resolve({kind:"answer",received:8});
  h.requests[2].ack.resolve({kind:"answer",received:12});
  const result=await running;
  expect(result.completed).toBe(true);expect(result.offset).toBe(12);
  expect(result.bufferPeak).toBe(12);expect(h.maxActive()).toBe(2);expect(h.active()).toBe(0);
  expect(h.confirmations).toEqual([4,8,12]);expect(h.recover).not.toHaveBeenCalled();
});

it("keeps cumulative confirmations monotonic when answers arrive in reverse order",async()=>{
  const h=setup({total:8,source:source(8)});const running=uploadPipeline(h.options);
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));h.requests[0].sent();
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));
  h.requests[1].ack.resolve({kind:"answer",received:8});
  await vi.waitFor(()=>expect(h.confirmations).toEqual([8]));
  let ended=false;void running.then(()=>{ended=true;});
  await Promise.resolve();expect(ended).toBe(false); // Earlier owner still live.
  h.requests[0].ack.resolve({kind:"answer",received:4});
  expect((await running).completed).toBe(true);expect(h.confirmations).toEqual([8]);
});

it("drains owned requests before resync and returns exactly the unconfirmed ciphertext",async()=>{
  const h=setup();
  h.options.recover=vi.fn(async()=>{expect(h.active()).toBe(0);return 6;});
  const running=uploadPipeline(h.options);
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));h.requests[0].sent();
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));
  h.requests[0].ack.resolve({kind:"fault"});
  const result=await running;
  expect(result.completed).toBe(false);expect(result.offset).toBe(6);expect(result.highestSent).toBe(8);
  const bytes=[...result.buffer.subarray(0,result.filled)];
  for await(const part of result.source) bytes.push(...part);
  expect(bytes).toEqual([6,7,8,9,10,11]);expect(h.active()).toBe(0);
  expect(result.bufferPeak).toBeLessThanOrEqual(12);
});

it("retains both pending chunks when recovery confirms only the first prefix",async()=>{
  const h=setup();h.options.recover=async()=>2;
  const running=uploadPipeline(h.options);
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));h.requests[0].sent();
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));h.requests[0].ack.resolve({kind:"fault"});
  const result=await running;
  const bytes=[...result.buffer.subarray(0,result.filled)];
  for await(const part of result.source) { expect(part.length).toBeLessThanOrEqual(2);bytes.push(...part); }
  expect(bytes).toEqual([2,3,4,5,6,7,8,9,10,11]);
});

it("never recovers or finalizes after user cancellation, and joins both requests",async()=>{
  const ac=new AbortController();const h=setup({signal:ac.signal});
  const running=uploadPipeline(h.options);const rejected=expect(running).rejects.toMatchObject({name:"AbortError"});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));h.requests[0].sent();
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));ac.abort();await rejected;
  expect(h.active()).toBe(0);expect(h.recover).not.toHaveBeenCalled();
});

it("rejects unsent offsets and drains the other owner",async()=>{
  const h=setup();const running=uploadPipeline(h.options);
  const rejected=expect(running).rejects.toThrow("invalid upload pipeline state");
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));h.requests[0].sent();
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));h.requests[0].ack.resolve({kind:"answer",received:9});
  await rejected;expect(h.active()).toBe(0);expect(h.confirmations).toEqual([]);expect(h.recover).not.toHaveBeenCalled();
});

it("degrades to serial timing when a transport has no body-sent callbacks",async()=>{
  const h=setup({total:8,source:source(8)});const running=uploadPipeline(h.options);
  await vi.waitFor(()=>expect(h.requests).toHaveLength(1));
  h.requests[0].ack.resolve({kind:"answer",received:4});
  await vi.waitFor(()=>expect(h.requests).toHaveLength(2));h.requests[1].ack.resolve({kind:"answer",received:8});
  expect((await running).completed).toBe(true);expect(h.maxActive()).toBe(1);
});

it("retains prepared ciphertext when pacing is enabled during an asynchronous file read",async()=>{
  let enabled=true;
  async function* changing(){yield new Uint8Array([0,1]);enabled=false;yield new Uint8Array([2,3]);yield new Uint8Array([4,5]);}
  const h=setup({source:changing(),total:6,enabled:()=>enabled});
  const result=await uploadPipeline(h.options);
  expect(h.requests).toHaveLength(0);expect(result.highestSent).toBe(0);expect(result.completed).toBe(false);
  const held=[...result.buffer.subarray(0,result.filled)];for await(const bytes of result.source)held.push(...bytes);
  expect(held).toEqual([0,1,2,3,4,5]);
});
