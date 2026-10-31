import type { OperationOptions } from '@itookit/vfs-core';
import type { HarnessUsage } from './usage';

export interface HarnessProfile {
    aliases?: string[];
    projectCapabilities?: import('../authorization').RemoteProjectCapabilities;
    id: string; kind: string; projectRuntime?: boolean; workspaces: Array<{ id: string }>;
    capabilities: { models?: boolean; slashCommands?: boolean; commandQueries?: boolean; commandOutputs?: boolean; usage?: boolean; history: boolean; create: boolean; resume: boolean; interrupt: boolean; interactions: boolean; fork?: boolean; checkpointFork?: boolean; search?: boolean; searchPrompts?: boolean; searchKeywords?: boolean; rename?: boolean; archive?: boolean; unarchive?: boolean; delete?: boolean; attachments?: Array<'text' | 'image'> };
}
export interface HarnessWriterLock {
    status: 'held' | 'not-held' | 'unknown'; checkedAt: number; acquiredAt?: number | null;
    lockFileModifiedAt?: number | null; code?: string;
    owner?: {pid: number; uid?: number | null; processStartedAt?: number | null};
}
export interface HarnessSession {
    writerLock?: HarnessWriterLock;
    usage?: HarnessUsage; usageUnavailable?: boolean;
    id: string; title: string; cwd: string | null; status: string | null; updatedAt: number | null; resumable: boolean;
    createdAt?: number | null;
    owned?: boolean;
    loaded?: boolean;
    parentSessionId?: string | null;
    branchName?: string | null;
    forkable?: boolean;
    activeTurnId?: string | null;
    statusDetails?: {type: string; activeFlags?: string[]} | null;
    lastTurnResult?: 'completed' | 'failed' | 'cancelled';
    lastTurnId?: string;
    archived?: boolean;
    /** Native management eligibility; independent of client attachment ownership. */
    archiveAllowed?: boolean;
    /** False until the native adapter has identified an interruptible turn. */
    interruptible?: boolean;
}
export interface HarnessEvent { seq: number; timestamp?: number; message: { method: string; id?: string | number; params?: Record<string, unknown> } }
export interface HarnessEvents {
    after?: number;
    epoch: string; cursor: number; gap: boolean; events: HarnessEvent[]; requests: Array<HarnessEvent['message']>;
}
export interface HarnessPage { sessions: HarnessSession[]; nextCursor: string | null }
/** Native provenance within a complete ordered turn; attached to a terminal history turn. */
export interface HarnessTurnSubmissionEvidence {
    version: 1; requestId: string; promptSha256: string; startSequence: number; endSequence: number;
}
export interface HarnessHistory {
    session: HarnessSession; turns: unknown[] | null; nextCursor?: string | null;
    /** Native snapshot boundary; resume events after the items already included in history. */
    eventCursor?: {after: number; eventEpoch: string};
}
export interface HarnessEventsOptions extends OperationOptions { toolDetail?: 'summary' }
export interface HarnessHistoryOptions extends HarnessEventsOptions { cursor?: string }
export interface HarnessReceipt { requestId: string; outcome: 'committed' | 'not-committed' | 'unknown'; result?: unknown; code?: string }
export interface HarnessMutationOptions extends OperationOptions { requestId?: string; epoch?: string }
export interface HarnessForkOptions extends HarnessMutationOptions {lastTurnId?: string}
export interface HarnessForkResult {session: HarnessSession; checkpoint?: {sourceSessionId: string; turnId: string; verified: boolean; code?: string}}
export interface HarnessAttachment {kind: 'text' | 'image'; name: string; content: string; mimeType?: string}
export interface HarnessCommandOptions extends HarnessMutationOptions {selection?: HarnessModelSelection; expectedCommand?: {id?: string; revision?: string}}
export interface HarnessTurnOptions extends HarnessMutationOptions {attachments?: HarnessAttachment[]; selection?: HarnessModelSelection}
export interface HarnessSlashCommand { id?: string; revision?: string; execution?: 'query' | 'serial'; name: string; description: string; argumentHint?: string; kind: 'prompt' | 'action'; disabled?: boolean }
export interface HarnessCommandObservation {complete: boolean; code?: string}
export interface HarnessCommandCatalog {commands: HarnessSlashCommand[]; observation?: HarnessCommandObservation}
export interface HarnessCommandOutputRef {version: 1; epoch: string; requestId: string; bytes: number; sha256: string; mimeType: 'text/plain'}
export interface HarnessCommandOutputPage {ref: HarnessCommandOutputRef; offset: number; data: string; nextOffset: number | null}
export interface HarnessCommandOutputOptions extends OperationOptions {offset?: number; limit?: number}
export interface HarnessCommandOutputLoadOptions extends OperationOptions {maxBytes?: number}
export interface HarnessCommandOutputIssue {code: string; bytes?: number}
export interface HarnessCommandOutput {commandId: string; ref?: HarnessCommandOutputRef; unavailable?: HarnessCommandOutputIssue; truncated: boolean}
export interface HarnessCommandResult { turnId?: string; commandId?: string; output?: string; outputRef?: HarnessCommandOutputRef;
    outputError?: HarnessCommandOutputIssue; failed?: boolean; status?: 'running' | 'completed' }
