import { expect, it, vi } from 'vitest';
import { HarnessConversation } from '../src/harness/conversation';
import { MCPHarnessClient } from '../src/harness/client';
import type { HarnessClient, HarnessProfile } from '../src/harness/contracts';
import type { HarnessRecovery } from '../src/harness/conversation-journal';
import { historyMessages, mergeMessages } from '../src/harness/conversation-model';
import { toolSummary } from '../src/harness/tool-summary';
const profile: HarnessProfile = {id:'codex', kind:'codex', projectRuntime:true, workspaces:[{id:'p'}], capabilities:{history:true,create:true,resume:true,interrupt:true,interactions:true}};
const session = {id:'s', title:'Title', cwd:'/projects/p', status:'idle', updatedAt:1, resumable:true, owned:true};
const queryCommand = {name: 'session:status', description: 'State', kind: 'action' as const, execution: 'query' as const, revision: 'state-v1'};
const queryProfile = {...profile, capabilities: {...profile.capabilities, slashCommands: true, commandQueries: true}};

it('reads an explicitly requested query without loading history, refreshing the catalog or trusting stale execution state', async () => {
    const client = peer(); client.commands = vi.fn(async () => {throw new Error('Directory unavailable');});
    vi.mocked(client.read).mockRejectedValue(new Error('History unavailable'));
    client.queryCommand = vi.fn(async (_p, _s, _n, _a, options) => ({commandId: options!.requestId, status: 'completed', output: 'Observed state'}));
    const view = new HarnessConversation(client, queryProfile, 'p', 's');
    expect(await view.queryCommand('session:status', '', 'query')).toMatchObject({queryReceipts: [{id: 'query', status: 'accepted'}], canSend: false});
    expect(client.read).not.toHaveBeenCalled(); expect(client.commands).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled();
    await view.close();
});

it('persists a query during a suspended send without replacing its receipt, queued work or newer draft', async () => {
    const client = peer(); let record: HarnessRecovery | undefined, finish!: (value: {turnId: string}) => void;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.commands = vi.fn(async () => [queryCommand]);
    client.queryCommand = vi.fn(async (_profile, _session, _name, _args, options) => ({commandId: options!.requestId, output: 'Observed state', status: 'completed'}));
    client.command = vi.fn(); client.turn = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new HarnessConversation(client, queryProfile, 'p', 's', true, journal); await view.read(); await view.commands();
    const sending = view.send('Original', [], undefined, 'original-send');
    await vi.waitFor(() => expect(client.turn).toHaveBeenCalledOnce());
    await view.saveDraft('Newer input'); await view.enqueue('Queued next', [], undefined, 'next');
    expect(view.snapshot()).toMatchObject({pending: true, canQueryCommand: true, canCommand: false});
    const pending = structuredClone(record!.pending), submission = structuredClone(record!.submission);
    const result = await view.command(queryCommand.name, '', undefined, '/session:status', 'read-state', queryCommand);
    expect(result).toMatchObject({pending: true, draft: 'Newer input', submission, queryReceipts: [{id: 'read-state', status: 'accepted'}]});
    expect(record!.pending).toEqual(pending); expect(record!.instructionQueue!.items[0].id).toBe('next');
    expect(result.messages).toContainEqual(expect.objectContaining({id: 'command:read-state', role: 'system', text: 'Observed state'}));
    await view.queryCommand(queryCommand.name, '', 'read-state', queryCommand);
    expect(client.queryCommand).toHaveBeenCalledOnce(); expect(client.command).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled();
    await view.reconcile('read-state'); expect(client.operation).not.toHaveBeenCalled();
    finish({turnId: 'original-turn'}); await sending; await view.close();
    const reopened = new HarnessConversation(client, queryProfile, 'p', 's', true, journal); await reopened.read();
    expect((await reopened.reconcile('read-state')).queryReceipts).toEqual([{id: 'read-state', status: 'accepted'}]);
    expect(client.operation).not.toHaveBeenCalled(); await reopened.close();
});

it('recovers an uncertain query report write without re-reading native state or settling the input operation', async () => {
    const client = peer(); let record: HarnessRecovery | undefined, fail = true;
    const pending = {requestId: 'original', epoch: 'e', operation: 'turn', inputText: 'Original'};
    record = {sessionId: 's', pending, submission: {id: 'original', status: 'pending'}, draft: 'Keep'};
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {
        record = structuredClone(value); if (fail && value.commandResults?.length) {fail = false; throw new Error('Lost storage response');}
    }};
    client.commands = vi.fn(async () => [queryCommand]);
    client.queryCommand = vi.fn(async (_p, _s, _c, _a, options) => ({commandId: options!.requestId, output: 'Observed', status: 'completed'}));
    const view = new HarnessConversation(client, queryProfile, 'p', 's', true, journal); await view.read(); await view.commands();
    await expect(view.queryCommand(queryCommand.name, '', 'query')).rejects.toThrow('Lost storage response');
    expect(view.snapshot()).toMatchObject({pending: true, draft: 'Keep', queryReceipts: [], pendingQueryReports: ['query'], submission: {id: 'original', status: 'pending'}});
    expect(await view.reconcileQuery('query')).toMatchObject({queryReceipts: [{id: 'query', status: 'accepted'}], pendingQueryReports: []});
    expect(record!.pending).toEqual(pending); expect(client.queryCommand).toHaveBeenCalledOnce(); expect(client.operation).not.toHaveBeenCalled();
    await view.close();
});

it('keeps read failures outside execution uncertainty and requires positively negotiated query support', async () => {
    const client = peer(); client.commands = vi.fn(async () => [queryCommand]);
    client.queryCommand = vi.fn(async () => {throw new Error('Read unavailable');});
    const view = new HarnessConversation(client, queryProfile, 'p', 's'); await view.read(); await view.commands(); await view.saveDraft('Keep');
    await expect(view.queryCommand(queryCommand.name, '', 'query')).rejects.toMatchObject({outcome: 'not-committed'});
    expect(view.snapshot()).toMatchObject({pending: false, canSend: true, draft: 'Keep', queryReceipts: []});
    await expect(view.queryCommand(queryCommand.name, 'side effect', 'bad')).rejects.toMatchObject({outcome: 'not-committed'});
    const legacy = new HarnessConversation(client, {...queryProfile, capabilities: {...queryProfile.capabilities, commandQueries: false}}, 'p', 's');
    await legacy.read(); await expect(legacy.queryCommand(queryCommand.name)).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(client.queryCommand).toHaveBeenCalledOnce(); await legacy.close(); await view.close();
});

it('does not turn an absent durable query report into a native mutation receipt lookup', async () => {
    const client = peer(), view = new HarnessConversation(client, queryProfile, 'p', 's'); await view.read();
    expect((await view.reconcileQuery('missing-query')).queryReceipts).toEqual([]);
    expect(client.operation).not.toHaveBeenCalled(); expect(view.snapshot().pending).toBe(false); await view.close();
});
it('projects partial command discovery independently of conversation connectivity and input readiness', async () => {
    const client = peer(); client.commands = vi.fn();
    let catalog = {commands: [{name: 'session:status', description: 'State', kind: 'action' as const, execution: 'query' as const}],
        observation: {complete: false, code: 'DSH_SESSION_NOT_ATTACHED'}};
    client.commandCatalog = vi.fn(async () => catalog);
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, slashCommands: true}}, 'p', 's');
    await view.read(); await view.commands();
    expect(view.snapshot()).toMatchObject({disconnected: false, canSend: true, commandCatalogObservation: catalog.observation});
    expect(client.commands).not.toHaveBeenCalled();
    catalog = {...catalog, observation: {complete: true, code: ''}}; await view.commands();
    expect(view.snapshot().commandCatalogObservation?.complete).toBe(true); await view.close();
});

it('disables mutation controls on an expired observation and restores them after refresh', async () => {
    vi.useFakeTimers();
    const client = peer(); client.fork = vi.fn(async () => ({session: {...session, id: 'branch'}}));
    const source = {...profile, capabilities: {...profile.capabilities, fork: true}};
    const view = new HarnessConversation(client, source, 'p', 's');
    try {
        await view.read(); expect(view.snapshot()).toMatchObject({canSend: true, canFork: true});
        await vi.advanceTimersByTimeAsync(30_001);
        expect(view.snapshot()).toMatchObject({canSend: false, canFork: false, observation: {stale: true}});
        await expect(view.fork()).rejects.toMatchObject({code: 'ECAPABILITY'}); expect(client.fork).not.toHaveBeenCalled();
        await view.read(); expect(view.snapshot()).toMatchObject({canSend: true, canFork: true});
    } finally {await view.close(); vi.useRealTimers();}
});

it('validates model-specific reasoning before admission and leaves unsupported nodes unchanged', async () => {
    const client = peer();
    client.models = vi.fn(async () => ({models: [{id: 'native', label: 'Native', reasoningEfforts: [{id: 'high', label: 'High'}]}]}));
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, models: true}}, 'p', 's');
    await view.read();
    await expect(view.send('Prompt', [], {modelId: 'native', reasoningEffort: 'invalid'})).rejects.toThrow();
    expect(client.turn).not.toHaveBeenCalled();
    await view.send('Prompt', [], {modelId: 'native', reasoningEffort: 'high'});
    expect(client.turn).toHaveBeenCalledWith('codex', 's', 'Prompt', expect.objectContaining({selection: {modelId: 'native', reasoningEffort: 'high'}}));
    await view.close();
    vi.mocked(client.models).mockClear();
    const legacy = new HarnessConversation(client, profile, 'p', 's');
    expect(await legacy.models()).toEqual({models: []}); expect(client.models).not.toHaveBeenCalled();
    await legacy.close();
});

it('captures the model selection before asynchronous discovery can observe later edits', async () => {
    const client = peer();
    let finish!: (catalog: import('../src/harness/contracts').HarnessModelCatalog) => void;
    client.models = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, models: true}}, 'p', 's');
    await view.read();
    const selected = {modelId: 'native', reasoningEffort: 'high'};
    const sending = view.send('Prompt', [], selected);
    selected.modelId = 'changed'; selected.reasoningEffort = 'invalid';
    finish({models: [{id: 'native', label: 'Native', reasoningEfforts: [{id: 'high', label: 'High'}]}]});
    await sending;
    expect(client.turn).toHaveBeenCalledWith('codex', 's', 'Prompt', expect.objectContaining({selection: {modelId: 'native', reasoningEffort: 'high'}}));
    await view.close();
});

