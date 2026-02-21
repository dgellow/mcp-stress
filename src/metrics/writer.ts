/**
 * Main-thread API for the writer worker.
 *
 * Spawns the writer worker and provides a handle for the Recorder
 * to post records to. Receives final stats back on completion.
 */

import type { MetaEvent, SummaryEvent } from "./events.ts";

export interface WriterOptions {
  outputPath?: string;
  meta?: MetaEvent;
}

export class Writer {
  private worker: Worker;
  private _stats: Promise<SummaryEvent>;
  private _resolveStats!: (stats: SummaryEvent) => void;

  constructor(opts: WriterOptions) {
    this._stats = new Promise((resolve) => {
      this._resolveStats = resolve;
    });

    this.worker = new Worker(
      new URL("./writer_worker.ts", import.meta.url).href,
      { type: "module" },
    );

    this.worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "stats") {
        this._resolveStats(e.data.summary);
      }
    };

    this.worker.postMessage({
      type: "init",
      outputPath: opts.outputPath,
      meta: opts.meta,
    });
  }

  /**
   * Post a message to the writer worker.
   * Used by the Recorder to send records, method registrations, and signals.
   */
  post(msg: unknown): void {
    this.worker.postMessage(msg);
  }

  /**
   * Wait for the writer to finish and return final stats.
   * The writer sends stats back after receiving a "complete" message.
   */
  async stats(): Promise<SummaryEvent> {
    return this._stats;
  }

  close(): void {
    this.worker.terminate();
  }
}
