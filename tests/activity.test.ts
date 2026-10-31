import {expect, it, vi} from 'vitest';
import {HarnessActivityTracker} from '../src/harness/activity';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile} from '../src/harness/contracts';

it('publishes a phase for a native reasoning item with no displayable text', async () => {
    const profile: HarnessProfile = {id: 'native', kind: 'codex', workspaces: [],
        capabilities: {history: true, create: false, resume: false, interrupt: false, interactions: false}};
    const client = {close: vi.fn(async () => {}), read: vi.fn(async () => ({session: {id: 'session', title: '', cwd: null, updatedAt: null,
        status: 'active', activeTurnId: 'turn', resumable: true}, turns: []})),
        eventSnapshot: vi.fn(async () => ({epoch: 'epoch', cursor: 1, gap: false, requests: [], events: [{seq: 1, timestamp: 2000,
            message: {method: 'item/started', params: {threadId: 'session', turnId: 'turn', item: {id: 'empty', type: 'reasoning', summary: [], content: []}}}}]}))} as unknown as HarnessClient;
    const view = new HarnessConversation(client, profile, 'project', 'session', false);
    try {
        await view.read(); const state = await view.refresh();
        expect(state.messages).toEqual([]);
        expect(state.observation.activity).toEqual({turnId: 'turn', phase: 'reasoning', updatedAt: 2000});
        expect(state.observation.execution).toBe('running');
    } finally {await view.close();}
});

it('tracks content-free reasoning and tools without changing the native turn identity', () => {
    const activity = new HarnessActivityTracker();
    activity.observe('turn/started', {turn: {id: 'turn'}}, 1000, 'turn');
    activity.observe('item/started', {item: {id: 'reasoning', type: 'reasoning'}}, 2000, 'turn');
    expect(activity.snapshot('turn')).toEqual({turnId: 'turn', phase: 'reasoning', updatedAt: 2000});
    activity.observe('item/started', {item: {id: 'tool', type: 'dynamicToolCall'}}, 3000, 'turn');
    expect(activity.snapshot('turn')?.phase).toBe('tool');
    activity.observe('item/completed', {item: {id: 'tool', type: 'dynamicToolCall'}}, 4000, 'turn');
    expect(activity.snapshot('turn')).toEqual({turnId: 'turn', phase: 'working', updatedAt: 4000});
    activity.observe('item/agentMessage/delta', {turnId: 'turn'}, 5000, 'turn');
    expect(activity.snapshot('turn')?.phase).toBe('responding');
    expect(activity.snapshot(null)).toBeUndefined();
});

it('ignores old turns, invalid times, heartbeats and inspection timestamps', () => {
    const activity = new HarnessActivityTracker();
    activity.observe('item/reasoning/summaryTextDelta', {turnId: 'current'}, 3000, 'current');
    activity.observe('item/agentMessage/delta', {turnId: 'old'}, 4000, 'current');
    activity.observe('item/agentMessage/delta', {}, 2000, 'current');
    activity.observe('heartbeat', {}, 5000, 'current');
    activity.observe('item/agentMessage/delta', {}, NaN, 'current');
    expect(activity.snapshot('current')).toEqual({turnId: 'current', phase: 'reasoning', updatedAt: 3000});
    expect(activity.snapshot('next')).toBeUndefined();
});

it('keeps tool execution visible until all concurrent tools finish', () => {
    const activity = new HarnessActivityTracker();
    for (const id of ['one', 'two']) activity.observe('item/started', {item: {id, type: 'commandExecution'}}, 1000, 'turn');
    activity.observe('item/completed', {item: {id: 'one', type: 'commandExecution'}}, 2000, 'turn');
    expect(activity.snapshot('turn')?.phase).toBe('tool');
    activity.observe('item/completed', {item: {id: 'two', type: 'commandExecution'}}, 3000, 'turn');
    expect(activity.snapshot('turn')?.phase).toBe('working');
});
