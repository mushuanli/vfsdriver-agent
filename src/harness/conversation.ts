import {recoverHistoryCompletions} from './history-completion';
import {validateModels, validateModelSelection, validateAvailableSelection} from './models';
import {HarnessControlLedger, type HarnessInterruptRequest} from './control-ledger';
import {HarnessCommandQueries} from './conversation-queries';
import {HarnessInstructionRuntime, type HarnessInstruction, type HarnessQueueEdit} from './instruction-queue';
import type {HarnessSlashCommand, HarnessModelCatalog, HarnessModelSelection} from './contracts';
import {validateCommands, validateCommandResult, validateCommandReceipts} from './commands';
import { requestId as createRequestId } from '../files/request-id';
import { FSError, type OperationOptions } from '@itookit/vfs-core';
import type { HarnessClient, HarnessProfile, HarnessSession, HarnessEvents, HarnessAttachment } from './contracts';
import { conversationBranches } from './branches';
import { validateAttachments, validateDeletedSessionIds, validateSession } from './validation';
import {readStoredAttachments, prepareTurnInput} from './attachments';
import { applyHarnessStatus, harnessObservation, harnessArchiveAllowed } from './state';
import { ObservationErrors, connectionLost, type HarnessObservationError } from './observation-errors';
import {validateSubmission, type HarnessConversationJournal} from './conversation-journal';
import {forkReceipt, forkFailure, validateForkCheckpoint, validateForkReceipt, type ForkCheckpoint, type HarnessForkReceipt} from './forks';
import { mergeMessages, historyMessages, nativeMessage, nativeRequest, type HarnessMessage, type HarnessRequest } from './conversation-model';
import type {HarnessConversationActions, HarnessConversationSnapshot} from './conversation-snapshot';
import type {HarnessObservation} from './state';
import {committedReceipt, decodeCommittedResult} from './committed-result';
import {commandResultIssue, replaceCommandRecord, bindCommandOutput, projectCommandMessage, commandRecordMessage, commandOutputDiagnostic} from './command-records';
import {loadCommandOutput, validateCommandOutputPage} from './command-output';
export type {HarnessConversationSnapshot} from './conversation-snapshot';

