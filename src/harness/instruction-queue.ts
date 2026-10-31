import {FSError} from '@itookit/vfs-core';
import {sha256} from '@itookit/vfs-sync';
import {readStoredAttachments, validateAttachments, prepareTurnInput} from './attachments';
import {validateModelSelection} from './models';
import {requestId} from '../files/request-id';
import type {HarnessAttachment, HarnessModelSelection} from './contracts';
import type {HarnessConversationSnapshot} from './conversation-snapshot';
import {COMMAND_ID_LIMIT} from './command-output';

export interface HarnessInstruction {
    id: string; attemptId?: string; text: string; attachments: HarnessAttachment[]; selection?: HarnessModelSelection;
    commandKind?: 'prompt' | 'action';
    commandId?: string; commandRevision?: string;
    receipt?: InstructionReceipt;
    createdAt: number; dispatchedAt?: number; acceptedAt?: number; state: 'pending' | 'dispatching' | 'failed' | 'uncertain'; error?: string;
}
export interface HarnessInstructionQueue {
    revision: number; paused: boolean; items: HarnessInstruction[];
    receipts: Array<{id: string; input: string; turnId?: string; commandId?: string; createdAt?: number; dispatchedAt?: number; acceptedAt?: number}>;
}
export type HarnessQueueEdit = {expectedRevision: number} & (
    {action: 'pause' | 'resume'} | {action: 'remove' | 'retry'; id: string}
    | {action: 'update'; id: string; text: string} | {action: 'reorder' | 'merge'; ids: string[]});
export type HarnessQueueProjection = Omit<HarnessInstructionQueue, 'items' | 'receipts'> & {
    acceptedIds: string[];
    submissions?: Array<{id: string; turnId?: string; commandId?: string; createdAt?: number; dispatchedAt?: number; acceptedAt?: number}>;
    items: Array<Omit<HarnessInstruction, 'attachments'> & {files: Array<{name: string}>}>;
};
type InstructionReceipt = Pick<NonNullable<HarnessConversationSnapshot['submission']>, 'turnId' | 'commandId' | 'commandStatus' | 'failed' | 'resultError'>;
type SubmissionReceipt = NonNullable<HarnessConversationSnapshot['submission']>;
interface Ports {
    save(): Promise<void>;
    load(): Promise<HarnessInstructionQueue | undefined>;
    snapshot(): HarnessConversationSnapshot;
    send(item: HarnessInstruction): Promise<HarnessConversationSnapshot>;
    reconcile(id: string): Promise<HarnessConversationSnapshot>;
    command(id: string): import('./contracts').HarnessCommandResult | undefined;
    completion(turnId: string): 'completed' | 'failed' | 'cancelled' | undefined;
}
const empty = (): HarnessInstructionQueue => ({revision: 0, paused: false, items: [], receipts: []});
const fail = (message: string) => new FSError('ECONFLICT', message);
const inputKey = (item: Pick<HarnessInstruction, 'text' | 'attachments' | 'selection' | 'commandKind'>) =>
    sha256(new TextEncoder().encode(JSON.stringify([item.text, item.attachments, item.selection ?? null, item.commandKind ?? null])));