it('keeps native command acceptance separate from turns and preserves newer draft edits', async () => {
    const client = peer(), catalog = [{name: 'compact', description: 'Compact', kind: 'action' as const}];
    client.commands = vi.fn(async () => catalog);
    let finish!: (value: {commandId: string; output: string}) => void;
    client.command = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, slashCommands: true}}, 'p', 's');
    await view.read(); await view.commands();
    const sending = view.command('compact');
    await vi.waitFor(() => expect(client.command).toHaveBeenCalledOnce());
    await view.saveDraft('Next question'); finish({commandId: 'native', output: 'Compacted'});
    const result = await sending;
    expect(result.draft).toBe('Next question'); expect(result.pending).toBe(false);
    expect(result.messages).toContainEqual(expect.objectContaining({id: 'command:native', role: 'system', text: 'Compacted'}));
    expect(client.turn).not.toHaveBeenCalled(); await view.close();
});

it('reconciles a native command after a lost response without replaying it or clearing a newer draft', async () => {
    const client = peer(), commands = [{name: 'compact', description: 'Compact', kind: 'action' as const}];
    client.commands = vi.fn(async () => commands);
    client.command = vi.fn(async () => {throw Object.assign(new Error('Lost response'), {outcome: 'unknown'});});
    let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (value: HarnessRecovery) => {saved = structuredClone(value);}};
    const source = {...profile, capabilities: {...profile.capabilities, slashCommands: true}};
    const first = new HarnessConversation(client, source, 'p', 's', true, journal); await first.read();
    await expect(first.command('compact')).rejects.toThrow('Lost response');
    expect(first.snapshot().pending).toBe(true); await first.saveDraft('Newer input'); await first.close();
    const reopened = new HarnessConversation(client, source, 'p', 's', true, journal);
    await reopened.read(); vi.mocked(client.operation).mockResolvedValue({requestId: saved!.pending!.requestId, outcome: 'committed', result: {commandId: 'native', output: 'Done'}});
    expect((await reopened.reconcile()).draft).toBe('Newer input'); expect(client.command).toHaveBeenCalledOnce();
    await reopened.close();
});
function peer(): HarnessClient {
    return {profiles:vi.fn(async () => ({epoch:'e',profiles:[profile]})), list:vi.fn(), read:vi.fn(async () => ({session:{...session}, turns:[{items:[{id:'a',type:'agentMessage',text:'native history'}]}]})),
        create:vi.fn(async () => ({session:{...session}})), resume:vi.fn(async () => ({session:{...session}})), turn:vi.fn(async () => ({turnId:'t'})),
        interrupt:vi.fn(async () => {}), respond:vi.fn(async () => {}), operation:vi.fn(), close:vi.fn(async () => {}),
        eventSnapshot:vi.fn(async () => ({epoch:'events',cursor:1,gap:false,events:[],requests:[]}))};
}
it('restores legacy attachments for queries and repair while rejecting native dispatch before session preparation', async () => {
    const client = peer(), capable = {...queryProfile, capabilities: {...queryProfile.capabilities, attachments: ['image' as const]}};
    const files = [{kind: 'image' as const, name: 'legacy.png', content: 'data:image/png;base64,AQID', mimeType: 'image/png'}];
    let record: HarnessRecovery = {sessionId: 's', draft: 'Keep original', draftRevision: 7, draftAttachments: files,
        instructionQueue: {revision: 3, paused: true, items: [{id: 'legacy', text: 'Old queued input', attachments: files, createdAt: 1, state: 'pending'}], receipts: []}};
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.queryCommand = vi.fn(async () => ({commandId: 'query', status: 'completed', output: 'Observed'}));
    const view = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect(await view.read()).toMatchObject({draft: 'Keep original', draftAttachments: files, instructionQueue: {items: [{id: 'legacy'}]}});
    expect(record.draftRevision).toBe(7);
    expect(await view.queryCommand(queryCommand.name, '', 'query')).toMatchObject({queryReceipts: [{id: 'query', status: 'accepted'}]});
    await expect(view.send('Keep original', files)).rejects.toMatchObject({attachmentCode: 'HARNESS_ATTACHMENT_MIME_MISMATCH'});
    expect(record.draftAttachments).toEqual(files); expect(client.turn).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled();
    await view.editInstructionQueue({action: 'resume', expectedRevision: 3}); await view.refresh();
    expect(view.snapshot().instructionQueue).toMatchObject({paused: true, items: [{id: 'legacy', state: 'failed', error: 'HARNESS_ATTACHMENT_MIME_MISMATCH'}]});
    await view.editInstructionQueue({action: 'remove', id: 'legacy', expectedRevision: view.snapshot().instructionQueue!.revision});
    await view.saveDraft('Repaired'); expect(record.draftAttachments).toEqual([]);
    expect(client.turn).not.toHaveBeenCalled(); await view.close();
});

it('reconciles an old uncertain turn without revalidating or replaying its stored attachments', async () => {
    const client = peer(), files = [{kind: 'text' as const, name: 'legacy.txt', content: '\ud800'}];
    let record: HarnessRecovery = {sessionId: 's', draft: 'Original', draftAttachments: files,
        pending: {requestId: 'original', epoch: 'old-epoch', operation: 'turn', inputText: 'Original'}, submission: {id: 'original', status: 'pending'},
        instructionQueue: {revision: 3, paused: true, items: [{id: 'original', text: 'Original', attachments: files, createdAt: 1, state: 'uncertain'}], receipts: []}};
    const journal = {epoch: 'new-epoch', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    vi.mocked(client.operation).mockResolvedValue({requestId: 'original', outcome: 'unknown'});
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, attachments: ['text']}}, 'p', 's', true, journal);
    await view.read(); await view.reconcile('original'); await view.refresh();
    expect(client.operation).toHaveBeenCalledWith('codex', 'original', expect.objectContaining({epoch: 'old-epoch'}));
    expect(record).toMatchObject({draftAttachments: files, pending: {requestId: 'original'}, instructionQueue: {items: [{id: 'original', state: 'uncertain'}]}});
    expect(client.turn).not.toHaveBeenCalled(); expect(client.create).not.toHaveBeenCalled(); expect(client.resume).not.toHaveBeenCalled();
    await view.close();
});

it('checks new and edited queue prompt bytes without changing prior accepted instructions', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    await view.enqueue('Original', [], undefined, 'first'); const before = structuredClone(record);
    await expect(view.enqueue('中'.repeat(50000), [], undefined, 'oversize')).rejects.toMatchObject({attachmentCode: 'HARNESS_PROMPT_LIMIT'});
    await expect(view.editInstructionQueue({action: 'update', id: 'first', text: '中'.repeat(50000), expectedRevision: before!.instructionQueue!.revision})).rejects.toMatchObject({attachmentCode: 'HARNESS_PROMPT_LIMIT'});
    expect(record).toEqual(before); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});

it('queues attachment-only input using its original identity and reconciles a lost acknowledgement without resending', async () => {
    const client = peer(), files = [{kind: 'text' as const, name: 'notes.txt', content: 'Review these notes'}];
    const capable = {...profile, capabilities: {...profile.capabilities, attachments: ['text' as const]}};
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.turn = vi.fn(async () => {throw {outcome: 'unknown'};});
    const first = new HarnessConversation(client, capable, 'p', 's', true, journal); await first.read();
    await first.saveDraft('', files); await first.enqueue('', files, undefined, 'file-only');
    // The host consumes the matching composer after durable queue admission.
    await first.saveDraft('', []);
    expect(record!.instructionQueue!.items[0]).toMatchObject({id: 'file-only', text: '', attachments: files});
    await first.refresh(); expect(client.turn).toHaveBeenCalledWith('codex', 's', 'Attachments: notes.txt', expect.objectContaining({requestId: 'file-only', attachments: files}));
    expect(record!.pending).toMatchObject({requestId: 'file-only', inputText: '', operation: 'turn'}); await first.close();
    vi.mocked(client.operation).mockResolvedValue({requestId: 'file-only', outcome: 'committed', result: {turnId: 'native-file-only'}});
    const next = new HarnessConversation(client, capable, 'p', 's', true, journal); await next.read();
    await next.reconcile('file-only'); await next.refresh();
    expect(record).toMatchObject({draft: '', draftAttachments: [], submission: {id: 'file-only', status: 'accepted', turnId: 'native-file-only'}});
    expect(client.turn).toHaveBeenCalledOnce(); await next.close();
});

it('retains newer file-only drafts after an earlier attachment-only turn is acknowledged', async () => {
    const client = peer(), original = [{kind: 'text' as const, name: 'notes.txt', content: 'Original'}], newer = [{...original[0], content: 'Changed'}];
    let record: HarnessRecovery | undefined, finish!: (value: {turnId: string}) => void;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.turn = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, attachments: ['text']}}, 'p', 's', true, journal); await view.read();
    const sending = view.send('', original, undefined, 'first-file');
    await vi.waitFor(() => expect(client.turn).toHaveBeenCalledOnce());
    await view.saveDraft('', newer); finish({turnId: 'first-file-turn'}); await sending;
    expect(record!.draftAttachments).toEqual(newer); expect(record!.pending).toBeUndefined();
    await expect(view.send('')).rejects.toMatchObject({attachmentCode: 'HARNESS_PROMPT_INVALID'});
    expect(client.turn).toHaveBeenCalledOnce(); await view.close();
});

it('persists queued native instructions, edits them and dispatches once in order', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    const turns: Array<{id: string; status: string; items: unknown[]}> = [];
    vi.mocked(client.read).mockImplementation(async () => ({session: {...session}, turns: [...turns]}));
    vi.mocked(client.turn).mockImplementation(async () => {
        const turnId = `turn-${turns.length + 1}`; turns.push({id: turnId, status: 'completed', items: []}); return {turnId};
    });
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    await Promise.all([view.enqueue('First', [], undefined, 'queue-first'), view.enqueue('Second', [], undefined, 'queue-second')]);
    expect(client.turn).not.toHaveBeenCalled(); expect(saved?.instructionQueue?.items).toHaveLength(2);
    let queue = view.snapshot().instructionQueue!;
    await view.editInstructionQueue({action: 'update', id: 'queue-second', text: 'Revised second', expectedRevision: queue.revision});
    await expect(view.editInstructionQueue({action: 'remove', id: 'queue-first', expectedRevision: queue.revision})).rejects.toMatchObject({code: 'ECONFLICT'});
    await view.enqueue('Second', [], undefined, 'queue-second');
    expect(view.snapshot().instructionQueue?.items).toHaveLength(2);
    await view.refresh(); expect(client.turn).toHaveBeenCalledOnce();
    await view.refresh(); expect(client.turn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.turn).mock.calls.map(args => args[2])).toEqual(['First', 'Revised second']);
    expect(vi.mocked(client.turn).mock.calls.map(args => args[3]?.requestId)).toEqual(['queue-first', 'queue-second']);
    await view.refresh(); expect(view.snapshot().instructionQueue?.items).toEqual([]);
    expect(view.snapshot().instructionQueue?.submissions).toEqual([
        {id: 'queue-first', turnId: 'turn-1', commandId: undefined, createdAt: expect.any(Number), dispatchedAt: expect.any(Number), acceptedAt: expect.any(Number)},
        {id: 'queue-second', turnId: 'turn-2', commandId: undefined, createdAt: expect.any(Number), dispatchedAt: expect.any(Number), acceptedAt: expect.any(Number)},
    ]);
    await view.close();
    const reopened = new HarnessConversation(client, profile, 'p', 's', true, journal);
    await reopened.read(); expect(reopened.snapshot().instructionQueue?.submissions).toEqual(view.snapshot().instructionQueue?.submissions);
    expect(client.turn).toHaveBeenCalledTimes(2); await reopened.close();
});

