import { afterEach, expect, it, vi } from 'vitest';
import { requestId } from '../../src/files/request-id';
import { HttpTransport } from '../../src/files/transport';
import { HttpProcessSession } from '../../src/files/process';
const secureBytes = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
afterEach(() => vi.unstubAllGlobals());

it('uses secure UUIDs on HTTP origins where randomUUID is missing or throws', () => {
    for (const randomUUID of [undefined, () => { throw new Error('insecure origin'); }]) {
        vi.stubGlobal('crypto', { randomUUID, getRandomValues: secureBytes });
        const ids = Array.from({ length: 100 }, requestId);
        expect(new Set(ids).size).toBe(100);
        expect(ids.every(id => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))).toBe(true);
    }
});

it('does not silently use weak randomness when WebCrypto is absent', () => {
    vi.stubGlobal('crypto', undefined);
    expect(requestId).toThrow('Secure random generation');
});

it('starts remote processes without randomUUID and logs server-side failure details', async () => {
    vi.stubGlobal('crypto', { getRandomValues: secureBytes });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn(async () => Response.json({ state: 'failed', stdout: '', stderr: 'sandbox start failed', code: null,
        error: 'spawn denied', truncated: false }));
    const session = new HttpProcessSession(new HttpTransport({ endpoint: 'http://localhost', credential: () => 'secret', fetch }),
        { serverId: 'node', epoch: 'epoch', cwd: '/workspace', mounts: [] });
    try {
        await expect(session.nativeShell.exec('bash', ['-c', 'ls'])).rejects.toThrow('spawn denied');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('[cells] Process failed', expect.objectContaining({
            cwd: '/workspace', error: 'spawn denied', stderr: 'sandbox start failed', state: 'failed',
        }));
        expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    } finally { await session.release(); log.mockRestore(); }
});
