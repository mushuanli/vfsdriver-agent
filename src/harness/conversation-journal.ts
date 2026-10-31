import type { HarnessAttachment, HarnessCommandRecord } from './contracts';
import {FSError} from '@itookit/vfs-core';
export interface HarnessRecovery {
    controls?: import('./control-ledger').HarnessControlRecord[];
    lastFork?: import('./forks').HarnessForkReceipt;
    instructionQueue?: import('./instruction-queue').HarnessInstructionQueue;
    responses?: Array<{id: string | number; requestId: string; epoch: string}>;
    submission?: {id: string; kind?: 'steer'; steeredFrom?: string; status: 'pending' | 'accepted' | 'rejected'; turnId?: string; code?: string; commandId?: string; commandStatus?: 'running' | 'completed'; failed?: boolean; resultError?: {code: string}};
    submittedTurnId?: string;
    deletedSessionIds?: string[];
    draft?: string;
    draftAttachments?: HarnessAttachment[];
    draftRevision?: number;
    commandResults?: HarnessCommandRecord[];
    sessionId?: string;
    pending?: {requestId: string; epoch: string; operation: string; turnId?: string; inputText?: string; draftRevision?: number;
        /** Queued execution has no ownership of the current composer draft. */
        consumeDraft?: false;
        forkCheckpoint?: import('./forks').ForkCheckpoint};
}
export interface HarnessConversationJournal {
    epoch: string;
    load(): Promise<HarnessRecovery | undefined>;
    save(record: HarnessRecovery): Promise<void>;
}
export function validateSubmission(value: unknown): HarnessRecovery['submission'] {
    if (value === undefined) return;
    const receipt = value as NonNullable<HarnessRecovery['submission']>;
    if (!receipt || typeof receipt.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(receipt.id)
        || !['pending', 'accepted', 'rejected'].includes(receipt.status)
        || receipt.kind !== undefined && receipt.kind !== 'steer'
        || receipt.steeredFrom !== undefined && (typeof receipt.steeredFrom !== 'string' || !receipt.steeredFrom || receipt.steeredFrom.length > 1024)
        || receipt.turnId !== undefined && (typeof receipt.turnId !== 'string' || !receipt.turnId)
        || receipt.commandId !== undefined && (typeof receipt.commandId !== 'string' || !receipt.commandId)
        || receipt.commandStatus !== undefined && !['running', 'completed'].includes(receipt.commandStatus)
        || receipt.failed !== undefined && typeof receipt.failed !== 'boolean'
        || receipt.resultError !== undefined && (receipt.status !== 'accepted' || !receipt.resultError
            || typeof receipt.resultError.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.resultError.code))
        || receipt.code !== undefined && (typeof receipt.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(receipt.code)))
        throw new FSError('EINVAL', 'Invalid submission receipt');
    return {...receipt};
}
