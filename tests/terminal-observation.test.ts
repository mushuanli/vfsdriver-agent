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
    const save = vi.fn(async (next: HarnessRecovery) => {record = structuredClone(next);});
    const view = new HarnessConversation(client, profile, 'project', 'native', true, {epoch: 'epoch', load: async () => record, save});
    await view.read(); return {client, view, session, profile, save, saved: () => record};
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

it.each(['completed', 'failed', 'interrupted', 'another-turn', 'missing'])('recovers history despite failed events without replaying input (%s)', async status => {
    const f = await fixture();
    const eventError = Object.assign(new Error('private transport details'), {code: 'EIO'});
    vi.mocked(f.client.eventSnapshot).mockRejectedValue(eventError);
    vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null},
        turns: status === 'missing' ? [] : [{id: status === 'another-turn' ? 'other' : 'old-turn', status: status === 'another-turn' ? 'completed' : status, items: []}]});
    try {
        await f.view.refresh();
        const confirmed = !['another-turn', 'missing'].includes(status);
        expect(f.view.snapshot().instructionQueue!.items).toHaveLength(confirmed ? 0 : 1);
        expect(f.saved().instructionQueue!.items).toHaveLength(confirmed ? 0 : 1);
        expect(f.view.snapshot().observation.refreshError).toEqual({stage: 'events', code: 'EIO'});
        expect(f.view.snapshot().canSend).toBe(false);
        expect(f.client.read).toHaveBeenCalledTimes(2);
        await f.view.refresh();
        expect(f.client.read).toHaveBeenCalledTimes(2);
        expect(f.client.turn).not.toHaveBeenCalled();
        expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('keeps the queue and event failure when fallback history is unavailable, then retries after the interval', async () => {
    const f = await fixture(), clock = vi.spyOn(Date, 'now'), started = Date.now();
    clock.mockReturnValue(started);
    vi.mocked(f.client.eventSnapshot).mockRejectedValue(Object.assign(new Error('unreachable'), {code: 'ECONNREFUSED'}));
    vi.mocked(f.client.read).mockRejectedValueOnce(Object.assign(new Error('private history details'), {code: 'EACCES'}));
    try {
        await f.view.refresh();
        expect(f.view.snapshot().instructionQueue!.items).toHaveLength(1);
        expect(f.view.snapshot().observation.refreshError).toEqual({stage: 'events', code: 'ECONNREFUSED'});
        expect(f.view.snapshot().observation.connection).toBe('offline');
        await f.view.refresh(); expect(f.client.read).toHaveBeenCalledTimes(2);
        clock.mockReturnValue(started + 15_001);
        vi.mocked(f.client.read).mockResolvedValue({session: {...f.session, status: 'idle', activeTurnId: null}, turns: [{id: 'old-turn', status: 'completed', items: []}]});
        await f.view.refresh();
        expect(f.client.read).toHaveBeenCalledTimes(3);
        expect(f.view.snapshot().instructionQueue!.items).toEqual([]);
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {clock.mockRestore(); await f.view.close();}
});

const recoveryEvidence = {state: 'detached' as const, checkedAt: 100, runtimeId: 'a'.repeat(32), processId: 10, childPid: 11, runtimeStartedAt: 50};
function detachedSession(session: HarnessSession): HarnessSession {
    return {...session, status: 'notLoaded', activeTurnId: null, owned: false, loaded: false,
        writerLock: {status: 'not-held', checkedAt: 100}, executionRecovery: recoveryEvidence};
}

it('explicitly abandons a detached turn as unknown, persists the decision and keeps later work paused', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const session = detachedSession(f.session);
    vi.mocked(f.client.read).mockResolvedValue({session, turns: []});
    vi.mocked(f.client.inspect!).mockResolvedValue({session});
    await f.view.enqueue('Later instruction', [], undefined, 'later');
    try {
        const revision = f.view.snapshot().instructionQueue!.revision;
        await f.view.editInstructionQueue({action: 'recover', id: 'first', expectedRevision: revision});
        expect(f.saved().instructionQueue).toMatchObject({paused: true, items: [{id: 'later', state: 'pending'}],
            recoveries: [{id: 'first', turnId: 'old-turn', outcome: 'unknown', evidence: recoveryEvidence}]});
        await f.view.refresh();
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.resume).not.toHaveBeenCalled();
        expect(f.saved().instructionQueue!.receipts[0]).toMatchObject({id: 'first', turnId: 'old-turn'});
        expect(f.view.snapshot().instructionQueue!.recoveries![0]).not.toHaveProperty('terminal');
    } finally {await f.view.close();}
});

