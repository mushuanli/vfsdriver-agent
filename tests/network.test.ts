import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createCellsDriver } from '../src/provider';

const enabled = process.env.CELLS_HARNESS_TEST === '1';
const manifest = resolve(process.env.CELLS_MANIFEST ?? '../../tools/cells/Cargo.toml');
it.skipIf(!enabled)('roundtrips MCP SDK v2 → Rust gateway → native stdio harness',async () => {
    const root = await mkdtemp(join(tmpdir(),'itookit-harness-'));
    const fixture = join(root,'codex.py'), config = join(root,'config.toml');
    await writeFile(fixture,await readFile(join(dirname(manifest),'src/plugin/harness/tests/fixtures/codex-app-server.py'))); await chmod(fixture,0o700);
    await writeFile(config,`listen = "127.0.0.1:0"\nexecution = false\ntoken = "test-harness-token-0123456789"\n[[harnesses]]\nid = "codex"\nkind = "codex"\ncommand = ${JSON.stringify(fixture)}\nhome = ${JSON.stringify(root)}\n[[harnesses.workspaces]]\nid = "project"\npath = ${JSON.stringify(root)}\n`);
    const home=join(root,'home'), exports=join(root,'exports'), catalog=join(root,'catalog');
    await Promise.all([mkdir(home),mkdir(exports)]);
    await writeFile(config,`listen = "127.0.0.1:0"\nserver_id = "network-node"\nexecution = false\ntoken = "test-harness-token-0123456789"\n[projects]\nroot = ${JSON.stringify(catalog)}\n[[exports]]\nalias = "home"\npath = ${JSON.stringify(exports)}\naccess = "rw"\n[[harnesses]]\nid = "codex"\nkind = "codex"\nprojects = true\ncommand = ${JSON.stringify(fixture)}\nhome = ${JSON.stringify(home)}\n[[harnesses.workspaces]]\nid = "project"\npath = ${JSON.stringify(home)}\n`);
    const child = spawn('cargo' ,['run','--quiet','--offline','--manifest-path',manifest,'--',config],{ stdio:['ignore','ignore','pipe'] });
    const exit = new Promise<void>(resolve => child.once('exit',() => resolve()));
    let adapter: ReturnType<typeof createCellsDriver> | undefined;
    try {
        const endpoint = await new Promise<string>((resolve,reject) => {
            const timer = setTimeout(() => reject(new Error('cells startup timed out')),20_000);
            let buffer = '';
            child.stderr.on('data',chunk => {
                buffer += String(chunk);
                for (const line of buffer.split('\n').slice(0,-1)) {
                    try {
                        const event = JSON.parse(line);
                        if (event.event === 'server.ready') { clearTimeout(timer); resolve('http://' + event.fields.address); }
                        if (event.event === 'server.start_failed') { clearTimeout(timer); reject(new Error(event.fields.error)); }
                    } catch { /* Cargo diagnostics are not JSON. */ }
                }
                buffer = buffer.split('\n').at(-1) ?? '';
            });
            child.once('error',error => { clearTimeout(timer); reject(error); });
            child.once('exit',code => { clearTimeout(timer); reject(new Error('cells exited: ' + code)); });
        });
        adapter = createCellsDriver(); adapter.setCredential('ref','test-harness-token-0123456789');
        const descriptor = await adapter.discover({endpoint:endpoint + '/mcp',credentialRef:'ref'});
        expect(descriptor).toMatchObject({version:1,fileProtocol:'fs-agent-http-v1',httpEndpoint:endpoint,harness:true,projects:true,projectProtocol:'fs-agent-project-v1'});
        const projects=adapter.projects({endpoint,credentialRef:'ref'});
        const project=await projects.register({name:'Nested',alias:'home',path:'nested',access:'rw',createDirectory:true});
        expect(project.path).toBe('nested');
        expect((await projects.register({name:'Other label',alias:'home',path:'nested/',access:'rw'})).id).toBe(project.id);
        expect((await projects.list()).map(item => item.id)).toEqual([project.id]);
        const files=await adapter.open({endpoint,alias:'home',credentialRef:'ref',serverProjectId:project.id,serverProjectRevision:project.revision,access:'rw'});
        try {
            await files.fs.driver.createFile({parentPath:'/nested',name:'note.txt',content:'scoped file'});
            expect(await files.fs.driver.readContent('/nested/note.txt',{encoding:'utf-8'})).toBe('scoped file');
            await expect(files.fs.driver.getChildren('/')).rejects.toMatchObject({code:'EACCES'});
        } finally {await files.dispose();}
        const readonly=await adapter.open({endpoint,alias:'home',credentialRef:'ref',serverProjectId:project.id,serverProjectRevision:project.revision,access:'ro'});
        try {await expect(readonly.fs.driver.writeContent('/nested/note.txt','forbidden')).rejects.toMatchObject({code:'EROFS'});}finally{await readonly.dispose();}
        const scope=projects.harness(project);
        const stopDirectory = scope.subscribeDirectory!(() => {});
        await vi.waitFor(() => expect(scope.directorySnapshot!()).toBeTypeOf('string'));
        const version = scope.directorySnapshot!();
        await writeFile(join(exports, project.path, 'external-native.md'), 'independent CLI write');
        await vi.waitFor(() => expect(scope.directorySnapshot!()).not.toBe(version));
        stopDirectory();
        expect((await scope.profiles()).profiles[0].workspaces).toEqual([{id:project.id}]);
        await expect(scope.create('codex',project.id)).rejects.toMatchObject({outcome:'not-committed',code:'ECAPABILITY'});
        await scope.close(); await projects.close();
        const client = adapter.harness({ endpoint,credentialRef:'ref' });
        expect((await client.profiles()).profiles[0].kind).toBe('codex');
        const { session } = await client.create('codex','project');
        expect(session.createdAt).toBe(1791458500000);
        expect(session.updatedAt).toBe(1791458565000);
        expect((await client.list('codex')).sessions).toHaveLength(1);
        expect((await client.search('codex', {query: 'history', mode: 'title'})).matches).toMatchObject([{sessionId: session.id, title: '<script>history</script>'}]);
        expect((await client.search('codex', {query: 'absent', mode: 'content'})).matches).toEqual([]);
        expect((await client.search('codex', {query: 'absent', mode: 'prompt'})).matches).toEqual([]);
        expect((await client.read('codex',session.id)).turns).toEqual([]);
        expect((await client.read('codex',session.id,{toolDetail:'summary'})).turns).toEqual([]);
        await client.resume('codex',session.id);
        const { turnId } = await client.turn('codex',session.id,'test', {attachments: Array.from({length: 5}, (_, index) => ({kind: 'text' as const, name: `large-${index}.txt`, content: '\n'.repeat(64 * 1024)}))});
        let page = await client.eventSnapshot('codex',undefined,{toolDetail:'summary'});
        for (let i=0;i<10 && !page.requests.length;i++) { await new Promise(resolve => setTimeout(resolve,20)); page = await client.eventSnapshot('codex',undefined,{toolDetail:'summary'}); }
        expect(page.events.some(e => e.message.method === 'item/agentMessage/delta')).toBe(true);
        expect(page.events.every(event => Number.isFinite(event.timestamp) && event.timestamp! > 0)).toBe(true);
        await client.respond('codex',page.requests[0].id!,{ decision:'accept' });
        await client.interrupt('codex',session.id,turnId);
        await client.close();
        const owned=await adapter.open({endpoint,alias:'home',credentialRef:'ref',serverProjectId:project.id,serverProjectRevision:project.revision,access:'ro'});
        await adapter.dispose();
        await expect(owned.fs.driver.readContent('/nested/note.txt',{encoding:'utf-8'})).rejects.toThrow();
    } finally {
        await adapter?.dispose(); child.kill('SIGINT');
        const timer = setTimeout(() => child.kill('SIGKILL'),6000); await exit; clearTimeout(timer);
        await rm(root,{recursive:true,force:true});
    }
},30_000);
