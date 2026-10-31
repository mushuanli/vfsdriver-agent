import {terminalTurn} from './history-completion';
import { FSError } from '@itookit/vfs-core';
import { validateUsage } from './usage';
import {validateWriterLock} from './writer-lock';
import type { HarnessEvents, HarnessHistory, HarnessPage, HarnessProfile, HarnessReceipt, HarnessSession } from './contracts';

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value as Record<string, unknown>;
}
function invalid() { return new FSError('EIO', 'Invalid harness response'); }
function sessionTime(value: unknown): number | null {
    const time = typeof value === 'number' ? value >= 1_000_000_000 && value < 100_000_000_000 ? value * 1000 : value
        : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(time) && time > 0 && time <= 8_640_000_000_000_000 ? time : null;
}
export function validateSession(value: unknown): HarnessSession {
    const v = record(value);
    if (typeof v.id !== 'string' || !v.id || typeof v.title !== 'string' || typeof v.resumable !== 'boolean'
        || !(v.cwd === null || typeof v.cwd === 'string') || !(v.status === null || typeof v.status === 'string')
        || !(v.updatedAt === null || (typeof v.updatedAt === 'number' && Number.isFinite(v.updatedAt)))
        || !(v.createdAt === undefined || v.createdAt === null || (typeof v.createdAt === 'number' && Number.isFinite(v.createdAt)))
        || !(v.parentSessionId === undefined || v.parentSessionId === null || typeof v.parentSessionId === 'string')
        || !(v.branchName === undefined || v.branchName === null || typeof v.branchName === 'string')
        || (v.forkable !== undefined && typeof v.forkable !== 'boolean')
        || (v.interruptible !== undefined && typeof v.interruptible !== 'boolean')
        || (v.loaded !== undefined && typeof v.loaded !== 'boolean')
        || (v.owned !== undefined && typeof v.owned !== 'boolean')
        || (v.archived !== undefined && typeof v.archived !== 'boolean')
        || (v.archiveAllowed !== undefined && typeof v.archiveAllowed !== 'boolean')
        || !(v.activeTurnId === undefined || v.activeTurnId === null || typeof v.activeTurnId === 'string')) throw invalid();
    if (v.statusDetails !== undefined && v.statusDetails !== null) {
        const status = record(v.statusDetails);
        if (typeof status.type !== 'string' || status.activeFlags !== undefined && (!Array.isArray(status.activeFlags)
            || status.activeFlags.some(flag => typeof flag !== 'string'))) throw invalid();
    }
    if (v.lastTurnResult !== undefined && v.lastTurnResult !== null && !['completed', 'failed', 'cancelled'].includes(String(v.lastTurnResult))) throw invalid();
    const usage = v.usage === undefined ? undefined : validateUsage(v.usage, v.id as string);
    if (v.usageUnavailable !== undefined && typeof v.usageUnavailable !== 'boolean') throw invalid();
    const native = v.native && typeof v.native === 'object' ? v.native as Record<string, unknown> : {};
    return {...v, usage, writerLock: validateWriterLock(v.writerLock), title: [v.title, native.name, native.preview].find(text => typeof text === 'string' && text.trim())?.toString().trim() ?? '',
        lastTurnResult: v.lastTurnResult ?? undefined,
        createdAt: sessionTime(v.createdAt ?? native.createdAt), updatedAt: sessionTime(v.updatedAt ?? native.updatedAt)} as unknown as HarnessSession;
}
export function validateProfiles(value: unknown): { epoch: string; profiles: HarnessProfile[] } {
    const v = record(value);
    if (typeof v.epoch !== 'string' || !v.epoch || !Array.isArray(v.profiles)) throw invalid();
    for (const profile of v.profiles) {
        const p = record(profile), caps = record(p.capabilities);
        if (typeof p.id !== 'string' || !p.id || typeof p.kind !== 'string' || !p.kind || !Array.isArray(p.workspaces)
            || p.aliases !== undefined && (!Array.isArray(p.aliases) || p.aliases.length > 128 || p.aliases.some(alias => typeof alias !== 'string' || !alias))
            || p.workspaces.some(w => typeof record(w).id !== 'string')
            || (caps.fork !== undefined && typeof caps.fork !== 'boolean')
            || (caps.search !== undefined && typeof caps.search !== 'boolean')
            || ['models', 'slashCommands', 'commandQueries', 'commandOutputs', 'usage', 'checkpointFork', 'searchPrompts', 'searchKeywords', 'rename', 'archive', 'unarchive', 'delete'].some(key => caps[key] !== undefined && typeof caps[key] !== 'boolean')
            || caps.checkpointFork === true && caps.fork !== true
            || caps.commandQueries === true && caps.slashCommands !== true
            || caps.commandOutputs === true && caps.slashCommands !== true
            || caps.attachments !== undefined && (!Array.isArray(caps.attachments) || caps.attachments.length > 2 || caps.attachments.some(kind => !['text', 'image'].includes(String(kind))))
            || ['history','create','resume','interrupt','interactions'].some(key => typeof caps[key] !== 'boolean')) throw invalid();
    }
    return v as unknown as { epoch: string; profiles: HarnessProfile[] };
}
export function validatePage(value: unknown): HarnessPage {
    const v = record(value);
    if (!Array.isArray(v.sessions) || !(v.nextCursor === null || typeof v.nextCursor === 'string')) throw invalid();
    return {...v, sessions: v.sessions.map(validateSession)} as unknown as HarnessPage;
}
export function validateHistory(value: unknown): HarnessHistory {
    const v = record(value), session = validateSession(v.session);
    if (!(v.turns === null || Array.isArray(v.turns)) || !(v.nextCursor === undefined || v.nextCursor === null || typeof v.nextCursor === 'string')) throw invalid();
    if (v.eventCursor !== undefined) {
        const cursor = record(v.eventCursor);
        if (!Number.isSafeInteger(cursor.after) || (cursor.after as number) < 0 || typeof cursor.eventEpoch !== 'string' || !cursor.eventEpoch) throw invalid();
    }
    for (const turn of v.turns ?? []) terminalTurn(turn);
    return {...v, session} as unknown as HarnessHistory;
}
export function validateEvents(value: unknown): HarnessEvents {
    const v = record(value);
    if (typeof v.epoch !== 'string' || !v.epoch || !Number.isSafeInteger(v.cursor) || (v.cursor as number) < 0 || typeof v.gap !== 'boolean'
        || !Array.isArray(v.events) || !Array.isArray(v.requests)) throw invalid();
    if (v.after !== undefined && (!Number.isSafeInteger(v.after) || (v.after as number) < 0 || (v.after as number) > (v.cursor as number))) throw invalid();
    let previous = 0;
    for (const event of v.events) {
        const e = record(event);
        if (!Number.isSafeInteger(e.seq) || (e.seq as number) <= previous || (e.seq as number) > (v.cursor as number)
            || (e.timestamp !== undefined && (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)))
            || typeof record(e.message).method !== 'string') throw invalid();
        previous = e.seq as number;
    }
    for (const request of v.requests) if (typeof record(request).method !== 'string') throw invalid();
    return v as unknown as HarnessEvents;
}
export function validateReceipt(value: unknown): HarnessReceipt {
    const v = record(value);
    if (typeof v.requestId !== 'string' || !['committed','not-committed','unknown'].includes(String(v.outcome))) throw invalid();
    return v as unknown as HarnessReceipt;
}

export {validateAttachments} from './attachments';

export function validateDeletedSessionIds(value: unknown, sessionId: string): string[] {
    if (!Array.isArray(value) || !value.includes(sessionId) || value.length > 16401
        || value.some(id => typeof id !== 'string' || !id || id.length > 512) || new Set(value).size !== value.length)
        throw new FSError('EIO', 'Invalid native deletion receipt');
    return value;
}
