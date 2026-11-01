import { HttpTransport } from '../../src/files/transport';
import { it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createFile } from '@itookit/vfs-core';
import { HttpProcessSession, discoverServer, openHttpFileSource } from '../../src/files';

// Hosts can supply the independently maintained server for protocol verification.
// Inside itookit, retain automatic discovery of its server submodule.
const configuredManifest = process.env.CELLS_MANIFEST;
const manifest = resolve(configuredManifest ?? '../../tools/cells/Cargo.toml');
if (configuredManifest && (process.platform !== 'linux' || !existsSync(manifest))) {
    throw new Error('CELLS_MANIFEST requires Linux and an existing Cargo.toml');
}

it.skipIf(process.platform !== 'linux' || !existsSync(manifest))('reads, conditionally saves and cancels against the real Rust server', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'http-vfs-'));
    const root = join(directory, 'data');
    const { mkdir } = await import('node:fs/promises'); await mkdir(root);
    await writeFile(join(root, 'note.txt'), 'original');
    const config = join(directory, 'server.toml');
    // Single-user config: top-level credentials plus a flat export list.
    await writeFile(config, `listen = "127.0.0.1:0"
log_level = "debug"
${process.env.CELLS_PROCESS_TEST === '1' ? '' : 'execution = false'}
username = "test"
password_env = "TEST_FS_PASSWORD"

[[exports]]
alias = "docs"
path = ${JSON.stringify(root)}
access = "rw"
`);
    const password = 'integration-password';
    const child = spawn('cargo', ['run', '--quiet', '--manifest-path', manifest, '--', config],
        { env: { ...process.env, TEST_FS_PASSWORD: password }, stdio: ['ignore', 'ignore', 'pipe'] });
    const exited = once(child, 'exit');
    let output = '';
    let owner: Awaited<ReturnType<typeof openHttpFileSource>> | undefined;
    try {
        const endpoint = await new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fs-server startup timeout')), 60_000);
            child.stderr.on('data', data => {
                output += data; const match = output.match(/listening on (127\.0\.0\.1:\d+)/);
                if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); }
            });
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`fs-server exited ${code}: ${output}`)); });
        });
        owner = await openHttpFileSource({ endpoint, alias: 'docs', username: 'test', credential: () => password });
        const a = createFile(owner.fs, '/note.txt'), b = createFile(owner.fs, '/note.txt');
        expect(await a.read({ encoding: 'utf-8' })).toBe('original'); expect(await b.read({ encoding: 'utf-8' })).toBe('original');
        await a.write('updated');
        await expect(b.write('lost update')).rejects.toMatchObject({ code: 'ECONFLICT', outcome: 'not-committed' });
        expect(await a.read({ encoding: 'utf-8' })).toBe('updated');
        expect(new TextDecoder().decode(await owner.fs.driver.readContent('/note.txt', { encoding: 'binary', offset: 1, length: 3 }))).toBe('pda');
        await owner.fs.driver.createFile({ parentPath: '/', name: 'new.txt', content: 'new' });
        await owner.fs.driver.rename('/new.txt', 'moved.txt');
        await owner.fs.driver.delete(['/moved.txt']);
        const controller = new AbortController(); controller.abort();
        await expect(owner.fs.driver.readContent('/note.txt', { signal: controller.signal })).rejects.toMatchObject({ code: 'ECANCELLED' });
        if (process.env.CELLS_PROCESS_TEST === '1') {
            const transport = new HttpTransport({ endpoint, username: 'test', credential: () => password });
            const caps = await discoverServer(transport);
            expect(caps.process.exec).toBe(true);
            const execution = new HttpProcessSession(transport, { serverId: caps.serverId!, epoch: caps.processEpoch!, cwd: '/workspace',
                mounts: [{ alias: 'docs', path: '', at: '/workspace', access: 'rw' }] });
            await b.read({ encoding: 'utf-8' });
            const result = await execution.nativeShell.exec('/bin/bash', ['-c', 'pwd; echo shell > note.txt']);
            expect(result.stdout.trim()).toBe('/workspace');
            expect(await a.read({ encoding: 'utf-8' })).toBe('shell\n');
            await expect(b.write('stale')).rejects.toMatchObject({ code: 'ECONFLICT' });
            const stop = new AbortController();
            const running = execution.nativeShell.exec('/bin/bash', ['-c', 'sleep 30'], { signal: stop.signal });
            setTimeout(() => stop.abort(), 100);
            await expect(running).rejects.toThrow();
            await execution.release();
        }
        // The durable recovery journal survives successful writes; transient staging files must not.
        expect((await readdir(root)).filter(name => name.startsWith('.itookit-upload-') && name !== '.itookit-upload-state')).toEqual([]);
        await vi.waitFor(() => expect(output).toContain('mutation.finished'));
        const events = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        expect(events.some(event => event.event === 'mutation.accepted' && event.level === 'debug')).toBe(true);
        expect(events.some(event => event.event === 'mutation.finished' && event.fields.outcome === 'committed')).toBe(true);
        expect(events.filter(event => event.event === 'http.failed').every(event => event.fields.status >= 400)).toBe(true);
        expect(output).not.toContain(password);
        expect(output).not.toContain('pwd; echo shell');
        if (process.env.CELLS_PROCESS_TEST === '1') expect(events.some(event => event.event === 'process.finished')).toBe(true);
    } finally {
        await owner?.dispose(); child.kill('SIGINT'); await exited; await rm(directory, { recursive: true, force: true });
    }
}, 90_000);
