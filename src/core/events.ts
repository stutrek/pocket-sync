/** In-process pub/sub used by the SSE endpoint, the tray and the log window. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppEvent {
  id: number;
  ts: string;
  level: LogLevel;
  /** Machine-readable event name, e.g. "device.connected", "sync.book.done". */
  event: string;
  message: string;
  deviceId?: string;
  bookId?: string;
  detail?: Record<string, unknown>;
}

type Listener = (e: AppEvent) => void;

export class EventBus {
  #listeners = new Set<Listener>();
  #ring: AppEvent[] = [];
  #seq = 0;

  constructor(readonly ringSize = 500) {}

  emit(e: Omit<AppEvent, "id" | "ts"> & { ts?: string }): AppEvent {
    const full: AppEvent = { ...e, id: ++this.#seq, ts: e.ts ?? new Date().toISOString() };
    this.#ring.push(full);
    if (this.#ring.length > this.ringSize) this.#ring.shift();
    for (const l of this.#listeners) {
      try {
        l(full);
      } catch (err) {
        console.error("event listener threw", err);
      }
    }
    return full;
  }

  subscribe(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  /** Recent events, oldest first, optionally only those after `sinceId`. */
  recent(sinceId = 0, limit = 200): AppEvent[] {
    return this.#ring.filter((e) => e.id > sinceId).slice(-limit);
  }
}
