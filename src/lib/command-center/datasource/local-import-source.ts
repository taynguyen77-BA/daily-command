import type { ImportResult } from "../import";
import type { DataSourceProvider, DataSourceSyncResult } from "./types";

/** Wraps an already-parsed ImportResult (from ../import.ts) behind the same
 *  DataSourceProvider interface as Demo and Jira — no parsing logic duplicated here. */
export class LocalImportDataSource implements DataSourceProvider {
  readonly type = "local-import" as const;

  constructor(private result: ImportResult) {}

  async sync(): Promise<DataSourceSyncResult> {
    if (!this.result.ok) {
      return { ok: false, error: this.result.errors.join("; ") || "Import failed." };
    }
    const recordsFetched = Object.values(this.result.addedCounts).reduce((a, b) => a + b, 0);
    return { ok: true, data: this.result.data, recordsFetched, syncedAt: new Date().toISOString() };
  }
}
