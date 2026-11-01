import {afterEach, expect, it, vi} from 'vitest';
import {NodeEventHub, requireEventCapability} from '../src/events';
import {readEventStream} from '../src/events/parser';
import {HarnessEventFeed} from '../src/harness/event-feed';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const encoder = new TextEncoder();
function fixture() {
    const opened: Array<{body:{subscriptions:Array<{id:string;plugin:string;args:Record<string,unknown>}>};controller:ReadableStreamDefaultController<Uint8Array>}> = [];
    const fetcher = vi.fn(async (_input,init) => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({start: value => {controller=value;}});
        opened.push({body:JSON.parse(init.body),controller});
        return new Response(body,{headers:{'content-type':'text/event-stream'}});
    });
    const hub = new NodeEventHub(new URL('https://node.example/v1/events'),fetcher);
    const send = (index: number,id: string,data: unknown) => opened[index].controller.enqueue(encoder.encode(`event: update\ndata: ${JSON.stringify({id,data})}\n\n`));
    return {hub,fetcher,opened,send};
}
it('shares profile subscriptions and multiplexes subjects while preserving reconnect cursors', async () => {
    vi.useFakeTimers(); const {hub,fetcher,opened,send} = fixture(), a={next:vi.fn(),error:vi.fn()}, b={next:vi.fn(),error:vi.fn()};
    const stopA = hub.subscribe('harness',{profileId:'p',projectId:'project'},a);
    const stopB = hub.subscribe('harness',{projectId:'project',profileId:'p'},b);
    await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledOnce(); expect(opened[0].body.subscriptions).toHaveLength(1);
    const id = opened[0].body.subscriptions[0].id;
    send(0,id,{epoch:'e',cursor:7,events:[]}); await vi.advanceTimersByTimeAsync(0);
    expect(a.next).toHaveBeenCalledOnce(); expect(b.next).toHaveBeenCalledOnce();
    stopA(); await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledOnce();
    const stopProcess = hub.subscribe('process',{epoch:'node',processId:'command'},{next:vi.fn(),error:vi.fn()});
    await vi.advanceTimersByTimeAsync(0); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(opened[1].body.subscriptions).toHaveLength(2);
    expect(opened[1].body.subscriptions.find(row => row.plugin==='harness')?.args).toMatchObject({after:7,eventEpoch:'e'});
    stopB(); stopProcess(); hub.close(); expect(a.error).not.toHaveBeenCalled();
});
it('resumes a disconnected stream without any polling request or command replay', async () => {
    vi.useFakeTimers(); vi.spyOn(console,'warn').mockImplementation(() => {});
    const {hub,fetcher,opened,send} = fixture(), listener={next:vi.fn(),error:vi.fn()};
    hub.subscribe('harness',{profileId:'p'},listener); await vi.advanceTimersByTimeAsync(0);
    send(0,opened[0].body.subscriptions[0].id,{epoch:'e',cursor:9}); await vi.advanceTimersByTimeAsync(0);
    opened[0].controller.close(); await vi.advanceTimersByTimeAsync(0); expect(listener.error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(500); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(opened[1].body.subscriptions[0].args).toMatchObject({after:9,eventEpoch:'e'});
    expect(fetcher.mock.calls.every(([,init]) => init.method==='POST')).toBe(true); hub.close();
});
it('isolates a revoked project from another live subscription', async () => {
    vi.useFakeTimers(); const {hub,opened,send} = fixture(), denied={next:vi.fn(),error:vi.fn()}, allowed={next:vi.fn(),error:vi.fn()};
    hub.subscribe('harness',{profileId:'p',projectId:'a'},denied); hub.subscribe('harness',{profileId:'p',projectId:'b'},allowed);
    await vi.advanceTimersByTimeAsync(0);
    const [a,b] = opened[0].body.subscriptions;
    opened[0].controller.enqueue(encoder.encode(`data: ${JSON.stringify({id:a.id,error:{code:'PROJECT_REVISION_CHANGED',status:409}})}\n\n`));
    await vi.advanceTimersByTimeAsync(0);
    expect(denied.error).toHaveBeenCalledOnce(); expect(allowed.error).not.toHaveBeenCalled();
    expect(opened).toHaveLength(1);
    send(0,b.id,{epoch:'e',cursor:1}); await vi.advanceTimersByTimeAsync(0); expect(allowed.next).toHaveBeenCalledOnce(); hub.close();
});
it('backs off a failed source while keeping healthy subjects streaming', async () => {
    vi.useFakeTimers(); const {hub,opened,send} = fixture(), a={next:vi.fn(),error:vi.fn()}, b={next:vi.fn(),error:vi.fn()};
    hub.subscribe('projects',{projectId:'a'},a); hub.subscribe('harness',{profileId:'b'},b); await vi.advanceTimersByTimeAsync(0);
    const [first,second] = opened[0].body.subscriptions;
    const fail = (index:number) => opened[index].controller.enqueue(encoder.encode(`data: ${JSON.stringify({id:first.id,error:{code:'PROJECT_WATCH_LIMIT',status:429}})}\n\n`));
    fail(0); await vi.advanceTimersByTimeAsync(0);
    send(0,second.id,{epoch:'e',cursor:1}); await vi.advanceTimersByTimeAsync(499);
    expect(b.next).toHaveBeenCalledOnce(); expect(b.error).not.toHaveBeenCalled(); expect(opened).toHaveLength(1);
    // A reconnect queued inside a retry timer runs on the next fake-clock tick.
    await vi.advanceTimersByTimeAsync(2); expect(opened).toHaveLength(2);
    fail(1); await vi.advanceTimersByTimeAsync(999); expect(opened).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2); expect(opened).toHaveLength(3); hub.close();
});
it('parses split UTF-8 CRLF frames and ignores heartbeat comments', async () => {
    const bytes=encoder.encode(': heartbeat\r\n\r\ndata: {"text":\r\ndata: "你好"}\r\n\r\n'), seen: unknown[]=[];
    const stream = new ReadableStream<Uint8Array>({start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); }});
    await readEventStream(stream,new AbortController(),value => seen.push(value)); expect(seen).toEqual([{text:'你好'}]);
});
it('bounds frames and rejects unsupported nodes without a polling fallback', async () => {
    const body = new ReadableStream<Uint8Array>({start(controller) { controller.enqueue(encoder.encode('data: '+'x'.repeat(8*1024*1024)+'\n\n')); }});
    await expect(readEventStream(body,new AbortController(),() => {})).rejects.toMatchObject({code:'EFBIG'});
    expect(() => requireEventCapability(undefined)).toThrow('upgraded cells');
    requireEventCapability({version:1,transport:'sse',endpoint:'/v1/events'});
});
it('keeps independent local cursors and does not confuse filtered sequence numbers with a gap', async () => {
    let receive!: (value:unknown) => void;
    const stop=vi.fn(), rpc={call:vi.fn(),close:vi.fn(),subscribe:vi.fn((_plugin,_args,listener) => {receive=listener.next;return stop;})};
    const feed=new HarnessEventFeed(rpc,{profileId:'p'});
    receive({epoch:'e',after:0,cursor:10,gap:false,events:[{seq:10,message:{method:'turn/started'}}],requests:[]});
    expect((await feed.snapshot({eventEpoch:'e',after:0})).gap).toBe(false);
    expect((await feed.snapshot({eventEpoch:'e',after:10})).events).toEqual([]);
    receive({epoch:'e',after:20,cursor:30,gap:true,events:[{seq:30,message:{method:'turn/completed'}}],requests:[]});
    expect((await feed.snapshot({eventEpoch:'e',after:10})).gap).toBe(true);
    expect((await feed.snapshot({eventEpoch:'e',after:30})).gap).toBe(false);
    feed.close(); expect(stop).toHaveBeenCalledOnce();
});

