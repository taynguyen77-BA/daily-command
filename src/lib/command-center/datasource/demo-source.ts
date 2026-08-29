import { buildDemoData } from "../demo-data";
import { todayLocalIso } from "../date-utils";
import type { DataSourceProvider, DataSourceSyncResult } from "./types";

export class DemoDataSource implements DataSourceProvider {
  readonly type = "demo" as const;

  async sync(): Promise<DataSourceSyncResult> {
    const { current } = buildDemoData(todayLocalIso());
    return { ok: true, data: current, recordsFetched: current.workItems.length, syncedAt: new Date().toISOString() };
  }
}
