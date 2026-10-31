import {sha256} from '@itookit/vfs-sync';
import { FSError, type OperationOptions, type RecordValue } from '@itookit/vfs-core';
import { HttpTransport, type HttpConnectionOptions } from '../transport';

export interface HttpSeqSnapshot { revision: string | null; entries: Array<{ key: string; value: RecordValue }> }
export type HttpSeqSelection = {keys: readonly string[]; expectedRevision?: string} |
    {prefix?: string; after?: string; limit?: number; expectedRevision?: string};
export interface HttpSeqPage extends HttpSeqSnapshot {next: string | null}
export type HttpSeqChange = { action: 'set'; key: string; value: RecordValue } | { action: 'delete'; key: string };

/** A transaction changes one portable SQLite SeqFile, with the existing mutation receipt protocol. */
export class HttpSeqClient {
    private readonly transport: HttpTransport;
    private readonly base: string;
    constructor(options: HttpConnectionOptions & { alias: string }) {
        if (!/^[a-zA-Z0-9_-]+$/.test(options.alias)) throw new FSError('EINVAL', 'Invalid export alias');
        this.base = `v1/fs/${options.alias}`; this.transport = new HttpTransport(options);
    }
    dispose(): void { this.transport.close(); }
    async snapshot(path: string, options?: OperationOptions): Promise<HttpSeqSnapshot> {
        const result = await this.transport.json<HttpSeqSnapshot>(`${this.base}/seq/snapshot`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: this.path(path) }),
        }, options, 32 * 1024 * 1024);
        if (!result || typeof result !== 'object' || !(result.revision === null || typeof result.revision === 'string') || !Array.isArray(result.entries)
            || result.entries.some(entry => !entry || typeof entry.key !== 'string' || !Object.hasOwn(entry, 'value')))
            throw new FSError('EIO', 'Invalid SeqFile snapshot');
        return result;
    }
    async query(path: string, selection: HttpSeqSelection, options?: OperationOptions): Promise<HttpSeqPage> {
        validateSelection(selection);
        const result = await this.transport.json<HttpSeqPage>(`${this.base}/seq/query`, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({path: this.path(path), selection}),
        }, options, 32 * 1024 * 1024);
        validatePage(result, selection);
        return result;
    }
    async readBody(path: string, hash: string): Promise<ArrayBuffer | null> {
        validateHash(hash);
        const result = await this.transport.json<{text: string | null}>(`${this.base}/seq/body`, {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path:this.path(path),sha256:hash}),
        }, undefined, 8 * 1024 * 1024);
        if (!result || !(result.text === null || typeof result.text === 'string')) throw new FSError('EIO','Invalid SeqFile body');
        if (result.text === null) return null;
        const bytes = new TextEncoder().encode(result.text);
        if (bytes.length > 1024 * 1024 || await sha256(bytes) !== hash) throw new FSError('EIO','SeqFile body integrity mismatch');
        return bytes.buffer;
    }
    async writeBody(path: string, hash: string, bytes: ArrayBuffer): Promise<void> {
        validateHash(hash);
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength > 1024 * 1024 || await sha256(new Uint8Array(bytes)) !== hash)
            throw new FSError('EINVAL','Invalid SeqFile body identity');
        const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
        await this.transport.mutate(`${this.base}/seq/body/put`, {method:'POST', headers:{'Content-Type':'application/json'},
            body:JSON.stringify({path:this.path(path),sha256:hash,text})}, `${this.base}/operations`);
    }
    async transaction(path: string, expectedRevision: string | null, changes: readonly HttpSeqChange[], options?: OperationOptions): Promise<{ revision: string }> {
        const result = await this.transport.mutate<{ revision: string }>(`${this.base}/seq/transaction`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: this.path(path), expectedRevision, changes }),
        }, `${this.base}/operations`, options);
        if (!result || typeof result.revision !== 'string' || !result.revision)
            throw new FSError('EIO', 'Invalid committed SeqFile transaction result');
        return result;
    }
    private path(path: string): string {
        const relative = path.replace(/^\//, '');
        if (!relative.endsWith('.seq') || relative.includes('\\') || relative.includes('\0')
            || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new FSError('EINVAL', 'Invalid SeqFile path');
        return relative;
    }
}

function validKey(key: unknown): key is string {
    return typeof key === 'string' && key.length > 0 && new TextEncoder().encode(key).length <= 1024 && !key.includes('\0');
}
function validateSelection(input: HttpSeqSelection): void {
    const invalid = 'keys' in input ? !Array.isArray(input.keys) || input.keys.length > 256 || input.keys.some(key => !validKey(key))
        : (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1000))
            || (input.prefix !== undefined && input.prefix !== '' && !validKey(input.prefix))
            || (input.after !== undefined && !validKey(input.after));
    if (invalid) throw new FSError('EINVAL', 'Invalid SeqFile selection');
}
function validatePage(result: HttpSeqPage, input: HttpSeqSelection): void {
    const bad = () => new FSError('EIO', 'Invalid SeqFile query response');
    if (!result || !(result.revision === null || typeof result.revision === 'string') || !Array.isArray(result.entries)
        || !(result.next === null || validKey(result.next))) throw bad();
    if (input.expectedRevision !== undefined && result.revision !== input.expectedRevision) throw bad();
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const row of result.entries) {
        if (!row || !validKey(row.key) || !Object.hasOwn(row, 'value') || seen.has(row.key)) throw bad();
        if ('keys' in input ? !input.keys.includes(row.key)
            : !row.key.startsWith(input.prefix ?? '') || (input.after !== undefined && compareKeys(row.key, input.after) <= 0)) throw bad();
        if (!('keys' in input) && previous !== undefined && compareKeys(previous, row.key) >= 0) throw bad();
        previous = row.key; seen.add(row.key);
    }
    if ('keys' in input) { if (result.next !== null || result.entries.length > input.keys.length) throw bad(); }
    else if (result.entries.length > (input.limit ?? 100) || (result.next !== null
        && (result.entries.length !== (input.limit ?? 100) || result.next !== result.entries.at(-1)?.key))) throw bad();
}

function validateHash(hash: string): void {if (!/^[a-f0-9]{64}$/.test(hash)) throw new FSError('EINVAL','Invalid SeqFile body digest');}

function compareKeys(a: string, b: string): number {
    const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
    for (let index = 0; index < Math.min(left.length, right.length); index++) if (left[index] !== right[index]) return left[index] - right[index];
    return left.length - right.length;
}
