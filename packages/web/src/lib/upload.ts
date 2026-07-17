import { api, apiPost, messageFrom } from "./api.js";

/* Multipart upload engine for the dashboard uploader.

   One file at a time moves through the queue, but each file's parts upload
   with PART_CONCURRENCY parallel PUTs. Progress is byte-accurate (XHR upload
   events) with a rolling transfer rate. The session id is surfaced to the
   caller so a retry reuses the same session: the engine lists persisted
   parts, skips completed part numbers, and continues from the failure. */

export interface PendingFile {
  file: File;
  /* Path relative to the chosen directory root, including the filename
     (e.g. "day01/A001/clip.mov"). Empty for loose files. */
  relativePath: string;
}

/* Files from a plain or webkitdirectory input. webkitRelativePath is set
   only for directory picks. */
export const filesFromInput = (files: FileList): PendingFile[] =>
  Array.from(files).map((file) => ({
    file,
    relativePath: file.webkitRelativePath || "",
  }));

interface EntryFile {
  entry: FileSystemFileEntry;
  path: string;
}

const readAllEntries = (
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> =>
  new Promise((resolve, reject) => {
    const collected: FileSystemEntry[] = [];
    const step = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(collected);
          return;
        }
        collected.push(...batch);
        step();
      }, reject);
    };
    step();
  });

const walkEntry = async (
  entry: FileSystemEntry,
  out: EntryFile[],
): Promise<void> => {
  if (entry.isFile) {
    out.push({
      entry: entry as FileSystemFileEntry,
      path: entry.fullPath.replace(/^\//, ""),
    });
    return;
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(
      (entry as FileSystemDirectoryEntry).createReader(),
    );
    for (const child of children) await walkEntry(child, out);
  }
};

const fileOfEntry = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

/* Dropped files and folders. Entries must be captured synchronously before
   the first await: the DataTransfer item list is gone once the drop handler
   yields. Folder trees are walked recursively via webkitGetAsEntry. */
export const filesFromDataTransfer = async (
  data: DataTransfer,
): Promise<PendingFile[]> => {
  const entries: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry();
    if (entry) {
      entries.push(entry);
    } else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  const found: EntryFile[] = [];
  for (const entry of entries) await walkEntry(entry, found);
  const out: PendingFile[] = loose.map((file) => ({
    file,
    relativePath: "",
  }));
  for (const item of found) {
    const file = await fileOfEntry(item.entry);
    /* A loose file's fullPath is just "/name": no directory context. */
    out.push({
      file,
      relativePath: item.path.includes("/") ? item.path : "",
    });
  }
  return out;
};

export interface UploadProgress {
  /* Bytes confirmed or in flight, including parts skipped on resume. */
  bytes: number;
  total: number;
  /* Rolling transfer rate in bytes per second; 0 while idle. */
  rate: number;
}

export class UploadQuarantinedError extends Error {
  constructor() {
    super(
      "Checksum mismatch: the upload is quarantined and cannot be resumed.",
    );
    this.name = "UploadQuarantinedError";
  }
}

const PART_CONCURRENCY = 4;
const RATE_WINDOW_MS = 5000;

/* A transient part failure retries with backoff before the file is allowed
   to fail; a network blip should cost seconds, not the upload. */
const PART_RETRY_DELAYS_MS = [500, 1500, 4000];

const putPart = (
  partPath: string,
  partNo: number,
  body: Blob,
  onBytes: (loaded: number) => void,
): Promise<{ part_no: number; etag: string }> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", partPath);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (event) => onBytes(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onBytes(body.size);
        resolve({
          part_no: partNo,
          etag: xhr.getResponseHeader("etag") ?? "",
        });
      } else {
        reject(new Error(`Part ${partNo} could not be uploaded.`));
      }
    };
    xhr.onerror = () =>
      reject(new Error(`Part ${partNo} could not be uploaded.`));
    xhr.send(body);
  });

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const putPartWithRetry = async (
  partPath: string,
  partNo: number,
  body: Blob,
  onBytes: (loaded: number) => void,
): Promise<{ part_no: number; etag: string }> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await putPart(partPath, partNo, body, onBytes);
    } catch (caught) {
      const delay = PART_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw caught;
      onBytes(0);
      await wait(delay + Math.random() * 250);
    }
  }
};

/* Sessions persist across page reloads: the ledger remembers the session id
   for a file's identity, so reopening the page and dropping the same file
   resumes from the last completed part instead of starting over. */
const ledgerKey = (scope: string, file: File): string =>
  `onelight.upload.${scope}.${file.name}.${file.size}.${file.lastModified}`;

const ledgerRead = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const ledgerWrite = (key: string, sessionId: string): void => {
  try {
    localStorage.setItem(key, sessionId);
  } catch {
    /* Private windows without storage still upload, without resume. */
  }
};

const ledgerClear = (key: string): void => {
  try {
    localStorage.removeItem(key);
  } catch {
    /* Nothing to clear. */
  }
};

export interface UploadTarget {
  /** Member upload into a project. */
  projectId?: string;
  /** Anonymous upload through a transfer request link. */
  transferSlug?: string;
}

const endpointsFor = (target: UploadTarget) => {
  if (target.transferSlug) {
    const base = `/api/v1/t/${target.transferSlug}/uploads`;
    return {
      scope: `t.${target.transferSlug}`,
      create: (file: File, relativePath: string) =>
        apiPost<{ upload: { id: string } }>(base, {
          filename: file.name,
          relative_path: relativePath,
          size: file.size,
        }),
      session: (sessionId: string) => `${base}/${sessionId}`,
    };
  }
  if (!target.projectId) throw new Error("An upload needs a destination.");
  const projectId = target.projectId;
  return {
    scope: `p.${projectId}`,
    create: (file: File, relativePath: string) =>
      apiPost<{ upload: { id: string } }>("/api/v1/uploads", {
        project_id: projectId,
        filename: file.name,
        relative_path: relativePath,
        size: file.size,
      }),
    session: (sessionId: string) => `/api/v1/uploads/${sessionId}`,
  };
};