it('keeps an uncertain native queue claim on reopen and reconciles without replaying it', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    vi.mocked(client.read).mockResolvedValue({session: {...session}, turns: [{id: 't', status: 'completed', items: []}]});
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    vi.mocked(client.turn).mockRejectedValueOnce(new TypeError('Lost response'));
    const first = new HarnessConversation(client, profile, 'p', 's', true, journal); await first.read();
    await first.enqueue('Do once', [], undefined, 'uncertain-queue'); await first.refresh();
    expect(first.snapshot().instructionQueue).toMatchObject({paused: true, items: [{id: 'uncertain-queue', state: 'uncertain'}]});
    await first.close();
    vi.mocked(client.operation).mockResolvedValue({requestId: 'uncertain-queue', outcome: 'unknown'});
    const reopened = new HarnessConversation(client, profile, 'p', 's', true, journal); await reopened.read(); await reopened.refresh();
    expect(client.turn).toHaveBeenCalledOnce(); expect(reopened.snapshot().instructionQueue?.items).toHaveLength(1);
    vi.mocked(client.operation).mockResolvedValue({requestId: 'uncertain-queue', outcome: 'committed', result: {turnId: 't'}});
    await reopened.refresh();
    expect(client.turn).toHaveBeenCalledOnce(); expect(reopened.snapshot().instructionQueue).toMatchObject({paused: true, items: []});
    await reopened.close();
});

it('does not dispatch queued instructions when durable acceptance fails or leak attachment bodies in projections', async () => {
    const client = peer(); const journal = {epoch: 'e', load: async () => undefined, save: vi.fn(async () => {throw new Error('Storage unavailable');})};
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, attachments: ['text']}}, 'p', 's', true, journal);
    await view.read();
    await expect(view.enqueue('Retain me', [{kind: 'text', name: 'a.txt', content: 'private-body'}], undefined, 'not-accepted')).rejects.toThrow('Storage unavailable');
    await view.refresh(); expect(client.turn).not.toHaveBeenCalled(); expect(view.snapshot().instructionQueue?.items).toEqual([]);
    journal.save.mockResolvedValue(undefined as never);
    await view.enqueue('Accepted', [{kind: 'text', name: 'a.txt', content: 'private-body'}], undefined, 'accepted');
    expect(JSON.stringify(view.snapshot().instructionQueue)).not.toContain('private-body');
    await view.close();
});
it('waits for the corresponding native turn completion instead of advancing on an idle history alone', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    const view = new HarnessConversation(client, profile, 'p', 's', true,
        {epoch: 'e', load: async () => saved, save: async record => {saved = structuredClone(record);}});
    await view.read(); await view.enqueue('First', [], undefined, 'first'); await view.enqueue('Second', [], undefined, 'second');
    await view.refresh(); await view.refresh();
    expect(client.turn).toHaveBeenCalledOnce(); expect(view.snapshot().instructionQueue?.items).toHaveLength(2);
    vi.mocked(client.eventSnapshot).mockResolvedValue({epoch: 'events', cursor: 2, gap: false, requests: [],
        events: [{seq: 2, message: {method: 'turn/completed', params: {threadId: 's', turn: {id: 't', status: 'completed'}}}}]});
    await view.refresh(); expect(client.turn).toHaveBeenCalledTimes(2);
    await view.close();
});
it('recovers a persisted queue acceptance whose storage acknowledgement was lost before any native call', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined, loseReply = true;
    const view = new HarnessConversation(client, profile, 'p', 's', true, {epoch: 'e', load: async () => saved,
        save: async record => {
            saved = structuredClone(record);
            if (loseReply) {loseReply = false; throw new Error('Lost storage acknowledgement');}
        }});
    await view.read();
    await expect(view.enqueue('Accepted once', [], undefined, 'stored-once')).rejects.toThrow('Lost storage acknowledgement');
    const recovered = await view.reconcile('stored-once');
    expect(recovered.instructionQueue?.acceptedIds).toContain('stored-once');
    expect(client.operation).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled();
    await view.refresh(); await view.refresh();
    expect(client.turn).toHaveBeenCalledOnce(); await view.close();
});

it('queues native commands through the command protocol and retries only a definitely rejected attempt', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    client.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    client.command = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Busy'), {code: 'EBUSY', outcome: 'not-committed'}))
        .mockResolvedValue({commandId: 'done', output: 'Done'});
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, slashCommands: true}}, 'p', 's', true,
        {epoch: 'e', load: async () => saved, save: async record => {saved = structuredClone(record);}});
    await view.read(); await view.enqueue('/compact', [], undefined, 'native-command'); await view.refresh();
    expect(view.snapshot().instructionQueue).toMatchObject({paused: true, items: [{state: 'failed'}]});
    await view.editInstructionQueue({action: 'retry', id: 'native-command', expectedRevision: view.snapshot().instructionQueue!.revision});
    await view.refresh(); await view.refresh();
    expect(client.turn).not.toHaveBeenCalled(); expect(client.command).toHaveBeenCalledTimes(2);
    const attempts = vi.mocked(client.command).mock.calls.map(args => args[4]?.requestId);
    expect(attempts[0]).toBe('native-command'); expect(attempts[1]).not.toBe(attempts[0]);
    expect(view.snapshot().instructionQueue?.items).toEqual([]); await view.close();
});

it.each(['retry', 'resume'] as const)('restores a preparation-rejected EIO queue entry and starts a new attempt only after explicit %s', async action => {
    const client = peer(); let saved: HarnessRecovery | undefined; const attempts: string[] = [];
    const capable = {...profile, capabilities: {...profile.capabilities, slashCommands: true}};
    const native = new MCPHarnessClient({close: vi.fn(), call: async (name, args) => {
        if (name === 'harness_profiles') return {epoch: 'e', profiles: [capable]};
        const id = (args as {requestId: string}).requestId; attempts.push(id);
        return attempts.length === 1 ? {requestId: id, outcome: 'not-committed', code: 'EIO', stage: 'prepare', executionStarted: false}
            : {requestId: id, outcome: 'committed', result: {commandId: 'native-completed', status: 'completed', output: 'Done'}};
    }});
    client.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    client.command = native.command.bind(native);
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    const first = new HarnessConversation(client, capable, 'p', 's', true, journal);
    await first.read(); await first.enqueue('/compact', [], undefined, 'preparation-failed'); await first.refresh();
    expect(first.snapshot()).toMatchObject({pending: false, instructionQueue: {paused: true, items: [{state: 'failed', error: 'EIO'}]}});
    await first.close();
    const restored = new HarnessConversation(client, capable, 'p', 's', true, journal); await restored.read(); await restored.refresh();
    expect(attempts).toEqual(['preparation-failed']); expect(client.operation).not.toHaveBeenCalled();
    await restored.editInstructionQueue({action, ...(action === 'retry' ? {id: 'preparation-failed'} : {}), expectedRevision: restored.snapshot().instructionQueue!.revision});
    await restored.refresh(); await restored.refresh();
    expect(attempts).toHaveLength(2); expect(attempts[1]).not.toBe(attempts[0]);
    expect(restored.snapshot().instructionQueue?.items).toEqual([]);
    expect(restored.snapshot().instructionQueue?.acceptedIds).toContain('preparation-failed');
    expect(client.turn).not.toHaveBeenCalled(); await restored.close(); await native.close();
});
it('runs declared queries during an active turn without resuming it or queuing the query', async () => {
    const client = peer();
    client.commands = vi.fn(async () => [{name: 'session:status', description: 'State', kind: 'action', execution: 'query', id: 'status', revision: 'one'}]);
    client.command = vi.fn(async () => ({commandId: 'status-op', output: 'running', status: 'completed'}));
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'active', activeTurnId: 'existing'}, turns: []});
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, slashCommands: true}}, 'p', 's');
    await view.read(); expect(view.snapshot()).toMatchObject({canSend: false, canCommand: true});
    const result = await view.command('session:status', '', undefined, '/session:status', 'query-id');
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled();
    expect(result).toMatchObject({active: true, pending: false, submission: {id: 'query-id', status: 'accepted'}});
    expect(client.command).toHaveBeenCalledWith('codex','s','session:status','', expect.objectContaining({expectedCommand: {id: 'status',revision: 'one'}}));
    await view.close();
});

it('pins an asynchronous command receipt while queries run and advances only after its exact completion', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    client.commands = vi.fn(async () => [{name: 'compact',description: 'Compact',kind: 'action',execution: 'serial',revision: 'one'},
        {name: 'session:status',description: 'State',kind: 'action',execution: 'query'}]);
    client.command = vi.fn(async (_profile,_session,name) => name === 'compact'
        ? {commandId: 'compaction',status: 'running'} : {commandId: 'query',status: 'completed',output: 'Running'});
    const view = new HarnessConversation(client, {...profile,capabilities: {...profile.capabilities,slashCommands: true}}, 'p','s',true,
        {epoch: 'e',load: async () => saved,save: async value => {saved = structuredClone(value);}});
    await view.read(); await view.enqueue('/compact',[],undefined,'compact-id'); await view.enqueue('After compact',[],undefined,'next');
    await view.refresh(); expect(view.snapshot().canSend).toBe(false);
    await view.command('session:status','',undefined,'/session:status','query-id');
    await view.refresh(); expect(client.turn).not.toHaveBeenCalled();
    expect(saved?.instructionQueue?.items[0]).toMatchObject({receipt: {commandId: 'compaction',commandStatus: 'running'}});
    vi.mocked(client.eventSnapshot).mockResolvedValueOnce({epoch: 'events',cursor: 3,gap: false,requests: [],events: [
        {seq: 2,message: {method: 'turn/completed',params: {threadId: 's',turn: {id: 'compact-turn',status: 'completed'}}}},
        {seq: 3,message: {method: 'harness/command/updated',params: {threadId: 's',commandId: 'compaction',turnId: 'compact-turn',status: 'completed',failed: false}}},
    ]});
    await view.refresh(); expect(client.turn).toHaveBeenCalledOnce(); expect(vi.mocked(client.turn).mock.calls[0][2]).toBe('After compact');
    await view.close();
});

