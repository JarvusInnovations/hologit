declare module 'hologit' {
    import { Git as GitClient } from 'git-client';
    import { Docker } from 'dockerode';

    export interface GitOptions {
        gitDir: string;
        workTree?: string | null;
    }

    export interface RepoOptions {
        gitDir: string;
        ref?: string;
        workTree?: string | null;
    }

    export interface WorkspaceOptions {
        root: TreeObject;
    }

    export interface BranchOptions {
        workspace: Workspace;
        name: string;
    }

    export interface SourceOptions {
        workspace: Workspace;
        name: string;
    }

    export interface LensOptions {
        workspace: Workspace;
        name: string;
        path?: string;
    }

    export interface ConfigurableOptions {
        phantom?: any;
        workspace?: Workspace;
    }

    export interface GitObjectOptions {
        hash: string;
        mode?: string | null;
    }

    export interface MergeOptions {
        files?: string[] | null;
        mode?: 'overlay' | 'replace' | 'underlay';
    }

    export interface ProjectionOptions {
        debug?: boolean;
        lens?: boolean | null;
        commitTo?: string | null;
        commitMessage?: string | null;
        parentCommit?: string | null;
        fetch?: boolean | string[];
        cacheFrom?: string | null;
        cacheTo?: string | null;
    }

    export class Git {
        static async get(): Promise<typeof GitClient>;
        constructor(options: GitOptions);
        gitDir: string;
        workTree?: string;
    }

    export class BlobObject {
        static async write(repo: Repo, content: string): Promise<BlobObject>;
        static async writeFromFile(repo: Repo, filePath: string): Promise<BlobObject>;

        constructor(repo: Repo, options: GitObjectOptions);

        repo: Repo;
        hash: string;
        mode: string;
        isBlob: boolean;
        type: 'blob';

        async read(): Promise<string>;
    }

    export class TreeObject {
        static getEmptyTreeHash(): string;
        static async createFromRef(repo: Repo, ref: string): Promise<TreeObject>;

        constructor(repo: Repo, options?: { hash?: string; parent?: TreeObject | null });

        repo: Repo;
        dirty: boolean;
        hash: string;
        parent: TreeObject | null;
        isTree: boolean;
        type: 'tree';
        mode: '040000';

        async getHash(): Promise<string>;
        getWrittenHash(): string | null;
        markDirty(): void;
        async getChild(childPath: string): Promise<TreeObject | BlobObject | CommitObject | null>;
        async writeChild(childPath: string, content: string | BlobObject): Promise<BlobObject>;
        async getChildren(): Promise<{ [key: string]: TreeObject | BlobObject | CommitObject }>;
        async getBlobMap(): Promise<{ [key: string]: BlobObject }>;
        async deleteChild(childPath: string): Promise<void>;
        async getSubtree(subtreePath: string, create?: boolean): Promise<TreeObject | null>;
        async getSubtreeStack(subtreePath: string, create?: boolean): Promise<TreeObject[] | null>;
        async write(): Promise<string>;
        async merge(input: TreeObject, options?: MergeOptions, basePath?: string, preloadChildren?: boolean): Promise<void>;
        async clone(): Promise<TreeObject>;
    }

    export class CommitObject {
        constructor(repo: Repo, options: GitObjectOptions);

        repo: Repo;
        hash: string;
        mode: string;
        isCommit: boolean;
        type: 'commit';
    }

    export class Configurable {
        constructor(options: ConfigurableOptions);

        phantom?: any;
        workspace?: Workspace;

        getWorkspace(): Workspace;
        getRepo(): Repo;
        async readConfig(): Promise<any>;
        async writeConfig(config?: any): Promise<void>;
        async getConfig(): Promise<any>;
        async getCachedConfig(): Promise<any>;
    }

    export class Branch extends Configurable {
        constructor(options: BranchOptions);

        name: string;

        getKind(): 'holobranch';
        getConfigPath(): string;
        async isDefined(): Promise<boolean>;
        getMapping(key: string): Mapping;
        async getMappings(): Promise<Map<string, Mapping>>;
        async composite(options: {
            outputTree?: TreeObject;
            fetch?: boolean | string[];
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<TreeObject>;
        getLens(name: string): Lens;
        async getLenses(): Promise<Map<string, Lens>>;
    }

    export class Source extends Configurable {
        constructor(options: SourceOptions);

        name: string;
        holosourceName: string;
        holobranchName: string | null;

        getKind(): 'holosource';
        getConfigPath(): string;
        async getSpec(): Promise<{ hash: string; ref: string; data: any }>;
        async getCachedSpec(): Promise<{ hash: string; ref: string; data: any }>;
        async queryRef(): Promise<{ hash: string; ref: string } | null>;
        async hashWorkTree(): Promise<string | null>;
        async getOutputTree(options?: {
            working?: boolean | null;
            fetch?: boolean | string[];
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<string>;
        async getHead(options?: { required?: boolean; working?: boolean | null }): Promise<string | null>;
        async getCachedHead(): Promise<string | null>;
        async getBranch(): Promise<string | null>;
        async fetch(options?: { depth?: number; unshallow?: boolean | null }, ...refs: string[]): Promise<{ refs: string[] }>;
        async checkout(options?: { submodule?: boolean }): Promise<{
            path: string;
            head: string;
            branch: string | null;
            url: string;
            ref: string;
            submodule: boolean;
        }>;
    }

    export class Lens extends Configurable {
        constructor(options: LensOptions);

        name: string;
        path: string;

        getKind(): 'hololens';
        getConfigPath(): string;
        async buildInputTree(inputRoot?: TreeObject): Promise<TreeObject>;
        async buildSpec(inputTree: TreeObject): Promise<{
            hash: string;
            ref: string;
            data: any;
        }>;
        async executeSpec(specHash: string, options: {
            refresh?: boolean;
            save?: boolean;
            repo?: Repo | null;
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<string>;

        static async executeSpec(specHash: string, options: {
            refresh?: boolean;
            save?: boolean;
            repo?: Repo | null;
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<string>;
    }

    export class Workspace extends Configurable {
        constructor(options: WorkspaceOptions);

        root: TreeObject;

        getWorkspace(): Workspace;
        getKind(): 'holospace';
        getConfigPath(): string;
        async writeWorkingChanges(): Promise<void>;
        getBranch(name: string): Branch;
        async getBranches(): Promise<Map<string, Branch>>;
        getSource(name: string): Source;
        async getSources(): Promise<Map<string, Source>>;
        async getLayers(): Promise<Map<string, Map<string, Mapping>>>;
        getLens(name: string): Lens;
        async getLenses(): Promise<Map<string, Lens>>;
    }

    export class Repo {
        static async getFromEnvironment(options?: { ref?: string; working?: boolean }): Promise<Repo>;

        constructor(options: RepoOptions);

        gitDir: string;
        ref: string;
        workTree: string | null;

        async getWorkspace(): Promise<Workspace>;
        async createWorkspaceFromRef(ref: string): Promise<Workspace>;
        async createWorkspaceFromTreeHash(hash: string): Promise<Workspace>;
        async getGit(): Promise<GitClient>;
        async resolveRef(ref?: string | null): Promise<string | null>;
        createBlob(options: GitObjectOptions): BlobObject;
        async writeBlob(content: string): Promise<BlobObject>;
        async writeBlobFromFile(filePath: string): Promise<BlobObject>;
        createTree(options?: { hash?: string; parent?: TreeObject | null }): TreeObject;
        async createTreeFromRef(ref: string): Promise<TreeObject>;
        createCommit(options: GitObjectOptions): CommitObject;
        async hasCommit(commit: string): Promise<boolean>;
        async hashWorkTree(): Promise<string>;
        async watch(options: { callback: (treeHash: string, commitHash?: string) => void }): Promise<{
            watching: Promise<void>;
            cancel: () => void;
        }>;
    }

    export class Projection {
        static async projectBranch(branch: Branch, options?: ProjectionOptions): Promise<string>;

        constructor(options: { branch: Branch });

        branch: Branch;
        workspace: Workspace;
        output: Workspace;

        async composite(options: {
            fetch?: boolean | string[];
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<void>;
        async lens(options: {
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<void>;
        async commit(ref: string, options?: {
            parentCommit?: string | null;
            commitMessage?: string | null;
        }): Promise<string>;
    }

    export class Studio {
        static async cleanup(): Promise<void>;
        static async getHab(): Promise<any>;
        static async getDocker(): Promise<Docker>;
        static async isEnvironmentStudio(): Promise<boolean>;
        static async get(gitDir: string): Promise<Studio>;

        constructor(options: { gitDir: string; container: any });

        container: any;
        gitDir: string;

        isLocal(): boolean;
        async habExec(...command: any[]): Promise<string>;
        async habPkgExec(pkg: string, bin: string, ...args: any[]): Promise<string>;
        async holoExec(...command: any[]): Promise<string>;
        async holoLensExec(spec: string): Promise<string>;
        async getPackage(query: string, options?: { install?: boolean }): Promise<string | null>;
    }

    export class Mapping extends Configurable {
        constructor(options: { branch: Branch; key: string });

        branch: Branch;
        key: string;

        getWorkspace(): Workspace;
        getKind(): 'holomapping';
        getConfigPath(): string;
    }

    export class SpecObject extends BlobObject {
        static async write(repo: Repo, kind: string, data: any): Promise<{
            hash: string;
            ref: string;
        }>;
        static buildRef(kind: string, hash: string): string;

        isSpec: boolean;
    }
}
