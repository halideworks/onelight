/* Sequential file downloads: each file saves through the browser's own
   download manager, which already knows how to pause, resume, and survive a
   restart. The zip is one click; this is the path that shrugs off a dropped
   connection at file 40 of 60, because only that file retries.

   Browsers allow the first programmatic download freely and ask the user
   once to allow the rest; the spacing keeps the prompt and the saves from
   trampling each other. */

export const triggerDownload = (url: string): void => {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  link.download = "";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface SequentialProgress {
  done: number;
  total: number;
  started: number;
  skipped: string[];
}

/** Runs each job for a signed URL and triggers the save; a job returning
    null is counted as skipped (e.g. a rendition still processing). */
export const downloadSequentially = async (
  jobs: Array<{ label: string; url: () => Promise<string | null> }>,
  onProgress?: (progress: SequentialProgress) => void,
): Promise<SequentialProgress> => {
  const progress: SequentialProgress = {
    done: 0,
    total: jobs.length,
    started: 0,
    skipped: [],
  };
  for (const job of jobs) {
    let url: string | null = null;
    try {
      url = await job.url();
    } catch {
      url = null;
    }
    if (url) {
      triggerDownload(url);
      progress.started += 1;
      await wait(750);
    } else {
      progress.skipped.push(job.label);
    }
    progress.done += 1;
    onProgress?.({ ...progress, skipped: [...progress.skipped] });
  }
  return progress;
};
