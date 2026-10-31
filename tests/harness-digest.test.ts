import {expect, it, vi} from 'vitest';
import {MCPHarnessClient} from '../src/harness/client';
import {validateDigest} from '../src/harness/digest';
const session = {id: 's', title: 'Session', cwd: '/p', status: 'idle', updatedAt: 1000, resumable: true};
const value = {version: 1, session, revision: 'a'.repeat(64), messages: [{id: 'm', role: 'user', text: 'request', turnId: null, timestamp: null}], omittedUnclassified: 0, nextCursor: null};
it('negotiates digest access and preserves project/revision boundaries without native mutations', async () => {
    const call = vi.fn(async name => name === 'harness_profiles' ? {epoch: 'e', profiles: [{id: 'p', kind: 'native', projectRuntime: true, workspaces: [],
        capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, sessionDigest: true}}]} : value);
    const client = new MCPHarnessClient({call, close: vi.fn()}, {projectId: 'project', revision: 3});
    expect((await client.digest('p', 's', {expectedRevision: value.revision})).messages[0].text).toBe('request');
    expect(call).toHaveBeenLastCalledWith('harness_session_digest', {projectId: 'project', revision: 3, profileId: 'p', sessionId: 's', expectedRevision: value.revision}, expect.anything());
    expect(call.mock.calls.map(c => c[0])).toEqual(['harness_profiles', 'harness_session_digest']); await client.close();
});
it('rejects wrong session, malformed revisions and non-text projection content', () => {
    expect(() => validateDigest({...value, session: {...session, id: 'other'}}, 's')).toThrow();
    expect(() => validateDigest({...value, revision: 'bad'}, 's')).toThrow();
    expect(() => validateDigest({...value, messages: [{id: 'm', role: 'tool', text: 'hidden'}]}, 's')).toThrow();
});
it('does not read full history as a fallback on legacy servers', async () => {
    const call = vi.fn(async () => ({epoch: 'e', profiles: []}));
    const client = new MCPHarnessClient({call, close: vi.fn()});
    await expect(client.digest('p', 's')).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call).toHaveBeenCalledOnce(); await client.close();
});
