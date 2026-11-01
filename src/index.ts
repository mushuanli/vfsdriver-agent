export type {HarnessTurnSubmissionEvidence} from './harness/contracts';
export { createCellsDriver } from './provider';
export type { RemoteAuthorization, RemoteProjectCapabilities } from './authorization';
export { validateAuthorization } from './authorization';
export type { CellsDriver, CellsDescriptor } from './provider';
export * from './files/index';
export type { HarnessClient, HarnessMutationOptions, HarnessExecutionRecovery, HarnessProfile, HarnessSession, HarnessPage, HarnessHistory, HarnessHistoryOptions, HarnessEvent, HarnessEvents, HarnessReceipt } from './harness/contracts';

export type { ProjectClient, RemoteProject, ProjectMount, RegisterProject, ProjectProcess } from './projects';

export type { DirectorySyncClient, DirectorySyncBinding, DirectorySyncInput, DirectorySyncPlan, DirectoryContent } from './directory-sync';
export type { DirectorySyncDirection, DirectorySyncConflict, DirectorySyncComparison, SyncContentPreview } from './directory-sync';

export { HarnessConversation } from './harness/conversation';
export type { HarnessMessage, HarnessRequest } from './harness/conversation-model';

export type { HarnessConversationJournal, HarnessRecovery } from './harness/conversation-journal';

export type { HarnessConversationPort, HarnessConversationSnapshot } from './harness/conversation';
export { harnessObservation, harnessArchiveAllowed } from './harness/state';
export type { HarnessObservation, HarnessExecutionState } from './harness/state';
export type { HarnessStatusPort, HarnessStatusRow } from './harness/status-observer';
export type { FileSearchQuery, FileSearchResult, FileSearchMatch } from './search';
export type { HarnessSearchMatch, HarnessSearchResult } from './harness/contracts';
export { conversationBranches } from './harness/branches';
export type { HarnessAttachment, HarnessTurnOptions } from './harness/contracts';

export type { HarnessUsage, HarnessUsageEntry, HarnessTokens } from './harness/usage';

export type { HarnessSlashCommand, HarnessCommandResult, HarnessCommandRecord, HarnessCommandQuery, HarnessQueryOptions } from './harness/contracts';

export type {HarnessModel, HarnessModelCatalog, HarnessModelSelection, HarnessCommandOptions} from './harness/contracts';

export type {HarnessAbandonedInstruction, HarnessInstruction, HarnessInstructionQueue, HarnessQueueEdit, HarnessQueueProjection} from './harness/instruction-queue';

export type {HarnessInterruptRequest, HarnessControlRecord, HarnessControlProjection} from './harness/control-ledger';

export type {HarnessCommandCatalog, HarnessCommandObservation} from './harness/contracts';
export type {HarnessCommandOutputRef, HarnessCommandOutputPage, HarnessCommandOutputOptions, HarnessCommandOutputLoadOptions,
    HarnessCommandOutputIssue, HarnessCommandOutput} from './harness/contracts';


export type {HarnessMetrics} from './harness/metrics';
