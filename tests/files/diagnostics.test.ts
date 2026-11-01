import { expect, it, vi } from 'vitest';
import { HttpTransport } from '../../src/files/transport';

it('logs request context and preserves the network cause without logging credentials', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = new TypeError('Failed to fetch');
    try {
        const transport = new HttpTransport({ endpoint: 'http://localhost:8080/', credential: () => 'secret-password',
            fetch: vi.fn(async () => { throw cause; }) });
        await expect(transport.json('v1/exports/project/list?path=src')).rejects.toMatchObject({ cause });
        expect(log).toHaveBeenCalledWith('[cells] Request failed', expect.objectContaining({
            method: 'GET', route: '/v1/exports/project/list', path: 'src', sent: true,
        }), cause);
        expect(JSON.stringify(log.mock.calls)).not.toContain('secret-password');
    } finally { log.mockRestore(); }
});

it('distinguishes a closed source from an aborted caller', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        const transport = new HttpTransport({ endpoint: 'http://localhost:8080/', credential: () => '' });
        const caller = new AbortController(); caller.abort();
        await expect(transport.json('v1/capabilities', {}, { signal: caller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
        expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ cancellation: 'caller-aborted', sent: false });
        transport.close();
        await expect(transport.json('v1/capabilities')).rejects.toMatchObject({ code: 'ECANCELLED' });
        expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ cancellation: 'source-closed', sent: false });
        expect(failures).not.toHaveBeenCalled();
    } finally { log.mockRestore(); failures.mockRestore(); }
});
