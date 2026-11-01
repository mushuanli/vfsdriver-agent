import {validateAuthorization, validateProjectCapabilities, type RemoteAuthorization, type RemoteProjectCapabilities} from './authorization';
import { MCPDirectorySyncClient, type DirectorySyncClient } from './directory-sync';
import { FSError, type OperationOptions } from '@itookit/vfs-core';
import { MCPHarnessClient } from './harness/client';
import { HarnessRpc } from './harness/rpc';
import type { HarnessClient } from './harness/contracts';
import { validateFileSearch, validateSearchDirectory, type FileSearchQuery, type FileSearchResult } from './search';

export interface ProjectMount { alias: string; path: string; at: string; access: 'ro' | 'rw' }
export interface RemoteProject {
    authorization?: RemoteAuthorization; capabilities?: RemoteProjectCapabilities;
    id: string; name: string; alias: string; path: string; access: 'ro' | 'rw'; revision: number; mounts: ProjectMount[];
}
export interface RegisterProject { name: string; alias: string; path: string; access: 'ro' | 'rw'; mounts?: ProjectMount[]; createDirectory?: boolean }
export interface ProjectProcess { state: string; stdout: string; stderr: string; code: number | null; error: string | null; truncated: boolean }
export interface ProjectClient {
    search?(project: RemoteProject, query: FileSearchQuery, options?: OperationOptions): Promise<FileSearchResult>;
    roots(options?: OperationOptions): Promise<{ roots: Array<{alias: string; access: 'ro' | 'rw'}>; execution: boolean; backend: string }>;
    list(options?: OperationOptions): Promise<RemoteProject[]>;
    read(id: string, options?: OperationOptions): Promise<RemoteProject>;
    register(input: RegisterProject, options?: OperationOptions): Promise<RemoteProject>;
    configure(project: RemoteProject, name: string, mounts: ProjectMount[], options?: OperationOptions): Promise<RemoteProject>;
    remount?(project: RemoteProject, access: 'ro' | 'rw', options?: OperationOptions): Promise<RemoteProject>;
    forget(project: RemoteProject, options?: OperationOptions): Promise<void>;
    exec(project: RemoteProject, input: {command: string; args: string[]; cwd?: string; timeoutMs?: number; readOnly?: boolean; epoch: string; requestId: string}, options?: OperationOptions): Promise<ProjectProcess>;
    harness(project: RemoteProject, options?: {readOnly?: boolean}): HarnessClient;
    directorySync(): DirectorySyncClient;
    close(): Promise<void>;
}
export class MCPProjectClient implements ProjectClient {
    constructor(private readonly rpc: HarnessRpc) {}
    async search(project: RemoteProject, query: FileSearchQuery, options?: OperationOptions) {
        validateSearchDirectory(query.directory);
        const meta = await this.rpc.metadata?.(options);
        const capabilities = meta?.['itookit/cells'] as {fileSearch?: boolean; fileSearchVersion?: number; searchKeywords?: boolean} | undefined;
        if (capabilities?.fileSearch === false) throw new FSError('ECAPABILITY', 'Server file search unavailable');
        if (/[^\S\r\n]/u.test(query.query) && capabilities?.searchKeywords !== true)
            throw new FSError('ECAPABILITY', 'Keyword search requires a newer server');
        if (query.mode === 'name' || query.directory) {
            if (typeof capabilities?.fileSearchVersion !== 'number' || !Number.isSafeInteger(capabilities.fileSearchVersion) || capabilities.fileSearchVersion < 2) throw new FSError('ECAPABILITY', 'Scoped file search requires a newer server');
        }
        return validateFileSearch(await this.rpc.call('project_search', {projectId: project.id, revision: project.revision, ...query}, options));
    }
    async roots(options?: OperationOptions) {
        const value = await this.rpc.call('project_roots', {}, options) as Awaited<ReturnType<ProjectClient['roots']>>;
        if (!value || !Array.isArray(value.roots) || typeof value.execution !== 'boolean' || typeof value.backend !== 'string'
            || value.roots.some(root => !root || typeof root.alias !== 'string' || !['ro','rw'].includes(root.access))) throw new FSError('EIO','Invalid project roots');
        return value;
    }
    async list(options?: OperationOptions) {
        const value = await this.rpc.call('project_list',{},options) as {projects?: unknown[]};
        if (!Array.isArray(value?.projects)) throw new FSError('EIO','Invalid project list');
        return value.projects.map(validateProject);
    }
    read(id: string, options?: OperationOptions) { return this.project('project_read',{projectId:id},options); }
    register(input: RegisterProject, options?: OperationOptions) { return this.project('project_register',input,options); }
    configure(project: RemoteProject, name: string, mounts: ProjectMount[], options?: OperationOptions) {
        return this.project('project_configure',{projectId:project.id,revision:project.revision,name,mounts},options);
    }
    remount(project: RemoteProject, access: 'ro' | 'rw', options?: OperationOptions) {
        return this.project('project_remount', {projectId: project.id, revision: project.revision, access}, options);
    }
    async forget(project: RemoteProject, options?: OperationOptions) {
        const value=await this.rpc.call('project_forget',{projectId:project.id,revision:project.revision},options) as {forgotten?: string};
        if (value?.forgotten!==project.id) throw new FSError('EIO','Invalid project removal');
    }
    async exec(project: RemoteProject, input: Parameters<ProjectClient['exec']>[1], options?: OperationOptions) {
        const value = await this.rpc.call('project_exec',{projectId:project.id,revision:project.revision,...input},options) as {process?: ProjectProcess};
        if (!value?.process || typeof value.process.state !== 'string' || typeof value.process.stdout !== 'string' || typeof value.process.stderr !== 'string') throw new FSError('EIO','Invalid project process');
        return value.process;
    }
    harness(project: RemoteProject, options?: {readOnly?: boolean}) { return new MCPHarnessClient(this.rpc,{projectId:project.id,revision:project.revision,capabilities:project.capabilities,...options}); }
    private async project(name: string, args: object, options?: OperationOptions) {
        const value = await this.rpc.call(name,args,options) as {project?: unknown}; return validateProject(value?.project);
    }
    directorySync() { return new MCPDirectorySyncClient(this.rpc); }
    close() { return this.rpc.close(); }
}
function validateProject(value: unknown): RemoteProject {
    const project = value as RemoteProject | undefined;
    if (!project || typeof project.id !== 'string' || typeof project.name !== 'string' || typeof project.alias !== 'string'
        || typeof project.path !== 'string' || !['ro','rw'].includes(project.access) || !Number.isSafeInteger(project.revision)
        || project.revision < 1 || !Array.isArray(project.mounts)) throw new FSError('EIO','Invalid project descriptor');
    if (project.mounts.some(mount => !mount || typeof mount.alias !== 'string' || typeof mount.path !== 'string'
        || typeof mount.at !== 'string' || !['ro','rw'].includes(mount.access))) throw new FSError('EIO','Invalid project mount');
    return {...project, authorization: validateAuthorization(project.authorization), capabilities: validateProjectCapabilities(project.capabilities)};
}
