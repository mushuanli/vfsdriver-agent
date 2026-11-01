import { expect, it, vi } from 'vitest';
import {validateCommands, validateCommandCatalog} from '../src/harness/commands';
import { MCPHarnessClient } from '../src/harness/client';
import { createCellsDriver } from '../src/provider';
import { validateEvents, validateHistory, validatePage, validateProfiles, validateSession } from '../src/harness/validation';

const session = { id: 's',title:'<script>x</script>',cwd:'/workspace',status:'idle',updatedAt:1,resumable:true };
it('rejects invalid turn input as not committed without discovering or mutating a remote session', async () => {
    const call = vi.fn(), client = new MCPHarnessClient({call, close: vi.fn()});
    await expect(client.turn('native', 's', '中'.repeat(50000), {requestId: 'too-large'})).rejects.toMatchObject({
        outcome: 'not-committed', requestId: 'too-large', attachmentCode: 'HARNESS_PROMPT_LIMIT'});
    await expect(client.turn('native', 's', 'Review', {requestId: 'bad-file', attachments: [
        {kind: 'image', name: 'a.png', mimeType: 'image/png', content: 'data:image/png;base64,AQID'},
    ]})).rejects.toMatchObject({outcome: 'not-committed', requestId: 'bad-file', attachmentCode: 'HARNESS_ATTACHMENT_MIME_MISMATCH'});
    expect(call).not.toHaveBeenCalled(); await client.close();
});
it('negotiates a receipt-free command query and rejects malformed results or legacy capabilities', async () => {
    const capabilities = {history: true, create: true, resume: true, interrupt: true, interactions: true, slashCommands: true, commandQueries: true};
    let result: unknown = {commandId: 'query', output: 'State', status: 'completed'};
    const call = vi.fn(async (name: string) => name === 'harness_profiles' ? {epoch: 'e', profiles: [{id: 'native', kind: 'native', workspaces: [], capabilities}]} : result);
    const client = new MCPHarnessClient({call, close: vi.fn()}); await client.profiles();
    expect(await client.queryCommand('native', 's', 'session:status', '', {requestId: 'query'})).toEqual(result);
    expect(call).toHaveBeenLastCalledWith('harness_query', {profileId: 'native', sessionId: 's', command: 'session:status', arguments: '', requestId: 'query'}, {requestId: 'query'});
    for (const invalid of [{commandId: 'wrong', status: 'completed'}, {commandId: 'query', status: 'running'}, {commandId: 'query', status: 'completed', turnId: 't'}]) {
        result = invalid; await expect(client.queryCommand('native', 's', 'session:status', '', {requestId: 'query'})).rejects.toThrow('Invalid read-only command result');
    }
    capabilities.commandQueries = false; await client.profiles(); const before = call.mock.calls.length;
    await expect(client.queryCommand('native', 's', 'session:status', '')).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call).toHaveBeenCalledTimes(before); await client.close();
});
it('preserves incomplete native command observations without turning them into an empty complete catalog', async () => {
    const value = {commands: [{name: 'session:status', description: 'State', kind: 'action', execution: 'query'}],
        observation: {complete: false, code: 'DSH_SESSION_NOT_ATTACHED'}};
    const client = new MCPHarnessClient({call: vi.fn(async () => value), close: vi.fn()});
    expect(await client.commandCatalog('dsh', 's')).toEqual(value);
    expect(await client.commands('dsh', 's')).toEqual(value.commands);
    expect(validateCommandCatalog({commands: []})).toEqual({commands: []});
    for (const observation of [{complete: false}, {complete: 'false'}, {complete: false, code: 'private failure text'}, []])
        expect(() => validateCommandCatalog({...value, observation})).toThrow('Invalid command catalog observation');
    await client.close();
});
it('negotiates exact checkpoint fork and preserves created identity when proof is absent', async () => {
    const profile = {id: 'codex', kind: 'codex', workspaces: [], capabilities: {history: true, create: true, resume: true, interrupt: true,
        interactions: true, fork: true, checkpointFork: true}};
    const call = vi.fn(async (name, args) => name === 'harness_profiles' ? {epoch: 'e', profiles: [profile]}
        : {outcome: 'committed', requestId: args.requestId, result: {session: {...session, id: 'created'}}});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    expect(await client.fork('codex', 's', undefined, {requestId: 'fork', lastTurnId: 'old-turn'})).toMatchObject({
        session: {id: 'created'}, checkpoint: {sourceSessionId: 's', turnId: 'old-turn', verified: false, code: 'HARNESS_CHECKPOINT_BOUNDARY_UNKNOWN'}});
    expect(call).toHaveBeenLastCalledWith('harness_fork', expect.objectContaining({sessionId: 's', lastTurnId: 'old-turn', requestId: 'fork'}), expect.anything());
});
it('does not send checkpoint requests to legacy nodes or turn discovery failure into an unknown mutation', async () => {
    const call = vi.fn(async () => ({epoch: 'e', profiles: []})), client = new MCPHarnessClient({call, close: vi.fn()});
    await expect(client.fork('codex', 's', undefined, {requestId: 'fork', lastTurnId: 'old-turn'}))
        .rejects.toMatchObject({code: 'ECAPABILITY', outcome: 'not-committed', requestId: 'fork'});
    expect(call).toHaveBeenCalledOnce();
    const failed = new MCPHarnessClient({call: vi.fn(async () => {throw new Error('Discovery unavailable');}), close: vi.fn()});
    await expect(failed.fork('codex', 's', undefined, {requestId: 'fork', lastTurnId: 'old-turn'}))
        .rejects.toMatchObject({outcome: 'not-committed', requestId: 'fork'});
});
it('validates optional native archive eligibility without accepting truthy values', () => {
    for (const archiveAllowed of [true, false]) expect(validateSession({...session, archiveAllowed}).archiveAllowed).toBe(archiveAllowed);
    for (const archiveAllowed of ['true', 1, null, {}]) expect(() => validateSession({...session, archiveAllowed})).toThrow();
});
it('retains profile aliases and rejects malformed alias metadata', () => {
    const profile = {id:'codex',kind:'codex',aliases:['codex-main'],workspaces:[],
        capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}};
    expect(validateProfiles({epoch:'e',profiles:[profile]}).profiles[0].aliases).toEqual(['codex-main']);
    for (const aliases of ['codex-main', [false], [''], Array(129).fill('old')])
        expect(() => validateProfiles({epoch:'e',profiles:[{...profile,aliases}]})).toThrow();
});
it('retains distinct creation and modification instants and accepts legacy native seconds without repeated conversion', () => {
    const legacy = {...session, title: ' ', updatedAt: 1791458565, native: {name: '', preview: 'Fix session navigation', createdAt: 1791458500}};
    const expected = {title: 'Fix session navigation', createdAt: 1791458500000, updatedAt: 1791458565000};
    const normalized = validatePage({sessions: [legacy], nextCursor: null}).sessions[0];
    expect(normalized).toMatchObject(expected); expect(validateSession(normalized)).toEqual(normalized);
    expect(validateHistory({session: legacy, turns: []}).session).toMatchObject(expected);
    expect(legacy.updatedAt).toBe(1791458565);
    expect(validateSession({...session, updatedAt: 0})).toMatchObject({createdAt: null, updatedAt: null});
    expect(() => validateSession({...session, createdAt: NaN})).toThrow();
});
it('carries an epoch and stable receipt identity, without replay after a lost response',async () => {
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
        if (name === 'harness_profiles') return { epoch:'e',profiles:[] };
        if (name === 'harness_operation') return { outcome:'committed',requestId:args.requestId,result:{ session } };
        throw new Error('response lost');
    });
    const client = new MCPHarnessClient({ call,close:vi.fn() });
    const error = await client.create('codex','project').catch(e => e);
    expect(error.outcome).toBe('unknown'); expect(typeof error.requestId).toBe('string');
    expect(call.mock.calls.filter(([name]) => name === 'harness_create')).toHaveLength(1);
    expect(call.mock.calls[1][1]).toMatchObject({ epoch:'e',requestId:error.requestId });
    const receipt = await client.operation('codex',error.requestId);
    expect(receipt.outcome).toBe('committed');
    expect(call.mock.calls.filter(([name]) => name === 'harness_create')).toHaveLength(1);
});