it('isolates throwing observers during live delivery, cached replay and error notification', async () => {
    vi.useFakeTimers(); const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { hub, opened, send } = fixture(), good = { next: vi.fn(), error: vi.fn() };
    const bad = { next: vi.fn(() => { throw new Error('private observer details'); }), error: vi.fn(() => { throw new Error('private error details'); }) };
    hub.subscribe('harness', { profileId: 'p' }, bad);
    hub.subscribe('harness', { profileId: 'p' }, good);
    const other = { next: vi.fn(), error: vi.fn() };
    hub.subscribe('projects', { projectId: 'other' }, other);
    try {
        await vi.advanceTimersByTimeAsync(0); const [harness, project] = opened[0].body.subscriptions;
        send(0, harness.id, { epoch: 'e', cursor: 1 }); send(0, project.id, { version: '1' });
        await vi.advanceTimersByTimeAsync(0);
        expect(good.next).toHaveBeenCalledOnce(); expect(other.next).toHaveBeenCalledOnce();
        expect(good.error).not.toHaveBeenCalled(); expect(other.error).not.toHaveBeenCalled();
        hub.subscribe('harness', { profileId: 'p' }, bad); await vi.advanceTimersByTimeAsync(0);
        send(0, harness.id, { epoch: 'e', cursor: 2 }); await vi.advanceTimersByTimeAsync(0);
        expect(good.next).toHaveBeenCalledTimes(2); expect(opened).toHaveLength(1);
        opened[0].controller.close(); await vi.advanceTimersByTimeAsync(0);
        expect(good.error).toHaveBeenCalledOnce(); expect(other.error).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(500); expect(opened).toHaveLength(2);
        expect(opened[1].body.subscriptions[0].args).toMatchObject({ after: 2, eventEpoch: 'e' });
        expect(JSON.stringify(warning.mock.calls)).not.toContain('private');
    } finally { hub.close(); }
});

it('keeps healthy feed observers current after another observer throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let receive!: (value: unknown) => void;
    const feed = new HarnessEventFeed({ call: vi.fn(), close: vi.fn(), subscribe: (_plugin, _args, listener) => {
        receive = listener.next; return () => {};
    } }, { profileId: 'p' });
    const healthy = vi.fn(); feed.subscribe(() => { throw new Error('private listener'); }); feed.subscribe(healthy);
    try {
        receive({ epoch: 'e', cursor: 1, gap: false, events: [], requests: [] });
        expect(healthy).toHaveBeenCalledOnce(); expect((await feed.snapshot()).cursor).toBe(1);
    } finally { feed.close(); }
});