/** One native conversation; closing a viewer never interrupts its remote turn. */
export class HarnessConversation implements HarnessConversationPort {
    private readonly queries: HarnessCommandQueries;
    private readonly instructions: HarnessInstructionRuntime;
    private readonly controls: HarnessControlLedger;
    private readonly localListeners = new Set<() => void>();
    async enqueue(text: string, attachments: HarnessAttachment[] = [], selection?: HarnessModelSelection, submissionId = createRequestId()) {
        await this.restore();
        if (!this.snapshot().canQueue || typeof text !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId))
            throw new FSError('EBUSY', 'Conversation cannot queue instructions');
        if (attachments.some(file => !this.profile.capabilities.attachments?.includes(file.kind))) throw new FSError('ECAPABILITY', 'Attachment kind unavailable');
        const prepared = validateAttachments(attachments);
        const command = await this.queuedCommand(text);
        if (command?.execution === 'query') throw new FSError('EINVAL', 'Query commands must use the command port');
        if (command && prepared.length) throw new FSError('ECAPABILITY', 'Native commands cannot include attachments');
        const selected = selection && command?.kind !== 'action' ? validateAvailableSelection(validateModelSelection(selection), await this.beforeSubmission(() => this.models())) : undefined;
        await this.instructions.enqueue({id: submissionId, text, attachments: prepared, selection: selected, commandKind: command?.kind, commandId: command?.id, commandRevision: command?.revision, createdAt: Date.now(), state: 'pending'});
        return {...this.snapshot(), submission: {id: submissionId, status: 'accepted' as const}, submittedTurnId: undefined};
    }
    async editInstructionQueue(edit: HarnessQueueEdit) {
        await this.restore();
        if (!this.writable || this.lifetime.signal.aborted) throw new FSError('EACCES', 'Instruction queue is read only');
        let binding: HarnessSlashCommand | undefined;
        if (edit.action === 'update') {
            binding = await this.queuedCommand(edit.text);
            const item = this.instructions.record.items.find(row => row.id === edit.id);
            if (item?.commandKind !== binding?.kind || binding?.execution === 'query') throw new FSError('EINVAL', 'Editing cannot change between a native command and a message');
        }
        await this.instructions.edit(edit,binding);
        return this.snapshot();
    }
    private async queuedCommand(text: string) {
        if (!this.profile.capabilities.slashCommands || !text.trimStart().startsWith('/')) return;
        const parsed = text.trimStart().match(/^\/([\p{L}\p{N}_:.-]+)(?:\s+([\s\S]*))?$/u);
        const command = parsed && (await this.beforeSubmission(() => this.commands())).find(row => row.name === parsed[1] && !row.disabled);
        if (!parsed || !command) throw new FSError('EINVAL', 'Native command unavailable');
        return {...command, arguments: parsed[2] ?? ''};
    }
    private async sendInstruction(item: HarnessInstruction): Promise<HarnessConversationSnapshot> {
        if (!item.commandKind) return this.sendTurn(item.text, item.attachments, item.selection, item.attemptId ?? item.id, true);
        const command = await this.queuedCommand(item.text);
        if (!command || command.kind !== item.commandKind || command.execution === 'query'
            || item.commandId !== undefined && command.id !== item.commandId || item.commandRevision !== undefined && command.revision !== item.commandRevision) throw new FSError('ECAPABILITY', 'Queued native command changed or is unavailable');
        return this.sendCommand(command.name, command.arguments, item.selection, item.text, item.attemptId ?? item.id, command, true);
    }
    async models(): Promise<HarnessModelCatalog> {
        if (!this.profile.capabilities.models || !this.client.models) return {models: []};
        return validateModels(await this.client.models(this.profile.id, this.session?.id, this.options()));
    }
    private nativeCommands: import('./contracts').HarnessSlashCommand[] = [];
    private commandCatalogObservation?: import('./contracts').HarnessCommandObservation;
    async commands() {
        if (!this.profile.capabilities.slashCommands || !this.client.commands) return [];
        const catalog = this.client.commandCatalog ? await this.client.commandCatalog(this.profile.id, this.session?.id, this.options())
            : {commands: await this.client.commands(this.profile.id, this.session?.id, this.options())};
        this.nativeCommands = catalog.commands;
        this.commandCatalogObservation = catalog.observation;
        return this.availableCommands();
    }
    private availableCommands() {
        return this.nativeCommands.map(command => ({...command, ...(!this.session && command.kind === 'action' ? {disabled: true} : {})}));
    }
    async queryCommand(name: string, args = '', operationId = createRequestId(), expected?: Pick<HarnessSlashCommand, 'id' | 'revision' | 'kind' | 'execution'>) {
        await this.restore();
        const reject = (code: ConstructorParameters<typeof FSError>[0], message: string) => Object.assign(new FSError(code, message), {outcome: 'not-committed'});
        if (!this.snapshot().canQueryCommand) throw reject('ECAPABILITY', 'Independent command query unavailable');
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId) || !/^[\p{L}\p{N}_:.-]{1,128}$/u.test(name) || args.trim() || args.length > 128 * 1024)
            throw reject('EINVAL', 'Invalid read-only command query');
        if (this.submission?.id === operationId || this.instructions.hasReceipt(operationId)) throw reject('ECONFLICT', 'Query identity belongs to an execution submission');
        const cached = this.availableCommands().find(row => row.name === name);
        if (cached && (cached.disabled || cached.execution !== 'query' || cached.kind !== 'action' || expected && !this.matchesCommand(cached, expected))
            || expected && (expected.kind !== 'action' || expected.execution !== undefined && expected.execution !== 'query'))
            throw reject('ECAPABILITY', 'Query command changed or is unavailable');
        const command = expected ?? cached;
        const sessionId = this.session!.id;
        await this.queries.execute({id: operationId, name, sessionId, ...(command?.id ? {definitionId: command.id} : {}), ...(command?.revision ? {revision: command.revision} : {})}, async () => {
            const result = await this.client.queryCommand!(this.profile.id, sessionId, name, args,
                {...this.options(), requestId: operationId, expectedCommand: {id: command?.id, revision: command?.revision}});
            if (this.session?.id !== sessionId || this.lifetime.signal.aborted) throw reject('ECONFLICT', 'Query observation belongs to a closed or changed session');
            return result;
        });
        this.notify(); return this.snapshot();
    }
    async command(name: string, args = '', selection?: HarnessModelSelection, inputText?: string, submissionId?: string, expected?: Pick<HarnessSlashCommand, 'id' | 'revision' | 'kind' | 'execution'>) {
        return this.sendCommand(name, args, selection, inputText, submissionId, expected);
    }
    private async sendCommand(name: string, args = '', selection?: HarnessModelSelection, inputText?: string, submissionId?: string, expected?: Pick<HarnessSlashCommand, 'id' | 'revision' | 'kind' | 'execution'>, queued = false) {
        const requested = selection ? validateModelSelection(selection) : undefined;
        if (!this.loaded || Date.now() - this.observedAt > 30_000) await this.beforeSubmission(() => this.read());
        if (!this.client.command) throw new FSError('ECAPABILITY', 'Native command unavailable');
        const known = this.nativeCommands.find(row => row.name === name);
        const command = known?.execution === 'query' && this.profile.capabilities.commandQueries ? known
            : (await this.beforeSubmission(() => this.commands())).find(row => row.name === name);
        if (command?.execution === 'query' && this.profile.capabilities.commandQueries) {
            if (selection) throw Object.assign(new FSError('EINVAL', 'Read-only commands cannot change model selection'), {outcome: 'not-committed'});
            return this.queryCommand(name, args, submissionId, expected ?? command);
        }
        if (expected && !this.matchesCommand(command,expected)) throw new FSError('ECONFLICT', 'Native command changed; refresh before submitting');
        const available = () => command?.execution === 'query' ? this.snapshot().canCommand : this.snapshot().canSend;
        const canonical = `/${name}${args ? ' ' + args : ''}`;
        const text = inputText ?? (this.draft.trim() === canonical.trim() ? this.draft : canonical);
        if (!available() || !command || command.disabled || args.length > 128 * 1024 || text.length > 1024 * 1024) throw new FSError('EINVAL', 'Unknown native command');
        if (!this.session && command.kind !== 'prompt') throw new FSError('ECAPABILITY', 'Native command requires a session');
        const selected = requested && command.kind === 'prompt' ? validateAvailableSelection(requested, await this.beforeSubmission(() => this.models())) : undefined;
        if (!available()) throw new FSError('EBUSY', 'Native command unavailable');
        if (!queued && !this.draft) this.setDraft(text, []);
        this.startSubmission(submissionId);
        const submission = {inputText: text, draftRevision: this.draftRevision, ...(queued ? {consumeDraft: false as const} : {})};
        this.submittedTurnId = undefined;
        return this.mutate(async () => {
            if (command.execution !== 'query') await this.prepareSession();
            await this.native('command', options => this.client.command!(this.profile.id, this.session!.id, name, args,
                {...options, ...(command.id || command.revision ? {expectedCommand: {id: command.id,revision: command.revision}} : {}), ...(selected ? {selection: selected} : {})}), submission, result => this.acceptCommand(result, text));
        }).then(() => this.refreshSubmitted()).catch(error => {
            if ((error as {outcome?: string})?.outcome === 'committed' && !this.pending && commandResultIssue(this.commandResults)) return this.snapshot();
            throw error;
        });
    }
    private matchesCommand(command: HarnessSlashCommand | undefined, expected: Pick<HarnessSlashCommand,'id' | 'revision' | 'kind' | 'execution'>): boolean {
        if (!command || command.kind !== expected.kind) return false;
        if (expected.id !== undefined && expected.id !== command.id) return false;
        if (expected.revision !== undefined && expected.revision !== command.revision) return false;
        return (expected.execution ?? 'serial') === (command.execution ?? 'serial');
    }
    private session?: HarnessSession;
    private messages: HarnessMessage[] = [];
    private requests: HarnessRequest[] = [];
    private responses: NonNullable<import('./conversation-journal').HarnessRecovery['responses']> = [];
    private responseBusy = new Set<string>();
    private cursor?: {after: number; eventEpoch: string};
    private readonly completed = new Set<string>();
    private readonly turnResults = new Map<string, 'completed' | 'failed' | 'cancelled'>();
    private readonly completedItems = new Set<string>();
    private pending?: import('./conversation-journal').HarnessRecovery['pending'];
    private draftRevision = 0;
    private commandResults: import('./contracts').HarnessCommandRecord[] = [];
    private commandResultsChanged = false;
    private deletedSessionIds: string[] = [];
    private loaded = false;
    private earlier?: string;
    private expandedHistory = false;
    private readonly historyCursors = new Set<string>();
    private navigationSessionId?: string;
    private forking = false;
    private lastFork?: HarnessForkReceipt;
    private draft = '';
    private submittedTurnId?: string;
    private submission?: import('./conversation-journal').HarnessRecovery['submission'];
    private draftAttachments: HarnessAttachment[] = [];
    private writes: Promise<void> = Promise.resolve();
    private disconnected = false;
    private nativeDisconnected = false;
    private refreshError?: HarnessObservationError;
    private readonly errors: ObservationErrors;
    private gap = false;
    private busy = false;
    private observedAt = 0;
    private source: 'history' | 'events' = 'history';
    private inspectedAt = 0;
    private terminalReadAt = 0;
    private closing?: Promise<void>;
    private readonly lifetime = new AbortController();
    constructor(private readonly client: HarnessClient, private readonly profile: HarnessProfile,
        private readonly workspaceId: string, sessionId?: string, private readonly writable = true, private readonly journal?: HarnessConversationJournal) {
        this.errors = new ObservationErrors(profile.id, sessionId);
        this.queries = new HarnessCommandQueries({records: () => this.commandResults, commit: async record => {
            await this.instructions.synchronize();
            if (record.query?.sessionId !== this.session?.id || this.lifetime.signal.aborted || this.deletedSessionIds.length)
                throw Object.assign(new FSError('ECONFLICT', 'Query report belongs to a closed or changed session'), {outcome: 'not-committed'});
            this.commandResults = replaceCommandRecord(this.commandResults, record);
            await this.save();
        }});
        this.instructions = new HarnessInstructionRuntime({save: () => this.save(), snapshot: () => this.snapshot(),
            load: async () => (await this.journal?.load())?.instructionQueue,
            reconcile: id => this.reconcileInstruction(id),
            command: id => this.commandResults.find(row => row.commandId === id),
            completion: id => this.turnResults.get(id),
            send: item => this.sendInstruction(item)});
        this.controls = new HarnessControlLedger({
            before: async () => {
                await this.instructions.synchronize();
                return this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
            },
            call: row => this.client.interrupt(this.profile.id, row.sessionId, row.turnId, {...this.options(), epoch: row.epoch, requestId: row.requestId}),
            query: row => this.client.operation(this.profile.id, row.requestId, {...this.options(), epoch: row.epoch}),
            save: () => this.save(), completion: id => this.turnResults.get(id),
            changed: () => this.notify(), closed: () => this.lifetime.signal.aborted});
        if (sessionId) this.session = {id: sessionId, title: sessionId, cwd: null, status: null, updatedAt: null, resumable: false};
    }
    get kind() { return this.profile.kind; }
    subscribe(listener: () => void): () => void {
        this.localListeners.add(listener); const stop = this.client.subscribe(this.profile.id, listener);
        return () => {this.localListeners.delete(listener); stop();};
    }
    private notify(): void {
        if (this.lifetime.signal.aborted) return;
        for (const listener of this.localListeners) {try {listener();} catch (error) {this.errors.record('control.notify', error);}}
    }
    private options(): OperationOptions { return {signal: this.lifetime.signal, timeoutMs: 30_000}; }
    snapshot(): HarnessConversationSnapshot {
        const observation = harnessObservation(this.session, this.requests, {observedAt: this.observedAt, source: this.source,
            connection: this.disconnected || this.nativeDisconnected ? 'offline' : 'online',
            refreshError: this.refreshError, stale: !!this.refreshError || Date.now() - this.observedAt > 30_000,
            receiptUnknown: !!this.pending || !!this.responses.length || this.controls.pending});
        if (this.commandResults.some(row => row.status === 'running') && observation.execution === 'idle') observation.execution = 'running';
        const active = ['running', 'waiting-approval', 'waiting-input'].includes(observation.execution);
        const actions = this.actions(observation);
        const queue = this.instructions.projection(observation);
        observation.canInterrupt = actions.canInterrupt; observation.canRespond = actions.canRespond;
        return {resultError: commandResultIssue(this.commandResults), ...(this.profile.capabilities.models ? {supportsModels: true} : {}), ...(this.profile.capabilities.slashCommands ? {supportsSlashCommands: true} : {}), ...(this.nativeCommands.length ? {slashCommands: this.availableCommands()} : {}), usage: this.session?.usage, usageUnavailable: this.session?.usageUnavailable, observation, submission: this.submission ? {...this.submission} : undefined, submittedTurnId: this.submittedTurnId, draft: this.draft, draftAttachments: structuredClone(this.draftAttachments), sessionId: this.navigationSessionId ?? this.session?.id, title: this.session?.title.trim() || this.profile.kind,
            attachments: this.writable ? this.profile.capabilities.attachments : undefined,
            deletedSessionIds: this.deletedSessionIds.slice(),
            archived: !!this.session?.archived,
            createdAt: this.session?.createdAt, updatedAt: this.session?.updatedAt, writerLock: this.session?.writerLock,
            branchName: this.session?.branchName ?? (this.session?.parentSessionId ? undefined : 'main'),
            ...(this.profile.capabilities.fork !== undefined ? {forkSupport: this.profile.capabilities.checkpointFork ? 'turn' as const
                : this.profile.capabilities.fork ? 'latest' as const : 'none' as const} : {}),
            ...(this.lastFork && !this.lastFork.verified ? {forkFailure: {...this.lastFork}} : {}),
            messages: mergeMessages(this.messages, this.commandMessages()).map(m => projectCommandMessage(m, this.commandResults)), requests: this.requests.map(r => ({...r, responding: this.responses.some(p => p.id === r.id)})),
            hasEarlier: !!this.earlier,
            commandCatalogObservation: this.commandCatalogObservation ? {...this.commandCatalogObservation} : undefined,
            queryReceipts: this.queries.receipts(), pendingQueryReports: this.queries.pendingReports(), controls: this.controls.projection(), instructionQueue: queue, canQueue: this.loaded && this.writable && !this.lifetime.signal.aborted && !this.deletedSessionIds.length && !this.session?.archived && !this.navigationSessionId && !this.forking && this.pending?.operation !== 'fork' && !!this.journal && !!this.session && (!!this.session.owned || this.profile.capabilities.resume),
            ...actions, active, pending: observation.receiptUnknown, disconnected: observation.connection === 'offline', gap: this.gap};
    }
    private actions(observation: HarnessObservation): HarnessConversationActions {
        const available = observation.connection === 'online' && !observation.stale;
        const authorized = !this.deletedSessionIds.length && !this.lifetime.signal.aborted && this.writable && observation.connection === 'online';
        const ready = authorized && this.loaded && !this.busy && !this.pending;
        const dispatchReady = ready && !this.controls.blocksDispatch && !commandResultIssue(this.commandResults);
        const manageable = dispatchReady && available && !!this.session && !this.instructions.record.items.length;
        const inactive = !['running', 'waiting-approval', 'waiting-input'].includes(observation.execution);
        const settled = inactive && !this.commandResults.some(row => row.status === 'running') && !observation.receiptUnknown && !this.requests.length && !this.session?.archived && !this.navigationSessionId;
        const resumable = !!this.session?.resumable && (!!this.session?.owned || this.profile.capabilities.resume);
        const create = !this.session && this.profile.capabilities.create;
        const removable = observation.execution === 'idle' && !!this.session?.owned || !!this.session?.archived && this.session?.status === 'notLoaded';
        return {
            canQueryCommand: this.loaded && !this.lifetime.signal.aborted && !this.deletedSessionIds.length && !this.navigationSessionId
                && !!this.session && !!this.profile.capabilities.commandQueries && !!this.client.queryCommand,
            canCommand: ready && available && !this.refreshError && !!this.session && !this.session.archived && !!this.profile.capabilities.slashCommands,
            canSend: dispatchReady && settled && !this.refreshError && (create || available && resumable),
            canFork: manageable && settled && this.messages.some(message => message.role === 'user' || message.role === 'assistant') && !!this.client.fork && !!this.profile.capabilities.fork && this.session?.forkable !== false,
            canDelete: manageable && removable && !!this.client.delete && !!this.profile.capabilities.delete,
            canRename: manageable && !!this.client.rename && !!this.profile.capabilities.rename,
            canArchive: manageable && harnessArchiveAllowed(this.session) && !!this.client.archive && !!this.profile.capabilities.archive,
            canUnarchive: manageable && !!this.session?.archived && !!this.client.archive && !!this.profile.capabilities.unarchive,
            canInterrupt: authorized && this.loaded && available && !this.navigationSessionId && this.pending?.operation !== 'interrupt'
                && !!this.session?.owned && !!this.session.activeTurnId && this.session.interruptible !== false && this.profile.capabilities.interrupt
                && !this.turnResults.has(this.session.activeTurnId) && this.controls.canStart({sessionId: this.session.id, turnId: this.session.activeTurnId}),
            canRespond: authorized && available && this.pending?.operation !== 'respond' && !!this.session?.owned && this.profile.capabilities.interactions
                && this.requests.some(r => r.kind !== 'unsupported' && !this.responses.some(p => p.id === r.id)),
        };
    }
    private async restore() {
        if (this.loaded) return;
        const record = await this.journal?.load();
        if (record?.pending?.consumeDraft !== undefined && record.pending.consumeDraft !== false) throw new FSError('EINVAL', 'Invalid native draft consumption');
        if (record?.sessionId && !this.session) this.session = {id: record.sessionId, title: record.sessionId, cwd: null, status: null, updatedAt: null, resumable: false};
        this.deletedSessionIds = record?.deletedSessionIds ?? [];
        this.instructions.restore(record?.instructionQueue);
        this.controls.restore(record?.controls);
        this.pending = record?.pending; this.draft = record?.draft ?? '';
        if (this.pending?.forkCheckpoint) this.pending = {...this.pending, forkCheckpoint: validateForkCheckpoint(this.pending.forkCheckpoint)};
        this.lastFork = validateForkReceipt(record?.lastFork);
        this.responses = record?.responses?.map(row => ({...row})) ?? [];
        this.submittedTurnId = record?.submittedTurnId;
        this.submission = validateSubmission(record?.submission);
        this.draftRevision = record?.draftRevision ?? 0;
        this.commandResults = validateCommandReceipts(record?.commandResults);
        this.draftAttachments = readStoredAttachments(record?.draftAttachments); this.loaded = true;
    }
    private save(sessionId = this.session?.id): Promise<void> {
        const record = {controls: this.controls.records(), instructionQueue: structuredClone(this.instructions.record), sessionId, lastFork: this.lastFork, responses: this.responses.map(row => ({...row})), submission: this.submission ? {...this.submission} : undefined, submittedTurnId: this.submittedTurnId, deletedSessionIds: this.deletedSessionIds, pending: this.pending, draft: this.draft,
            draftAttachments: this.draftAttachments, draftRevision: this.draftRevision, commandResults: this.commandResults};
        const write = this.writes.then(() => this.journal?.save(record));
        this.writes = write.catch(() => {}); return write;
    }
    async saveDraft(text: string, attachments: HarnessAttachment[] = []) {
        await this.restore();
        await this.instructions.synchronize();
        if (text.length > 1024 * 1024) throw new FSError('EFBIG', 'Remote input draft too large');
        this.setDraft(text, validateAttachments(attachments)); await this.save();
    }
    private setDraft(text: string, attachments: HarnessAttachment[]): void {
        if (text !== this.draft || JSON.stringify(attachments) !== JSON.stringify(this.draftAttachments)) ++this.draftRevision;
        this.draft = text; this.draftAttachments = attachments;
    }
    private acceptDraft(submission: {inputText?: string; draftRevision?: number; consumeDraft?: false}): void {
        if (submission.consumeDraft === false) {
            try {console.debug('[Harness] Composer draft preserved', {operation: 'harness.draft.admission', operationId: this.pending?.requestId,
                stage: 'queued_admission', result: 'preserved', code: 'HARNESS_QUEUE_DRAFT_PRESERVED', durationMs: 0});} catch { /* Diagnostics do not own draft consumption. */ }
            return;
        }
        if (submission.draftRevision !== undefined && submission.draftRevision !== this.draftRevision) return;
        if (submission.inputText !== undefined && submission.inputText !== this.draft) return;
        this.setDraft('', []);
    }
    private startSubmission(id?: string): void {
        if (id !== undefined && (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) throw new FSError('EINVAL', 'Invalid submission identity');
        if (id && this.submission?.id === id) throw new FSError('ECONFLICT', 'Submission already tracked; reconcile its receipt');
        this.submission = id ? {id, status: 'pending'} : undefined;
    }
    private acceptSubmission(turnId?: string): void {
        if (this.submission?.status === 'pending') this.submission = {id: this.submission.id, status: 'accepted', turnId};
    }
    private rejectSubmission(code?: string): void {
        if (this.submission?.status === 'pending') this.submission = {id: this.submission.id, status: 'rejected', ...(code ? {code} : {})};
    }
    private async beforeSubmission<T>(read: () => Promise<T>): Promise<T> {
        try { return await read(); }
        catch (error) {
            if (error && typeof error === 'object') Object.assign(error, {outcome: 'not-committed'});
            throw error;
        }
    }
    private async prepareSession(): Promise<void> {
        try { await this.prepareNativeSession(); }
        catch (error) {
            // Preparation never dispatches the user's turn or command.
            if (!this.pending) {
                this.rejectSubmission(); await this.save();
                if (error && typeof error === 'object') Object.assign(error, {outcome: 'not-committed'});
            }
            throw error;
        }
    }
    private async prepareNativeSession(): Promise<void> {
        if (!this.session) this.session = (await this.native('create', options => this.client.create(this.profile.id, this.workspaceId, options))).session;
        else if (this.client.inspect) this.session = (await this.client.inspect(this.profile.id, this.session.id, this.options())).session;
        if (!this.session.owned) this.session = (await this.native('resume', options => this.client.resume(this.profile.id, this.session!.id, options))).session;
    }
    private async refreshSubmitted(): Promise<HarnessConversationSnapshot> {
        try {return await this.read();}
        catch (error) {
            this.disconnected = connectionLost(error);
            this.refreshError = this.errors.record('history', error);
            return this.snapshot();
        }
    }
    private acceptCommand(value: unknown, inputText: string, identity?: {operationId: string; epoch: string}): void {
        const operationId = identity?.operationId ?? this.pending?.requestId ?? this.submission?.id;
        const operationEpoch = identity?.epoch ?? this.pending?.epoch ?? this.journal?.epoch;
        const result = bindCommandOutput(validateCommandResult(value), operationId, operationEpoch);
        if (result.outputError) commandOutputDiagnostic(operationId, 'output', Date.now(), result.outputError);
        const prior = result.commandId ? this.commandResults.find(row => row.commandId === result.commandId) : undefined;
        const status = prior?.status === 'completed' ? 'completed' : result.status ?? (result.turnId ? 'running' : 'completed');
        const failed = prior?.failed ?? result.failed;
        this.submittedTurnId = result.turnId;
        this.acceptSubmission(result.turnId);
        if (this.submission) this.submission = {...this.submission, commandId: result.commandId, commandStatus: status, failed, resultError: undefined};
        if (result.commandId) {
            const record = {...result, ...prior, operationId, operationEpoch, commandId: result.commandId, output: result.output ?? prior?.output ?? inputText, status, failed};
            this.commandResults = replaceCommandRecord(this.commandResults, record);
        } else if (operationId) {
            this.commandResults = this.commandResults.filter(row => row.operationId !== operationId);
        }
        if (result.turnId && !this.completed.has(result.turnId)) {this.session!.activeTurnId = result.turnId; this.session!.status = 'active';}
    }
    private commandUpdated(params: Record<string, unknown>): void {
        const result = validateCommandResult(params);
        if (!result.commandId || !result.status) throw new FSError('EIO', 'Invalid native command update');
        const prior = this.commandResults.find(row => row.commandId === result.commandId);
        if (prior?.status === 'completed' && result.status === 'running') return;
        const record = {...prior, ...result, output: prior?.output ?? result.output ?? ''};
        if (prior?.outputRef) {record.outputRef = prior.outputRef; record.outputError = prior.outputError;}
        if (prior?.outputError && !result.outputRef) record.outputError = prior.outputError;
        this.commandResults = replaceCommandRecord(this.commandResults, record);
        this.commandResultsChanged = true;
        if (this.submission?.commandId === result.commandId) this.submission = {...this.submission, commandStatus: result.status, failed: result.failed};
    }
    private commandMessages(): HarnessMessage[] {
        const nativeIds = new Set(this.messages.map(message => message.id));
        return this.commandResults.flatMap(row => {
            const message = commandRecordMessage(row);
            return message && !nativeIds.has(message.id) ? [message] : [];
        });
    }
    private recordInvalidCommand(operationId: string, epoch: string): void {
        const resultError = {code: 'HARNESS_COMMITTED_RESULT_INVALID'};
        this.commandResults = replaceCommandRecord(this.commandResults, {operationId, operationEpoch: epoch, output: '', resultError});
        this.submission = {id: operationId, status: 'accepted', resultError};
    }
    private async captureInvalidCommand(error: unknown): Promise<boolean> {
        const started = Date.now();
        const receipt = committedReceipt(error), pending = this.pending;
        if (!receipt || !pending || receipt.requestId !== pending.requestId || pending.operation !== 'command') return false;
        this.recordInvalidCommand(pending.requestId, pending.epoch);
        commandOutputDiagnostic(pending.requestId, 'envelope', started, {code: 'HARNESS_COMMITTED_RESULT_INVALID'});
        if (!this.draftAttachments.length) this.acceptDraft(pending);
        this.pending = undefined;
        try {await this.save();} catch (failure) {this.pending = pending; throw failure;}
        return true;
    }
    private async applyCommandReceipt(receipt: import('./contracts').HarnessReceipt, inputText: string): Promise<boolean> {
        try {decodeCommittedResult(receipt, result => this.acceptCommand(result, inputText)); return true;}
        catch (error) {if (await this.captureInvalidCommand(error)) return false; throw error;}
    }
    async readCommandOutput(commandId: string, options?: import('./contracts').HarnessCommandOutputOptions) {
        await this.restore(); return this.readOutput(this.outputReference(commandId), options);
    }
    async loadCommandOutput(commandId: string, options?: import('./contracts').HarnessCommandOutputLoadOptions): Promise<ArrayBuffer> {
        await this.restore(); const ref = this.outputReference(commandId), started = Date.now();
        try {return await loadCommandOutput(ref, range => this.readOutput(ref, range), options);}
        catch (error) {commandOutputDiagnostic(ref.requestId, 'download', started, {code: (error as {code?: unknown})?.code}); throw error;}
    }
    private outputReference(commandId: string): import('./contracts').HarnessCommandOutputRef {
        const record = this.commandResults.find(row => row.commandId === commandId);
        const ref = record?.outputRef ?? this.messages.find(message => message.commandOutput?.commandId === commandId)?.commandOutput?.ref;
        if (!ref) throw new FSError('ENOENT', 'Native command output is unavailable; inspect its result notice');
        return {...ref};
    }
    private async readOutput(ref: import('./contracts').HarnessCommandOutputRef, options?: import('./contracts').HarnessCommandOutputOptions) {
        this.lifetime.signal.throwIfAborted(); options?.signal?.throwIfAborted(); const started = Date.now();
        if (!this.profile.capabilities.commandOutputs || !this.client.readCommandOutput) throw new FSError('ECAPABILITY', 'Native command output reads are unavailable');
        try {
            const range = {...this.options(), ...options}, page = await this.client.readCommandOutput(this.profile.id, {...ref}, range);
            this.lifetime.signal.throwIfAborted(); options?.signal?.throwIfAborted();
            return validateCommandOutputPage(page, ref, range);
        } catch (error) {
            commandOutputDiagnostic(ref.requestId, 'read', started, {code: (error as {remoteCode?: string})?.remoteCode ?? (error as {code?: string})?.code});
            throw error;
        }
    }
    private async native<T>(operation: string, call: (options: import('./contracts').HarnessMutationOptions) => Promise<T>,
        submission?: {inputText: string; draftRevision: number; consumeDraft?: false}, committed?: (result: T) => void, forkCheckpoint?: ForkCheckpoint): Promise<T> {
        const epoch = this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        const requestId = ['turn', 'command'].includes(operation) && this.submission?.status === 'pending' ? this.submission.id : createRequestId();
        this.pending = {requestId, epoch, operation, ...submission, ...(forkCheckpoint ? {forkCheckpoint} : {})};
        try {
            try { await this.save(); } catch (error) { this.pending = undefined; throw error; }
            const result = await call({...this.options(), ...this.pending});
            const session = (result as {session?: HarnessSession} | undefined)?.session;
            if (operation === 'delete') this.deletedSessionIds = (result as {deletedSessionIds: string[]}).deletedSessionIds;
            decodeCommittedResult({requestId, outcome: 'committed', result}, () => committed?.(result));
            if (operation === 'turn' || operation === 'command' && !this.draftAttachments.length) this.acceptDraft(this.pending);
            const pending = this.pending; this.pending = undefined;
            try { await this.save(operation === 'fork' ? this.session?.id : session?.id ?? this.session?.id); } catch (error) { this.pending = pending; throw error; }
            return result;
        } catch (error) {
            if (operation === 'command' && await this.captureInvalidCommand(error)) throw error;
            if ((error as {outcome?: string})?.outcome === 'not-committed') {
                this.rejectSubmission((error as {code?: string; remoteCode?: string}).remoteCode ?? (error as {code?: string}).code); this.pending = undefined; await this.save();
            } else if (this.pending && error && typeof error === 'object' && (error as {outcome?: string}).outcome !== 'committed') Object.assign(error, {outcome: 'unknown'});
            throw error;
        }
    }
    async read(): Promise<HarnessConversationSnapshot> {
        await this.restore();
        if (this.pending?.operation === 'delete') return this.reconcile();
        if (this.deletedSessionIds.length) return this.snapshot();
        if (this.session) {
            const history = await this.client.read(this.profile.id, this.session.id, {...this.options(), toolDetail: 'summary'});
            await this.observeHistoryCompletion(history);
            const nativeMessages = historyMessages(history); this.observeCommandHistory(nativeMessages);
            const messages = nativeMessages.map(message => projectCommandMessage(message, this.commandResults));
            for (const value of history.turns ?? []) {
                const turn = value as {id?: string; status?: string};
                if (turn.id) this.recordTurnResult(turn.id, turn.status);
            }
            this.messages = this.expandedHistory ? mergeMessages(this.messages, messages) : messages;
            this.session = {...history.session, lastTurnResult: history.session.lastTurnResult ?? (history.session.lastTurnId ? this.turnResults.get(history.session.lastTurnId) : undefined)};
            if (this.session.lastTurnId) this.recordTurnResult(this.session.lastTurnId, this.session.lastTurnResult);
            if (history.eventCursor) this.cursor = {...history.eventCursor};
            this.observedAt = Date.now(); this.source = 'history'; this.gap = false;
            if (!this.expandedHistory) { this.earlier = history.nextCursor ?? undefined; this.historyCursors.clear(); }
            for (const message of this.messages) if (message.status === 'completed') this.completedItems.add(message.id);
            while (this.completedItems.size > 1000) this.completedItems.delete(this.completedItems.values().next().value!);
        }
        this.disconnected = this.nativeDisconnected = false;
        this.refreshError = undefined; this.errors.clear('history');
        if (this.session) {
            try {
                const page = await this.client.eventSnapshot(this.profile.id, this.cursor, {...this.options(), toolDetail: 'summary'});
                this.requests = page.requests.filter(r => r.params?.threadId === this.session!.id).flatMap(nativeRequest);
                await this.reconcileResponses();
            } catch (error) {this.refreshError = this.errors.record('events', error);}
        }
        try {await this.controls.reconcile();} catch (error) {this.refreshError = this.errors.record('controls', error);}
        return this.snapshot();
    }
    async loadEarlier() {
        if (!this.session || !this.earlier || this.busy) throw new FSError('EBUSY','No earlier history available');
        const history = await this.client.read(this.profile.id, this.session.id, {...this.options(), cursor:this.earlier, toolDetail: 'summary'});
        if (history.nextCursor === this.earlier || history.nextCursor && this.historyCursors.has(history.nextCursor)) throw new FSError('EIO','History cursor did not advance');
        await this.observeHistoryCompletion(history);
        this.messages = mergeMessages(historyMessages(history), this.messages); this.expandedHistory = true;
        this.historyCursors.add(this.earlier);
        this.earlier = history.nextCursor ?? undefined;
        return this.snapshot();
    }
    branches() {
        if (!this.session) return Promise.resolve([]);
        return conversationBranches(this.client, this.profile.id, this.session, this.options());
    }
    async fork(name?: string) {
        return this.forkNative(name);
    }
    async forkAt(target: {turnId: string; messageId?: string}, name?: string) {
        if (!this.profile.capabilities.checkpointFork) throw new FSError('ECAPABILITY', 'Exact native checkpoint fork is unavailable');
        if (!target || typeof target.turnId !== 'string' || !target.turnId || target.turnId.length > 256) throw new FSError('EINVAL', 'Invalid native checkpoint');
        if (!this.messages.some(message => message.turnId === target.turnId && (!target.messageId || message.id === target.messageId)))
            throw new FSError('ECONFLICT', 'Native fork checkpoint is no longer in the observed history');
        return this.forkNative(name, {sourceSessionId: this.session!.id, turnId: target.turnId});
    }
    private async forkNative(name?: string, checkpoint?: ForkCheckpoint) {
        if (!this.snapshot().canFork || !this.client.fork) throw new FSError('ECAPABILITY','Conversation cannot fork');
        if (name && name.length > 256) throw new FSError('EINVAL','Branch name too long');
        this.forking = true;
        try {return await this.performFork(name, checkpoint);} finally {this.forking = false;}
    }
    private async performFork(name?: string, checkpoint?: ForkCheckpoint) {
        await this.mutate(async () => {
            await this.native('fork', options => this.client.fork!(this.profile.id, this.session!.id, name,
                {...options, ...(checkpoint ? {lastTurnId: checkpoint.turnId} : {})}), undefined,
            result => this.acceptFork(result, checkpoint), checkpoint);
        });
        const error = forkFailure(this.lastFork); if (error) throw error;
        this.navigationSessionId = this.lastFork!.sessionId;
        return this.snapshot();
    }
    private acceptFork(result: unknown, checkpoint?: ForkCheckpoint): void {
        const source = checkpoint?.sourceSessionId ?? this.session!.id;
        if (source !== this.session!.id) throw new FSError('EIO', 'Native fork source changed');
        this.lastFork = forkReceipt(this.pending!.requestId, source, result, checkpoint);
    }
    async refresh() {
        if (this.deletedSessionIds.length) return this.snapshot();
        let stage = 'events';
        try {
            const page = await this.client.eventSnapshot(this.profile.id, this.cursor, {...this.options(), toolDetail: 'summary'});
            this.disconnected = false;
            const repair = page.gap || !!this.cursor && this.cursor.eventEpoch !== page.epoch;
            if (repair && this.busy) {
                this.consume({...page, events: []}); this.gap = true;
                this.errors.clear('events');
                return this.snapshot();
            }
            if (repair) { stage = 'history'; await this.read(); this.gap = true; }
            stage = 'projection';
            if (!repair) this.consume(page);
            if (!repair && !this.busy) {
                stage = 'inspect'; await this.inspect(page);
                stage = 'history'; await this.recoverQueuedTerminal();
            }
            if (!repair && page.events.some(e => e.message.method === 'turn/completed' && e.message.params?.threadId === this.session?.id)) {
                stage = 'history'; await this.read();
            }
            if (!this.cursor || this.cursor.eventEpoch !== page.epoch || this.cursor.after < page.cursor)
                this.cursor = {after: page.cursor, eventEpoch: page.epoch};
            stage = 'controls'; await this.controls.reconcile();
            this.refreshError = undefined;
            for (const recovered of ['events', 'projection', 'inspect', 'history', 'controls']) this.errors.clear(recovered);
        } catch (error) {
            if (this.lifetime.signal.aborted) throw error;
            this.disconnected = connectionLost(error);
            this.refreshError = this.errors.record(stage, error);
        }
        if (this.writable && !this.busy) {
            if (this.commandResultsChanged) {await this.save(); this.commandResultsChanged = false;}
            await this.instructions.pump();
        }
        return this.snapshot();
    }
    private async inspect(page: HarnessEvents): Promise<void> {
        if (!this.session || !this.client.inspect || Date.now() - this.inspectedAt < 15_000) return;
        this.session = (await this.client.inspect(this.profile.id, this.session.id, this.options())).session;
        this.observedAt = Date.now(); this.inspectedAt = this.observedAt;
        if (this.session.lastTurnId) this.recordTurnResult(this.session.lastTurnId, this.session.lastTurnResult);
        this.requests = page.requests.filter(r => r.params?.threadId === this.session?.id).flatMap(nativeRequest);
        this.nativeDisconnected = false;
    }
    private async recoverQueuedTerminal(): Promise<void> {
        const head = this.instructions.record.items[0], turnId = head?.receipt?.turnId;
        if (!turnId || head.terminal || this.turnResults.has(turnId) || this.session?.status !== 'idle'
            || this.session.activeTurnId || Date.now() - this.terminalReadAt < 15_000) return;
        this.terminalReadAt = Date.now(); await this.read();
    }
    private consume(page: HarnessEvents) {
        for (const {message, timestamp} of page.events) {
            if (message.method === 'harness/disconnected' && (!message.params?.threadId || message.params.threadId === this.session?.id)) this.nativeDisconnected = true;
            if (!this.session || message.params?.threadId !== this.session.id) continue;
            this.consumeEvent(message.method, message.params, timestamp);
        }
        this.requests = page.requests.filter(r => this.session && r.params?.threadId === this.session.id).flatMap(nativeRequest);
        if (this.requests.length) { this.observedAt = Date.now(); this.source = 'events'; }
    }
    private consumeEvent(method: string, params: Record<string, unknown>, at?: number) {
        if (method === 'harness/command/updated' && params.threadId === this.session?.id) this.commandUpdated(params);
        if (method === 'harness/commands/updated') this.nativeCommands = validateCommands({commands: params.commands});
        const prior = this.session!;
        this.session = applyHarnessStatus(prior, {method, params});
        if (this.session !== prior) {
            this.observedAt = Date.now(); this.source = 'events'; this.gap = false;
            if (['thread/status/changed', 'turn/started', 'turn/completed'].includes(method)) this.nativeDisconnected = false;
        }
        const turn = params.turn as {id?: string} | undefined;
        const turnId = typeof params.turnId === 'string' ? params.turnId : this.session?.activeTurnId ?? undefined;
        if (method === 'turn/started' && turn?.id && !this.completed.has(turn.id)) { this.session!.activeTurnId = turn.id; this.session!.status = 'active'; }
        if (method === 'turn/completed' && turn?.id) {
            this.recordTurnResult(turn.id, (turn as {status?: string}).status);
            this.completed.add(turn.id);
            if (this.completed.size > 1024) this.completed.delete(this.completed.values().next().value!);
            if (!this.session!.activeTurnId || this.session!.activeTurnId === turn.id) { this.session!.activeTurnId = null; this.session!.status = 'idle'; }
        }
        if (method === 'item/started' || method === 'item/completed') {
            const message = nativeMessage(params.item, `item:${String(params.itemId ?? '')}`, turnId, at);
            if (message) { this.replace(message); if (method === 'item/completed') { this.completedItems.add(message.id); if (this.completedItems.size > 1000) this.completedItems.delete(this.completedItems.values().next().value!); } }
        }
        if (['item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta'].includes(method)
            && typeof params.delta === 'string' && typeof params.itemId === 'string' && !this.completedItems.has(params.itemId)) {
            if (method === 'item/commandExecution/outputDelta') return;
            const prior = this.messages.find(m => m.id === params.itemId);
            this.replace({...prior, id: params.itemId, turnId: turnId ?? prior?.turnId, timestamp: prior?.timestamp ?? at, role: method.includes('reasoning') ? 'system' : 'assistant', text: (prior?.text ?? '') + params.delta, status: prior?.status ?? 'running'});
        }
    }
    private replace(message: HarnessMessage) {
        this.messages = mergeMessages(this.messages, [projectCommandMessage(message, this.commandResults)]);
    }
    private observeCommandHistory(messages: readonly HarnessMessage[]): void {
        for (const row of this.commandResults) {
            if (row.status !== 'running' || !row.commandId) continue;
            const terminal = messages.find(message => message.id === `command:${row.commandId}` && ['completed', 'failed'].includes(message.status ?? ''));
            if (terminal) this.commandUpdated({commandId: row.commandId, status: 'completed', failed: terminal.status === 'failed'});
        }
    }
    private async observeHistoryCompletion(history: import('./contracts').HarnessHistory): Promise<void> {
        const started = Date.now(), sessionId = this.session!.id;
        const proofs = await recoverHistoryCompletions(history, sessionId, this.instructions.record.items);
        if (this.lifetime.signal.aborted || this.session?.id !== sessionId) return;
        for (const proof of proofs) {
            const status = proof.status === 'interrupted' ? 'cancelled' : proof.status;
            if (this.turnResults.get(proof.turnId) === status) continue;
            this.recordTurnResult(proof.turnId, proof.status);
            console.info('[Harness] Turn history evidence', {operation: 'turn.history.reconcile', operationId: proof.turnId,
                sessionId: this.session!.id, stage: 'native_history', result: 'confirmed', code: 'HARNESS_TURN_HISTORY_CONFIRMED',
                durationMs: Date.now() - started});
        }
    }
    private recordTurnResult(id: string, status?: string): void {
        const result = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'interrupted' || status === 'cancelled' ? 'cancelled' : undefined;
        if (!result) return;
        this.turnResults.set(id, result);
        this.controls.observeTerminal(id, result);
        this.commandResults = this.commandResults.map(command => {
            if (command.turnId !== id || command.status !== 'running') return command;
            this.commandResultsChanged = true;
            return {...command, status: 'completed', failed: result !== 'completed'};
        });
        if (this.turnResults.size > 1024) this.turnResults.delete(this.turnResults.keys().next().value!);
    }
    async send(text: string, attachments?: HarnessAttachment[], selection?: HarnessModelSelection, submissionId?: string) {
        return this.sendTurn(text, attachments, selection, submissionId);
    }
    private async sendTurn(text: string, attachments?: HarnessAttachment[], selection?: HarnessModelSelection, submissionId?: string, queued = false) {
        const {prompt, attachments: prepared} = prepareTurnInput(text, attachments);
        const requested = selection ? validateModelSelection(selection) : undefined;
        if (!this.loaded || Date.now() - this.observedAt > 30_000) await this.beforeSubmission(() => this.read());
        if (!this.snapshot().canSend) throw new FSError('EBUSY', 'Conversation cannot send');
        if (attachments?.some(file => !this.profile.capabilities.attachments?.includes(file.kind))) throw new FSError('ECAPABILITY', 'Attachment kind unavailable');
        const selected = requested ? validateAvailableSelection(requested, await this.beforeSubmission(() => this.models())) : undefined;
        if (!this.snapshot().canSend) throw new FSError('EBUSY', 'Conversation cannot send');
        this.submittedTurnId = undefined;
        if (!queued) this.setDraft(text, prepared);
        this.startSubmission(submissionId);
        const submission = {inputText: text, draftRevision: this.draftRevision, ...(queued ? {consumeDraft: false as const} : {})};
        return this.mutate(async () => {
            await this.prepareSession();
            await this.native('turn', options => this.client.turn(this.profile.id, this.session!.id, prompt,
                {...options, ...(selected ? {selection: selected} : {}), ...(prepared.length ? {attachments: prepared} : {})}), submission, ({turnId}) => {
                this.submittedTurnId = turnId;
                this.acceptSubmission(turnId);
                if (!this.completed.has(turnId)) { this.session!.activeTurnId = turnId; this.session!.status = 'active'; }
                this.replace({id: `submitted:${turnId}`, role: 'user', text: text.trim() ? text : prompt, turnId, timestamp: Date.now()});
            });
        }).then(() => this.refreshSubmitted());
    }
    async interrupt(request?: HarnessInterruptRequest) {
        if (request?.operationId && this.controls.has(request.operationId)) {await this.controls.start({...request}); return this.snapshot();}
        const target = request ? {...request} : this.session?.activeTurnId ? {sessionId: this.session.id, turnId: this.session.activeTurnId} : undefined;
        if (!target || target.sessionId !== this.session?.id || target.turnId !== this.session.activeTurnId)
            throw new FSError('ECONFLICT', 'Native control target changed');
        if (!this.snapshot().canInterrupt) throw new FSError('EACCES', 'Conversation cannot interrupt');
        await this.controls.start(target); return this.snapshot();
    }
    async reconcileControl(operationId?: string): Promise<HarnessConversationSnapshot> {
        await this.restore();
        if (operationId && !this.controls.has(operationId)) throw new FSError('ENOENT', 'Native control recovery record unavailable');
        await this.instructions.synchronize();
        await this.controls.reconcile(operationId, true);
        return this.read();
    }
    async rename(name: string) {
        if (!this.snapshot().canRename || !name.trim() || new TextEncoder().encode(name.trim()).byteLength > 512 || /[\x00-\x1f\x7f]/.test(name)) throw new FSError('EACCES', 'Native rename unavailable');
        return this.mutate(async () => {
            this.session = (await this.native('rename', options => this.client.rename!(this.profile.id, this.session!.id, name.trim(), options))).session;
            this.observedAt = Date.now();
        });
    }
    async archive(archived: boolean) {
        if (!(archived ? this.snapshot().canArchive : this.snapshot().canUnarchive)) throw new FSError('EACCES', 'Native archive operation unavailable');
        return this.mutate(async () => {
            this.session = (await this.native(archived ? 'archive' : 'unarchive', options => this.client.archive!(this.profile.id, this.session!.id, archived, options))).session;
            this.observedAt = Date.now();
        });
    }
    async delete() {
        if (!this.snapshot().canDelete) throw new FSError('EACCES', 'Native deletion unavailable');
        return this.mutate(async () => {
            const result = await this.native('delete', options => this.client.delete!(this.profile.id, this.session!.id, options));
            this.deletedSessionIds = result.deletedSessionIds; this.messages = []; this.requests = [];
            this.commandResults = []; this.setDraft('', []); await this.save();
        });
    }
    async respond(id: string | number, response: Record<string, unknown>) {
        const request = this.requests.find(r => r.id === id && r.kind !== 'unsupported');
        if (this.lifetime.signal.aborted || !this.writable || this.pending?.operation === 'respond' || !this.session?.owned || !this.profile.capabilities.interactions || !request || this.responses.some(p => p.id === id))
            throw new FSError('EACCES', 'Interaction no longer pending or not owned');
        const epoch = this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        if (this.responses.some(p => p.id === id)) throw new FSError('EBUSY', 'Response already pending');
        const pending = {id, epoch, requestId: createRequestId()};
        this.responses.push(pending); this.responseBusy.add(pending.requestId);
        let sent = false;
        try {
            await this.save();
            sent = true;
            await this.client.respond(this.profile.id, id, response, {...this.options(), ...pending});
            this.requests = this.requests.filter(r => r.id !== id);
            this.responses = this.responses.filter(p => p !== pending); await this.save();
        } catch (error) {
            if (!sent || (error as {outcome?: string})?.outcome === 'not-committed') {this.responses = this.responses.filter(p => p !== pending); await this.save();}
            throw error;
        } finally {this.responseBusy.delete(pending.requestId);}
        return this.snapshot();
    }
    private async reconcileResponses(): Promise<void> {
        for (const pending of [...this.responses]) {
            if (this.responseBusy.has(pending.requestId)) continue;
            const receipt = await this.client.operation(this.profile.id, pending.requestId, {...this.options(), epoch: pending.epoch});
            if (receipt.outcome === 'unknown') continue;
            if (receipt.outcome === 'committed') this.requests = this.requests.filter(r => r.id !== pending.id);
            this.responses = this.responses.filter(p => p !== pending); await this.save();
        }
    }
    private async mutate(action: () => Promise<void>) {
        this.busy = true;
        try { await action(); } finally { this.busy = false; }
        return this.snapshot();
    }
    async reconcileQuery(operationId: string): Promise<HarnessConversationSnapshot> {
        await this.restore();
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw new FSError('EINVAL', 'Invalid query identity');
        await this.queries.reconcile(operationId); this.notify(); return this.snapshot();
    }
    async reconcile(submissionId?: string): Promise<HarnessConversationSnapshot> {
        await this.restore();
        if (submissionId && await this.queries.reconcile(submissionId)) {this.notify(); return this.snapshot();}
        await this.reconcileResponses();
        await this.controls.reconcile();
        const issue = this.commandResults.find(row => row.resultError && (!submissionId || row.operationId === submissionId));
        if (issue?.operationId && !this.pending) {
            await this.reconcileSubmission(issue.operationId); return this.readReconciled();
        }
        if (submissionId && !this.instructions.hasReceipt(submissionId)) await this.instructions.reload();
        if (submissionId && this.instructions.hasReceipt(submissionId)) {
            const snapshot = await this.read();
            if (await this.instructions.settleAccepted(submissionId, snapshot)) this.notify();
            return {...this.snapshot(), submission: {id: submissionId, status: 'accepted'}};
        }
        if (!this.pending) {
            if (submissionId && (this.submission?.id !== submissionId || this.submission.status === 'pending')) await this.reconcileSubmission(submissionId);
            return this.readReconciled();
        }
        if (submissionId && this.submission?.id !== submissionId) return this.snapshot();
        const receipt = await this.client.operation(this.profile.id, this.pending.requestId, {...this.options(), epoch: this.pending.epoch});
        if (receipt.requestId !== this.pending.requestId) throw new FSError('EIO', 'Mismatched harness receipt');
        if (receipt.outcome === 'unknown') return this.snapshot();
        const result = receipt.result as {session?: HarnessSession; turnId?: string; deletedSessionIds?: string[]} | undefined;
        if (receipt.outcome === 'committed') {
            if (['create', 'resume', 'rename', 'archive', 'unarchive'].includes(this.pending.operation)) this.session = validateSession(result?.session);
            if (this.pending.operation === 'delete') {
                this.deletedSessionIds = validateDeletedSessionIds(result?.deletedSessionIds, this.session!.id); this.messages = []; this.requests = [];
                this.commandResults = []; this.setDraft('', []);
            }
            if (this.pending.operation === 'fork') this.acceptFork(result, this.pending.forkCheckpoint);
            if (this.pending.operation === 'command') {
                if (!await this.applyCommandReceipt(receipt, this.pending.inputText ?? '')) return this.snapshot();
                if (!this.draftAttachments.length) this.acceptDraft(this.pending);
            }
            if (this.pending.operation === 'turn') {
                if (typeof result?.turnId !== 'string') throw new FSError('EIO', 'Invalid turn receipt');
                this.submittedTurnId = result.turnId;
                this.acceptSubmission(result.turnId);
                this.acceptDraft(this.pending);
            }
        }
        if (receipt.outcome !== 'committed' || ['create', 'resume'].includes(this.pending.operation)) this.rejectSubmission(receipt.code);
        const pending = this.pending; this.pending = undefined;
        try { await this.save(); } catch (error) { this.pending = pending; throw error; }
        if (pending.operation === 'fork') {
            const error = forkFailure(this.lastFork); if (error) throw error;
            this.navigationSessionId = this.lastFork!.sessionId;
        }
        return this.readReconciled();
    }
    private async readReconciled(): Promise<HarnessConversationSnapshot> {
        await this.read(); if (this.writable) await this.instructions.pump(); return this.snapshot();
    }
    private async reconcileSubmission(id: string): Promise<void> {
        if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new FSError('EINVAL', 'Invalid submission identity');
        const failure = this.commandResults.find(row => row.operationId === id && row.resultError);
        const epoch = failure?.operationEpoch ?? this.journal?.epoch ?? (await this.client.profiles(this.options())).epoch;
        const receipt = await this.client.operation(this.profile.id, id, {...this.options(), epoch});
        if (receipt.requestId !== id) throw new FSError('EIO', 'Mismatched submission receipt');
        if (receipt.outcome === 'unknown') return;
        if (failure && receipt.outcome !== 'committed') return;
        let result: import('./contracts').HarnessCommandResult | undefined;
        if (receipt.outcome === 'committed') {
            try {result = validateCommandResult(receipt.result);}
            catch {this.recordInvalidCommand(id, epoch); await this.save(); return;}
            if (failure) this.acceptCommand(result, '', {operationId: id, epoch});
        }
        const turnId = result?.turnId;
        this.submission = {id, status: receipt.outcome === 'committed' ? 'accepted' : 'rejected', turnId, commandId: result?.commandId, commandStatus: result?.status, failed: result?.failed, ...(receipt.code ? {code: receipt.code} : {})};
        if (turnId) this.submittedTurnId = turnId;
        await this.save();
    }
    private async reconcileInstruction(id: string): Promise<HarnessConversationSnapshot> {
        if (this.busy) return this.snapshot();
        if (this.pending) return this.reconcile();
        if (this.submission?.id !== id || this.submission.status === 'pending' || this.submission.resultError) await this.reconcileSubmission(id);
        return this.snapshot();
    }
    close(): Promise<void> {
        this.lifetime.abort(); this.localListeners.clear();
        return this.closing ??= this.writes.then(() => this.client.close());
    }
}

