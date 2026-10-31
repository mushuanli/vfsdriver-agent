import {afterEach, expect, it, vi} from 'vitest';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile} from '../src/harness/contracts';

afterEach(() => vi.restoreAllMocks());
async function fixture(owned = false) {
    let revision = 'a'.repeat(64), now = 100_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const session = () => ({id: 'session', title: '', cwd: null, updatedAt: null, resumable: true,
        status: owned ? 'idle' : 'notLoaded', owned, activeTurnId: null, historyRevision: revision});
    const client = {close: vi.fn(async () => {}), turn: vi.fn(), resume: vi.fn(),
        read: vi.fn(async () => ({session: session(), turns: [{items: [{id: 'reply', type: 'agentMessage', text: revision}]}]})),
        inspect: vi.fn(async () => ({session: session()})),
        eventSnapshot: vi.fn(async () => ({epoch: 'events', cursor: 0, gap: false, events: [], requests: []}))};
    const profile: HarnessProfile = {id: 'codex', kind: 'codex', workspaces: [],
        capabilities: {history: true, create: false, resume: false, interrupt: false, interactions: false}};
    const view = new HarnessConversation(client as unknown as HarnessClient, profile, 'project', 'session', false);
    await view.read();
    return {view, client, clock, append: () => {revision = 'b'.repeat(64); now += 15_001;}, tick: () => {now += 15_001;}};
}

it.each([false, true])('refreshes changed history without native events or a queue (owned: %s)', async owned => {
    const f = await fixture(owned);
    try {
        await f.view.refresh(); expect(f.client.read).toHaveBeenCalledOnce();
        f.append(); const next = await f.view.refresh();
        expect(next.messages[0].text).toBe('b'.repeat(64));
        expect(next.observation.historyRevision).toBe('b'.repeat(64));
        f.tick(); await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('does not acknowledge a changed revision until its history has been read successfully', async () => {
    const f = await fixture();
    try {
        f.append(); f.client.read.mockRejectedValueOnce(Object.assign(new Error('Read unavailable'), {code: 'EIO'}));
        const failed = await f.view.refresh();
        expect(failed.messages[0].text).toBe('a'.repeat(64));
        expect(failed.observation.historyRevision).toBe('a'.repeat(64));
        expect(failed.observation.refreshError?.code).toBe('EIO');
        f.tick(); const recovered = await f.view.refresh();
        expect(recovered.messages[0].text).toBe('b'.repeat(64));
        expect(recovered.observation.refreshError).toBeUndefined();
    } finally {await f.view.close();}
});

it('repairs history after event failure even when there is no queued instruction', async () => {
    const f = await fixture(true);
    try {
        f.append(); f.client.eventSnapshot.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), {code: 'EIO'}));
        const state = await f.view.refresh();
        expect(state.messages[0].text).toBe('b'.repeat(64));
        expect(state.observation.refreshError).toEqual({stage: 'events', code: 'EIO'});
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});
