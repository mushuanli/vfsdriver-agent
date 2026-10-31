import { requestId as createRequestId } from '../files/request-id';
import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessMutationOptions, HarnessEvents, HarnessHistory, HarnessPage, HarnessReceipt, HarnessSession, HarnessHistoryOptions, HarnessEventsOptions } from './contracts';
import { HarnessRpc } from './rpc';
import { HarnessEventFeed } from './event-feed';
import {validateMetrics} from './metrics';
import { validateUsage } from './usage';
import {validateModels, validateModelSelection} from './models';
import {validateCommandCatalog, validateCommandResult} from './commands';
import { validateDeletedSessionIds, validateHistory, validatePage, validateProfiles, validateReceipt, validateSession } from './validation';
import {validateForkResult} from './forks';
import {validateTurnInput} from './attachments';
import {decodeCommittedResult} from './committed-result';
import {outputRange, validateCommandOutputRef, validateCommandOutputPage} from './command-output';

/** Native task ownership lives on the gateway; this client never replays a mutation. */
export class MCPHarnessClient implements HarnessClient {
    private checkpointProfiles: import('./contracts').HarnessProfile[] = [];
    async metrics(profileId: string, sessionId: string, options?: HarnessMutationOptions) {
        if (!this.checkpointProfiles.length) await this.profiles(options);
        if (!this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(profileId))?.capabilities.metrics)
            throw new FSError('ECAPABILITY', 'Native metrics are unavailable');
        const value = await this.rpc.call('harness_session_metrics', {profileId, sessionId, requestId: options?.requestId ?? createRequestId()}, options) as {sessionId?: unknown; metrics?: unknown};
        if (value?.sessionId !== sessionId) throw new FSError('EIO', 'Mismatched native metrics session');
        return validateMetrics(value.metrics);
    }
    async models(profileId: string, sessionId?: string, options?: OperationOptions) {
        return validateModels(await this.rpc.call('harness_models', {...this.scope, profileId, ...(sessionId ? {sessionId} : {})}, options));
    }
    async commands(profileId: string, sessionId?: string, options?: OperationOptions) {
        return (await this.commandCatalog(profileId, sessionId, options)).commands;
    }
    async commandCatalog(profileId: string, sessionId?: string, options?: OperationOptions) {
        return validateCommandCatalog(await this.rpc.call('harness_commands', {...this.scope, profileId, ...(sessionId ? {sessionId} : {})}, options));
    }
    async readCommandOutput(profileId: string, value: import('./contracts').HarnessCommandOutputRef, options?: import('./contracts').HarnessCommandOutputOptions) {
        const ref = validateCommandOutputRef(value), range = outputRange(ref, options);
        options?.signal?.throwIfAborted();
        if (!this.checkpointProfiles.length) await this.profiles(options);
        const profile = this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(profileId));
        if (!profile?.capabilities.commandOutputs) throw new FSError('ECAPABILITY', 'Native command output reads require a newer server');
        const page = await this.rpc.call('harness_command_output', {...this.scope, profileId, requestId: ref.requestId,
            epoch: ref.epoch, sha256: ref.sha256, bytes: ref.bytes, ...range}, options);
        options?.signal?.throwIfAborted(); return validateCommandOutputPage(page, ref, options);
    }
    async command(profileId: string, sessionId: string, command: string, args: string, options?: import('./contracts').HarnessCommandOptions) {
        return await this.mutate('harness_command', {profileId, sessionId, command, arguments: args, ...(options?.expectedCommand ? {expectedCommand: options.expectedCommand} : {}), ...(options?.selection ? {selection: validateModelSelection(options.selection)} : {})}, options, validateCommandResult) as import('./contracts').HarnessCommandResult;
    }
    async queryCommand(profileId: string, sessionId: string, command: string, args: string, options?: import('./contracts').HarnessQueryOptions) {
        const profile = this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(profileId));
        if (!profile?.capabilities.commandQueries) throw new FSError('ECAPABILITY', 'Independent command queries require a newer server');
        const requestId = options?.requestId ?? createRequestId();
        const result = validateCommandResult(await this.rpc.call('harness_query', {...this.scope, profileId, sessionId, command,
            arguments: args, requestId, ...(options?.expectedCommand ? {expectedCommand: options.expectedCommand} : {})}, options));
        if (result.commandId !== requestId || result.turnId || result.status !== 'completed') throw new FSError('EIO', 'Invalid read-only command result');
        return result;
    }
    private epoch?: string;
    private readonly feeds = new Map<string, HarnessEventFeed>();
    private closed = false;
    private feed(profileId: string): HarnessEventFeed {
        if (this.closed) throw new FSError('ECANCELLED','Harness client is closed');
        let feed = this.feeds.get(profileId);
        if (!feed) { feed = new HarnessEventFeed(this.rpc,{...this.scope,profileId}); this.feeds.set(profileId,feed); }
        return feed;
    }
    subscribe(profileId: string, listener: () => void): () => void { return this.feed(profileId).subscribe(listener); }
    eventSnapshot(profileId: string, cursor?: {after:number;eventEpoch:string}, options?: HarnessEventsOptions): Promise<HarnessEvents> {
        return this.feed(profileId).snapshot(cursor,options);
    }
    private directoryValue?: string;
    private directoryError?: unknown;
    private directoryStop?: () => void;
    private readonly directoryListeners = new Set<() => void>();
    constructor(private readonly rpc: HarnessRpc, private readonly scope: {projectId: string; revision: number; readOnly?: boolean; capabilities?: import('../authorization').RemoteProjectCapabilities} | undefined = undefined) {}
    subscribeDirectory(listener: () => void): () => void {
        this.directoryListeners.add(listener);
        if (this.scope && !this.directoryStop) this.directoryStop = this.rpc.subscribe('projects',{...this.scope},{next: value => {
            const row = value as {version?:unknown;gap?:unknown;truncated?:unknown};
            if (typeof row?.version !== 'string' || row.version.length > 128 || typeof row.gap !== 'boolean' || typeof row.truncated !== 'boolean')
                throw new FSError('EIO','Invalid directory subscription frame','protocol');
            this.directoryValue = row.version; this.directoryError = undefined;
            this.notifyDirectory();
        },error: error => { this.directoryError = error; this.notifyDirectory(); }});
        return () => { this.directoryListeners.delete(listener); if (!this.directoryListeners.size) { this.directoryStop?.(); this.directoryStop = undefined; } };
    }
    directorySnapshot(): string | undefined { if (this.directoryError) throw this.directoryError; return this.directoryValue; }
    private notifyDirectory(): void {
        for (const listener of [...this.directoryListeners]) {
            const started = Date.now();
            try { listener(); }
            catch { console.warn('[Harness] Directory observer failed', { operation: 'harness.directory.observe', operationId: createRequestId(),
                stage: 'notify', outcome: 'failure', code: 'EVENT_OBSERVER_FAILED', durationMs: Date.now() - started }); }
        }
    }
    async search(profileId: string, query: {query: string; mode: 'title' | 'content' | 'prompt'; archived?: boolean}, options?: OperationOptions) {
        const keywords = /[^\S\r\n]/u.test(query.query);
        if (keywords || query.mode === 'prompt') {
            const capabilities = (await this.profiles(options)).profiles.find(profile => profile.id === profileId || profile.aliases?.includes(profileId))?.capabilities;
            if (query.mode === 'prompt' && !capabilities?.searchPrompts) throw new FSError('ECAPABILITY', 'Prompt search requires a newer server');
            if (keywords && !capabilities?.searchKeywords) throw new FSError('ECAPABILITY', 'Keyword search requires a newer server');
        }
        const result = await this.rpc.call('harness_session_search', {...this.scope, profileId, ...query}, options) as import('./contracts').HarnessSearchResult;
        if (!result || !Array.isArray(result.matches) || result.matches.length > 100 || typeof result.truncated !== 'boolean' || result.nextCursor !== null)
            throw new FSError('EIO', 'Invalid harness search response');
        for (const row of result.matches) if (!row || typeof row.sessionId !== 'string' || !row.sessionId || typeof row.title !== 'string'
            || typeof row.summary !== 'string' || row.summary.length > 2000 || !(row.updatedAt === null || typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt))
            || row.itemId !== undefined && row.itemId !== null && typeof row.itemId !== 'string'
            || row.turnId !== undefined && row.turnId !== null && typeof row.turnId !== 'string') throw new FSError('EIO', 'Invalid harness search match');
        return {...result, matches: result.matches.map(row => ({...row, turnId: row.turnId ?? undefined, itemId: row.itemId ?? undefined}))};
    }
    async profiles(options?: OperationOptions) {
        const value = validateProfiles(await this.rpc.call('harness_profiles', {}, options));
        this.epoch = value.epoch;
        if (this.scope) value.profiles=value.profiles.filter(profile => profile.projectRuntime).map(profile => ({...profile,projectCapabilities:this.scope!.capabilities,workspaces:[{id:this.scope!.projectId}]}));
        if (this.scope?.capabilities?.sessionControl === false) value.profiles=value.profiles.map(profile => ({...profile, capabilities:{...profile.capabilities,create:false,resume:false,interrupt:false,steer:false,interactions:false,fork:false,checkpointFork:false,rename:false,archive:false,unarchive:false,delete:false}}));
        this.checkpointProfiles = structuredClone(value.profiles);
        return value;
    }
    async list(profileId: string, query = {}, options?: OperationOptions): Promise<HarnessPage> {
        return validatePage(await this.rpc.call('harness_sessions', { ...this.scope, profileId, ...query }, options));
    }
    async usage(profileId: string, sessionId: string, options?: OperationOptions) {
        return validateUsage(await this.rpc.call('harness_session_usage', {...this.scope, profileId, sessionId}, options), sessionId);
    }
    async digest(profileId: string, sessionId: string, options?: HarnessHistoryOptions & {expectedRevision?: string; metadataOnly?: boolean}) {
        if (!this.checkpointProfiles.length) await this.profiles(options);
        const profile = this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(profileId));
        if (!profile?.capabilities.sessionDigest) throw new FSError('ECAPABILITY', 'Session digest requires a newer server');
        const {validateDigest} = await import('./digest');
        return validateDigest(await this.rpc.call('harness_session_digest', {...this.scope, profileId, sessionId,
            ...(options?.cursor ? {cursor: options.cursor} : {}),
            ...(options?.expectedRevision ? {expectedRevision: options.expectedRevision} : {}),
            ...(options?.metadataOnly !== undefined ? {metadataOnly: options.metadataOnly} : {})}, options), sessionId);
    }
    async read(profileId: string, sessionId: string, options?: HarnessHistoryOptions): Promise<HarnessHistory> {
        return validateHistory(await this.rpc.call('harness_session_read', { ...this.scope, profileId, sessionId, ...(options?.cursor ? {cursor:options.cursor} : {}), ...(options?.toolDetail ? {toolDetail: options.toolDetail} : {}) }, options));
    }
    async inspect(profileId: string, sessionId: string, options?: OperationOptions) {
        try {
            const value = await this.rpc.call('harness_session_info', {...this.scope, profileId, sessionId}, options);
            return {session:validateSession((value as {session?:unknown})?.session)};
        } catch (error) {
            if ((error as {remoteCode?:string})?.remoteCode !== 'ECAPABILITY') throw error;
            return {session:(await this.read(profileId,sessionId,options)).session};
        }
    }
    async fork(profileId: string, sessionId: string, name?: string, options?: import('./contracts').HarnessForkOptions): Promise<import('./contracts').HarnessForkResult> {
        const checkpoint = options?.lastTurnId;
        const mutationOptions = {...options, requestId: options?.requestId ?? createRequestId()};
        if (checkpoint !== undefined) await this.assertCheckpointFork(profileId, checkpoint, mutationOptions);
        return await this.mutate('harness_fork', {profileId, sessionId, ...(name ? {name} : {}),
            ...(checkpoint !== undefined ? {lastTurnId: checkpoint} : {})}, mutationOptions, value => {
            return validateForkResult(value, sessionId, checkpoint);
        }) as import('./contracts').HarnessForkResult;
    }
    private async assertCheckpointFork(profileId: string, checkpoint: string, options: HarnessMutationOptions): Promise<void> {
        try {
            if (typeof checkpoint !== 'string' || !checkpoint || checkpoint.length > 256) throw new FSError('EINVAL', 'Invalid native checkpoint');
            if (!this.checkpointProfiles.length) await this.profiles(options);
            const profile = this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(profileId));
            if (!profile?.capabilities.checkpointFork) throw new FSError('ECAPABILITY', 'Native checkpoint fork is unavailable');
        } catch (error) {throw Object.assign(error instanceof FSError ? error : new FSError('EIO', 'Native checkpoint capability discovery failed'),
            {outcome: 'not-committed', requestId: options.requestId});}
    }
    async delete(profileId: string, sessionId: string, options?: HarnessMutationOptions): Promise<{deletedSessionIds: string[]}> {
        return await this.mutate('harness_delete', {profileId, sessionId}, options, value => {
            return {deletedSessionIds: validateDeletedSessionIds((value as {deletedSessionIds?: unknown})?.deletedSessionIds, sessionId)};
        }) as {deletedSessionIds: string[]};
    }
    rename(profileId: string, sessionId: string, name: string, options?: HarnessMutationOptions) {
        return this.session('harness_rename', {profileId, sessionId, name}, options);
    }
    archive(profileId: string, sessionId: string, archived: boolean, options?: HarnessMutationOptions) {
        return this.session(archived ? 'harness_archive' : 'harness_unarchive', {profileId, sessionId}, options);
    }
    create(profileId: string, workspaceId: string, options?: OperationOptions) { return this.session('harness_create', { profileId, workspaceId }, options); }
    resume(profileId: string, sessionId: string, options?: OperationOptions) { return this.session('harness_resume', { ...this.scope, profileId, sessionId }, options); }
    private async session(name: string, args: object, options?: HarnessMutationOptions): Promise<{ session: HarnessSession }> {
        return await this.mutate(name, args, options, value => {
            const result = value as { session?: unknown };
            return { session: validateSession(result?.session) };
        }) as { session: HarnessSession };
    }
    async turn(profileId: string, sessionId: string, prompt: string, options?: import('./contracts').HarnessTurnOptions) {
        let attachments: ReturnType<typeof validateTurnInput>;
        try {attachments = validateTurnInput(prompt, options?.attachments);}
        catch (error) {throw Object.assign(error as Error, {outcome: 'not-committed', requestId: options?.requestId ?? createRequestId()});}
        return await this.mutate('harness_turn', { profileId, sessionId, prompt, ...(options?.selection ? {selection: validateModelSelection(options.selection)} : {}), ...(attachments.length ? {attachments} : {}) }, options, value => {
            const result = value as { turnId?: unknown };
            if (typeof result?.turnId !== 'string' || !result.turnId) throw new FSError('EIO', 'Invalid harness turn');
            return { turnId: result.turnId };
        }) as { turnId: string };
    }
    async steer(profileId: string, sessionId: string, turnId: string, prompt: string, options?: import('./contracts').HarnessTurnOptions): Promise<{turnId: string; targetTurnId?: string}> {
        let attachments: ReturnType<typeof validateTurnInput>;
        try {
            attachments = validateTurnInput(prompt, options?.attachments);
            if (typeof turnId !== 'string' || !turnId || turnId.length > 4096) throw new FSError('EINVAL', 'Invalid steering turn identity');
            if (!this.checkpointProfiles.length) await this.profiles(options);
            const profile = this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(profileId));
            if (!profile?.capabilities.steer) throw new FSError('ECAPABILITY', 'Native steering capability is unavailable');
        } catch (error) {throw Object.assign(error instanceof FSError ? error : new FSError('EIO', 'Native steering discovery failed'), {outcome: 'not-committed', requestId: options?.requestId});}
        return await this.mutate('harness_steer', {profileId, sessionId, turnId, prompt, ...(attachments.length ? {attachments} : {})}, options, value => {
            const result = value as {turnId?: unknown; targetTurnId?: unknown};
            if (typeof result?.turnId !== 'string' || !result.turnId || result.turnId.length > 1024 || (result.targetTurnId ?? result.turnId) !== turnId)
                throw new FSError('EIO', 'Mismatched native steering turn');
            return {turnId: result.turnId, ...(result.targetTurnId !== undefined ? {targetTurnId: turnId} : {})};
        }) as {turnId: string; targetTurnId?: string};
    }
    async interrupt(profileId: string, sessionId: string, turnId: string, options?: OperationOptions) {
        await this.mutate('harness_interrupt', { profileId, sessionId, turnId }, options);
    }
    async respond(profileId: string, nativeRequestId: string | number, response: Record<string, unknown>, options?: OperationOptions) {
        await this.mutate('harness_respond', { profileId, nativeRequestId, response }, options);
    }
    async operation(profileId: string, requestId: string, options?: OperationOptions): Promise<HarnessReceipt> {
        if (!this.epoch) await this.profiles(options);
        const receipt = validateReceipt(await this.rpc.call('harness_operation', { ...this.scope, profileId, requestId,
            epoch: (options as HarnessMutationOptions)?.epoch ?? this.epoch, ...this.outputMode(profileId) }, options));
        if (receipt.requestId !== requestId) throw new FSError('EIO', 'Mismatched harness receipt');
        return receipt;
    }
    private outputMode(profileId: unknown): {outputMode?: 'reference'} {
        const profile = this.checkpointProfiles.find(row => row.id === profileId || row.aliases?.includes(String(profileId)));
        return profile?.capabilities.commandOutputs ? {outputMode: 'reference'} : {};
    }
    private async mutate(name: string, args: object, options?: HarnessMutationOptions, decode = (value: unknown): unknown => value): Promise<unknown> {
        const requestId = options?.requestId ?? createRequestId();
        let sent = false;
        try {
            if (!this.epoch) await this.profiles(options);
            sent = true;
            const mode = name === 'harness_command' ? this.outputMode((args as {profileId?: string}).profileId) : {};
            const receipt = validateReceipt(await this.rpc.call(name, { ...args, ...this.scope, epoch: options?.epoch ?? this.epoch, requestId, ...mode }, options));
            if (receipt.requestId !== requestId) throw new FSError('EIO', 'Mismatched harness receipt');
            if (receipt.outcome !== 'committed') throw Object.assign(new FSError('EIO', receipt.code ?? 'Harness operation incomplete'), receipt);
            return decodeCommittedResult(receipt, decode);
        } catch (error) {
            if (sent && error && typeof error === 'object' && 'outcome' in error) throw error;
            throw Object.assign(new FSError('EIO', sent ? 'Harness operation outcome unknown' : 'Harness operation was not sent'),
                { requestId, outcome: sent ? 'unknown' : 'not-committed', cause: error });
        }
    }
    async close() {
        this.closed = true;
        for (const feed of this.feeds.values()) feed.close(); this.feeds.clear();
        this.directoryStop?.(); this.directoryStop = undefined; this.directoryListeners.clear();
        await this.rpc.close();
    }
}