/** Structural port for hosts; alternate transports do not inherit the implementation. */
export interface HarnessConversationPort {
    readCommandOutput?(commandId: string, options?: import('./contracts').HarnessCommandOutputOptions): Promise<import('./contracts').HarnessCommandOutputPage>;
    loadCommandOutput?(commandId: string, options?: import('./contracts').HarnessCommandOutputLoadOptions): Promise<ArrayBuffer>;
    reconcileQuery?(operationId: string): Promise<HarnessConversationSnapshot>;
    queryCommand?(name: string, args?: string, operationId?: string, expected?: Pick<HarnessSlashCommand, 'id' | 'revision' | 'kind' | 'execution'>): Promise<HarnessConversationSnapshot>;
    enqueue?(text: string, attachments?: HarnessAttachment[], selection?: HarnessModelSelection, submissionId?: string): Promise<HarnessConversationSnapshot>;
    editInstructionQueue?(edit: HarnessQueueEdit): Promise<HarnessConversationSnapshot>;
    subscribe(listener: () => void): () => void;
    readonly kind: string;
    commands?(): Promise<import('./contracts').HarnessSlashCommand[]>;
    command?(name: string, args?: string, selection?: HarnessModelSelection, inputText?: string, submissionId?: string, expected?: Pick<HarnessSlashCommand,'id' | 'revision' | 'kind' | 'execution'>): Promise<HarnessConversationSnapshot>;
    snapshot(): HarnessConversationSnapshot;
    delete?(): Promise<HarnessConversationSnapshot>;
    rename?(name: string): Promise<HarnessConversationSnapshot>;
    archive?(archived: boolean): Promise<HarnessConversationSnapshot>;
    fork(name?: string): Promise<HarnessConversationSnapshot>;
    forkAt?(target: {turnId: string; messageId?: string}, name?: string): Promise<HarnessConversationSnapshot>;
    branches(): Promise<HarnessSession[]>;
    loadEarlier(): Promise<HarnessConversationSnapshot>;
    saveDraft(text: string, attachments?: HarnessAttachment[]): Promise<void>;
    read(): Promise<HarnessConversationSnapshot>;
    refresh(): Promise<HarnessConversationSnapshot>;
    models?(): Promise<HarnessModelCatalog>;
    send(text: string, attachments?: HarnessAttachment[], selection?: HarnessModelSelection, submissionId?: string): Promise<HarnessConversationSnapshot>;
    interrupt(request?: HarnessInterruptRequest): Promise<HarnessConversationSnapshot>;
    reconcileControl?(operationId?: string): Promise<HarnessConversationSnapshot>;
    respond(id: string | number, response: Record<string, unknown>): Promise<HarnessConversationSnapshot>;
    reconcile(submissionId?: string): Promise<HarnessConversationSnapshot>;
    close(): Promise<void>;
}
