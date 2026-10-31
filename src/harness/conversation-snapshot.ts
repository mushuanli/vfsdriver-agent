import type {HarnessAttachment, HarnessSlashCommand} from './contracts';
import type {HarnessRecovery} from './conversation-journal';
import type {HarnessMessage} from './conversation-model';
import type {HarnessRequest} from './interactions';
import type {HarnessObservation} from './state';
import type {HarnessUsage} from './usage';

export interface HarnessConversationActions {
    canQueryCommand?: boolean;
    canCommand?: boolean;
    supportsSteer?: boolean;
    canSteer?: boolean;
    canSend: boolean;
    canInterrupt: boolean;
    canRespond: boolean;
    canFork: boolean;
    canDelete: boolean;
    canRename: boolean;
    canArchive: boolean;
    canUnarchive: boolean;
}
/** Public read model; runtime fields and private implementation never define this contract. */
export interface HarnessConversationSnapshot extends HarnessConversationActions {
    executionRecovery?: import('./contracts').HarnessExecutionRecovery;
    metrics?: import('./metrics').HarnessMetrics;
    metricsError?: {code: string};
    supportsMetrics?: boolean;
    writerLock?: import('./contracts').HarnessWriterLock;
    resultError?: {operationId: string; code: string};
    queryReceipts?: Array<{id: string; status: 'accepted'}>;
    pendingQueryReports?: string[];
    controls?: import('./control-ledger').HarnessControlProjection[];
    canCommand?: boolean;
    canQueue?: boolean;
    instructionQueue?: import('./instruction-queue').HarnessQueueProjection;
    sessionId?: string;
    title: string;
    createdAt?: number | null;
    updatedAt?: number | null;
    branchName?: string;
    forkSupport?: 'none' | 'latest' | 'turn';
    forkFailure?: import('./forks').HarnessForkReceipt;
    archived: boolean;
    deletedSessionIds: string[];
    messages: HarnessMessage[];
    requests: HarnessRequest[];
    hasEarlier: boolean;
    observation: HarnessObservation;
    submission?: HarnessRecovery['submission'];
    submittedTurnId?: string;
    draft: string;
    draftAttachments: HarnessAttachment[];
    attachments?: Array<'text' | 'image'>;
    supportsModels?: boolean;
    supportsSlashCommands?: boolean;
    slashCommands?: HarnessSlashCommand[];
    commandCatalogObservation?: import('./contracts').HarnessCommandObservation;
    usage?: HarnessUsage;
    usageUnavailable?: boolean;
    /** Compatibility projections of observation, never independent state. */
    active: boolean;
    pending: boolean;
    disconnected: boolean;
    gap: boolean;
}
