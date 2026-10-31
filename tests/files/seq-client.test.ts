import { expect, it, vi } from 'vitest';
import { HttpSeqClient } from '../../src/files/seq/client';

it('sends structured SQLite SeqFile transactions with explicit revisions', async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (String(_url).endsWith('/snapshot')) return Response.json({ revision: 'old', entries: [{ key: 'identity', value: { id: 'project' } }] });
        const input = JSON.parse(String(init?.body));
        expect(input.expectedRevision).toBe('old');
        return Response.json({ outcome: 'committed', result: { revision: 'new' } });
    });
    const client = new HttpSeqClient({ endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret', fetch });
    try {
        const snapshot = await client.snapshot('/.nestos/info.seq');
        expect(snapshot.entries[0].value).toEqual({ id: 'project' });
        expect(await client.transaction('/.nestos/info.seq', snapshot.revision, [{ action: 'set', key: 'title', value: 'Name' }]))
            .toEqual({ revision: 'new' });
        expect(new Headers(fetch.mock.calls[1][1]?.headers).get('x-operation-id')).toBeTruthy();
        await expect(client.snapshot('../escape.seq')).rejects.toMatchObject({ code: 'EINVAL' });
    } finally { client.dispose(); }
});


it('does not replay a SeqFile transaction whose server result is unknown', async () => {
    const routes: string[] = [];
    const fetch = vi.fn(async (url: unknown) => {
        routes.push(String(url));
        return Response.json({ outcome: 'unknown' }, { status: 504 });
    });
    const client = new HttpSeqClient({ endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret', fetch });
    try {
        await expect(client.transaction('info.seq', null, [])).rejects.toMatchObject({ outcome: 'unknown' });
        expect(routes.filter(route => route.endsWith('/seq/transaction'))).toHaveLength(1);
    } finally { client.dispose(); }
});

it('rejects malformed SeqFile snapshots and committed revision results', async () => {
    const client = new HttpSeqClient({ endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret',
        fetch: async url => Response.json(String(url).endsWith('/snapshot') ? null : { outcome: 'committed', result: {} }) });
    try {
        await expect(client.snapshot('info.seq')).rejects.toMatchObject({ code: 'EIO' });
        await expect(client.transaction('info.seq', null, [])).rejects.toMatchObject({ code: 'EIO' });
    } finally { client.dispose(); }
});

it('queries only explicit keys and binds prefix pages to a revision', async () => {
    const bodies: unknown[] = [];
    const client = new HttpSeqClient({endpoint: 'http://localhost/', alias: 'docs', credential: () => 'secret',
        fetch: async (_url, init) => {
            const body = JSON.parse(String(init?.body)); bodies.push(body);
            return Response.json({revision: 'r1', next: body.selection.keys ? null : 'event/01', entries: [{key: body.selection.keys?.[0] ?? 'event/01', value: 'safe'}]});
        }});
    try {
        expect((await client.query('info.seq', {keys: ['board/one']})).entries).toEqual([{key:'board/one',value:'safe'}]);
        await client.query('info.seq', {prefix:'event/',limit:1,expectedRevision:'r1'});
        expect(bodies).toEqual([{path:'info.seq',selection:{keys:['board/one']}},{path:'info.seq',selection:{prefix:'event/',limit:1,expectedRevision:'r1'}}]);
        await expect(client.query('info.seq', {limit:1001})).rejects.toMatchObject({code:'EINVAL'});
    } finally {client.dispose();}
});

it('rejects unrelated keys, duplicate rows, invalid cursors and changed page revisions', async () => {
    const replies = [
        {revision:'r1',next:null,entries:[{key:'private',value:'secret'}]},
        {revision:'r1',next:null,entries:[{key:'board/one',value:1},{key:'board/one',value:2}]},
        {revision:'r1',next:'elsewhere',entries:[{key:'board/one',value:1}]},
        {revision:'r2',next:null,entries:[]},
    ];
    const client = new HttpSeqClient({endpoint:'http://localhost/',alias:'docs',credential:()=> 'secret',fetch:async()=>Response.json(replies.shift())});
    try {for (let i=0;i<4;i++) await expect(client.query('info.seq',{keys:['board/one'],expectedRevision:'r1'})).rejects.toMatchObject({code:'EIO'});}
    finally {client.dispose();}
});
