import { FSError } from '@itookit/vfs-core';
import { requestId } from './files/request-id';
import { readEventStream } from './events/parser';

export interface RemoteEventListener { next(value: unknown): void; error(error: unknown): void }
interface Channel {
    id: string; plugin: string; args: Record<string, unknown>; listeners: Set<RemoteEventListener>; latest?: unknown;
    failure?: unknown;
    terminal?: boolean;
    retry?: ReturnType<typeof setTimeout>;
    failures?: number;
}

/** One authenticated stream per node/identity, with ref-counted domain subscriptions. */
export class NodeEventHub {
    private readonly channels = new Map<string, Channel>();
    private controller?: AbortController;
    private timer?: ReturnType<typeof setTimeout>;
    private revision = 0;
    private failures = 0;
    private closed = false;
    constructor(private readonly endpoint: URL, private readonly fetcher: typeof globalThis.fetch) {
        if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
            throw new FSError('EINVAL','Invalid node event endpoint');
    }

    subscribe(plugin: string, args: Record<string, unknown>, listener: RemoteEventListener): () => void {
        if (this.closed) throw new FSError('ECANCELLED', 'Node event connection is closed');
        const {after: _after, eventEpoch: _epoch, ...scope} = args;
        const key = JSON.stringify([plugin, Object.entries(scope).sort(([a],[b]) => a.localeCompare(b))]);
        let channel = this.channels.get(key);
        if (!channel) {
            if (this.channels.size >= 32) throw new FSError('EFBIG', 'Node subscription limit reached');
            channel = {id: requestId(), plugin, args: {...args}, listeners: new Set()};
            this.channels.set(key, channel); this.restart();
        }
        channel.listeners.add(listener);
        if (channel.failure) queueMicrotask(() => { if (channel!.listeners.has(listener)) this.notifyError(channel!, listener, channel!.failure); });
        else if (channel.latest !== undefined) queueMicrotask(() => { if (channel!.listeners.has(listener)) this.deliver(channel!, listener, channel!.latest); });
        let stopped = false;
        return () => {
            if (stopped) return; stopped = true; channel!.listeners.delete(listener);
            if (!channel!.listeners.size) { clearTimeout(channel!.retry); this.channels.delete(key); this.restart(); }
        };
    }
    private restart(delay = 0): void {
        ++this.revision; this.controller?.abort(); clearTimeout(this.timer); this.timer = undefined;
        if (this.closed || ![...this.channels.values()].some(channel => !channel.terminal)) return;
        const revision = this.revision;
        this.timer = setTimeout(() => { this.timer = undefined; void this.connect(revision); }, delay);
    }
    private async connect(revision: number): Promise<void> {
        if (revision !== this.revision || this.closed) return;
        const controller = this.controller = new AbortController(), started = Date.now(), operationId = requestId();
        const opening = setTimeout(() => controller.abort(), 30_000);
        try {
            const response = await this.fetcher(this.endpoint, {method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
                signal: controller.signal, headers: {'content-type': 'application/json','x-operation-id':operationId},
                body: JSON.stringify({version: 1, subscriptions: [...this.channels.values()].filter(row => !row.terminal).map(row => ({id:row.id,plugin:row.plugin,args:row.args}))})});
            clearTimeout(opening);
            if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
                await response.body?.cancel();
                throw Object.assign(new FSError(response.status === 404 ? 'ECAPABILITY' : 'EIO', `Node event subscription rejected (${response.status})`, 'connect'), {status:response.status});
            }
            await readEventStream(response.body, controller, value => {
                if (revision !== this.revision) return;
                this.accept(value); if (Date.now()-started >= 15_000) this.failures = 0;
            });
            throw Object.assign(new FSError('EIO', 'Node event stream disconnected', 'connect'),{code:'CONNECTION_CLOSED'});
        } catch (error) {
            if (revision !== this.revision || this.closed) return;
            if (![...this.channels.values()].some(channel => !channel.terminal)) return;
            const failure = error as {code?: string; status?: number};
            console.warn('[cells] events.failed', {operationId,stage:'stream',code:failure.code ?? 'EVENT_NETWORK',
                status:failure.status,elapsedMs:Date.now()-started,subscriptions:this.channels.size});
            for (const row of this.channels.values()) if (!row.terminal) {
                row.failure = error; for (const listener of [...row.listeners]) this.notifyError(row, listener, error);
            }
            if (failure.status && [400,401,403,404,409,413,422].includes(failure.status) || failure.code === 'EFBIG') return;
            this.restart(Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6)));
        } finally { clearTimeout(opening); }
    }
    private accept(value: unknown): void {
        const frame = value as {id?: string; data?: unknown; error?: {code?: string;status?: number}};
        if (!frame || typeof frame.id !== 'string' || !('data' in frame) && !frame.error) throw new FSError('EIO','Invalid node event envelope','protocol');
        const channel = [...this.channels.values()].find(row => row.id === frame.id);
        if (!channel) return;
        if (frame.error) {
            const code = typeof frame.error.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(frame.error.code) ? frame.error.code : 'EVENT_SOURCE_FAILED';
            const error = Object.assign(new FSError('EIO',`Node event source failed: ${code}`,'protocol'),{remoteCode:code,status:frame.error.status});
            channel.failure = error; channel.terminal = true;
            for (const listener of [...channel.listeners]) this.notifyError(channel, listener, error);
            if (!error.status || ![400,401,403,404,409,413,422].includes(error.status)) this.retry(channel);
            return;
        }
        channel.latest = frame.data;
        channel.failure = undefined;
        channel.failures = 0;
        const page = frame.data as {epoch?: unknown;cursor?: unknown};
        if (typeof page?.epoch === 'string' && Number.isSafeInteger(page.cursor)) {
            channel.args.eventEpoch = page.epoch; channel.args.after = page.cursor;
        }
        for (const listener of [...channel.listeners]) this.deliver(channel, listener, frame.data);
    }
    private deliver(channel: Channel, listener: RemoteEventListener, value: unknown): void {
        const started = Date.now();
        try { listener.next(value); }
        catch (error) { this.observerFailed(channel, 'next', started); this.notifyError(channel, listener, error); }
    }
    private notifyError(channel: Channel, listener: RemoteEventListener, error: unknown): void {
        const started = Date.now();
        try { listener.error(error); }
        catch { this.observerFailed(channel, 'error', started); }
    }
    private observerFailed(channel: Channel, stage: string, started: number): void {
        console.warn('[cells] events.observer.failed', {operation: 'node.events.observe', operationId: channel.id, plugin: channel.plugin,
            stage, outcome: 'failure', code: 'EVENT_OBSERVER_FAILED', durationMs: Date.now() - started});
    }
    private retry(channel: Channel): void {
        clearTimeout(channel.retry);
        const failures = channel.failures ?? 0; channel.failures = failures+1;
        channel.retry = setTimeout(() => {
            channel.retry = undefined; channel.terminal = false; this.restart();
        },Math.min(30_000,500*2**Math.min(failures,6)));
    }
    reconnect(): void { for (const channel of this.channels.values()) { clearTimeout(channel.retry); channel.terminal = false; channel.failure = undefined; } this.restart(); }
    close(): void { this.closed = true; ++this.revision; clearTimeout(this.timer); this.controller?.abort(); for (const channel of this.channels.values()) clearTimeout(channel.retry); this.channels.clear(); }
}

export function requireEventCapability(value: unknown): void {
    const capability = value as {version?: number;transport?: string;endpoint?: string};
    if (capability?.version !== 1 || capability.transport !== 'sse' || capability.endpoint !== '/v1/events')
        throw new FSError('ECAPABILITY','Node event subscriptions require an upgraded cells','protocol');
}
