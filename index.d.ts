declare module 'git-client' {
    export class Git {
        constructor(options: { gitDir: string; workTree?: string });
    }
}

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
        static get(): Promise<typeof GitClient>;
        constructor(options: GitOptions);
        gitDir: string;
        workTree?: string;
    }

    export class BlobObject {
        static write(repo: Repo, content: string): Promise<BlobObject>;
        static writeFromFile(repo: Repo, filePath: string): Promise<BlobObject>;

        constructor(repo: Repo, options: GitObjectOptions);

        repo: Repo;
        hash: string;
        mode: string;
        isBlob: boolean;
        type: 'blob';

        read(): Promise<string>;
    }

    export class TreeObject {
        static getEmptyTreeHash(): string;
        static createFromRef(repo: Repo, ref: string): Promise<TreeObject>;

        constructor(repo: Repo, options?: { hash?: string; parent?: TreeObject | null });

        repo: Repo;
        dirty: boolean;
        hash: string;
        parent: TreeObject | null;
        isTree: boolean;
        type: 'tree';
        mode: '040000';

        getHash(): Promise<string>;
        getWrittenHash(): string | null;
        markDirty(): void;
        getChild(childPath: string): Promise<TreeObject | BlobObject | CommitObject | null>;
        writeChild(childPath: string, content: string | BlobObject): Promise<BlobObject>;
        getChildren(): Promise<{ [key: string]: TreeObject | BlobObject | CommitObject }>;
        getBlobMap(): Promise<{ [key: string]: BlobObject }>;
        deleteChild(childPath: string): Promise<void>;
        getSubtree(subtreePath: string, create?: boolean): Promise<TreeObject | null>;
        getSubtreeStack(subtreePath: string, create?: boolean): Promise<TreeObject[] | null>;
        write(): Promise<string>;
        merge(input: TreeObject, options?: MergeOptions, basePath?: string, preloadChildren?: boolean): Promise<void>;
        clone(): Promise<TreeObject>;
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
        readConfig(): Promise<any>;
        writeConfig(config?: any): Promise<void>;
        getConfig(): Promise<any>;
        getCachedConfig(): Promise<any>;
    }

    export class Branch extends Configurable {
        constructor(options: BranchOptions);

        name: string;

        getKind(): 'holobranch';
        getConfigPath(): string;
        isDefined(): Promise<boolean>;
        getMapping(key: string): Mapping;
        getMappings(): Promise<Map<string, Mapping>>;
        composite(options: {
            outputTree?: TreeObject;
            fetch?: boolean | string[];
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<TreeObject>;
        getLens(name: string): Lens;
        getLenses(): Promise<Map<string, Lens>>;
    }

    export class Source extends Configurable {
        constructor(options: SourceOptions);

        name: string;
        holosourceName: string;
        holobranchName: string | null;

        getKind(): 'holosource';
        getConfigPath(): string;
        getSpec(): Promise<{ hash: string; ref: string; data: any }>;
        getCachedSpec(): Promise<{ hash: string; ref: string; data: any }>;
        queryRef(): Promise<{ hash: string; ref: string } | null>;
        hashWorkTree(): Promise<string | null>;
        getOutputTree(options?: {
            working?: boolean | null;
            fetch?: boolean | string[];
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<string>;
        getHead(options?: { required?: boolean; working?: boolean | null }): Promise<string | null>;
        getCachedHead(): Promise<string | null>;
        getBranch(): Promise<string | null>;
        fetch(options?: { depth?: number; unshallow?: boolean | null }, ...refs: string[]): Promise<{ refs: string[] }>;
        checkout(options?: { submodule?: boolean }): Promise<{
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
        buildInputTree(inputRoot?: TreeObject): Promise<TreeObject>;
        buildSpec(inputTree: TreeObject): Promise<{
            hash: string;
            ref: string;
            data: any;
        }>;
        executeSpec(specHash: string, options: {
            refresh?: boolean;
            save?: boolean;
            repo?: Repo | null;
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<string>;

        static executeSpec(specHash: string, options: {
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
        writeWorkingChanges(): Promise<void>;
        getBranch(name: string): Branch;
        getBranches(): Promise<Map<string, Branch>>;
        getSource(name: string): Source;
        getSources(): Promise<Map<string, Source>>;
        getLayers(): Promise<Map<string, Map<string, Mapping>>>;
        getLens(name: string): Lens;
        getLenses(): Promise<Map<string, Lens>>;
    }

    export class Repo {
        static getFromEnvironment(options?: { ref?: string; working?: boolean }): Promise<Repo>;

        constructor(options: RepoOptions);

        gitDir: string;
        ref: string;
        workTree: string | null;

        getWorkspace(): Promise<Workspace>;
        createWorkspaceFromRef(ref: string): Promise<Workspace>;
        createWorkspaceFromTreeHash(hash: string): Promise<Workspace>;
        getGit(): Promise<GitClient>;
        resolveRef(ref?: string | null): Promise<string | null>;
        createBlob(options: GitObjectOptions): BlobObject;
        writeBlob(content: string): Promise<BlobObject>;
        writeBlobFromFile(filePath: string): Promise<BlobObject>;
        createTree(options?: { hash?: string; parent?: TreeObject | null }): TreeObject;
        createTreeFromRef(ref: string): Promise<TreeObject>;
        createCommit(options: GitObjectOptions): CommitObject;
        hasCommit(commit: string): Promise<boolean>;
        hashWorkTree(): Promise<string>;
        watch(options: { callback: (treeHash: string, commitHash?: string) => void }): Promise<{
            watching: Promise<void>;
            cancel: () => void;
        }>;
    }

    export class Projection {
        static projectBranch(branch: Branch, options?: ProjectionOptions): Promise<string>;

        constructor(options: { branch: Branch });

        branch: Branch;
        workspace: Workspace;
        output: Workspace;

        composite(options: {
            fetch?: boolean | string[];
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<void>;
        lens(options: {
            cacheFrom?: string | null;
            cacheTo?: string | null;
        }): Promise<void>;
        commit(ref: string, options?: {
            parentCommit?: string | null;
            commitMessage?: string | null;
        }): Promise<string>;
    }

    export class Studio {
        static cleanup(): Promise<void>;
        static getHab(): Promise<any>;
        static getDocker(): Promise<Docker>;
        static isEnvironmentStudio(): Promise<boolean>;
        static get(gitDir: string): Promise<Studio>;

        constructor(options: { gitDir: string; container: any });

        container: any;
        gitDir: string;

        isLocal(): boolean;
        habExec(...command: any[]): Promise<string>;
        habPkgExec(pkg: string, bin: string, ...args: any[]): Promise<string>;
        holoExec(...command: any[]): Promise<string>;
        holoLensExec(spec: string): Promise<string>;
        getPackage(query: string, options?: { install?: boolean }): Promise<string | null>;
    }

    export class Mapping extends Configurable {
        constructor(options: { branch: Branch; key: string });

        branch: Branch;
        key: string;

        getWorkspace(): Workspace;
        getKind(): 'holomapping';
        getConfigPath(): string;
    }

    export class SpecObject {
        constructor(repo: Repo, options: GitObjectOptions);

        repo: Repo;
        hash: string;
        isSpec: boolean;

        static write(repo: Repo, kind: string, data: any): Promise<{
            hash: string;
            ref: string;
        }>;
        static buildRef(kind: string, hash: string): string;
    }
}
