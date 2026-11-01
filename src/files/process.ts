import { FSError, checkOperation, operationScope, pathUtils, type OperationOptions } from '@itookit/vfs-core';
import type { HttpTransport } from './transport';
import { ProcessClient } from './process/client';
import { requestId } from './request-id';
import type { RemoteProcessSpec, ProcessStatus, ExecOptions } from './process/contracts';
export type { RemoteProcessSpec, ExecOptions } from './process/contracts';

/** One process owner; lost startup responses are cancelled by ID, never replayed. */
export class HttpProcessSession {
    private closed = false;
    private readonly outstanding = new Set<string>();
    private readonly active = new Map<string, Promise<unknown>>();
    private readonly client: ProcessClient;
    private readonly spec: RemoteProcessSpec;
    readonly nativeShell = { capabilities: { ripgrep: false, fd: false },
        exec: (command: string, args: string[], options?: ExecOptions) => this.exec(command, args, options) };

    constructor(transport: HttpTransport, spec: RemoteProcessSpec) {
        this.spec = structuredClone(spec);
        this.client = new ProcessClient(transport, this.spec);
    }

    private exec(command: string, args: string[], options?: ExecOptions) {
        if (this.closed) return Promise.reject(new FSError('EACCES', 'Remote process context is closed'));
        const id = requestId();
        const pending = this.run(id, command, args, options);
        this.active.set(id, pending);
        void pending.finally(() => this.active.delete(id)).catch(() => {});
        return pending;
    }

    private async run(id: string, command: string, args: string[], options: ExecOptions = {}) {
        const scope = operationScope({ ...options, timeoutMs: options.timeoutMs ?? 120_000 });
        let registered = false;
        try {
            checkOperation(scope.options);
            const timeoutMs = Math.min(300_000, scope.remaining()!);
            const cwd = options.cwd ? pathUtils.normalize(options.cwd.startsWith('/') ? options.cwd : `${this.spec.cwd}/${options.cwd}`) : this.spec.cwd;
            this.outstanding.add(id); registered = true;
            const started = await this.client.start(id, command, args, cwd, timeoutMs, scope.options);
            const status = await this.wait(id, started, scope.options);
            if (isTerminal(status)) this.outstanding.delete(id);
            if (status.state !== 'exited' || status.code !== 0 || status.truncated) {
                console.error('[cells] Process failed', { serverId: this.spec.serverId, epoch: this.spec.epoch,
                    processId: id, cwd, state: status.state, exitCode: status.code, truncated: status.truncated,
                    error: status.error, stderr: status.stderr.slice(0, 4096) });
            }
            return processResult(id, status, options.onOutput);
        } catch (error) {
            return await this.failed(id, error, scope.options, registered);
        } finally { scope.dispose(); }
    }

    private async wait(id: string, initial: ProcessStatus, options: OperationOptions): Promise<ProcessStatus> {
        if (initial.state !== 'running') return initial;
        checkOperation(options);
        return new Promise((resolve,reject) => {
            let stop = () => {};
            const cleanup = () => { stop(); options.signal?.removeEventListener('abort',abort); };
            const abort = () => { cleanup(); reject(new FSError('ECANCELLED','Remote process observation cancelled')); };
            stop = this.client.subscribe(id, status => {
                if (status.state !== 'running') { cleanup(); resolve(status); }
            }, error => {
                const status = (error as {status?: number})?.status;
                if (status && status >= 400 && status < 500) { cleanup(); reject(error); }
            });
            options.signal?.addEventListener('abort',abort,{once:true});
            if (options.signal?.aborted) abort();
        });
    }

    private async failed(id: string, error: unknown, options: OperationOptions, registered: boolean): Promise<never> {
        if (this.outstanding.has(id)) await this.client.cancel(id).then(status => {
            if (isTerminal(status)) this.outstanding.delete(id);
        }).catch(() => {});
        if (this.outstanding.has(id)) throw Object.assign(new FSError('EIO', `Remote process outcome unknown: ${id}`),
            { processId: id, outcome: 'unknown', cause: error });
        // Preserve timeout/cancel classification after cleanup confirms the process has stopped.
        if (registered && options.signal?.aborted) {
            try { checkOperation(options); } catch (cancelled) {
                throw Object.assign(cancelled as Error, { processId: id, outcome: 'partial', cause: error });
            }
        }
        throw error;
    }

    async release(): Promise<void> {
        this.closed = true;
        for (const id of [...this.outstanding]) await this.drain(id);
        await Promise.allSettled(this.active.values());
        this.client.close();
    }

    private async drain(id: string): Promise<void> {
        const scope = operationScope({ timeoutMs: 10_000 });
        try {
            let status = await this.client.cancel(id);
            status = await this.wait(id,status,scope.options);
            if (!isTerminal(status)) throw new FSError('EBUSY', 'Remote process cleanup is not confirmed');
            this.outstanding.delete(id);
        } finally { scope.dispose(); }
    }
}

function isTerminal(status: ProcessStatus): boolean { return status.state !== 'running' && status.state !== 'unknown'; }

function processResult(id: string, status: ProcessStatus, onOutput?: ExecOptions['onOutput']) {
    onOutput?.({ stream: 'stdout', text: status.stdout });
    onOutput?.({ stream: 'stderr', text: status.stderr });
    if (status.state !== 'exited' || status.truncated) {
        const code = status.state === 'cancelled' ? 'ECANCELLED' : status.state === 'timed-out' ? 'ETIMEDOUT' : 'EIO';
        throw new FSError(code, `Remote process ${status.state}${status.truncated ? ' (output limit)' : ''}: ${id}${status.error ? `: ${status.error}` : ''}`);
    }
    return { stdout: status.stdout, stderr: status.stderr, code: status.code };
}
