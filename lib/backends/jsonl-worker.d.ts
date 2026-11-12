export interface JsonlWorkerOptions {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;
}
export declare class JsonlWorker {
    private proc;
    private rl;
    private nextId;
    private pending;
    private stderrTail;
    private readonly options;
    constructor(options: JsonlWorkerOptions);
    get isRunning(): boolean;
    start(): Promise<void>;
    request(payload: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
    stop(): Promise<void>;
}