it('keeps explicit refusal separate from unknown outcomes',async () => {
    const client = new MCPHarnessClient({ close:vi.fn(),call:async (name,args) => name === 'harness_profiles'
        ? { epoch:'e',profiles:[] } : { outcome:'not-committed',requestId:(args as { requestId:string }).requestId,code:'EACCES' } });
    await expect(client.resume('codex','s')).rejects.toMatchObject({ outcome:'not-committed',code:'EACCES' });
});

it('reports failed profile discovery as not sent and never dispatches the mutation', async () => {
    const call = vi.fn(async () => {throw new TypeError('Load failed');});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    await expect(client.resume('codex', 's', {requestId: 'before-dispatch'}))
        .rejects.toMatchObject({outcome: 'not-committed', requestId: 'before-dispatch'});
    expect(call).toHaveBeenCalledOnce(); expect(call.mock.calls[0][0]).toBe('harness_profiles');
});

it('rejects malformed session, history, and event responses',() => {
    expect(() => validatePage({ sessions:[{...session,resumable:'true'}],nextCursor:null })).toThrow();
    expect(() => validateHistory({ session,turns:{} })).toThrow();
    expect(() => validateEvents({ epoch:'e',cursor:1,gap:false,events:[{seq:1,message:{}}],requests:[] })).toThrow();
    expect(() => validateEvents({epoch: 'e', cursor: 1, gap: false, events: [{seq: 1, timestamp: NaN, message: {method: 'item/started'}}], requests: []})).toThrow();
});

