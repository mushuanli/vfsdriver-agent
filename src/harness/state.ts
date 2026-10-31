import {detachedExecution} from './execution-recovery';
import type { HarnessSession, HarnessEvent } from './contracts';
import type { HarnessObservationError } from './observation-errors';
export type { HarnessObservationError } from './observation-errors';

export type HarnessExecutionState = 'unknown' | 'idle' | 'running' | 'waiting-approval' | 'waiting-input';
export interface HarnessObservation {
    historyRevision?: string;
    activity?: import('./activity').HarnessActivity;
    execution: HarnessExecutionState;
    scope?: 'controlled' | 'external';
    loaded?: boolean;
    lastResult?: 'completed' | 'failed' | 'cancelled';
    rawStatus: string | null;
    updatedAt?: number | null;
    nativeError: boolean;
    activeTurnId?: string | null;
    owned: boolean;
    observedAt: number;
    source: 'list' | 'inspect' | 'history' | 'events';
    connection: 'online' | 'offline';
    stale: boolean;
    refreshError?: HarnessObservationError;
    receiptUnknown: boolean;
    canInterrupt: boolean;
    canRespond: boolean;
}
/** Native eligibility refines the legacy rule without changing execution or authorization. */
export function harnessArchiveAllowed(session: HarnessSession | undefined): boolean {
    if (!session || session.archived || session.activeTurnId) return false;
    const idle = harnessObservation(session).execution === 'idle';
    if (!idle && session.status !== 'notLoaded') return false;
    return session.archiveAllowed ?? (session.status === 'notLoaded' || !!session.owned && idle);
}
export function harnessObservation(session: HarnessSession | undefined, requests: Array<{kind: string}> = [],
    evidence: Partial<HarnessObservation> = {}): HarnessObservation {
    const flags = session?.statusDetails?.activeFlags ?? [];
    const waitingApproval = requests.some(r => r.kind === 'approval') || flags.includes('waitingOnApproval');
    const waitingInput = requests.some(r => r.kind === 'input') || flags.includes('waitingOnUserInput');
    const execution = waitingApproval ? 'waiting-approval' : waitingInput ? 'waiting-input'
        : session?.activeTurnId || session?.status === 'active' ? 'running' : session?.status === 'idle' || detachedExecution(session) ? 'idle' : 'unknown';
    return {execution, scope: session?.owned ? 'controlled' : 'external', loaded: session?.loaded ?? (session?.status === 'notLoaded' ? false : session?.owned ? true : undefined), updatedAt: session?.updatedAt, rawStatus: session?.status ?? null, nativeError: session?.status === 'systemError', lastResult: session?.lastTurnResult,
        activeTurnId: session?.activeTurnId, owned: !!session?.owned, observedAt: Date.now(), source: 'history',
        connection: 'online', stale: false, receiptUnknown: false, canInterrupt: false, canRespond: false, ...evidence};
}
/** Only explicit lifecycle notifications can change execution; text deltas are not liveness evidence. */
export function applyHarnessStatus(session: HarnessSession, message: HarnessEvent['message']): HarnessSession {
    const params = message.params;
    if (params?.threadId !== session.id) return session;
    if (message.method === 'thread/name/updated' && typeof params.threadName === 'string') return {...session, title: params.threadName};
    if (message.method === 'thread/archived') return {...session, archived: true, owned: false, activeTurnId: null};
    if (message.method === 'thread/unarchived') return {...session, archived: false};
    if (message.method === 'thread/status/changed') {
        const raw = params.status as HarnessSession['statusDetails'];
        const status = raw && typeof raw.type === 'string' ? {type: raw.type,
            activeFlags: Array.isArray(raw.activeFlags) ? raw.activeFlags.filter(flag => typeof flag === 'string') : undefined} : null;
        return {...session, status: typeof status?.type === 'string' ? status.type : null, statusDetails: status,
            activeTurnId: status?.type === 'active' ? session.activeTurnId : null};
    }
    const turn = params.turn as {id?: string; status?: string} | undefined;
    if (!turn?.id) return session;
    if (message.method === 'turn/started') return {...session, ...(session.interruptible !== undefined ? {interruptible: true} : {}), activeTurnId: turn.id, status: 'active', statusDetails: {type: 'active'}};
    if (message.method !== 'turn/completed' || session.activeTurnId && session.activeTurnId !== turn.id) return session;
    const lastTurnResult = turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed'
        : turn.status === 'interrupted' ? 'cancelled' : undefined;
    return {...session, ...(session.interruptible !== undefined ? {interruptible: false} : {}), activeTurnId: null, status: 'idle', statusDetails: {type: 'idle'}, lastTurnResult};
}
