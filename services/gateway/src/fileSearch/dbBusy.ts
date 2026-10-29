/**
 * No file_search database connection became available in time (see db.ts). A fixed message: the
 * files and vector store routes answer it as `503 file_search_busy`; anything else that passes it
 * to the express error handler gets its `status` 503, never driver text. The workers hand the
 * item back without spending an attempt (workQueue.ts BUSY_HANDBACK_SET).
 */
export class FileSearchBusyError extends Error {
  readonly status = 503;
  /** The API code the file_search routes answer it with (type `file_search_unavailable`). */
  readonly code = 'file_search_busy';
  constructor() {
    super('file_search is busy: no database connection became available in time. Retry the request.');
    this.name = 'FileSearchBusyError';
  }
}
