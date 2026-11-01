import type { OperationOptions } from '@itookit/vfs-core';

/** Log request identity and failure evidence, never request headers or content. */
export function reportHttpFailure(endpoint: URL, route: string, method: string, error: unknown,
    options: OperationOptions, sourceClosed: boolean, callerAborted: boolean, sent: boolean): void {
    const url = new URL(route, endpoint);
    const cancelled = sourceClosed || callerAborted;
    const log = cancelled ? console.debug : console.error;
    log(cancelled ? '[cells] Request cancelled' : '[cells] Request failed', {
        method, endpoint: endpoint.origin + endpoint.pathname, route: url.pathname,
        path: url.searchParams.get('path') ?? undefined,
        sent, cancellation: sourceClosed ? 'source-closed' : callerAborted ? 'caller-aborted'
            : options.signal?.aborted ? 'deadline-or-scope' : undefined,
    }, error);
}
