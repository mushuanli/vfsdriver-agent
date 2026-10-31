import {expect, it, vi} from 'vitest';
import {validateSession} from '../src/harness/validation';
import {observeContextMetrics, validateMetrics} from '../src/harness/metrics';
import {MCPHarnessClient} from '../src/harness/client';
import {HarnessConversation} from '../src/harness/conversation';
import type {HarnessClient, HarnessProfile} from '../src/harness/contracts';
const metrics = {observedAt: 1793440000000, contextWindow: {limitTokens: 200000, usedTokens: 10000},
    quota: {windows: [{id: 'primary', usedPercent: 25, windowMinutes: 300, resetsAt: 1793450000000}]}, cost: {amountUsd: 0, kind: 'native-estimate' as const}};
const profile: HarnessProfile = {id: 'native', kind: 'fixture', workspaces: [{id: 'p'}], capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, metrics: true}};
it('validates independent context and quota observations, keeps zero estimates and removes unknown fields', () => {
    expect(validateMetrics({...metrics, accountEmail: 'private', token: 'secret'})).toEqual(metrics);
    expect(() => validateMetrics({...metrics, contextWindow: {limitTokens: 0}})).toThrow();
    expect(() => validateMetrics({...metrics, quota: {windows: [{id: 'primary', usedPercent: -1}]}})).toThrow();
    expect(() => validateMetrics({...metrics, cost: {amountUsd: NaN, kind: 'native-estimate'}})).toThrow();
    expect(validateMetrics({observedAt: metrics.observedAt}).cost).toBeUndefined();
});
it('keeps malformed optional session metrics from blocking native history and execution', () => {
    const session = validateSession({id: 's', title: 'Native', cwd: null, status: 'idle', updatedAt: 1, resumable: true, metrics: {observedAt: 1, contextWindow: {limitTokens: -1}}});
    expect(session.metrics).toBeUndefined(); expect(session.status).toBe('idle');
});
it('negotiates read-only metrics and checks the returned session identity', async () => {
    const call = vi.fn(async (name: string) => name === 'harness_profiles' ? {epoch: 'e', profiles: [profile]} : {sessionId: 's', metrics});
    const client = new MCPHarnessClient({call, close: vi.fn()});
    expect(await client.metrics('native', 's')).toEqual(metrics);
    expect(call).toHaveBeenLastCalledWith('harness_session_metrics', expect.objectContaining({profileId: 'native', sessionId: 's', requestId: expect.any(String)}), undefined);
    await expect(client.metrics('native', 'other')).rejects.toMatchObject({code: 'EIO'});
    const legacyCall = vi.fn(async () => ({epoch: 'e', profiles: [{...profile, capabilities: {...profile.capabilities, metrics: false}}]}));
    const legacy = new MCPHarnessClient({call: legacyCall, close: vi.fn()});
    await expect(legacy.metrics('native', 's')).rejects.toMatchObject({code: 'ECAPABILITY'}); expect(legacyCall).toHaveBeenCalledOnce();
});
it('reads metrics without history, sending or consuming drafts and keeps failures local', async () => {
    const peer = {metrics: vi.fn(async () => metrics), close: vi.fn(async () => {})};
    const view = new HarnessConversation(peer as unknown as HarnessClient, profile, 'p', 's');
    await view.saveDraft('Keep composer input');
    expect(await view.refreshMetrics()).toMatchObject({metrics, draft: 'Keep composer input', pending: false});
    peer.metrics.mockRejectedValue(Object.assign(new Error('private response body'), {code: 'ETIMEDOUT'}));
    const state = await view.refreshMetrics();
    expect(state).toMatchObject({metrics, metricsError: {code: 'ETIMEDOUT'}, draft: 'Keep composer input', pending: false, observation: {refreshError: undefined}});
    await view.close();
});

it('updates current occupancy from native last usage, preserving quota and unknowns independently', () => {
    const next = observeContextMetrics({...metrics, errors: {context: 'ENOENT', quota: 'ETIMEDOUT'}},
        {modelContextWindow: 200000, last: {totalTokens: 12345}, total: {totalTokens: 900000}}, 2);
    expect(next).toMatchObject({contextWindow: {limitTokens: 200000, usedTokens: 12345}, quota: metrics.quota, errors: {quota: 'ETIMEDOUT'}});
    expect(next.errors?.context).toBeUndefined();
    expect(observeContextMetrics(next, {modelContextWindow: 200000, last: {}}, 3).contextWindow?.usedTokens).toBeNull();
    expect(observeContextMetrics(next, {modelContextWindow: null}, 4).contextWindow).toBeUndefined();
    expect(observeContextMetrics(next, {modelContextWindow: 200000, last: {totalTokens: 0}}, 5).contextWindow?.usedTokens).toBe(0);
    expect(() => observeContextMetrics(next, {modelContextWindow: 200000, last: {totalTokens: -1}}, 6)).toThrow();
});