it('rejects a changed native command binding before dispatching a queued instruction', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined, revision = 'original';
    client.commands = vi.fn(async () => [{name: 'verify',description: 'Verify',kind: 'prompt',id: 'plugin',revision}]);
    client.command = vi.fn(async () => ({turnId: 't'}));
    const view = new HarnessConversation(client,{...profile,capabilities: {...profile.capabilities,slashCommands: true}},'p','s',true,
        {epoch:'e',load:async () => saved,save:async value => {saved = structuredClone(value);}});
    await view.read(); await view.enqueue('/verify',[],undefined,'bound'); revision = 'changed'; await view.refresh();
    expect(client.command).not.toHaveBeenCalled(); expect(view.snapshot().instructionQueue).toMatchObject({paused: true,items: [{state: 'failed'}]});
    await view.close();
});
it('recovers a command completion from the exact native turn after losing its final event', async () => {
    const client = peer();
    let saved: HarnessRecovery = {sessionId: 's', commandResults: [{commandId: 'compaction', turnId: 'compact-turn', status: 'running', output: '/compact'}]};
    vi.mocked(client.read).mockResolvedValue({session: {...session, lastTurnId: 'compact-turn', lastTurnResult: 'completed'}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's', true,
        {epoch: 'e', load: async () => saved, save: async value => {saved = structuredClone(value);}});
    await view.read();
    expect(view.snapshot()).toMatchObject({canSend: true, observation: {execution: 'idle'}});
    await view.refresh();
    expect(saved.commandResults).toContainEqual(expect.objectContaining({commandId: 'compaction', status: 'completed', failed: false}));
    await view.close();
});
it('creates the first prompt command lazily and keeps session actions unavailable in a draft', async () => {
    const client = peer();
    client.commands = vi.fn(async () => [{name: 'verify', description: 'Verify', kind: 'prompt'}, {name: 'compact', description: 'Compact', kind: 'action'}]);
    client.command = vi.fn(async () => ({turnId: 'first-command'}));
    const source = {...profile, capabilities: {...profile.capabilities, slashCommands: true}};
    const view = new HarnessConversation(client, source, 'p');
    await view.read();
    expect(await view.commands()).toContainEqual(expect.objectContaining({name: 'compact', disabled: true}));
    await expect(view.command('compact')).rejects.toThrow(); expect(client.create).not.toHaveBeenCalled();
    const result = await view.command('verify', 'src');
    expect(client.create).toHaveBeenCalledOnce(); expect(client.turn).not.toHaveBeenCalled();
    expect(result.submittedTurnId).toBe('first-command'); expect(result.sessionId).toBe('s'); await view.close();
});

it('clears the exact command completion text and preserves a later identical draft revision', async () => {
    const client = peer();
    client.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    client.command = vi.fn(async () => ({commandId: 'once', output: 'Done'}));
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, slashCommands: true}}, 'p', 's');
    await view.read(); await view.saveDraft('  /compact ');
    expect((await view.command('compact')).draft).toBe('');
    let finish!: (value: {commandId: string}) => void;
    client.command = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    await view.saveDraft('/compact '); const sending = view.command('compact', '', undefined, '/compact ');
    await vi.waitFor(() => expect(client.command).toHaveBeenCalledOnce());
    await view.saveDraft('New input'); await view.saveDraft('/compact '); finish({commandId: 'twice'});
    expect((await sending).draft).toBe('/compact '); await view.close();
});

it('retains reconciled command output through history refresh, reopen and native echo replacement', async () => {
    const client = peer();
    client.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    client.command = vi.fn(async () => {throw Object.assign(new Error('Lost'), {outcome: 'unknown'});});
    let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    const source = {...profile, capabilities: {...profile.capabilities, slashCommands: true}};
    const view = new HarnessConversation(client, source, 'p', 's', true, journal);
    await view.read(); await view.saveDraft('/compact '); await expect(view.command('compact')).rejects.toThrow('Lost');
    client.operation = vi.fn(async () => ({requestId: saved!.pending!.requestId, outcome: 'committed', result: {commandId: 'c', output: 'Done', failed: true}}));
    const result = await view.reconcile();
    expect(result.draft).toBe(''); expect(result.messages).toContainEqual(expect.objectContaining({id: 'command:c', text: 'Done', status: 'failed'}));
    await view.close(); const reopened = new HarnessConversation(client, source, 'p', 's', true, journal);
    expect((await reopened.read()).messages).toContainEqual(expect.objectContaining({id: 'command:c', text: 'Done'}));
    vi.mocked(client.read).mockResolvedValue({session, turns: [{items: [{id: 'command:c', type: 'systemMessage', text: 'Native done'}]}]});
    expect((await reopened.read()).messages.filter(message => message.id === 'command:c')).toEqual([expect.objectContaining({text: 'Native done'})]);
    expect(client.command).toHaveBeenCalledOnce(); await reopened.close();
});

it('keeps newer native input when a normal message is accepted after editing', async () => {
    const client = peer(); let finish!: (value: {turnId: string}) => void;
    client.turn = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    const sending = view.send('First'); await vi.waitFor(() => expect(client.turn).toHaveBeenCalledOnce());
    await view.saveDraft('Second'); finish({turnId: 'first'});
    expect((await sending).draft).toBe('Second'); await view.close();
});
it('projects native roles, keeps stream items distinct and replaces deltas with finalized content', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's');
    await view.read();
    vi.mocked(client.eventSnapshot).mockResolvedValue({epoch:'events',cursor:2,gap:false,requests:[],events:[
        {seq:1,message:{method:'item/agentMessage/delta',params:{threadId:'other',itemId:'a',delta:'wrong'}}},
        {seq:2,message:{method:'item/agentMessage/delta',params:{threadId:'s',itemId:'b',delta:'draft'}}},
        {seq:3,message:{method:'item/completed',params:{threadId:'s',item:{id:'b',type:'agentMessage',text:'final'}}}},
        {seq:4,message:{method:'item/agentMessage/delta',params:{threadId:'s',itemId:'b',delta:'late'}}}
    ]});
    const state = await view.refresh();
    expect(state.messages.map(m => m.text)).toEqual(['native history','final']);
    await view.close(); expect(client.interrupt).not.toHaveBeenCalled();
});
it('repairs an event gap from native history without appending already recorded deltas', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.eventSnapshot).mockResolvedValue({epoch:'events',cursor:2,gap:true,requests:[],events:[{seq:1,message:{method:'item/agentMessage/delta',params:{threadId:'s',itemId:'a',delta:'duplicate'}}}]});
    const state = await view.refresh(); expect(state.gap).toBe(true); expect(state.messages[0].text).toBe('native history');
});
it('persists mutation identity before creation and blocks replay after reopening an unknown result', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch:'original', load:async () => record, save:async (value: HarnessRecovery) => {record=structuredClone(value);}};
    vi.mocked(client.create).mockImplementation(async (_p,_w,options) => {
        expect(record?.pending?.requestId).toBe(options?.requestId);
        throw {outcome:'unknown',requestId:options?.requestId};
    });
    const first = new HarnessConversation(client, profile, 'p', undefined, true, journal);
    await expect(first.send('task')).rejects.toMatchObject({outcome:'unknown'});
    expect(first.snapshot().pending).toBe(true); expect(record?.draft).toBe('task'); await first.close();
    const next = new HarnessConversation(client, profile, 'p', undefined, true, {...journal,epoch:'replacement'});
    await next.read(); await expect(next.send('task')).rejects.toMatchObject({code:'EBUSY'});
    expect(client.create).toHaveBeenCalledOnce();
    vi.mocked(client.operation).mockResolvedValue({outcome:'committed',requestId:record!.pending!.requestId,result:{session}});
    const confirmed = await next.reconcile(); expect(confirmed.sessionId).toBe('s'); expect(confirmed.pending).toBe(false);
    expect(client.operation).toHaveBeenCalledWith('codex',expect.any(String),expect.objectContaining({epoch:'original'}));
});
it('keeps a successfully committed turn accepted when its history refresh fails', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.read).mockRejectedValueOnce(new Error('history offline'));
    const state = await view.send('task');
    expect(state.disconnected).toBe(false); expect(state.canSend).toBe(false);
    expect(state.observation).toMatchObject({stale: true, refreshError: {stage: 'history', code: 'OBSERVATION_ERROR'}});
    expect(client.turn).toHaveBeenCalledOnce();
});

it('distinguishes projection and inspect failures from network loss and clears recovered errors', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    client.inspect = vi.fn().mockRejectedValueOnce(Object.assign(new Error('bad reply'), {code: 'EIO'}))
        .mockResolvedValue({session: {...session}});
    expect(await view.refresh()).toMatchObject({disconnected: false, observation: {stale: true, refreshError: {stage: 'inspect', code: 'EIO'}}});
    expect((await view.refresh()).observation.refreshError).toBeUndefined();
    vi.mocked(client.eventSnapshot).mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await view.refresh()).disconnected).toBe(true);
    expect((await view.read()).disconnected).toBe(false);
    expect((await view.refresh()).observation.refreshError).toBeUndefined();
    await view.close();
});

it('keeps native process disconnection separate from a healthy empty event response', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.eventSnapshot).mockResolvedValueOnce({epoch:'e',cursor:1,gap:false,requests:[],events:[
        {seq:1,message:{method:'harness/disconnected',params:{threadId:'s'}}}]} );
    expect((await view.refresh()).disconnected).toBe(true);
    vi.mocked(client.eventSnapshot).mockResolvedValue({epoch:'e',cursor:1,gap:false,requests:[],events:[]});
    expect((await view.refresh()).disconnected).toBe(true);
    expect((await view.read()).disconnected).toBe(false);
    await view.close();
});