export interface HarnessCommandQuery {id: string; name: string; sessionId: string; definitionId?: string; revision?: string}
export interface HarnessCommandRecord extends HarnessCommandResult {query?: HarnessCommandQuery; operationId?: string; operationEpoch?: string; resultError?: {code: string}}
export interface HarnessQueryOptions extends OperationOptions {requestId?: string; expectedCommand?: {id?: string; revision?: string}}
export interface HarnessModelSelection {modelId: string; reasoningEffort?: string}
export interface HarnessModel {id: string; label: string; reasoningEfforts: Array<{id: string; label: string}>; defaultReasoningEffort?: string}
export interface HarnessModelCatalog {models: HarnessModel[]; current?: HarnessModelSelection; default?: HarnessModelSelection}
export interface HarnessClient {
    readCommandOutput?(profileId: string, ref: HarnessCommandOutputRef, options?: HarnessCommandOutputOptions): Promise<HarnessCommandOutputPage>;
    queryCommand?(profileId: string, sessionId: string, command: string, args: string, options?: HarnessQueryOptions): Promise<HarnessCommandResult>;
    commandCatalog?(profileId: string, sessionId?: string, options?: OperationOptions): Promise<HarnessCommandCatalog>;
    models?(profileId: string, sessionId?: string, options?: OperationOptions): Promise<HarnessModelCatalog>;
    commands?(profileId: string, sessionId?: string, options?: OperationOptions): Promise<HarnessSlashCommand[]>;
    command?(profileId: string, sessionId: string, command: string, args: string, options?: HarnessCommandOptions): Promise<HarnessCommandResult>;
    usage?(profileId: string, sessionId: string, options?: OperationOptions): Promise<HarnessUsage>;
    directorySnapshot?(): string | undefined | Promise<string | undefined>;
    subscribeDirectory?(listener: () => void): () => void;
    delete?(profileId: string, sessionId: string, options?: HarnessMutationOptions): Promise<{deletedSessionIds: string[]}>;
    rename?(profileId: string, sessionId: string, name: string, options?: HarnessMutationOptions): Promise<{session: HarnessSession}>;
    archive?(profileId: string, sessionId: string, archived: boolean, options?: HarnessMutationOptions): Promise<{session: HarnessSession}>;
    search?(profileId: string, query: {query: string; mode: 'title' | 'content' | 'prompt'; archived?: boolean}, options?: OperationOptions): Promise<HarnessSearchResult>;
    profiles(options?: OperationOptions): Promise<{ epoch: string; profiles: HarnessProfile[] }>;
    list(profileId: string, query?: { cursor?: string; archived?: boolean }, options?: OperationOptions): Promise<HarnessPage>;
    read(profileId: string, sessionId: string, options?: HarnessHistoryOptions): Promise<HarnessHistory>;
    inspect?(profileId: string, sessionId: string, options?: OperationOptions): Promise<{session: HarnessSession}>;
    fork?(profileId: string, sessionId: string, name?: string, options?: HarnessForkOptions): Promise<HarnessForkResult>;
    create(profileId: string, workspaceId: string, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }>;
    resume(profileId: string, sessionId: string, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }>;
    turn(profileId: string, sessionId: string, prompt: string, options?: HarnessTurnOptions): Promise<{ turnId: string }>;
    interrupt(profileId: string, sessionId: string, turnId: string, options?: HarnessMutationOptions): Promise<void>;
    respond(profileId: string, nativeRequestId: string | number, response: Record<string, unknown>, options?: HarnessMutationOptions): Promise<void>;
    subscribe(profileId: string, listener: () => void): () => void;
    eventSnapshot(profileId: string, cursor?: { after: number; eventEpoch: string }, options?: HarnessEventsOptions): Promise<HarnessEvents>;
    operation(profileId: string, requestId: string, options?: HarnessMutationOptions): Promise<HarnessReceipt>;
    close(): Promise<void>;
}
export interface HarnessSearchMatch { sessionId: string; title: string; summary: string; updatedAt: number | null; turnId?: string; itemId?: string }
export interface HarnessSearchResult { matches: HarnessSearchMatch[]; truncated: boolean; nextCursor: null }
