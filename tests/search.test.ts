import { expect, it, vi } from 'vitest';
import { MCPProjectClient } from '../src/projects';
const project = {id: 'p', name: 'P', alias: 'home', path: 'p', access: 'rw' as const, revision: 3, mounts: []};
const result = {matches: [{path: 'nested/file.txt', summary: 'needle'}], truncated: false, nextCursor: null};
it('negotiates keyword semantics on the same project connection and preserves the literal query', async () => {
    let searchKeywords = false;
    const call = vi.fn(async () => result), metadata = vi.fn(async () => ({'itookit/cells': {fileSearchVersion: 2, searchKeywords}}));
    const client = new MCPProjectClient({call, metadata, close: vi.fn()});
    await expect(client.search(project, {query: 'Beta alpha', mode: 'content'})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call).not.toHaveBeenCalled();
    searchKeywords = true;
    await client.search(project, {query: 'Beta\talpha　a.*', mode: 'content', directory: 'nested'});
    expect(call).toHaveBeenCalledExactlyOnceWith('project_search', {projectId: 'p', revision: 3, query: 'Beta\talpha　a.*', mode: 'content', directory: 'nested'}, undefined);
});

it.each(['title', 'content', 'prompt'] as const)('requires native keyword capability for %s and resolves profile aliases', async mode => {
    let searchKeywords = false;
    const call = vi.fn(async (name: string) => name === 'harness_profiles' ? {epoch: 'e', profiles: [{id: 'native', aliases: ['alias'], kind: 'codex', projectRuntime: true, workspaces: [],
        capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, search: true, searchPrompts: true, searchKeywords}}]} : {matches: [], truncated: false, nextCursor: null});
    const client = new MCPProjectClient({call, close: vi.fn()}).harness(project);
    await expect(client.search!('alias', {query: 'Beta alpha', mode})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call.mock.calls.map(args => args[0])).not.toContain('harness_session_search');
    searchKeywords = true;
    await client.search!('alias', {query: 'Beta alpha', mode});
    expect(call).toHaveBeenLastCalledWith('harness_session_search', {projectId: 'p', revision: 3, profileId: 'alias', query: 'Beta alpha', mode}, undefined);
});
it('negotiates scoped/name file search and retains project revision and source-relative paths', async () => {
    const call = vi.fn(async () => result), metadata = vi.fn(async () => ({'itookit/cells': {fileSearchVersion: 2}}));
    const client = new MCPProjectClient({call, metadata, close: vi.fn()});
    expect(await client.search(project, {query: 'file', mode: 'name', directory: 'nested'})).toEqual(result);
    expect(call).toHaveBeenCalledExactlyOnceWith('project_search', {projectId: 'p', revision: 3, query: 'file', mode: 'name', directory: 'nested'}, undefined);
    for (const directory of ['../secret', '/nested', 'nested/../secret', 'a//b', 'a\\b'])
        await expect(client.search(project, {query: 'x', mode: 'name', directory})).rejects.toMatchObject({code: 'EINVAL'});
    expect(call).toHaveBeenCalledTimes(1);
});
it('rejects new file scopes on old servers instead of accepting an ignored scope', async () => {
    const call = vi.fn(async () => result), client = new MCPProjectClient({call, close: vi.fn()});
    await expect(client.search(project, {query: 'x', mode: 'name'})).rejects.toMatchObject({code: 'ECAPABILITY'});
    await expect(client.search(project, {query: 'x', mode: 'content', directory: 'nested'})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call).not.toHaveBeenCalled();
    await client.search(project, {query: 'x', mode: 'path'}); expect(call).toHaveBeenCalledTimes(1);
});
it.each(['name', 'path', 'content'] as const)('rejects disabled file search in %s mode using the project transport metadata', async mode => {
    const call = vi.fn(async () => result), metadata = vi.fn(async () => ({'itookit/cells': {fileSearch: false, fileSearchVersion: 2}}));
    const client = new MCPProjectClient({call, metadata, close: vi.fn()});
    await expect(client.search(project, {query: 'x', mode})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(metadata).toHaveBeenCalledOnce(); expect(call).not.toHaveBeenCalled();
});
it('requires explicit prompt capability and sends the native prompt mode', async () => {
    let prompts = false;
    const call = vi.fn(async (name: string) => name === 'harness_profiles' ? {epoch: 'e', profiles: [{id: 'native', kind: 'codex', projectRuntime: true, workspaces: [],
        capabilities: {history: true, create: true, resume: true, interrupt: true, interactions: true, search: true, searchPrompts: prompts}}]} : {matches: [], truncated: false, nextCursor: null});
    const client = new MCPProjectClient({call, close: vi.fn()}).harness(project);
    await expect(client.search!('native', {query: 'needle', mode: 'prompt'})).rejects.toMatchObject({code: 'ECAPABILITY'});
    expect(call.mock.calls.map(args => args[0])).not.toContain('harness_session_search');
    prompts = true; await client.search!('native', {query: 'needle', mode: 'prompt', archived: true});
    expect(call).toHaveBeenLastCalledWith('harness_session_search', {projectId: 'p', revision: 3, profileId: 'native', query: 'needle', mode: 'prompt', archived: true}, undefined);
});