it('disables native controls after a process disconnect even while its last activity is fresh', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'active', activeTurnId: 't'}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    expect(view.snapshot().canInterrupt).toBe(true);
    vi.mocked(client.eventSnapshot).mockResolvedValue({epoch: 'e', cursor: 1, gap: false, requests: [], events: [
        {seq: 1, message: {method: 'harness/disconnected', params: {threadId: 's'}}}]});
    expect(await view.refresh()).toMatchObject({disconnected: true, canInterrupt: false, canRespond: false, canSend: false, canRename: false});
    await view.close();
});
it('denies sending, interruption and approvals for an attenuated read-only project', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's', false); await view.read();
    expect(view.snapshot()).toMatchObject({canSend:false,canRespond:false,canInterrupt:false});
    await expect(view.send('task')).rejects.toMatchObject({code:'EBUSY'}); await expect(view.respond(1,{decision:'accept'})).rejects.toMatchObject({code:'EACCES'});
    expect(client.turn).not.toHaveBeenCalled(); expect(client.respond).not.toHaveBeenCalled();
});

it('persists unsent input across view closure while keeping native history remote', async () => {
    const client=peer();let record:HarnessRecovery | undefined;
    const journal={epoch:'e',load:async () => record,save:async (value:HarnessRecovery) => {record=structuredClone(value);}};
    const first=new HarnessConversation(client,profile,'p','s',true,journal);await first.read();await first.saveDraft('unsent task');await first.close();
    const next=new HarnessConversation(client,profile,'p','s',true,journal);expect((await next.read()).draft).toBe('unsent task');
    expect(record).not.toHaveProperty('messages');expect(client.turn).not.toHaveBeenCalled();
});

it('loads earlier history by stable native IDs without duplicating the current page',async () => {
    const client=peer();
    vi.mocked(client.read).mockResolvedValueOnce({session,turns:[{items:[{id:'recent',type:'agentMessage',text:'Latest'}]}],nextCursor:'200'});
    const view=new HarnessConversation(client,profile,'p','s');expect((await view.read()).hasEarlier).toBe(true);
    vi.mocked(client.read).mockResolvedValueOnce({session,turns:[{items:[{id:'earlier',type:'userMessage',text:'Earlier'}]}],nextCursor:null});
    const state=await view.loadEarlier();expect(state.messages.map(m=>m.text)).toEqual(['Earlier','Latest']);expect(state.hasEarlier).toBe(false);
    expect(client.read).toHaveBeenLastCalledWith('codex','s',expect.objectContaining({cursor:'200'}));await view.close();
});
it('creates a native branch and recovers an unknown fork without replaying it',async () => {
    const client=peer();client.fork=vi.fn(async () => {throw {outcome:'unknown'};});
    let record:HarnessRecovery | undefined;
    const journal={epoch:'e',load:async()=>record,save:async (value:HarnessRecovery)=>{record=structuredClone(value);}};
    const forkProfile={...profile,capabilities:{...profile.capabilities,fork:true}};
    const view=new HarnessConversation(client,forkProfile,'p','s',true,journal);await view.read();
    expect(view.snapshot()).toMatchObject({canFork: true, forkSupport: 'latest'});await expect(view.fork('Alternative')).rejects.toMatchObject({outcome:'unknown'});
    expect(view.snapshot()).toMatchObject({pending:true,canFork:false});
    const reopened=new HarnessConversation(client,forkProfile,'p','s',true,journal);await reopened.read();
    const branch={...session,id:'branch',parentSessionId:'s'};
    vi.mocked(client.operation).mockResolvedValue({outcome:'committed',requestId:record!.pending!.requestId,result:{session:branch}});
    expect(await reopened.reconcile()).toMatchObject({sessionId:'branch',pending:false,canSend:false});
    expect(client.fork).toHaveBeenCalledOnce();expect(record?.pending).toBeUndefined();
    await view.close();await reopened.close();
});

it.each([true, false])('freezes a historical fork point and reconciles only its exact receipt (verified: %s)', async verified => {
    const client = peer(); client.fork = vi.fn(async () => {throw {outcome: 'unknown'};});
    vi.mocked(client.read).mockResolvedValue({session, turns: [{id: 'old-turn', status: 'completed', items: [{id: 'u-old', type: 'userMessage', content: [{type: 'text', text: 'Old request'}]}]},
        {id: 'new-turn', status: 'completed', items: [{id: 'u-new', type: 'userMessage', content: [{type: 'text', text: 'New request'}]}]}]});
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const capable = {...profile, capabilities: {...profile.capabilities, fork: true, checkpointFork: true}};
    const view = new HarnessConversation(client, capable, 'p', 's', true, journal); await view.read(); await view.saveDraft('Keep my draft');
    expect(view.snapshot().forkSupport).toBe('turn');
    await expect(view.forkAt({messageId: 'u-old', turnId: 'old-turn'})).rejects.toMatchObject({outcome: 'unknown'});
    expect(view.snapshot().canQueue).toBe(false);
    await expect(view.enqueue('Ambiguous next target')).rejects.toMatchObject({code: 'EBUSY'});
    expect(record?.pending?.forkCheckpoint).toEqual({sourceSessionId: 's', turnId: 'old-turn'});
    expect(client.fork).toHaveBeenCalledWith('codex', 's', undefined, expect.objectContaining({lastTurnId: 'old-turn'}));
    const reopened = new HarnessConversation(client, capable, 'p', 's', true, journal); await reopened.read();
    vi.mocked(client.operation).mockResolvedValue({requestId: record!.pending!.requestId, outcome: 'committed', result: {
        session: {...session, id: 'created'}, checkpoint: {sourceSessionId: 's', turnId: verified ? 'old-turn' : 'new-turn', verified: true}}});
    if (verified) expect(await reopened.reconcile()).toMatchObject({sessionId: 'created', pending: false});
    else {
        await expect(reopened.reconcile()).rejects.toMatchObject({outcome: 'committed', remoteCode: 'HARNESS_CHECKPOINT_BOUNDARY_MISMATCH'});
        expect(reopened.snapshot()).toMatchObject({sessionId: 's', pending: false, forkFailure: {sessionId: 'created', verified: false}});
        expect(reopened.snapshot().canQueue).toBe(true);
    }
    expect(record?.pending).toBeUndefined(); expect(record?.lastFork?.sessionId).toBe('created'); expect(record?.sessionId).toBe('s');
    expect(reopened.snapshot().draft).toBe('Keep my draft'); expect(client.fork).toHaveBeenCalledOnce(); expect(client.turn).not.toHaveBeenCalled();
    await view.close(); await reopened.close();
});

it('does not switch native history before the fork receipt is durable', async () => {
    const client = peer(); client.fork = vi.fn(async () => ({session: {...session, id: 'created'}}));
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {
        if (value.lastFork && !value.pending) throw new Error('Receipt storage unavailable'); record = structuredClone(value);
    }};
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, fork: true}}, 'p', 's', true, journal); await view.read();
    await expect(view.fork()).rejects.toMatchObject({outcome: 'unknown'});
    expect(view.snapshot()).toMatchObject({sessionId: 's', pending: true}); expect(record?.pending?.operation).toBe('fork');
    await view.close();
});
it('groups native siblings and nested branches, excluding independent sessions across list pages',async () => {
    const client=peer(),view=new HarnessConversation(client,profile,'p','s');await view.read();
    vi.mocked(client.list).mockResolvedValueOnce({sessions:[session,{...session,id:'branch',parentSessionId:'s'},{...session,id:'other'}],nextCursor:'p2'})
        .mockResolvedValueOnce({sessions:[{...session,id:'nested',parentSessionId:'branch'}],nextCursor:null});
    expect((await view.branches()).map(s=>s.id)).toEqual(['s','branch','nested']);await view.close();
});

it('uses parent links refreshed from listing when the history summary omitted them',async()=>{
    const client=peer();vi.mocked(client.read).mockResolvedValueOnce({session:{...session,id:'child'},turns:[]});
    vi.mocked(client.list).mockResolvedValue({sessions:[session,{...session,id:'child',parentSessionId:'s'}],nextCursor:null});
    const view=new HarnessConversation(client,profile,'p','child');await view.read();
    expect((await view.branches()).map(item=>item.id)).toEqual(['child','s']);await view.close();
});

it('retains native turn identities and compact tool targets while ignoring tool output deltas', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [{id: 'native-turn', items: [
        {id: 'u', type: 'userMessage', content: [{text: 'Inspect files'}]},
        {id: 'reasoning', type: 'reasoning', summary: [{text: 'Check the references'}]},
        {id: 'bash', type: 'commandExecution', command: 'rg pattern .', aggregatedOutput: 'file.ts', status: 'completed'},
        {id: 'a', type: 'agentMessage', text: 'Found files'},
    ]}]});
    const view = new HarnessConversation(client, profile, 'p', 's'); const initial = await view.read();
    expect(initial.messages.map(message => message.turnId)).toEqual(['native-turn', 'native-turn', 'native-turn', 'native-turn']);
    expect(initial.messages[1]).toMatchObject({role: 'system', text: 'Check the references'});
    expect(initial.messages[2]).toMatchObject({name: 'commandExecution', paths: ['.'], operation: 'search'});
    expect(initial.messages[2]).not.toHaveProperty('input'); expect(initial.messages[2].text).not.toContain('file.ts');
    vi.mocked(client.eventSnapshot).mockResolvedValueOnce({epoch: 'events', cursor: 2, gap: false, requests: [], events: [
        {seq: 1, message: {method: 'item/started', params: {threadId: 's', turnId: 'next-turn', item: {id: 'live-tool', type: 'commandExecution', command: 'pwd', aggregatedOutput: 'starting', status: 'inProgress'}}}},
        {seq: 2, message: {method: 'item/commandExecution/outputDelta', params: {threadId: 's', turnId: 'next-turn', itemId: 'live-tool', delta: '\n/project'}}},
    ]});
    const current = await view.refresh();
    expect(current.messages.find(message => message.id === 'live-tool')).toMatchObject({turnId: 'next-turn', text: 'commandExecution', operation: 'execute'});
    expect(client.read).toHaveBeenCalledWith('codex', 's', expect.objectContaining({toolDetail: 'summary'}));
    expect(client.eventSnapshot).toHaveBeenCalledWith('codex', undefined, expect.objectContaining({toolDetail: 'summary'}));
    await view.close();
});