/** Durable acceptance is separate from the native turn receipt. Never replay a claimed item. */
export class HarnessInstructionRuntime {
    record = empty();
    private pumping = false;
    private needsReload = false;
    private tail: Promise<unknown> = Promise.resolve();
    private serialize<T>(action: () => Promise<T>): Promise<T> {
        const work = this.tail.catch(() => {}).then(action); this.tail = work; return work;
    }
    constructor(private readonly ports: Ports) {}
    restore(record: HarnessInstructionQueue = empty()): void {
        validateQueue(record);
        record.items.forEach(validateInstruction);
        this.record = structuredClone(record);
        this.needsReload = false;
    }
    projection(): HarnessQueueProjection {
        return {revision: this.record.revision, paused: this.record.paused, acceptedIds: this.record.receipts.map(row => row.id),
            submissions: this.record.receipts.map(({id, turnId, commandId, createdAt, dispatchedAt, acceptedAt}) => ({id, turnId, commandId, createdAt, dispatchedAt, acceptedAt})),
            items: this.record.items.map(({attachments, ...item}) => ({...structuredClone(item), files: attachments.map(({name}) => ({name}))}))};
    }
    hasReceipt(id: string): boolean {return this.record.receipts.some(row => row.id === id);}
    reload(): Promise<void> {return this.serialize(async () => this.restore(await this.ports.load()));}
    synchronize(): Promise<void> {return this.serialize(() => this.sync());}
    private async sync(): Promise<void> {if (this.needsReload) this.restore(await this.ports.load());}
    enqueue(item: HarnessInstruction): Promise<void> {
        const captured = structuredClone(item), started = Date.now();
        return this.serialize(() => this.accept(captured)).catch(error => {this.log('accept', 'failed', started, captured.id, error); throw error;});
    }
    private async accept(item: HarnessInstruction): Promise<void> {
        await this.sync();
        const input = await inputKey(item), previous = this.record.receipts.find(row => row.id === item.id);
        if (previous) {if (previous.input !== input) throw fail('Instruction identity was used with different content'); return;}
        validateNewInput(item);
        if (this.record.items.length >= 100) throw new FSError('EFBIG', 'Instruction queue is full (100 instructions)');
        const items = [...this.record.items, structuredClone(item)];
        const receipts = [...this.record.receipts, {id: item.id, input, createdAt: item.createdAt}], active = new Set(items.map(row => row.id));
        while (receipts.length > 256) receipts.splice(receipts.findIndex(row => !active.has(row.id)), 1);
        await this.commit({...this.record, items, receipts}, 'enqueue', item.id);
    }
    edit(edit: HarnessQueueEdit, binding?: {id?: string; revision?: string}): Promise<void> {
        const captured = structuredClone(edit), started = Date.now();
        return this.serialize(() => this.change(captured,binding)).catch(error => {
            this.log(`edit.${captured.action}`, 'failed', started, 'id' in captured ? captured.id : undefined, error); throw error;
        });
    }
    private async change(edit: HarnessQueueEdit, binding?: {id?: string; revision?: string}): Promise<void> {
        const started = Date.now();
        await this.sync();
        if (!edit || edit.expectedRevision !== this.record.revision) throw fail('Instruction queue changed; refresh before editing');
        const next = structuredClone(this.record);
        const retried = edit.action === 'resume' ? next.items.filter(item => item.state === 'failed').map(item => item.id) : [];
        this.apply(next, edit);
        if (edit.action === 'update') {const item = this.editable(next,edit.id); item.commandId = binding?.id; item.commandRevision = binding?.revision;}
        await this.commit(next, edit.action);
        for (const id of retried) this.log('resume.retry', 'success', started, id);
    }
    private editable(queue: HarnessInstructionQueue, id: string, failed = false): HarnessInstruction {
        const item = queue.items.find(row => row.id === id);
        if (!item || item.state !== 'pending' && !(failed && item.state === 'failed')) throw fail('Only pending instructions can be changed');
        return item;
    }
    private apply(queue: HarnessInstructionQueue, edit: HarnessQueueEdit): void {
        switch (edit.action) {
            case 'pause': queue.paused = true; return;
            case 'resume':
                if (queue.items.some(row => row.state === 'uncertain')) throw fail('Resolve uncertain instructions before resuming');
                for (const item of queue.items) if (item.state === 'failed') this.retry(queue, item.id);
                queue.paused = false; return;
            case 'update': return this.updateText(queue, edit.id, edit.text);
            case 'remove': this.editable(queue, edit.id, true); queue.items = queue.items.filter(row => row.id !== edit.id); return;
            case 'retry': return this.retry(queue, edit.id);
            case 'reorder': return this.reorder(queue, edit.ids);
            case 'merge': return this.merge(queue, edit.ids);
            default: throw new FSError('EINVAL', 'Unknown instruction queue operation');
        }
    }
    private updateText(queue: HarnessInstructionQueue, id: string, text: string): void {
        if (typeof text !== 'string') throw new FSError('EINVAL', 'Instruction text must be a string');
        const item = this.editable(queue, id);
        validateNewInput({...item, text});
        item.text = text;
    }
    private retry(queue: HarnessInstructionQueue, id: string): void {
        const item = this.editable(queue, id, true);
        if (item.state !== 'failed') throw fail('Only rejected instructions can be retried');
        validateNewInput(item);
        item.state = 'pending'; item.attemptId = requestId(); item.error = undefined; queue.paused = false;
        item.dispatchedAt = undefined; item.acceptedAt = undefined;
    }
    private reorder(queue: HarnessInstructionQueue, ids: string[]): void {
        if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== queue.items.filter(row => row.state === 'pending').length)
            throw fail('Reordering must include every pending instruction once');
        const ordered = ids.map(id => this.editable(queue, id)); let index = 0;
        queue.items = queue.items.map(row => row.state === 'pending' ? ordered[index++] : row);
    }
    private merge(queue: HarnessInstructionQueue, ids: string[]): void {
        if (!Array.isArray(ids) || ids.length < 2 || new Set(ids).size !== ids.length) throw fail('Select distinct adjacent instructions');
        ids.forEach(id => this.editable(queue, id));
        const rows = queue.items.filter(row => ids.includes(row.id)), first = queue.items.indexOf(rows[0]);
        if (rows.some(row => row.commandKind)) throw fail('Native commands cannot be merged');
        if (rows.some((row, i) => queue.items.indexOf(row) !== first + i || JSON.stringify(row.selection) !== JSON.stringify(rows[0].selection)))
            throw fail('Merged instructions must be adjacent and use the same model');
        const attachments = rows.flatMap(row => row.attachments);
        const text = rows.map(row => row.text).join('\n\n');
        prepareTurnInput(text, attachments);
        rows[0].text = text; rows[0].attachments = attachments;
        queue.items = queue.items.filter(row => row === rows[0] || !ids.includes(row.id));
    }
    private async commit(next: HarnessInstructionQueue, stage: string, id?: string): Promise<void> {
        const started = Date.now(), previous = this.record;
        if (new TextEncoder().encode(JSON.stringify(next)).length > 4 * 1024 * 1024) throw new FSError('EFBIG', 'Instruction queue exceeds 4 MiB');
        for (const item of next.items) if (new TextEncoder().encode(JSON.stringify(item)).length > 1024 * 1024) throw new FSError('EFBIG', 'Instruction exceeds 1 MiB');
        this.record = {...next, revision: previous.revision + 1};
        try {await this.ports.save(); this.log(stage, 'success', started, id);}
        catch (error) {this.record = previous; this.needsReload = true; this.log(stage, 'failed', started, id, error); throw error;}
    }
    private log(stage: string, result: string, started: number, operationId?: string, error?: unknown): void {
        const metadata = {operation: 'harness.instructions', stage, result, operationId,
            attemptId: operationId ? this.record.items.find(item => item.id === operationId)?.attemptId : undefined,
            revision: this.record.revision, count: this.record.items.length, durationMs: Date.now() - started,
            code: error ? (error as {attachmentCode?: string}).attachmentCode ?? (error as {remoteCode?: string}).remoteCode ?? (error as {code?: string}).code ?? 'EIO' : undefined};
        if (error) console.warn('[Harness] Instruction queue', metadata); else console.info('[Harness] Instruction queue', metadata);
    }
    /** Settle an admitted head only; receipt inspection never dispatches queued work. */
    async settleAccepted(id: string, snapshot: HarnessConversationSnapshot): Promise<boolean> {
        return this.serialize(async () => {
            await this.sync();
            const item = this.record.items[0], revision = this.record.revision;
            if (!item || (item.attemptId ?? item.id) !== id || !item.receipt
                || !['dispatching', 'uncertain'].includes(item.state)) return false;
            await this.settle(item, snapshot);
            return this.record.revision !== revision;
        });
    }
    async pump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {await this.advance();}
        finally {this.pumping = false;}
    }
    private async advance(): Promise<void> {
        const work = await this.serialize(() => this.prepare());
        if (!work) return;
        if (work.dispatch) {await this.dispatch(work.item); return;}
        const snapshot = work.item.receipt && !work.item.receipt.resultError ? this.ports.snapshot() : await this.ports.reconcile(work.item.attemptId ?? work.item.id);
        await this.serialize(async () => {
            await this.sync(); const current = this.current(work.item);
            if (current) await this.settle(current, snapshot);
        });
        if (!this.record.items.some(row => row.id === work.item.id)) await this.advance();
    }
    private async prepare(): Promise<{item: HarnessInstruction; dispatch: boolean} | undefined> {
        await this.sync();
        const item = this.record.items[0]; if (!item || item.state === 'failed') return;
        if (item.state !== 'pending') return {item: structuredClone(item), dispatch: false};
        if (this.record.paused || !this.ports.snapshot().canSend) return;
        const dispatchedAt = Date.now();
        await this.commit({...this.record, items: this.record.items.map(row => row === item ? {...row, state: 'dispatching', dispatchedAt} : row),
            receipts: this.record.receipts.map(row => row.id === item.id ? {...row, dispatchedAt, acceptedAt: undefined} : row)}, 'claim', item.id);
        return {item: structuredClone(this.record.items[0]), dispatch: true};
    }
    private current(expected: HarnessInstruction): HarnessInstruction | undefined {
        const current = this.record.items[0];
        return current?.id === expected.id && current.attemptId === expected.attemptId
            && ['dispatching', 'uncertain'].includes(current.state) ? current : undefined;
    }
    private async dispatch(item: HarnessInstruction): Promise<void> {
        const started = Date.now(); let result: HarnessConversationSnapshot;
        try {result = await this.ports.send(structuredClone(item));}
        catch (error) {
            this.log('dispatch', 'failed', started, item.id, error);
            await this.serialize(() => this.dispatchFailed(item, error)); return;
        }
        const receipt = result.submission;
        if (receipt?.id === (item.attemptId ?? item.id) && receipt.status === 'accepted') {
            await this.serialize(async () => {
                await this.sync(); const current = this.current(item);
                if (current) await this.rememberReceipt(current, receipt);
            });
        }
        this.log('dispatch', 'accepted', started, item.id);
    }
    private async dispatchFailed(item: HarnessInstruction, error: unknown): Promise<void> {
        await this.sync(); if (!this.current(item)) return;
        const failure = error as {outcome?: string; remoteCode?: string; code?: string; attachmentCode?: string};
        const code = failure.remoteCode ?? failure.code ?? 'EIO';
        const definite = failure.outcome === 'not-committed' || failure.outcome !== 'unknown'
            && ['ECAPABILITY', 'EINVAL', 'EACCES', 'EBUSY', 'ECONFLICT', 'EFBIG'].includes(code);
        await this.commit({...this.record, paused: true, items: this.record.items.map(row => row.id === item.id
            ? {...row, state: definite ? 'failed' : 'uncertain', error: failure.attachmentCode ?? code} : row)}, 'dispatch.failed', item.id);
    }
    private async settle(item: HarnessInstruction, snapshot: HarnessConversationSnapshot): Promise<void> {
        const receipt = currentReceipt(item, snapshot);
        if (item.state === 'failed') return;
        if (!settledReceipt(receipt, item, snapshot)) {
            await this.markUnknown(item); return;
        }
        if (receipt.status === 'rejected') {await this.reject(item, receipt.code); return;}
        if (!item.receipt || JSON.stringify(item.receipt) !== JSON.stringify(receiptData(receipt))) await this.rememberReceipt(item, receipt);
        if (receipt.resultError) {
            await this.commit({...this.record, paused: true, items: this.record.items.map(row => row.id === item.id
                ? {...row, error: receipt.resultError!.code} : row)}, 'result.invalid', item.id); return;
        }
        await this.complete(item, snapshot, receipt);
    }
    private async rememberReceipt(item: HarnessInstruction, source: InstructionReceipt): Promise<void> {
        const {turnId,commandId} = source, receipt = receiptData(source);
        const acceptedAt = item.acceptedAt ?? Date.now();
        await this.commit({...this.record,
            receipts: this.record.receipts.map(row => row.id === item.id ? {...row, turnId, commandId, acceptedAt} : row),
            items: this.record.items.map(row => row.id === item.id ? {...row,receipt, acceptedAt} : row)}, 'admitted',item.id);
    }
    private async markUnknown(item: HarnessInstruction): Promise<void> {
        if (item.state === 'uncertain') return;
        await this.commit({...this.record, paused: true,
            items: this.record.items.map(row => row.id === item.id ? {...row, state: 'uncertain', error: 'HARNESS_RECEIPT_UNKNOWN'} : row)}, 'uncertain', item.id);
    }
    private async reject(item: HarnessInstruction, code?: string): Promise<void> {
        await this.commit({...this.record, paused: true,
            items: this.record.items.map(row => row.id === item.id ? {...row, state: 'failed', error: code} : row)}, 'rejected', item.id);
    }
    private async complete(item: HarnessInstruction, snapshot: HarnessConversationSnapshot, receipt: SubmissionReceipt): Promise<void> {
        if (!idleSnapshot(snapshot)) return;
        const command = receipt.commandId ? this.ports.command(receipt.commandId) : undefined;
        const turnId = receipt.turnId ?? command?.turnId;
        const completion = turnId ? this.ports.completion(turnId) : undefined;
        if (awaitingCompletion(turnId, completion, command?.status ?? receipt.commandStatus)) return;
        const failed = failedReceipt(completion, command, receipt);
        await this.commit({...this.record, paused: this.record.paused || failed,
            items: this.record.items.filter(row => row.id !== item.id)}, 'settled', item.id);
    }
}
function currentReceipt(item: HarnessInstruction, snapshot: HarnessConversationSnapshot): SubmissionReceipt | undefined {
    const id = item.attemptId ?? item.id, latest = snapshot.submission?.id === id ? snapshot.submission : undefined;
    return latest?.status === 'accepted' ? latest : item.receipt ? {id, status: 'accepted', ...item.receipt} : latest;
}
function settledReceipt(receipt: SubmissionReceipt | undefined, item: HarnessInstruction, snapshot: HarnessConversationSnapshot): receipt is SubmissionReceipt {
    return !!receipt && receipt.id === (item.attemptId ?? item.id) && receipt.status !== 'pending' && (!!item.receipt || !snapshot.pending);
}
function idleSnapshot(snapshot: HarnessConversationSnapshot): boolean {return !snapshot.active && !snapshot.requests.length && snapshot.observation.execution === 'idle';}
function awaitingCompletion(turnId: string | undefined, completion: string | undefined, status: string | undefined): boolean {
    return !completion && (!!turnId || status === 'running');
}
function failedReceipt(completion: string | undefined, command: {failed?: boolean} | undefined, receipt: SubmissionReceipt): boolean {
    return completion === 'failed' || completion === 'cancelled' || !!command?.failed || !!receipt.failed;
}
function receiptData(source: InstructionReceipt): InstructionReceipt {
    const {turnId,commandId,commandStatus,failed,resultError} = source;
    return {turnId,commandId,commandStatus,failed,...(resultError ? {resultError: {...resultError}} : {})};
}
function validId(id: string): boolean {return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);}

