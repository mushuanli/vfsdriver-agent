import { boundedBody } from './transport/body';
import { requestId } from './request-id';
import { reportHttpFailure } from './transport/diagnostics';
import { responseError } from './transport/errors';
import { cancellationReason, stagedCancellation, pause } from './transport/cancellation';
import { mutationResult, HttpMutationError } from './transport/mutation';
export { HttpMutationError } from './transport/mutation';
import { retryDelay } from './transport/retry';
export { HttpResponseError } from './transport/errors';

import { checkOperation, FSError, FSOperationCancelledError, operationScope, type OperationOptions } from '@itookit/vfs-core';
import { NodeEventHub, type RemoteEventListener } from '../events';

export interface HttpConnectionOptions {
    events?: NodeEventHub;
    endpoint: string;
    credential: () => string | Promise<string>;
    anonymous?: boolean;
    authorization?: import('../authorization').RemoteAuthorization;
    username?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    maxReadBytes?: number;
}

export class HttpTransport {
    private readonly events: NodeEventHub;
    private readonly eventStops = new Set<() => void>();
    private readonly endpoint: URL;
    private readonly lifetime = new AbortController();
    constructor(private readonly config: HttpConnectionOptions) {
        if (config.maxReadBytes !== undefined && (!Number.isSafeInteger(config.maxReadBytes) || config.maxReadBytes < 0)) throw new FSError('EINVAL', 'Invalid read limit');
        this.endpoint = new URL(config.endpoint.endsWith('/') ? config.endpoint : config.endpoint + '/');
        if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password
            || this.endpoint.search || this.endpoint.hash) throw new FSError('EINVAL', 'Invalid file server endpoint');
        this.events = config.events ?? new NodeEventHub(new URL('v1/events', this.endpoint), async (input,init) =>
            (config.fetch ?? globalThis.fetch)(input,{...init, headers:await this.headers(init?.headers)}));
    }
    get defaultTimeoutMs(): number { return this.config.timeoutMs ?? 30_000; }
    close() { this.lifetime.abort(new FSOperationCancelledError()); for (const stop of this.eventStops) stop(); this.eventStops.clear(); if (!this.config.events) this.events.close(); }
    subscribe(plugin: string, args: Record<string, unknown>, listener: RemoteEventListener): () => void {
        if (this.lifetime.signal.aborted) throw new FSOperationCancelledError();
        const stop = this.events.subscribe(plugin,args,listener);
        const release = () => { stop(); this.eventStops.delete(release); };
        this.eventStops.add(release); return release;
    }
    async json<T>(route: string, init: RequestInit = {}, options?: OperationOptions, maxBytes = 4 * 1024 * 1024): Promise<T> {
        return this.request(route, init, options, async response => {
            const data = await boundedBody(response, maxBytes);
            try { return JSON.parse(new TextDecoder().decode(data)) as T; }
            catch { throw new FSError('EIO', 'Invalid file server JSON', 'protocol'); }
        });
    }
    async jsonReply(route: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; value: unknown }> {
        return this.request(route, init, undefined, async response => {
            const bytes = await boundedBody(response, 4 * 1024 * 1024);
            try { return { ok: response.ok, status: response.status, value: JSON.parse(new TextDecoder().decode(bytes)) }; }
            catch { throw new FSError('EIO', 'Invalid server JSON', 'protocol'); }
        }, false);
    }
    async content(route: string, init: RequestInit, options?: OperationOptions) {
        return this.request(route, init, options, async response => ({
            data: await boundedBody(response, this.config.maxReadBytes ?? 32 * 1024 * 1024),
            revision: response.headers.get('etag') ?? undefined,
            status: response.status, range: response.headers.get('content-range'),
        }));
    }
    private async request<T>(route: string, init: RequestInit, options: OperationOptions | undefined,
        consume: (response: Response) => Promise<T>, requireOk = true): Promise<T> {
        const scope = operationScope({ ...options, timeoutMs: options?.timeoutMs ?? this.config.timeoutMs ?? 30_000 }, this.lifetime.signal);
        let sent = false;
        try {
            checkOperation(scope.options);
            const headers = await this.headers(init.headers); checkOperation(scope.options);
            if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
            sent = true;
            const response = await this.send(route, { ...init, headers }, scope.options, scope.remaining);
            if (requireOk && !response.ok) throw await responseError(response);
            return await consume(response);
        } catch (error) {
            reportHttpFailure(this.endpoint, route, init.method ?? 'GET', error, scope.options,
                this.lifetime.signal.aborted, options?.signal?.aborted === true, sent);
            const cancelled = error instanceof FSOperationCancelledError ? error : cancellationReason(scope.options);
            if (cancelled) throw stagedCancellation(cancelled, sent);
            if (error instanceof FSError) throw error;
            throw new FSError('EIO', 'File server request failed', 'connect', undefined, error instanceof Error ? error : undefined);
        } finally { scope.dispose(); }
    }
    async mutate<T>(route: string, init: RequestInit, statusRoute: string, options?: OperationOptions): Promise<T> {
        const operationId = requestId();
        const scope = operationScope({ ...options, timeoutMs: options?.timeoutMs ?? this.config.timeoutMs ?? 30_000 }, this.lifetime.signal);
        let sent = false;
        try {
            checkOperation(scope.options);
            const headers = await this.headers(init.headers); checkOperation(scope.options);
            headers.set('X-Operation-Id', operationId);
            headers.set('X-Timeout-Ms', String(Math.max(1, Math.floor(scope.remaining() ?? 30_000))));
            sent = true;
            const response = await (this.config.fetch ?? globalThis.fetch)(new URL(route, this.endpoint), {
                ...init, headers, signal: scope.options.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
            });
            return await mutationResult<T>(response, operationId);
        } catch (error) {
            reportHttpFailure(this.endpoint, route, init.method ?? 'POST', error, scope.options,
                this.lifetime.signal.aborted, options?.signal?.aborted === true, sent);
            if (error instanceof HttpMutationError) {
                if (error.outcome === 'unknown') this.reconcile(statusRoute, operationId);
                throw error;
            }
            if (!sent) { checkOperation(scope.options); throw error; }
            // A lost response never authorizes replay; only an unknown result is worth reconciling.
            this.reconcile(statusRoute, operationId);
            throw new HttpMutationError(cancellationReason(scope.options)?.timedOut ? 'ETIMEDOUT' : scope.options.signal?.aborted ? 'ECANCELLED' : 'EIO', operationId, 'unknown');
        } finally { scope.dispose(); }
    }
    private reconcile(statusRoute: string, operationId: string): void {
        void this.json(`${statusRoute}/${operationId}/cancel`, { method: 'POST' }, { timeoutMs: 5000 }).catch(() => {});
    }
    private authorization(secret: string): string {
        if (this.config.username === undefined) return `Bearer ${secret}`;
        if (!this.config.username || /[:\r\n]/.test(this.config.username)) throw new FSError('EINVAL', 'Invalid username');
        const bytes = new TextEncoder().encode(`${this.config.username}:${secret}`);
        return `Basic ${btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))}`;
    }
    private async headers(input?: HeadersInit): Promise<Headers> {
        const headers = new Headers(input);
        if (this.config.authorization) {
            headers.set('x-cells-principal', this.config.authorization.principalId);
            headers.set('x-cells-grant-revision', this.config.authorization.revision);
        }
        if (this.config.anonymous) headers.delete('Authorization');
        else headers.set('Authorization', this.authorization(await this.config.credential()));
        return headers;
    }
    private async send(route: string, init: RequestInit, options: OperationOptions, remaining: () => number | undefined): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            checkOperation(options);
            const headers = new Headers(init.headers), budget = remaining();
            if (budget !== undefined) headers.set('X-Timeout-Ms', String(Math.max(1, Math.floor(budget))));
            const response = await (this.config.fetch ?? globalThis.fetch)(new URL(route, this.endpoint), {
                ...init, headers, signal: options.signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
            });
            const delay = retryDelay(init.method ?? 'GET', response, attempt);
            if (delay === undefined) return response;
            await response.body?.cancel();
            await pause(delay, options);
        }
    }
}
