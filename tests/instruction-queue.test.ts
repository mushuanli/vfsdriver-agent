import {expect, it, vi} from 'vitest';
import {HarnessInstructionRuntime} from '../src/harness/instruction-queue';
import type {HarnessConversationSnapshot} from '../src/harness/conversation-snapshot';

function fixture() {
    let state = {canSend: false, active: true, pending: false, requests: [], observation: {execution: 'running'}} as unknown as HarnessConversationSnapshot;
    const ports = {save: vi.fn(async () => {}), load: vi.fn(), snapshot: () => state, command: vi.fn(), completion: vi.fn(), reconcile: vi.fn(),
        send: vi.fn(async (item: {id: string; attemptId?: string}) => {state = {...state, active: true, observation: {...state.observation, execution: 'running'},
            submission: {id: item.attemptId ?? item.id, status: 'accepted', turnId: 'turn'}}; return state;})};
    const runtime = new HarnessInstructionRuntime(ports), createdAt = Date.now();
    const enqueue = (id: string) => runtime.enqueue({id, text: `Input ${id}`, attachments: [], createdAt, state: 'pending'});
    const idle = () => {state = {...state, canSend: true, active: false, observation: {...state.observation, execution: 'idle'}};};
    return {runtime, ports, enqueue, idle, createdAt};
}

it('persists separate queue, dispatch and native acceptance timestamps across recovery', async () => {
    const f = fixture(); await f.enqueue('first'); await f.enqueue('second');
    expect(f.runtime.projection().items[0].createdAt).toBe(f.createdAt);
    expect(f.runtime.projection().items[0].dispatchedAt).toBeUndefined(); expect(f.runtime.projection().items[0].acceptedAt).toBeUndefined();
    await f.runtime.pump(); expect(f.ports.send).not.toHaveBeenCalled();
    f.idle(); await f.runtime.pump();
    const item = f.runtime.projection().items[0];
    expect(item.dispatchedAt).toBeGreaterThanOrEqual(f.createdAt); expect(item.acceptedAt).toBeGreaterThanOrEqual(item.dispatchedAt!);
    expect(f.runtime.projection().submissions![0]).toMatchObject({id: 'first', turnId: 'turn', createdAt: f.createdAt,
        dispatchedAt: item.dispatchedAt, acceptedAt: item.acceptedAt});
    const record = structuredClone(f.runtime.record); f.runtime.restore(record);
    expect(f.runtime.record).toEqual(record); await f.runtime.pump(); expect(f.ports.send).toHaveBeenCalledOnce();
});

it('merges pending inputs in queue order while retaining the original admission receipts', async () => {
    const f = fixture(); await f.enqueue('first'); await f.enqueue('second');
    const receipts = structuredClone(f.runtime.record.receipts), revision = f.runtime.record.revision;
    await f.runtime.edit({action: 'merge', ids: ['second', 'first'], expectedRevision: revision});
    expect(f.runtime.projection().items).toHaveLength(1);
    expect(f.runtime.projection().items[0]).toMatchObject({id: 'first', text: 'Input first\n\nInput second', createdAt: f.createdAt});
    expect(f.runtime.record.receipts).toEqual(receipts); expect(f.ports.send).not.toHaveBeenCalled();
    await expect(f.runtime.edit({action: 'merge', ids: ['first', 'second'], expectedRevision: revision})).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(f.runtime.projection().items).toHaveLength(1);
});

it('resumes a rejected head with a fresh attempt and continues in order after its terminal result', async () => {
    const f = fixture(); await f.enqueue('first'); await f.enqueue('second'); f.idle();
    f.ports.send.mockRejectedValueOnce(Object.assign(new Error('Occupied'), {outcome: 'not-committed', remoteCode: 'HARNESS_SESSION_BUSY'}));
    await f.runtime.pump();
    expect(f.runtime.record).toMatchObject({paused: true, items: [{id: 'first', state: 'failed'}, {id: 'second', state: 'pending'}]});
    const rejected = structuredClone(f.runtime.record); f.runtime.restore(rejected);
    await f.runtime.edit({action: 'resume', expectedRevision: rejected.revision});
    expect(f.runtime.record).toMatchObject({paused: false, items: [{id: 'first', state: 'pending'}, {id: 'second', state: 'pending'}]});
    const attempt = f.runtime.record.items[0].attemptId;
    expect(attempt).toMatch(/^[a-f\d-]{36}$/); expect(attempt).not.toBe('first');
    expect(f.runtime.record.items[0]).toMatchObject({createdAt: f.createdAt, error: undefined, dispatchedAt: undefined, acceptedAt: undefined});
    expect(f.runtime.record.receipts).toEqual(rejected.receipts); expect(f.ports.send).toHaveBeenCalledOnce();
    await expect(f.runtime.edit({action: 'resume', expectedRevision: rejected.revision})).rejects.toMatchObject({code: 'ECONFLICT'});
    expect(f.runtime.record.items[0].attemptId).toBe(attempt);
    await f.runtime.pump();
    expect(f.ports.send).toHaveBeenLastCalledWith(expect.objectContaining({id: 'first', attemptId: attempt}));
    f.ports.completion.mockReturnValue('completed'); f.idle(); await f.runtime.pump();
    expect(f.ports.send.mock.calls.map(([item]) => item.id)).toEqual(['first', 'first', 'second']);
});

it('blocks resume atomically when any submission outcome is unknown', async () => {
    const f = fixture(); await f.enqueue('first'); await f.enqueue('second');
    const saved = structuredClone(f.runtime.record); saved.paused = true;
    saved.items[0].state = 'failed'; saved.items[0].error = 'HARNESS_SESSION_BUSY';
    saved.items[1].state = 'uncertain'; saved.items[1].error = 'HARNESS_RECEIPT_UNKNOWN'; f.runtime.restore(saved);
    const writes = f.ports.save.mock.calls.length;
    await expect(f.runtime.edit({action: 'resume', expectedRevision: saved.revision})).rejects.toThrow('Resolve uncertain instructions');
    expect(f.runtime.record).toEqual(saved); expect(f.ports.save).toHaveBeenCalledTimes(writes);
    await f.runtime.pump(); expect(f.ports.send).not.toHaveBeenCalled();
});

it('retains the rejected head when persisting its resumed attempt fails', async () => {
    const f = fixture(); await f.enqueue('first'); f.idle();
    f.ports.send.mockRejectedValueOnce(Object.assign(new Error('Occupied'), {outcome: 'not-committed', remoteCode: 'HARNESS_SESSION_BUSY'}));
    await f.runtime.pump(); const saved = structuredClone(f.runtime.record);
    f.ports.save.mockRejectedValueOnce(new Error('Persistence unavailable'));
    await expect(f.runtime.edit({action: 'resume', expectedRevision: saved.revision})).rejects.toThrow('Persistence unavailable');
    expect(f.runtime.record).toEqual(saved); expect(f.ports.send).toHaveBeenCalledOnce();
});