function validateQueue(record: HarnessInstructionQueue): void {
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0 || typeof record.paused !== 'boolean')
        throw new FSError('EINVAL', 'Invalid native instruction queue');
    if (!Array.isArray(record.items) || record.items.length > 100 || !Array.isArray(record.receipts) || record.receipts.length > 256)
        throw new FSError('EINVAL', 'Invalid native instruction queue capacity');
    validateQueueIdentities(record);
    record.receipts.forEach(validateInstructionReceipt);
}
function validateQueueIdentities(record: HarnessInstructionQueue): void {
    if (new Set(record.items.map(row => row?.id)).size !== record.items.length
        || record.receipts.some(row => !row || !validId(row.id) || !/^[a-f0-9]{64}$/.test(row.input)))
        throw new FSError('EINVAL', 'Invalid native instruction queue identities');
}
function validateInstruction(item: HarnessInstruction): void {
    if (!item || !validId(item.id) || !hasInstructionInput(item) || !Number.isFinite(item.createdAt)
        || !['pending', 'dispatching', 'failed', 'uncertain'].includes(item.state)) throw new FSError('EINVAL', 'Invalid native instruction');
    validateInstructionOptions(item);
    if ([item.dispatchedAt, item.acceptedAt].some(value => value !== undefined && (!Number.isFinite(value) || value <= 0)))
        throw new FSError('EINVAL', 'Invalid native instruction timing');
    readStoredAttachments(item.attachments);
    if (item.selection) validateModelSelection(item.selection);
}
function hasInstructionInput(item: HarnessInstruction): boolean {
    return typeof item.text === 'string' && (!!item.text.trim() || !!item.attachments?.length);
}
function validateNewInput(item: HarnessInstruction): void {
    try {
        validateInstruction(item);
        if (item.commandKind) validateAttachments(item.attachments);
        else prepareTurnInput(item.text, item.attachments);
    } catch (error) {throw Object.assign(error as Error, {outcome: 'not-committed'});}
}
function validateInstructionOptions(item: HarnessInstruction): void {
    if (item.attemptId !== undefined && !validId(item.attemptId)) throw new FSError('EINVAL', 'Invalid native instruction attempt');
    if (item.commandKind !== undefined && !['prompt', 'action'].includes(item.commandKind)) throw new FSError('EINVAL', 'Invalid native command kind');
    for (const value of [item.commandId, item.commandRevision])
        if (!validOptionalReference(value, 256))
            throw new FSError('EINVAL', 'Invalid native command binding');
    if (item.receipt !== undefined) validateInstructionReceipt(item.receipt);
}
function validateInstructionReceipt(receipt: InstructionReceipt): void {
    if (!receipt || typeof receipt !== 'object') throw new FSError('EINVAL', 'Invalid native instruction receipt');
    for (const id of [receipt.turnId, receipt.commandId])
        if (!validOptionalReference(id, COMMAND_ID_LIMIT)) throw new FSError('EINVAL', 'Invalid native instruction receipt identity');
    if (!validReceiptStatus(receipt) || !validResultError(receipt.resultError)) throw new FSError('EINVAL', 'Invalid native instruction receipt status');
}
function validOptionalReference(value: unknown, limit: number): boolean {
    return value === undefined || typeof value === 'string' && !!value && value.length <= limit;
}
function validReceiptStatus(receipt: InstructionReceipt): boolean {
    return (receipt.commandStatus === undefined || ['running', 'completed'].includes(receipt.commandStatus))
        && (receipt.failed === undefined || typeof receipt.failed === 'boolean');
}
function validResultError(value: InstructionReceipt['resultError']): boolean {
    return value === undefined || !!value && typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code);
}
