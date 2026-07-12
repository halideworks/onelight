export interface BlobStore {
  putStream(
    key: string,
    stream: ReadableStream,
    meta: { contentType?: string; size?: number },
  ): Promise<void>;
  createMultipart(
    key: string,
    meta: { contentType?: string; size?: number },
  ): Promise<{ uploadId: string; partSize: number }>;
  signPartUrl(key: string, uploadId: string, partNo: number): Promise<string>;
  completeMultipart(
    key: string,
    uploadId: string,
    parts: Array<{ partNo: number; etag: string }>,
  ): Promise<void>;
  listParts(
    key: string,
    uploadId: string,
  ): Promise<Array<{ partNo: number; etag: string; size: number }>>;
  signGetUrl(
    key: string,
    options: { expires: number; contentDisposition?: string },
  ): Promise<string>;
  getStream(
    key: string,
    range?: { start: number; end?: number },
  ): Promise<ReadableStream>;
  head?(key: string): Promise<{ size: number }>;
  delete(key: string): Promise<void>;
}

export interface MultipartBlobStore extends BlobStore {
  putPart(
    uploadId: string,
    partNo: number,
    stream: ReadableStream,
    /**
     * Exact byte length of the part, when the caller knows it (from a trusted
     * Content-Length). The R2 adapter streams a fixed-length body instead of
     * buffering the whole part in the isolate; stores that ignore it simply
     * buffer as before.
     */
    partLength?: number,
  ): Promise<{ etag: string; size: number }>;
  abortMultipart?(uploadId: string): Promise<void>;
}

export interface MediaInfo {
  format: Record<string, unknown>;
  streams: Array<Record<string, unknown>>;
  sourceTimecodeStart?: string;
  frameRateNum?: number;
  frameRateDen?: number;
  durationFrames?: number;
  dropFrame?: boolean;
  variableFrameRate: boolean;
  colorAssumed: boolean;
}

export interface TranscodeJob {
  id: string;
  sourceKey: string;
  outputs: Array<{ kind: string; key: string; width?: number; codec?: string }>;
  mediaInfo: MediaInfo;
}

export interface TranscodeResult {
  renditions: Array<{
    kind: string;
    key: string;
    meta: Record<string, unknown>;
  }>;
}

export interface Transcoder {
  probe(source: { key: string }): Promise<MediaInfo>;
  run(job: TranscodeJob): Promise<TranscodeResult>;
}

export interface JobSpec {
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  runAfter?: number;
}

export interface JobQueue {
  enqueue(job: JobSpec): Promise<string>;
}

/**
 * Outbound mail delivery. Optional on AppEnv: deployments without SMTP or an
 * API-backed sender simply omit it, and mail-dependent flows degrade to an
 * audit trail instead of failing.
 */
export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface RealtimeHub {
  publish(
    channel: string,
    event: { id: string; type: string; data: unknown },
  ): Promise<void>;
  subscribe(
    channel: string,
    lastEventId?: string,
  ): AsyncIterable<{ id: string; type: string; data: unknown }>;
}