export const uploadFile = async (options: {
  projectId?: string;
  transferSlug?: string;
  file: File;
  relativePath: string;
  sessionId?: string | null;
  onSession?: (sessionId: string) => void;
  onProgress?: (progress: UploadProgress) => void;
}): Promise<string> => {
  const { file, relativePath, onSession, onProgress } = options;
  const endpoints = endpointsFor(options);
  const storageKey = ledgerKey(endpoints.scope, file);
  let sessionId = options.sessionId ?? ledgerRead(storageKey);
  let resumed = sessionId !== null && !options.sessionId;
  if (!sessionId) {
    const created = await endpoints.create(file, relativePath);
    sessionId = created.upload.id;
    ledgerWrite(storageKey, sessionId);
    onSession?.(sessionId);
  }
  let multipart: { upload: { status: string }; part_size?: number };
  try {
    multipart = await apiPost<{
      upload: { status: string };
      part_size?: number;
    }>(`${endpoints.session(sessionId)}/multipart`);
  } catch (caught) {
    /* A remembered session may be gone (reaped) or unusable (quarantined).
       Forget it and start clean, once; a fresh session that fails is real. */
    if (!resumed) {
      if (messageFrom(caught, "").toLowerCase().includes("resumed"))
        ledgerClear(storageKey);
      throw caught;
    }
    ledgerClear(storageKey);
    resumed = false;
    const created = await endpoints.create(file, relativePath);
    sessionId = created.upload.id;
    ledgerWrite(storageKey, sessionId);
    onSession?.(sessionId);
    multipart = await apiPost<{
      upload: { status: string };
      part_size?: number;
    }>(`${endpoints.session(sessionId)}/multipart`);
  }
  if (multipart.upload.status === "completed") {
    ledgerClear(storageKey);
    onProgress?.({ bytes: file.size, total: file.size, rate: 0 });
    return sessionId;
  }
  const partSize = multipart.part_size;
  if (!partSize)
    throw new Error("The upload session did not return a part size.");
  const count = Math.max(1, Math.ceil(file.size / partSize));
  const bytesOf = (partNo: number): number =>
    partNo === count ? file.size - (count - 1) * partSize : partSize;

  const existing = (
    await api<{ items: Array<{ part_no: number; etag: string }> }>(
      `${endpoints.session(sessionId)}/parts`,
    )
  ).items;
  const done = new Map<number, string>();
  for (const part of existing)
    if (part.etag && part.part_no >= 1 && part.part_no <= count)
      done.set(part.part_no, part.etag);

  /* Byte accounting: completed parts count in full, in-flight parts by their
     latest XHR progress event. Rate comes from a rolling window over the
     delta of transferred (non-resumed) bytes. */
  const partBytes = new Map<number, number>();
  for (const partNo of done.keys()) partBytes.set(partNo, bytesOf(partNo));
  const resumedBytes = Array.from(done.keys()).reduce(
    (sum, partNo) => sum + bytesOf(partNo),
    0,
  );
  const samples: Array<{ at: number; bytes: number }> = [];
  const report = (): void => {
    let bytes = 0;
    for (const value of partBytes.values()) bytes += value;
    const now = Date.now();
    samples.push({ at: now, bytes: bytes - resumedBytes });
    while (samples.length > 2 && samples[0].at < now - RATE_WINDOW_MS)
      samples.shift();
    const first = samples[0];
    const last = samples[samples.length - 1];
    const span = last.at - first.at;
    const rate = span > 0 ? ((last.bytes - first.bytes) / span) * 1000 : 0;
    onProgress?.({ bytes, total: file.size, rate: Math.max(0, rate) });
  };
  report();

  const pending: number[] = [];
  for (let partNo = 1; partNo <= count; partNo += 1)
    if (!done.has(partNo)) pending.push(partNo);
  let cursor = 0;
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null) {
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const partNo = pending[index];
      const start = (partNo - 1) * partSize;
      const body = file.slice(start, Math.min(file.size, start + partSize));
      try {
        const part = await putPartWithRetry(
          `${endpoints.session(sessionId)}/parts/${partNo}`,
          partNo,
          body,
          (loaded) => {
            partBytes.set(partNo, Math.min(loaded, bytesOf(partNo)));
            report();
          },
        );
        done.set(part.part_no, part.etag);
        partBytes.set(partNo, bytesOf(partNo));
        report();
      } catch (caught) {
        failure = caught;
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PART_CONCURRENCY, pending.length) }, () =>
      worker(),
    ),
  );
  if (failure !== null)
    throw failure instanceof Error ? failure : new Error("The upload failed.");

  const parts = Array.from(done.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([part_no, etag]) => ({ part_no, etag }));
  try {
    await apiPost(`${endpoints.session(sessionId)}/complete`, { parts });
  } catch (caught) {
    if (messageFrom(caught, "").toLowerCase().includes("checksum")) {
      ledgerClear(storageKey);
      throw new UploadQuarantinedError();
    }
    throw caught;
  }
  ledgerClear(storageKey);
  onProgress?.({ bytes: file.size, total: file.size, rate: 0 });
  return sessionId;
};

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export const formatBytes = (bytes: number): string => {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = value >= 100 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
};

export const formatRate = (bytesPerSecond: number): string =>
  `${formatBytes(bytesPerSecond)}/s`;