it.each(['held', 'unknown', 'active', 'owned', 'missing-evidence', 'wrong-session'])('refuses manual recovery without positive detached evidence (%s)', async blocked => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const session = detachedSession(f.session);
    if (blocked === 'held') session.writerLock = {status: 'held', checkedAt: 100, owner: {pid: 99}};
    if (blocked === 'unknown') session.writerLock!.status = 'unknown';
    if (blocked === 'active') {session.status = 'active'; session.activeTurnId = 'old-turn';}
    if (blocked === 'owned') session.owned = true;
    if (blocked === 'missing-evidence') delete session.executionRecovery;
    vi.mocked(f.client.read).mockResolvedValue({session, turns: []});
    vi.mocked(f.client.inspect!).mockResolvedValue({session: {...session, id: blocked === 'wrong-session' ? 'other' : session.id}});
    try {
        await expect(f.view.editInstructionQueue({action: 'recover', id: 'first', expectedRevision: 2})).rejects.toMatchObject({code: blocked === 'wrong-session' ? 'EIO' : 'EBUSY'});
        expect(f.saved().instructionQueue!.items).toHaveLength(1);
        expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('does not label a completed native turn as an unknown recovery', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const session = {...detachedSession(f.session), lastTurnId: 'old-turn', lastTurnResult: 'completed' as const};
    vi.mocked(f.client.read).mockResolvedValue({session, turns: [{id: 'old-turn', status: 'completed', items: []}]});
    vi.mocked(f.client.inspect!).mockResolvedValue({session});
    try {
        await f.view.editInstructionQueue({action: 'recover', id: 'first', expectedRevision: 2});
        expect(f.saved().instructionQueue!.items).toEqual([]);
        expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {await f.view.close();}
});

it('offers recovery after the observation timeout without treating the timeout as completion', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const clock = vi.spyOn(Date, 'now'), createdAt = f.saved().instructionQueue!.items[0].createdAt;
    try {
        clock.mockReturnValue(createdAt + 59_999);
        expect(f.view.snapshot().instructionQueue!.recovery).toBeUndefined();
        clock.mockReturnValue(createdAt + 60_000);
        expect(f.view.snapshot().instructionQueue!.recovery).toEqual({id: 'first'});
        expect(f.saved().instructionQueue!.items).toHaveLength(1);
        expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
        expect(f.client.turn).not.toHaveBeenCalled();
    } finally {clock.mockRestore(); await f.view.close();}
});

it.each(['completed', 'interrupted'])('settles a terminal-only rollout row after reopening (%s)', async status => {
    const f = await fixture(); await f.view.close();
    vi.mocked(f.client.read).mockResolvedValue({session: detachedSession(f.session),
        turns: [{items: []}, {id: 'old-turn', status, items: []}]});
    const reopened = new HarnessConversation(f.client, f.profile, 'project', 'native', true,
        {epoch: 'new-epoch', load: async () => structuredClone(f.saved()), save: f.save});
    try {
        await reopened.read(); await reopened.refresh();
        expect(f.saved().instructionQueue!.items).toEqual([]);
        expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await reopened.close();}
});

it('retains an orphaned head on save failure and preserves unknown recovery after reopening', async () => {
    const f = await fixture(); f.profile.capabilities.executionRecovery = true;
    const session = detachedSession(f.session);
    vi.mocked(f.client.read).mockResolvedValue({session, turns: []});
    vi.mocked(f.client.inspect!).mockResolvedValue({session});
    await f.view.enqueue('Later instruction', [], undefined, 'later');
    const edit = {action: 'recover' as const, id: 'first', expectedRevision: f.view.snapshot().instructionQueue!.revision};
    f.save.mockRejectedValueOnce(Object.assign(new Error('Unavailable'), {code: 'EIO'}));
    await expect(f.view.editInstructionQueue(edit)).rejects.toMatchObject({code: 'EIO'});
    expect(f.saved().instructionQueue!.items[0].id).toBe('first');
    expect(f.saved().instructionQueue!.recoveries).toBeUndefined();
    await f.view.editInstructionQueue(edit); await f.view.close();
    const reopened = new HarnessConversation(f.client, f.profile, 'project', 'native', true,
        {epoch: 'new-epoch', load: async () => structuredClone(f.saved()), save: f.save});
    try {
        await reopened.read(); await reopened.refresh();
        expect(reopened.snapshot().instructionQueue).toMatchObject({paused: true, items: [{id: 'later', state: 'pending'}],
            recoveries: [{turnId: 'old-turn', outcome: 'unknown', evidence: recoveryEvidence}]});
        expect(f.client.turn).not.toHaveBeenCalled(); expect(f.client.resume).not.toHaveBeenCalled();
    } finally {await reopened.close();}
});
