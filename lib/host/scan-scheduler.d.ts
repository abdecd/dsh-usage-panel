/** Disk logs contain CPU-heavy decompression/parsing; do not fan out 16 replays. */
export declare function mapScanSessions<T, R>(items: readonly T[], run: (item: T) => Promise<R>, isCancelled?: () => boolean): Promise<R[]>;
