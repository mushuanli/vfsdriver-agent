import { expect, it, vi } from 'vitest';
import { createFile } from '@itookit/vfs-core';
import { createCellsDriver } from '../src/provider';

it('opens unscoped exports through the injected transport and shares updated credentials', async () => {
    const auth: Array<string | null> = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const url = new URL(String(input));
        auth.push(new Headers(init?.headers).get('Authorization'));
        if (url.pathname === '/v1/exports') return Response.json({version: 1, exports: [{alias: 'docs'}]});
        if (url.pathname.endsWith('/stat')) {
            const {paths} = JSON.parse(String(init?.body)) as {paths: string[]};
            return Response.json({results: paths.map(path => ({stat: path ? {kind: 'file', size: 4} : {kind: 'directory'}}))});
        }
        if (url.pathname.endsWith('/content')) return new Response('note');
        if (url.pathname === '/v1/sync/capabilities') return Response.json({historyEpoch: 'epoch'});
        throw new Error(`Unexpected request: ${url.pathname}`);
    });
    const driver = createCellsDriver(undefined, fetch);
    const connection = {endpoint: 'https://pi.test', alias: 'docs', credentialRef: 'key'};
    driver.setCredential('key', 'first');
    const owner = await driver.open(connection), sync = driver.transport(connection);
    try {
        expect(await createFile(owner.fs, '/note.txt').read({encoding: 'utf-8'})).toBe('note');
        driver.setCredential('key', 'second');
        expect(await driver.browse(connection, '/')).toEqual({paths: ['/docs'], nextCursor: null});
        await sync.json('v1/sync/capabilities');
        expect(auth.slice(0, -2).every(value => value === 'Bearer first')).toBe(true);
        expect(auth.slice(-2)).toEqual(['Bearer second', 'Bearer second']);
    } finally { sync.close(); await owner.dispose(); await driver.dispose(); }
});
