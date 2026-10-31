import {expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile, HarnessSession} from '../src/harness/contracts';
import type {HarnessRecovery} from '../src/harness/conversation-journal';

async function fixture() {
    const profile: HarnessProfile = {id: 'codex', kind: 'codex', workspaces: [{id: 'project'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true}};
    const session: HarnessSession = {id: 'native', title: 'Native', cwd: '/project', status: 'active', activeTurnId: 'old-turn', updatedAt: 1, resumable: true, owned: true};
    let record: HarnessRecovery = {sessionId: 'native', instructionQueue: {revision: 2, paused: false, receipts: [{id: 'first', input: 'a'.repeat(64), turnId: 'old-turn'}],
        items: [{id: 'first', text: 'Original', attachments: [], createdAt: Date.now(), state: 'dispatching', receipt: {turnId: 'old-turn'}}]}};
    const client: HarnessClient = {profiles: vi.fn(async () => ({epoch: 'epoch', profiles: [profile]})), read: vi.fn(async () => ({session, turns: []})),
        inspect: vi.fn(async () => ({session: {...session, status: 'idle', activeTurnId: null, lastTurnId: 'old-turn'} })),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []})), subscribe: () => () => {},
        list: vi.fn(), create: vi.fn(), resume: vi.fn(), turn: vi.fn(), interrupt: vi.fn(), respond: vi.fn(), operation: vi.fn(), close: vi.fn()};
    const view = new HarnessConversation(client, profile, 'project', 'native', true, {epoch: 'epoch', load: async () => record, save: async next => {record = structuredClone(next);}});
    await view.read(); return {client, view, session, saved: () => record};
}

it('settles an admitted turn from exact inspection evidence when its completion event was missed', async () => {
    const f = await fixture();
    vi.mocked(f.client.inspect!).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null, lastTurnId: 'old-turn', lastTurnResult: 'completed'}});
    try {await f.view.refresh(); expect(f.view.snapshot().instructionQueue!.items).toEqual([]); expect(f.client.turn).not.toHaveBeenCalled();}
    finally {await f.view.close();}
});

it.each([true, false])('checks native history when an idle queue lacks terminal evidence (confirmed: %s)', async confirmed => {
    const f = await fixture();
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null},
        turns: confirmed ? [{id: 'old-turn', status: 'completed', items: []}] : []});
    try {
        await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);
        expect(f.view.snapshot().instructionQueue!.items).toHaveLength(confirmed ? 0 : 1);
        if (!confirmed) {expect(f.view.snapshot().instructionQueue!.reason).toBe('terminal-unconfirmed');
            await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);}
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('recovers an idle queued turn from native history even without an inspection capability', async () => {
    const f = await fixture(); f.client.inspect = undefined;
    vi.mocked(f.client.eventSnapshot).mockResolvedValue({epoch: 'events', cursor: 1, gap: false, requests: [],
        events: [{seq: 1, message: {method: 'thread/status/changed', params: {threadId: 'native', status: {type: 'idle'}}}}]});
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null}, turns: [{id: 'old-turn', status: 'completed', items: []}]});
    try {await f.view.refresh(); expect(f.view.snapshot().instructionQueue!.items).toEqual([]); expect(f.client.turn).not.toHaveBeenCalled();}
    finally {await f.view.close();}
});

it('does not unblock the queue using another turn completion', async () => {
    const f = await fixture(), another = {...f.session, status: 'idle', activeTurnId: null, lastTurnId: 'another-turn', lastTurnResult: 'completed' as const};
    vi.mocked(f.client.inspect!).mockResolvedValue({session: another});
    vi.mocked(f.client.read).mockResolvedValue({session: another, turns: [{id: 'another-turn', status: 'completed', items: []}]});
    try {
        await f.view.refresh(); expect(f.view.snapshot().instructionQueue!.items[0].id).toBe('first');
        expect(f.view.snapshot().instructionQueue!.reason).toBe('terminal-unconfirmed'); expect(f.client.turn).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});