it('preserves every request and response in native content arrays with real times and turn IDs', () => {
    const messages = historyMessages({session, turns: [{id: 'rollout-history', items: [
        {id: 'u', turnId: 't1', type: 'userMessage', timestamp: '2026-10-08T11:22:45Z', content: [{text: 'Request one'}, [{text: 'Request two'}, {content: [{text: 'Request three'}]}]]},
        {id: 'a1', turnId: 't1', type: 'agentMessage', timestamp: 1791458566, content: [{text: 'Answer one'}, {text: 'Answer two'}]},
        {id: 'a2', turnId: 't1', type: 'agentMessage', timestamp: 1791458567000, text: 'Answer three'},
        {id: 'u2', turnId: 't2', type: 'userMessage', content: [{text: 'Next request'}]},
    ]}]});
    expect(messages.map(message => message.text)).toEqual(['Request one\nRequest two\nRequest three', 'Answer one\nAnswer two', 'Answer three', 'Next request']);
    expect(messages[0].contentParts).toEqual(['Request one', 'Request two', 'Request three']);
    expect(messages[1]).not.toHaveProperty('contentParts');
    expect(messages.map(message => message.turnId)).toEqual(['t1', 't1', 't1', 't2']);
    expect(messages.map(message => message.timestamp)).toEqual([1791458565000, 1791458566000, 1791458567000, undefined]);
});

it('keeps explicit context provenance aligned with every flattened native text part', () => {
    const [message] = historyMessages({session, turns: [{id: 't', items: [{id: 'u', type: 'userMessage',
        content: [{text: '# AGENTS.md instructions'}, {content: [{text: 'first request'}, {text: 'second request'}]}],
        contentItemKinds: ['agents_md.instructions', 'user.text']}]}]});
    expect(message.contentParts).toEqual(['# AGENTS.md instructions', 'first request', 'second request']);
    expect(message.contentPartKinds).toEqual(['agents_md.instructions', 'user.text', 'user.text']);
    expect(message.text).toBe('# AGENTS.md instructions\nfirst request\nsecond request');
});
it('ignores absent or misaligned provenance without inferring context from prompt contents', () => {
    for (const kinds of [undefined, [], ['agents_md.instructions', 'user.text'], [1]]) {
        const [message] = historyMessages({session, turns: [{items: [{id: 'u', type: 'userMessage',
            content: [{text: '<environment_context>literal user request</environment_context>'}], contentItemKinds: kinds}]}]});
        expect(message.contentPartKinds).toBeUndefined();
        expect(message.text).toContain('literal user request');
    }
});

it('keeps loaded earlier history during refresh without silently discarding messages above the old budget', async () => {
    const client = peer(), text = 'x'.repeat(90_000);
    const page = (start: number) => Array.from({length: 20}, (_, index) => ({id: String(start + index), type: 'agentMessage', text}));
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [{items: page(20)}], nextCursor: 'earlier'})
        .mockResolvedValueOnce({session, turns: [{items: [...page(0), page(20)[0]]}], nextCursor: null})
        .mockResolvedValueOnce({session, turns: [{items: [...page(20), {id: 'new', type: 'agentMessage', text: 'Latest'}]}], nextCursor: 'earlier'});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    expect((await view.loadEarlier()).messages).toHaveLength(40);
    const refreshed = await view.read();
    expect(refreshed.messages).toHaveLength(41); expect(refreshed.messages[0].id).toBe('0');
    expect(refreshed.messages.at(-1)?.text).toBe('Latest'); expect(refreshed.hasEarlier).toBe(false);
    await view.close();
});

it('reports capacity overflow explicitly and preserves the existing history and paging cursor', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [{items: [{id: 'latest', type: 'agentMessage', text: 'Latest'}]}], nextCursor: 'earlier'})
        .mockResolvedValueOnce({session, turns: [{items: Array.from({length: 10_000}, (_, index) => ({id: String(index), type: 'agentMessage', text: 'Earlier'}))}], nextCursor: null});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    await expect(view.loadEarlier()).rejects.toMatchObject({code: 'EFBIG'});
    expect(view.snapshot().messages.map(message => message.text)).toEqual(['Latest']); expect(view.snapshot().hasEarlier).toBe(true);
    await view.close();
});

it('places backfilled native items before newer streamed items using their recorded timestamps', () => {
    const first = [{id: 'one', role: 'assistant' as const, text: 'First', timestamp: 1000}, {id: 'three', role: 'assistant' as const, text: 'Live', timestamp: 3000}];
    const second = [{...first[0], text: 'Final first'}, {id: 'two', role: 'tool' as const, text: 'Tool', timestamp: 2000}];
    expect(mergeMessages(first, second).map(message => message.text)).toEqual(['Final first', 'Tool', 'Live']);
    expect(mergeMessages(first.map(message => ({...message, timestamp: undefined})), second.map(message => ({...message, timestamp: undefined}))).map(message => message.text)).toEqual(['Final first', 'Live', 'Tool']);
});

it('summarizes declared tool targets without showing unrelated command content or search patterns', () => {
    for (const command of ['curl -H Authorization:Bearer.header.value https://example.com', 'node -e private.code.value', 'echo private.code.value']) {
        expect(toolSummary({command}, 'commandExecution').paths).toEqual([]);
    }
    expect(toolSummary({command: 'rg pattern.ts src/main.ts'}, 'commandExecution').paths).toEqual(['src/main.ts']);
    expect(toolSummary({command: 'cat "src/my file.ts"'}, 'commandExecution').paths).toEqual([]);
    expect(toolSummary({changes: [{path: 'src/my file.ts', diff: 'private patch'}]}, 'fileChange')).toMatchObject({paths: ['src/my file.ts'], operation: 'write'});
});
it('retains only the first command line and declared files when compacting exec tools', () => {
    const native = {type: 'toolCall', name: 'exec', arguments: JSON.stringify({cmd: '\n pnpm typecheck \ncat private-output', workdir: '/project'})};
    const summary = toolSummary(native, 'toolCall');
    expect(summary).toMatchObject({commandPreview: 'pnpm typecheck', paths: ['/project'], operation: 'execute'});
    expect(toolSummary(summary, 'toolCall')).toEqual(summary);
    expect(JSON.stringify(summary)).not.toContain('private-output');
    expect(toolSummary({command: 'x'.repeat(300)}, 'commandExecution').commandPreview).toHaveLength(241);
    expect(toolSummary({name: 'exec', input: 'await tools.exec_command({cmd: "pnpm build"})\n// second line'}, 'toolCall').commandPreview)
        .toBe('await tools.exec_command({cmd: "pnpm build"})');
});
it('rejects cyclic history cursors without overwriting already loaded history', async () => {
    const client = peer();
    vi.mocked(client.read).mockResolvedValueOnce({session, turns: [], nextCursor: 'first'})
        .mockResolvedValueOnce({session, turns: [{items: [{id: 'middle', type: 'agentMessage', text: 'Middle'}]}], nextCursor: 'second'})
        .mockResolvedValueOnce({session, turns: [], nextCursor: 'first'});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read(); await view.loadEarlier();
    await expect(view.loadEarlier()).rejects.toMatchObject({code: 'EIO'});
    expect(view.snapshot().messages.map(message => message.text)).toEqual(['Middle']);
    expect(view.snapshot().hasEarlier).toBe(true); await view.close();
});

it('renames and archives native metadata through receipts without resuming or sending', async () => {
    const client = peer(), managed = {...profile, capabilities: {...profile.capabilities, rename: true, archive: true, unarchive: true}};
    client.rename = vi.fn(async (_p, _s, name) => ({session: {...session, title: name}}));
    client.archive = vi.fn(async (_p, _s, archived) => ({session: {...session, archived, owned: false}}));
    const view = new HarnessConversation(client, managed, 'p', 's'); await view.read();
    expect((await view.rename('Native name')).title).toBe('Native name');
    expect((await view.archive(true))).toMatchObject({archived: true, canSend: false, canUnarchive: true});
    expect((await view.archive(false))).toMatchObject({archived: false, canArchive: false});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});
it('persists unknown native management outcomes and prevents mutation replay after reopening', async () => {
    const client = peer(), managed = {...profile, capabilities: {...profile.capabilities, rename: true}};
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (next: HarnessRecovery) => {record = structuredClone(next);}};
    client.rename = vi.fn(async () => {throw {outcome: 'unknown'};});
    const first = new HarnessConversation(client, managed, 'p', 's', true, journal); await first.read();
    await expect(first.rename('Saved elsewhere')).rejects.toMatchObject({outcome: 'unknown'}); await first.close();
    const next = new HarnessConversation(client, managed, 'p', 's', true, journal); await next.read();
    await expect(next.rename('Saved elsewhere')).rejects.toMatchObject({code: 'EACCES'});
    expect(client.rename).toHaveBeenCalledOnce();
    vi.mocked(client.operation).mockResolvedValue({requestId: record!.pending!.requestId, outcome: 'committed', result: {session: {...session, title: 'Saved elsewhere'}}});
    vi.mocked(client.read).mockResolvedValue({session: {...session, title: 'Saved elsewhere'}, turns: []});
    expect((await next.reconcile()).pending).toBe(false); await next.close();
});
it('denies metadata mutations on read-only, unsupported, busy and unowned archive targets', async () => {
    const client = peer(), managed = {...profile, capabilities: {...profile.capabilities, rename: true, archive: true}};
    client.rename = vi.fn(); client.archive = vi.fn();
    const readonly = new HarnessConversation(client, managed, 'p', 's', false); await readonly.read();
    await expect(readonly.rename('Denied')).rejects.toMatchObject({code: 'EACCES'});
    await expect(readonly.archive(true)).rejects.toMatchObject({code: 'EACCES'});
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'idle', owned: false}, turns: []});
    const external = new HarnessConversation(client, managed, 'p', 's'); await external.read();
    await expect(external.archive(true)).rejects.toMatchObject({code: 'EACCES'});
    expect(client.archive).not.toHaveBeenCalled(); await readonly.close(); await external.close();
});
it('uses native archive eligibility for idle unowned sessions without resuming them', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, archive: true}};
    vi.mocked(client.read).mockResolvedValue({session: {...session, owned: false, archiveAllowed: true}, turns: []});
    client.archive = vi.fn(async () => ({session: {...session, owned: false, archived: true, archiveAllowed: false}}));
    const view = new HarnessConversation(client, capable, 'p', 's');
    expect(await view.read()).toMatchObject({canArchive: true});
    expect(await view.archive(true)).toMatchObject({archived: true, canArchive: false});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled();
    await view.close();
});

it('preserves attachment drafts through closure and unknown receipts without replaying a native turn', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const capable = {...profile, capabilities: {...profile.capabilities, attachments: ['text' as const]}};
    const attachments = [{kind: 'text' as const, name: 'notes.md', content: 'quoted "text"\n中文'}];
    const first = new HarnessConversation(client, capable, 'p', 's', true, journal);
    await first.saveDraft('Review', attachments); await first.close();
    const next = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect((await next.read()).draftAttachments).toEqual(attachments);
    vi.mocked(client.turn).mockRejectedValueOnce({outcome: 'unknown'});
    await expect(next.send('Review', attachments)).rejects.toMatchObject({outcome: 'unknown'});
    expect(record?.draftAttachments).toEqual(attachments);
    await expect(next.send('Review', attachments)).rejects.toMatchObject({code: 'EBUSY'});
    vi.mocked(client.operation).mockResolvedValue({outcome: 'committed', requestId: record!.pending!.requestId, result: {turnId: 't'}});
    expect((await next.reconcile()).draftAttachments).toEqual([]); expect(record?.draft).toBe('');
    expect(client.turn).toHaveBeenCalledOnce(); await next.close();
});

