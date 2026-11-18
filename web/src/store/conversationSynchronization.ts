// Required Notice: Copyright 2026 MrStrenggeheim. Triune (https://github.com/MrStrenggeheim/triune).
import type { AnyBlock } from "@/lib/blocks";
import type { StreamEvent } from "@/lib/events";
import type { TranscriptCursor } from "@/lib/sessionUpdatesSocket";
import { TranscriptReplay } from "./transcriptReplay";

export const SYNCHRONIZATION_DEADLINE_MS = 60_000;
export type SynchronizationPhase =
  "binding" | "awaiting_sync" | "replaying" | "live" | "recovering" | "stopped";
export type RecoveryReason = "diverged" | "invalid_sync" | "deadline" | "transport";

/** One binding owns the accepted cursor; attempts cannot publish into a successor. */
export class ConversationSynchronization {
  readonly bindingId = crypto.randomUUID();
  private generation = 0;
  cursor: TranscriptCursor | undefined;
  phase: SynchronizationPhase = "binding";
  private attempt: SynchronizationAttempt | undefined;

  begin(
    expectsSync: boolean,
    recover?: (retry: boolean, reason: RecoveryReason) => void,
  ): SynchronizationAttempt {
    this.attempt?.stop();
    const attempt = new SynchronizationAttempt(this, ++this.generation, expectsSync, recover);
    this.attempt = attempt;
    return attempt;
  }

  owns(attempt: SynchronizationAttempt): boolean {
    return this.attempt === attempt;
  }
  stop(): void {
    this.attempt?.stop();
    this.phase = "stopped";
  }
}

export class SynchronizationAttempt {
  readonly attemptId = crypto.randomUUID();
  private syncGeneration = 0;
  private receivedSyncGeneration = 0;
  private progressPosition = -1;
  private gapTimer?: ReturnType<typeof setTimeout>;
  private gapTarget = 0;
  private readonly appliedPositions = new Map<number, number>();
  private readonly replay = new TranscriptReplay();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private recovering = false;
  private awaiting: boolean;
  private readonly owner: ConversationSynchronization;
  private readonly attemptGeneration: number;
  private readonly onRecover?: (retry: boolean, reason: RecoveryReason) => void;

  constructor(
    owner: ConversationSynchronization,
    attemptGeneration: number,
    expectsSync: boolean,
    onRecover?: (retry: boolean, reason: RecoveryReason) => void,
  ) {
    this.owner = owner;
    this.attemptGeneration = attemptGeneration;
    this.onRecover = onRecover;
    this.awaiting = expectsSync;
    owner.phase = expectsSync ? "awaiting_sync" : "live";
    if (expectsSync) this.armDeadline();
  }

  get identity() {
    return {
      bindingId: this.owner.bindingId,
      attemptId: this.attemptId,
      attemptGeneration: this.attemptGeneration,
      syncGeneration: this.syncGeneration,
    };
  }

  receivedIdentity(event: StreamEvent) {
    if (event.type === "session_sync" && event.phase === "start") this.receivedSyncGeneration++;
    return { ...this.identity, syncGeneration: this.receivedSyncGeneration };
  }

  get current(): boolean {
    return !this.stopped && !this.recovering && this.owner.owns(this);
  }
  get checkpointAccepted(): boolean {
    return this.replay.checkpointAccepted && !this.recovering;
  }
  stages(event: StreamEvent): boolean {
    return this.replay.stages(event);
  }
  get isResetting(): boolean {
    return this.replay.isResetting;
  }

  private armDeadline(): void {
    // Only genuinely new canonical progress rearms this deadline.
    if (this.deadline !== undefined) return;
    this.deadline = setTimeout(() => this.recover(true, "deadline"), SYNCHRONIZATION_DEADLINE_MS);
  }

  recover(retry: boolean, reason: RecoveryReason): void {
    if (!this.current || this.recovering) return;
    this.recovering = true;
    clearTimeout(this.gapTimer);
    this.owner.phase = "recovering";
    clearTimeout(this.deadline);
    this.onRecover?.(retry, reason);
  }