it('reads compact histories and receives live events without a polling RPC', async () => {
    const call = vi.fn(async () => ({session, turns: [], nextCursor: null}));
    const stop = vi.fn();
    const subscribe = vi.fn((_plugin, _args, listener) => {
        queueMicrotask(() => listener.next({epoch:'events',cursor:7,gap:false,events:[],requests:[]})); return stop;
    });
    const client = new MCPHarnessClient({call,subscribe,close:vi.fn()});
    await client.read('codex','s',{cursor:'old',toolDetail:'summary'});
    expect((await client.eventSnapshot('codex',{after:7,eventEpoch:'events'})).cursor).toBe(7);
    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith('harness_session_read',{profileId:'codex',sessionId:'s',cursor:'old',toolDetail:'summary'},expect.anything());
    expect(subscribe).toHaveBeenCalledWith('harness',{profileId:'codex'},expect.anything());
    await client.close(); expect(stop).toHaveBeenCalledOnce();
});

it('uses the MCP v2 SDK and resolves updated credentials for each request',async () => {
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : await (_input as Request).clone().json();
        const result = body.method === 'server/discover'
            ? { resultType:'complete',ttlMs:0,cacheScope:'private',supportedVersions:['2026-07-28'],capabilities:{ tools:{} },_meta:{ 'io.modelcontextprotocol/serverInfo':{name:'test',version:'1'} } }
            : { resultType:'complete',content:[],structuredContent:{ epoch:'e',profiles:[] } };
        return new Response(JSON.stringify({ jsonrpc:'2.0',id:body.id,result }),{ headers:{ 'content-type':'application/json' } });
    });
    const adapter = createCellsDriver(undefined,fetch);
    adapter.setCredential('ref','first');
    const client = adapter.harness({ endpoint:'http://localhost:8787',credentialRef:'ref' });
    await client.profiles(); adapter.setCredential('ref','second'); await client.profiles();
    expect(fetch.mock.calls.map(([,init]) => new Headers(init?.headers).get('authorization'))).toContain('Bearer second');
    expect(fetch.mock.calls.every(([,init]) => init?.redirect === 'error' && init.credentials === 'omit')).toBe(true);
    await adapter.dispose();
});

it('retains receipt identity when a committed payload cannot be decoded',async () => {
    const call = vi.fn(async (name: string, args: object) => name === 'harness_profiles'
        ? {epoch:'e',profiles:[]} : {outcome:'committed',requestId:(args as {requestId:string}).requestId,result:{session:{id:'broken'}}});
    const client = new MCPHarnessClient({call,close:vi.fn()});
    const error = await client.create('codex','project').catch(e => e);
    expect(error.outcome).toBe('committed'); expect(typeof error.requestId).toBe('string');
    expect(error.remoteCode).toBe('HARNESS_COMMITTED_RESULT_INVALID');
    expect(JSON.stringify(error)).not.toContain('broken');
    expect(call.mock.calls.filter(([name]) => name === 'harness_create')).toHaveLength(1);
});

it('uses the persisted mutation identity and queries the original epoch during recovery',async () => {
    const call=vi.fn(async (name:string,args:Record<string,unknown>) => name==='harness_profiles'
        ? {epoch:'current',profiles:[]} : {outcome:'committed',requestId:args.requestId,result:{session}});
    const client: import('../src/harness/contracts').HarnessClient=new MCPHarnessClient({call,close:vi.fn()});
    await client.create('codex','project',{requestId:'persisted',epoch:'original'});
    await client.operation('codex','persisted',{epoch:'original'});
    expect(call.mock.calls.find(([name])=>name==='harness_create')?.[1]).toMatchObject({requestId:'persisted',epoch:'original'});
    expect(call.mock.calls.find(([name])=>name==='harness_operation')?.[1]).toMatchObject({requestId:'persisted',epoch:'original'});
});

it('rejects a recovery receipt belonging to another request',async () => {
    const client=new MCPHarnessClient({call:vi.fn(async name=>name==='harness_profiles'?{epoch:'e',profiles:[]}:{outcome:'committed',requestId:'other',result:{session}}),close:vi.fn()});
    await expect(client.operation('codex','requested')).rejects.toMatchObject({code:'EIO'});
});

