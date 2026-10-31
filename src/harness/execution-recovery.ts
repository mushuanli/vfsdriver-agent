import {FSError} from '@itookit/vfs-core';
import type {HarnessExecutionRecovery, HarnessSession} from './contracts';

export function validateExecutionRecovery(value: unknown): HarnessExecutionRecovery | undefined {
    if (value === undefined) return;
    const row = value as HarnessExecutionRecovery;
    if (!row || !['running', 'detached', 'unknown'].includes(row.state)
        || typeof row.runtimeId !== 'string' || !/^[a-f0-9]{32}$/.test(row.runtimeId)
        || [row.checkedAt, row.processId, row.childPid, row.runtimeStartedAt].some(n => !Number.isSafeInteger(n) || n <= 0))
        throw new FSError('EIO', 'Invalid execution recovery observation');
    return {state: row.state, runtimeId: row.runtimeId, checkedAt: row.checkedAt,
        processId: row.processId, childPid: row.childPid, runtimeStartedAt: row.runtimeStartedAt};
}

/** The node must positively observe a detached runtime; absence of a PID is insufficient. */
export function detachedExecution(session: HarnessSession | undefined): HarnessExecutionRecovery | undefined {
    const evidence = session?.executionRecovery;
    if (evidence?.state !== 'detached' || session?.owned !== false || session.loaded !== false
        || session.status !== 'notLoaded' || session.activeTurnId || session.writerLock?.status !== 'not-held'
        || session.writerLock.checkedAt !== evidence.checkedAt) return;
    return validateExecutionRecovery(evidence);
}