  heartbeat(event: Extract<StreamEvent, { type: "session_heartbeat" }>): void {
    if (!this.current || this.awaiting || this.recovering) return;
    const cursor = this.owner.cursor;
    if (
      cursor?.stream_epoch?.startsWith("feed2:") &&
      event.streamEpoch === cursor.stream_epoch &&
      !event.reconcileRequired &&
      event.itemRevision !== undefined &&
      cursor.after_revision !== undefined &&
      event.itemRevision > cursor.after_revision
    ) {
      // A heartbeat reads committed storage while a matching live publication may be in flight.
      this.gapTarget = Math.max(this.gapTarget, event.itemRevision);
      this.gapTimer ??= setTimeout(() => this.recover(false, "diverged"), 2000);
      return;
    }
    if (!cursor) {
      this.owner.cursor = { after_position: -1 };
      this.recover(false, "diverged");
    } else if (
      event.streamEpoch !== cursor.stream_epoch ||
      (event.itemRevision !== undefined &&
        cursor.after_revision !== undefined &&
        event.itemRevision !== cursor.after_revision) ||
      event.lastPosition > cursor.after_position ||
      event.reconcileRequired
    ) {
      this.recover(false, "diverged");
    }
  }

  /** Join out-of-order publications only after each change has passed through the reducer. */
  appliedChange(revision: number, position: number): TranscriptCursor | undefined {
    const cursor = this.owner.cursor;
    if (
      !this.current ||
      this.awaiting ||
      !cursor?.stream_epoch?.startsWith("feed2:") ||
      cursor.after_revision === undefined ||
      !Number.isSafeInteger(revision) ||
      !Number.isSafeInteger(position) ||
      position < 0 ||
      revision <= cursor.after_revision
    )
      return;
    if (revision - cursor.after_revision > 256) {
      this.recover(false, "diverged");
      return;
    }
    this.appliedPositions.set(revision, position);
    let through = cursor.after_revision;
    let lastPosition = cursor.after_position;
    while (this.appliedPositions.has(through + 1)) {
      through++;
      lastPosition = Math.max(lastPosition, this.appliedPositions.get(through)!);
      this.appliedPositions.delete(through);
    }
    if (through === cursor.after_revision) return;
    if (through >= this.gapTarget) {
      clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
      this.gapTarget = 0;
    }
    this.owner.cursor = { ...cursor, after_revision: through, after_position: lastPosition };
    return this.owner.cursor;
  }

  accept(event: StreamEvent, blocks: AnyBlock[]): AnyBlock[] | null {
    if (!this.current || this.recovering) return null;
    if (event.type === "session_sync" && event.phase === "start") {
      this.syncGeneration++;
      this.appliedPositions.clear();
      clearTimeout(this.gapTimer);
      this.gapTimer = undefined;
      this.gapTarget = 0;
      this.awaiting = true;
      this.owner.phase = "replaying";
      this.armDeadline();
    }
    const rebuilt = this.replay.accept(event, blocks);
    const progress = this.replay.stagedProgressPosition;
    if (progress !== undefined && progress > this.progressPosition) {
      this.progressPosition = progress;
      clearTimeout(this.deadline);
      this.deadline = undefined;
      this.armDeadline();
    }
    if (event.type === "session_sync" && event.phase === "complete") {
      if (!this.replay.checkpointAccepted) this.recover(true, "invalid_sync");
      else {
        clearTimeout(this.deadline);
        this.deadline = undefined;
        this.awaiting = false;
        this.progressPosition = -1;
        this.owner.cursor = {
          after_position: event.lastPosition,
          after_revision: event.itemRevision,
          stream_epoch: event.streamEpoch,
        };
        this.owner.phase = "live";
      }
    }
    return rebuilt;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.gapTimer);
    clearTimeout(this.deadline);
    if (this.owner.owns(this)) this.owner.phase = "stopped";
  }
}

const bindings = new WeakMap<AbortController, ConversationSynchronization>();
export function conversationSynchronization(binding: AbortController): ConversationSynchronization {
  let owner = bindings.get(binding);
  if (!owner) {
    owner = new ConversationSynchronization();
    bindings.set(binding, owner);
    binding.signal.addEventListener("abort", () => owner!.stop(), { once: true });
  }
  return owner;
}