it('commits draft consumption atomically with the turn receipt and retains the receipt when saving fails', async () => {
    const client = peer(); let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {
        if (record?.pending && !value.pending) throw new Error('draft acknowledgement failed');
        record = structuredClone(value);
    }};
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    await expect(view.send('Task')).rejects.toThrow('draft acknowledgement failed');
    expect(view.snapshot().pending).toBe(true); expect(record?.pending?.operation).toBe('turn');
    await expect(view.send('Task')).rejects.toMatchObject({code: 'EBUSY'}); expect(client.turn).toHaveBeenCalledOnce();
    await view.close();
});

it('rejects invalid attachment drafts before persisting receipts or starting a native turn', async () => {
    const client = peer(), view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, attachments: ['text', 'image']}}, 'p', 's');
    await view.read();
    await expect(view.send('Review', [{kind: 'image', name: 'image.png', mimeType: 'image/png', content: 'http://localhost/private'}])).rejects.toMatchObject({code: 'EINVAL'});
    await expect(view.saveDraft('Review', [{kind: 'text', name: 'notes', content: 'x'.repeat(65537)}])).rejects.toMatchObject({code: 'EINVAL'});
    expect(client.turn).not.toHaveBeenCalled(); expect(view.snapshot().pending).toBe(false); await view.close();
});

it('recovers permanent deletion from the receipt before reading missing history and never replays it', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, delete: true}};
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    client.delete = vi.fn(async () => {throw {outcome: 'unknown'};});
    const first = new HarnessConversation(client, capable, 'p', 's', true, journal); await first.read();
    await expect(first.delete()).rejects.toMatchObject({outcome: 'unknown'}); await first.close();
    vi.mocked(client.read).mockRejectedValue(new Error('History permanently deleted'));
    vi.mocked(client.operation).mockResolvedValue({requestId: record!.pending!.requestId, outcome: 'committed', result: {deletedSessionIds: ['s', 'child']}});
    const restored = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect(await restored.read()).toMatchObject({deletedSessionIds: ['s', 'child'], pending: false, canSend: false, canDelete: false, messages: []});
    expect(client.read).toHaveBeenCalledOnce(); expect(client.delete).toHaveBeenCalledOnce();
    expect(record!.deletedSessionIds).toEqual(['s', 'child']); await restored.close();
    const reopened = new HarnessConversation(client, capable, 'p', 's', true, journal);
    expect((await reopened.read()).deletedSessionIds).toEqual(['s', 'child']);
    expect(client.read).toHaveBeenCalledOnce(); await reopened.close();
});
it('deletes only idle owned or archived unloaded sessions with a writable native capability', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, delete: true}};
    client.delete = vi.fn(async () => ({deletedSessionIds: ['s']}));
    for (const state of [{status: 'active', owned: true}, {status: 'notLoaded', owned: false}, {status: 'idle', owned: false}]) {
        vi.mocked(client.read).mockResolvedValue({session: {...session, ...state}, turns: []});
        const view = new HarnessConversation(client, capable, 'p', 's'); await view.read();
        await expect(view.delete()).rejects.toMatchObject({code: 'EACCES'}); await view.close();
    }
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'notLoaded', owned: false, archived: true}, turns: []});
    const readonly = new HarnessConversation(client, capable, 'p', 's', false); await readonly.read();
    await expect(readonly.delete()).rejects.toMatchObject({code: 'EACCES'}); await readonly.close();
    const view = new HarnessConversation(client, capable, 'p', 's'); await view.read();
    expect((await view.delete()).deletedSessionIds).toEqual(['s']); expect(client.resume).not.toHaveBeenCalled(); await view.close();
});

it('archives unloaded native history without acquiring ownership or claiming external inactivity', async () => {
    const client = peer(), capable = {...profile, capabilities: {...profile.capabilities, archive: true}};
    vi.mocked(client.read).mockResolvedValue({session: {...session, status: 'notLoaded', owned: false}, turns: []});
    client.archive = vi.fn(async () => ({session: {...session, status: 'notLoaded', owned: false, archived: true}}));
    const view = new HarnessConversation(client, capable, 'p', 's');
    expect(await view.read()).toMatchObject({canArchive: true, observation: {execution: 'unknown', rawStatus: 'notLoaded'}});
    expect(await view.archive(true)).toMatchObject({archived: true, canSend: false});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});


it('exposes the committed turn identity even before its native history echo is available', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    const accepted = await view.send('pending echo');
    expect(accepted.submittedTurnId).toBe('t'); expect(client.turn).toHaveBeenCalledOnce();
    expect((await view.read()).submittedTurnId).toBe('t'); await view.close();
});

it('retains input and never starts a turn when another native writer prevents resuming', async () => {
    const client = peer(); vi.mocked(client.read).mockResolvedValue({session: {...session, owned: false}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.resume).mockRejectedValue(Object.assign(new Error('HARNESS_SESSION_BUSY'), {outcome: 'not-committed'}));
    await expect(view.send('keep input')).rejects.toThrow('HARNESS_SESSION_BUSY');
    expect(view.snapshot()).toMatchObject({pending: false, draft: 'keep input', submittedTurnId: undefined});
    expect(client.turn).not.toHaveBeenCalled(); await view.close();
});

it.each(['send', 'command'] as const)('rejects a %s submission when read-only preparation fails before dispatch', async operation => {
    const client = peer();
    client.inspect = vi.fn(async () => {throw new TypeError('Load failed');});
    client.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action' as const}]);
    client.command = vi.fn();
    let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    const source = {...profile, capabilities: {...profile.capabilities, slashCommands: true}};
    const view = new HarnessConversation(client, source, 'p', 's', true, journal); await view.read();
    const result = operation === 'send' ? view.send('Keep input', [], undefined, 'before-dispatch')
        : view.command('compact', '', undefined, '/compact', 'before-dispatch');
    await expect(result).rejects.toMatchObject({outcome: 'not-committed'});
    expect(saved).toMatchObject({submission: {id: 'before-dispatch', status: 'rejected'}});
    expect(view.snapshot()).toMatchObject({pending: false, canSend: true});
    expect(client.turn).not.toHaveBeenCalled(); expect(client.command).not.toHaveBeenCalled();
    await view.close();
    const reopened = new HarnessConversation(client, source, 'p', 's', true, journal);
    expect((await reopened.read()).submission).toMatchObject({status: 'rejected'}); await reopened.close();
});

it.each(['send', 'command'] as const)('reports initial history failure before %s as not committed', async operation => {
    const client = peer(); vi.mocked(client.read).mockRejectedValue(new TypeError('Load failed'));
    const view = new HarnessConversation(client, profile, 'p', 's');
    const result = operation === 'send' ? view.send('Keep input', [], undefined, 'before-read')
        : view.command('compact', '', undefined, '/compact', 'before-read');
    await expect(result).rejects.toMatchObject({outcome: 'not-committed'});
    expect(client.resume).not.toHaveBeenCalled(); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});

it('recovers a rejected preparation receipt with its native error without dispatching the prompt', async () => {
    const client = peer(); vi.mocked(client.read).mockResolvedValue({session: {...session, owned: false}, turns: []});
    let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    vi.mocked(client.resume).mockRejectedValue(Object.assign(new Error('Load failed'), {outcome: 'unknown'}));
    await expect(view.send('Keep input', [], undefined, 'prompt-id')).rejects.toThrow('Load failed');
    const requestId = saved!.pending!.requestId;
    vi.mocked(client.operation).mockResolvedValue({requestId, outcome: 'not-committed', code: 'HARNESS_SESSION_BUSY'});
    expect((await view.reconcile('prompt-id')).submission).toEqual({id: 'prompt-id', status: 'rejected', code: 'HARNESS_SESSION_BUSY'});
    expect(client.turn).not.toHaveBeenCalled(); await view.close();
});

it.each(['missing', 'throws'])('creates and sends a native conversation through internal request IDs when UUID %s', async mode => {
    const original = globalThis.crypto;
    vi.stubGlobal('crypto', {getRandomValues: original.getRandomValues.bind(original),
        ...(mode === 'throws' ? {randomUUID: () => {throw new Error('Native UUID unavailable');}} : {})});
    const client = peer(), view = new HarnessConversation(client, profile, 'p');
    try {
        await view.send('Compatible native send'); expect(client.create).toHaveBeenCalledOnce(); expect(client.turn).toHaveBeenCalledOnce();
        expect(vi.mocked(client.create).mock.calls[0][2]?.requestId).toMatch(/^[\da-f]{8}-[\da-f-]{27}$/i);
    } finally {await view.close(); vi.unstubAllGlobals();}
});

it('restores a committed turn receipt after the view closes before composer cleanup', async () => {
    let record: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => record, save: async (value: HarnessRecovery) => {record = structuredClone(value);}};
    const client = peer(), first = new HarnessConversation(client, profile, 'p', 's', true, journal);
    await first.read(); const submitted = await first.send('Persist this');
    expect(submitted.submittedTurnId).toBeDefined(); expect(record!.submittedTurnId).toBe(submitted.submittedTurnId); await first.close();
    const reopened = new HarnessConversation(peer(), profile, 'p', 's', true, journal);
    expect((await reopened.read()).submittedTurnId).toBe(submitted.submittedTurnId); await reopened.close();
});