it('receives directory invalidations through the shared stream and releases its subscription', async () => {
    let listener: import('../src/events').RemoteEventListener | undefined;
    const stop = vi.fn(), close = vi.fn(), call = vi.fn();
    const subscribe = vi.fn((_plugin,_args,next) => {listener=next;return stop;});
    const client = new MCPHarnessClient({call,subscribe,close},{projectId:'p',revision:2,readOnly:true});
    const changed = vi.fn(), release = client.subscribeDirectory(changed);
    listener!.next({version:'token:1',gap:false,truncated:true});
    expect(client.directorySnapshot()).toBe('token:1'); expect(changed).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith('projects',expect.objectContaining({projectId:'p',revision:2}),expect.anything());
    expect(call).not.toHaveBeenCalled();
    expect(() => listener!.next({version:42,gap:false,truncated:false})).toThrow('Invalid directory');
    release(); expect(stop).toHaveBeenCalledOnce(); await client.close(); expect(close).toHaveBeenCalledOnce();
});
it.each(['missing', 'throws'])('uses the internal mutation ID generator when native UUID %s', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('Native UUID unavailable');}} : {})});
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'harness_profiles' ? {epoch: 'e', profiles: []}
        : {outcome: 'committed', requestId: args.requestId, result: {session}});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    try {
        await client.create('codex', 'project');
        expect(call).toHaveBeenCalledWith('harness_create', expect.objectContaining({requestId: expect.stringMatching(/^[\da-f]{8}-[\da-f-]{27}$/i)}), undefined);
    } finally {await client.close(); vi.unstubAllGlobals();}
});
it('validates native catalogs and carries project scope plus stable command receipts', async () => {
    const commands = [{name: 'team:verify', description: 'Verify', argumentHint: '[path]', kind: 'prompt'}];
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'harness_commands' ? {commands}
        : name === 'harness_profiles' ? {epoch: 'e', profiles: []}
        : {requestId: args.requestId, outcome: 'committed', result: {commandId: 'native', output: 'Done'}});
    const client = new MCPHarnessClient({call, close: vi.fn()}, {projectId: 'p', revision: 3});
    expect(await client.commands('claude', 's')).toEqual(commands);
    await client.command('claude', 's', 'team:verify', 'src', {requestId: 'once'});
    expect(call).toHaveBeenCalledWith('harness_commands', {profileId: 'claude', sessionId: 's', projectId: 'p', revision: 3}, undefined);
    expect(call).toHaveBeenCalledWith('harness_command', {profileId: 'claude', sessionId: 's', projectId: 'p', revision: 3,
        epoch: 'e', requestId: 'once', command: 'team:verify', arguments: 'src'}, {requestId: 'once'});
    for (const rows of [[...commands, ...commands], [{...commands[0], name: 'wrong name'}], [{...commands[0], kind: 'shell'}]])
        expect(() => validateCommands({commands: rows})).toThrow();
});

it('negotiates steering and validates its exact receipt without sending to legacy nodes', async () => {
    const profiles = [{id: 'codex', kind: 'codex', workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, steer: true}}];
    const call = vi.fn(async (name: string, args: Record<string, unknown>) => name === 'harness_profiles' ? {epoch: 'e', profiles}
        : {requestId: args.requestId, outcome: 'committed', result: {turnId: args.turnId}});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    expect(await client.steer('codex', 's', 'active', 'Context', {requestId: 'context'})).toEqual({turnId: 'active'});
    expect(call).toHaveBeenLastCalledWith('harness_steer', expect.objectContaining({sessionId: 's', turnId: 'active', requestId: 'context'}), expect.anything());
    const legacyCall = vi.fn(async () => ({epoch: 'e', profiles: []}));
    const legacy = new MCPHarnessClient({call: legacyCall, close: vi.fn()});
    await expect(legacy.steer('codex', 's', 'active', 'Context', {requestId: 'legacy'})).rejects.toMatchObject({code: 'ECAPABILITY', outcome: 'not-committed'});
    expect(legacyCall).toHaveBeenCalledOnce();
    await expect(client.steer('codex', 's', 'active', '中'.repeat(50000), {requestId: 'large'})).rejects.toMatchObject({outcome: 'not-committed'});
    call.mockImplementation(async (_name, args) => ({requestId: args.requestId, outcome: 'committed', result: {turnId: 'native-next', targetTurnId: 'active'}}));
    expect(await client.steer('codex', 's', 'active', 'Context', {requestId: 'next'})).toEqual({turnId: 'native-next', targetTurnId: 'active'});
    call.mockImplementation(async (_name, args) => ({requestId: args.requestId, outcome: 'committed', result: {turnId: 'wrong'}}));
    await expect(client.steer('codex', 's', 'active', 'Context', {requestId: 'mismatch'})).rejects.toMatchObject({outcome: 'committed'});
});
