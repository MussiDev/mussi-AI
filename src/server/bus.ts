import { EventEmitter } from 'node:events';

// In-process notifications that the ingest handler emits after an event is committed.
// Token usage tracking and the live stream subscribe to these; payloads carry identifiers only.

export interface AgentRef {
  session: string;
  agentKey: string;
}

export interface BusEvents {
  /** An agent's state was updated by a non-stale event. */
  agentChanged: [AgentRef];
  /** PostToolUse or PostToolUseFailure. taskId is the agent's open task, or null. */
  toolFinished: [AgentRef & { taskId: number | null }];
  /** Stop or SubagentStop. taskId is the task this event closed (already committed); for a stale event it is the still-open task instead; null when the agent had none. */
  agentStopped: [AgentRef & { taskId: number | null }];
  /** SessionEnd. */
  sessionEnded: [{ session: string }];
}

export type Bus = EventEmitter<BusEvents>;

export interface BusOptions {
  /** Called when a listener throws or rejects. Receives the event name only, never the payload. */
  onListenerError?: (err: unknown, eventName: string) => void;
}

/**
 * A listener failure must never undo a committed event or starve the other listeners, so emit
 * calls every listener on its own. Synchronous throws and promise rejections are both reported.
 */
class IsolatedBus extends EventEmitter<BusEvents> {
  constructor(private readonly onListenerError: (err: unknown, eventName: string) => void) {
    super();
  }

  override emit(eventName: string | symbol, ...args: unknown[]): boolean {
    const listeners = this.rawListeners(eventName) as Array<(...a: unknown[]) => unknown>;
    for (const listener of listeners) {
      try {
        const result = listener.apply(this, args);
        if (result instanceof Promise) {
          result.catch((err: unknown) => this.report(err, String(eventName)));
        }
      } catch (err) {
        this.report(err, String(eventName));
      }
    }
    return listeners.length > 0;
  }

  private report(err: unknown, eventName: string): void {
    try {
      this.onListenerError(err, eventName);
    } catch {
      // A failing error callback must not break the emitter either.
    }
  }
}

export function createBus(opts: BusOptions = {}): Bus {
  return new IsolatedBus(opts.onListenerError ?? (() => {}));
}
