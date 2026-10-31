export type {HarnessTurnSubmissionEvidence} from './harness/contracts';
export { createNestOSNodeDriver } from './provider';
/** @deprecated Use createNestOSNodeDriver. */
export { createNestOSNodeDriver as createNestOSNodeClient } from './provider';
/** @deprecated Use NestOSNodeDriver. */
export type { NestOSNodeDriver as NestOSNodeClient } from './provider';
/** @deprecated Use createNestOSNodeDriver. */
export { createNestOSNodeDriver as createPiAgentDriver } from './provider';
/** @deprecated Use NestOSNodeDriver and NestOSNodeDescriptor. */
export type { NestOSNodeDriver as PiAgentDriver, NestOSNodeDescriptor as PiAgentDescriptor } from './provider';
export type { RemoteAuthorization, RemoteProjectCapabilities } from './authorization';
export { validateAuthorization } from './authorization';
export type { NestOSNodeDriver, NestOSNodeDescriptor } from './provider';
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

/** @deprecated Use the NestOS names; legacy factories keep working. */
export {createNestOSNodeDriver as createMindOSNodeDriver, createNestOSNodeDriver as createMindOSNodeClient} from "./provider";
export type {NestOSNodeDriver as MindOSNodeDriver, NestOSNodeDriver as MindOSNodeClient, NestOSNodeDescriptor as MindOSNodeDescriptor} from "./provider";

export type {HarnessMetrics} from './harness/metrics';