it('persists the caller submission identity through an unknown turn and exact receipt reconciliation', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    client.turn = vi.fn(async () => {throw Object.assign(new Error('Lost response'), {outcome: 'unknown'});});
    const first = new HarnessConversation(client, profile, 'p', 's', true, journal); await first.read();
    await expect(first.send('Prompt', [], undefined, 'submission-1')).rejects.toThrow('Lost response');
    expect(client.turn).toHaveBeenCalledWith('codex', 's', 'Prompt', expect.objectContaining({requestId: 'submission-1'}));
    expect(saved?.submission).toEqual({id: 'submission-1', status: 'pending'}); await first.close();
    const reopened = new HarnessConversation(client, profile, 'p', 's', true, journal); await reopened.read();
    vi.mocked(client.operation).mockResolvedValue({requestId: 'submission-1', outcome: 'committed', result: {turnId: 'confirmed'}});
    expect((await reopened.reconcile()).submission).toEqual({id: 'submission-1', status: 'accepted', turnId: 'confirmed'});
    await expect(reopened.send('Prompt', [], undefined, 'submission-1')).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(client.turn).toHaveBeenCalledOnce(); await reopened.close();
});
it('records a rejected submission when its native receipt proves it was not committed', async () => {
    const client = peer();
    client.turn = vi.fn(async () => {throw Object.assign(new Error('Rejected'), {outcome: 'not-committed'});});
    const view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    await expect(view.send('Prompt', [], undefined, 'submission-1')).rejects.toThrow('Rejected');
    expect(view.snapshot().submission).toEqual({id: 'submission-1', status: 'rejected'}); await view.close();
});
it('keeps action command acceptance correlated even when no turn is created', async () => {
    const client = peer();
    client.commands = vi.fn(async () => [{name: 'compact', description: 'Compact', kind: 'action'}]);
    client.command = vi.fn(async () => ({commandId: 'compact-1', output: 'Done'}));
    const view = new HarnessConversation(client, {...profile, capabilities: {...profile.capabilities, slashCommands: true}}, 'p', 's');
    await view.read(); const result = await view.command('compact', '', undefined, '/compact', 'submission-1');
    expect(result.submission).toMatchObject({id: 'submission-1', status: 'accepted'});
    expect(client.command).toHaveBeenCalledWith('codex', 's', 'compact', '', expect.objectContaining({requestId: 'submission-1'}));
    await view.close();
});

it('queries a frozen submission after a crash before the driver recorded any pending request', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.operation).mockResolvedValue({requestId: 'frozen-before-send', outcome: 'not-committed'});
    expect((await view.reconcile('frozen-before-send')).submission).toMatchObject({id: 'frozen-before-send', status: 'rejected'});
    expect(client.turn).not.toHaveBeenCalled(); await view.close();
});
it('keeps unknown frozen submissions unresolved and refuses unrelated receipt identities', async () => {
    const client = peer(), view = new HarnessConversation(client, profile, 'p', 's'); await view.read();
    vi.mocked(client.operation).mockResolvedValue({requestId: 'frozen', outcome: 'unknown'});
    expect((await view.reconcile('frozen')).submission).toBeUndefined();
    vi.mocked(client.operation).mockResolvedValue({requestId: 'unrelated', outcome: 'committed', result: {turnId: 'other'}});
    await expect(view.reconcile('frozen')).rejects.toMatchObject({code: 'EIO'});
    expect(view.snapshot().submission).toBeUndefined(); expect(client.turn).not.toHaveBeenCalled(); await view.close();
});


it('reacquires a reclaimed observation on the same native session before dispatching queued input', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal);
    await view.read();
    client.inspect = vi.fn(async () => ({session: {...session, owned: false}}));
    await view.enqueue('Continue the existing work', [], undefined, 'after-reclaim');
    await view.refresh();
    expect(client.resume).toHaveBeenCalledWith('codex', 's', expect.objectContaining({requestId: expect.any(String)}));
    expect(client.create).not.toHaveBeenCalled();
    expect(client.turn).toHaveBeenCalledWith('codex', 's', 'Continue the existing work', expect.any(Object));
    expect(vi.mocked(client.resume).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(client.turn).mock.invocationCallOrder[0]);
    expect(saved?.instructionQueue?.items[0]?.id).toBe('after-reclaim');
    await view.close();
});

it('interrupts a confirmed turn while the original send reply hangs without replacing input recovery', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined, finish!: (value: {turnId: string}) => void;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    client.turn = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    let events: Array<{seq: number; message: {method: string; params: Record<string, unknown>}}> = [];
    client.eventSnapshot = vi.fn(async () => ({epoch: 'events', cursor: events.at(-1)?.seq ?? 0, gap: false, requests: [], events}));
    vi.mocked(client.read).mockResolvedValue({session: {...session, interruptible: false}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    const sending = view.send('Original', [], undefined, 'original-send');
    await vi.waitFor(() => expect(client.turn).toHaveBeenCalledOnce());
    await view.saveDraft('Keep newer input'); await view.enqueue('Queued next', [], undefined, 'next');
    events = [{seq: 1, message: {method: 'turn/started', params: {threadId: 's', turn: {id: 'owned'}}}}];
    await view.refresh(); expect(view.snapshot().canInterrupt).toBe(true);
    await view.interrupt({sessionId: 's', turnId: 'owned', operationId: 'stop-original'});
    expect(client.interrupt).toHaveBeenCalledWith('codex', 's', 'owned', expect.objectContaining({requestId: 'stop-original', epoch: 'e'}));
    expect(saved).toMatchObject({pending: {requestId: 'original-send', operation: 'turn'}, draft: 'Keep newer input', instructionQueue: {paused: false}, controls: [{requestId: 'stop-original', receipt: 'accepted'}]});
    expect(view.snapshot().canSend).toBe(false);
    events = [{seq: 2, message: {method: 'turn/completed', params: {threadId: 's', turn: {id: 'owned', status: 'completed'}}}}];
    vi.mocked(client.read).mockResolvedValue({session: {...session, lastTurnId: 'owned', lastTurnResult: 'completed'}, turns: [{id: 'owned', status: 'completed', items: []}]});
    await view.refresh();
    finish({turnId: 'owned'}); await sending;
    expect(saved?.controls?.[0]).toMatchObject({receipt: 'accepted', terminal: 'completed'});
    expect(view.snapshot()).toMatchObject({draft: 'Keep newer input', canInterrupt: false});
    await view.interrupt({sessionId: 's', turnId: 'owned', operationId: 'stop-original'});
    await expect(view.interrupt({sessionId: 's', turnId: 'other', operationId: 'stop-original'})).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(client.interrupt).toHaveBeenCalledOnce();
    expect(client.turn).toHaveBeenCalledOnce(); await view.close();
});

it('restores an unknown control independently and never resends it after reopen', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    vi.mocked(client.read).mockResolvedValue({session: {...session, activeTurnId: 't', status: 'active'}, turns: []});
    client.interrupt = vi.fn(async () => {throw Object.assign(new Error('lost acknowledgement'), {outcome: 'unknown'});});
    client.operation = vi.fn(async (_profile, id) => ({requestId: id, outcome: 'unknown'}));
    const first = new HarnessConversation(client, profile, 'p', 's', true, journal); await first.read();
    await expect(first.interrupt({sessionId: 's', turnId: 't', operationId: 'persisted-stop'})).rejects.toThrow();
    await first.saveDraft('Retain draft'); expect(saved?.pending).toBeUndefined(); await first.close();
    vi.mocked(client.read).mockResolvedValue({session: {...session, lastTurnId: 't', lastTurnResult: 'completed'}, turns: []});
    const next = new HarnessConversation(client, profile, 'p', 's', true, {...journal, epoch: 'different-current-epoch'});
    expect(await next.read()).toMatchObject({pending: true, canSend: false, controls: [{receipt: 'unknown', effect: 'completed'}]});
    client.operation = vi.fn(async (_profile, id) => ({requestId: id, outcome: 'committed', result: {}}));
    expect(await next.reconcileControl('persisted-stop')).toMatchObject({pending: false, canSend: true, draft: 'Retain draft', controls: [{receipt: 'accepted', effect: 'completed'}]});
    expect(client.operation).toHaveBeenCalledWith('codex', 'persisted-stop', expect.objectContaining({epoch: 'e'}));
    expect(client.interrupt).toHaveBeenCalledOnce(); await next.close();
});

it('retains uncertain control settlement after storage failure and refuses mismatched receipts', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined, writes = 0;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {if (++writes === 2) throw new Error('receipt write failed'); saved = structuredClone(record);}};
    vi.mocked(client.read).mockResolvedValue({session: {...session, activeTurnId: 't', status: 'active'}, turns: []});
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    await expect(view.interrupt({sessionId: 's', turnId: 't', operationId: 'storage-stop'})).rejects.toThrow('receipt write failed');
    expect(saved?.controls?.[0].receipt).toBe('pending'); expect(view.snapshot().controls?.[0].receipt).toBe('unknown');
    client.operation = vi.fn(async (_profile, id) => ({requestId: id, outcome: 'unknown'}));
    await view.close();
    const reopened = new HarnessConversation(client, profile, 'p', 's', true, journal); await reopened.read();
    client.operation = vi.fn(async () => ({requestId: 'wrong', outcome: 'committed', result: {}}));
    await expect(reopened.reconcileControl('storage-stop')).rejects.toMatchObject({code: 'EIO'});
    client.operation = vi.fn(async (_profile, id) => ({requestId: id, outcome: 'committed', result: {}}));
    expect(await reopened.reconcileControl('storage-stop')).toMatchObject({controls: [{receipt: 'accepted', effect: 'unconfirmed'}], canSend: false});
    expect(client.interrupt).toHaveBeenCalledOnce(); await reopened.close();
});

it('allows enqueue and queue pause while its claimed native submission reply hangs', async () => {
    const client = peer(); let saved: HarnessRecovery | undefined, finish!: (value: {turnId: string}) => void;
    const journal = {epoch: 'e', load: async () => saved, save: async (record: HarnessRecovery) => {saved = structuredClone(record);}};
    client.turn = vi.fn(() => new Promise(resolve => {finish = resolve;}));
    const view = new HarnessConversation(client, profile, 'p', 's', true, journal); await view.read();
    await view.enqueue('First', [], undefined, 'first-unlocked');
    const pumping = view.refresh(); await vi.waitFor(() => expect(client.turn).toHaveBeenCalledOnce());
    await view.enqueue('Second', [], undefined, 'second-unlocked');
    let queue = view.snapshot().instructionQueue!;
    await view.editInstructionQueue({action: 'update', id: 'second-unlocked', text: 'Revised second', expectedRevision: queue.revision});
    queue = view.snapshot().instructionQueue!;
    await view.editInstructionQueue({action: 'pause', expectedRevision: queue.revision});
    expect(saved?.instructionQueue).toMatchObject({paused: true, items: [{id: 'first-unlocked', state: 'dispatching'}, {id: 'second-unlocked', text: 'Revised second'}]});
    finish({turnId: 'original'}); await pumping;
    expect(saved?.instructionQueue).toMatchObject({paused: true, items: [{id: 'first-unlocked', receipt: {turnId: 'original'}}, {id: 'second-unlocked', text: 'Revised second'}]});
    expect(client.turn).toHaveBeenCalledOnce(); await view.close();
});
