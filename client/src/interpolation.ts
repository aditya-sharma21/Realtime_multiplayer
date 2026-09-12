/**
 * High-Performance Client Interpolation & Extrapolation Engine.
 * Provides Hermite Splines, LERP, Dead Reckoning (Extrapolation), and Jitter Buffering.
 */

export type InterpolationMode = 'hermite' | 'lerp' | 'extrapolation' | 'raw';

export interface CursorSample {
  x: number;
  y: number;
  ts: number; // Local receive timestamp (performance.now())
  seq: number;
}

export interface InterpolatedPosition {
  x: number;
  y: number;
  vx: number; // Estimated velocity x
  vy: number; // Estimated velocity y
  isExtrapolated: boolean;
}

export interface RemoteClientTrackerConfig {
  bufferDelayMs?: number; // Time window to look back for smooth interpolation (default 50ms)
  maxBufferSize?: number; // Ring buffer max size (default 10 samples)
  maxExtrapolationMs?: number; // Max time to extrapolate ahead before decaying (default 150ms)
}

/**
 * Tracks a single remote peer's cursor position history and calculates
 * interpolated / extrapolated display coordinates on every animation frame.
 */
export class RemoteCursorTracker {
  public readonly clientId: string;
  private buffer: CursorSample[] = [];
  private maxBufferSize: number;
  private bufferDelayMs: number;
  private maxExtrapolationMs: number;

  // Cached state for rendering
  private currentX: number = 0.5;
  private currentY: number = 0.5;
  private currentVx: number = 0;
  private currentVy: number = 0;

  constructor(clientId: string, config: RemoteClientTrackerConfig = {}) {
    this.clientId = clientId;
    this.bufferDelayMs = config.bufferDelayMs ?? 50;
    this.maxBufferSize = config.maxBufferSize ?? 10;
    this.maxExtrapolationMs = config.maxExtrapolationMs ?? 150;
  }

  public setBufferDelay(delayMs: number): void {
    this.bufferDelayMs = Math.max(0, delayMs);
  }

  /**
   * Adds an incoming cursor sample to the bounded ring buffer.
   */
  public pushSample(x: number, y: number, seq: number): void {
    const now = performance.now();

    // Out-of-order sequence check
    if (this.buffer.length > 0 && seq <= this.buffer[this.buffer.length - 1].seq) {
      return; // Drop stale sample
    }

    this.buffer.push({ x, y, ts: now, seq });

    // Enforce strictly bounded memory (ring buffer)
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }
  }

  /**
   * Evaluates the remote cursor's position at the given render timestamp.
   */
  public update(renderNow: number = performance.now(), mode: InterpolationMode = 'hermite'): InterpolatedPosition {
    if (this.buffer.length === 0) {
      return {
        x: this.currentX,
        y: this.currentY,
        vx: 0,
        vy: 0,
        isExtrapolated: false,
      };
    }

    // 1. RAW MODE: Snap directly to the latest known sample
    if (mode === 'raw' || this.buffer.length === 1) {
      const latest = this.buffer[this.buffer.length - 1];
      this.currentX = latest.x;
      this.currentY = latest.y;
      this.currentVx = 0;
      this.currentVy = 0;
      return {
        x: this.currentX,
        y: this.currentY,
        vx: 0,
        vy: 0,
        isExtrapolated: false,
      };
    }

    // Target playback time delayed by bufferDelayMs to absorb jitter
    const targetTime = renderNow - this.bufferDelayMs;
    const newest = this.buffer[this.buffer.length - 1];
    const oldest = this.buffer[0];

    // 2. EXTRAPOLATION / DEAD RECKONING CASE: Target time is beyond our newest received sample
    if (targetTime > newest.ts) {
      const secondNewest = this.buffer[this.buffer.length - 2];
      const dt = Math.max(1, newest.ts - secondNewest.ts);
      const vx = (newest.x - secondNewest.x) / dt;
      const vy = (newest.y - secondNewest.y) / dt;

      if (mode === 'extrapolation' || mode === 'hermite') {
        const timeAhead = Math.min(this.maxExtrapolationMs, targetTime - newest.ts);
        // Exponential damping factor to prevent flying off screen
        const damping = Math.exp(-timeAhead / 60);

        this.currentX = Math.max(0, Math.min(1, newest.x + vx * timeAhead * damping));
        this.currentY = Math.max(0, Math.min(1, newest.y + vy * timeAhead * damping));
        this.currentVx = vx * damping;
        this.currentVy = vy * damping;

        return {
          x: this.currentX,
          y: this.currentY,
          vx: this.currentVx,
          vy: this.currentVy,
          isExtrapolated: true,
        };
      } else {
        // LERP fallback without dead reckoning: stay clamped to newest sample
        this.currentX = newest.x;
        this.currentY = newest.y;
        this.currentVx = 0;
        this.currentVy = 0;
        return {
          x: this.currentX,
          y: this.currentY,
          vx: 0,
          vy: 0,
          isExtrapolated: false,
        };
      }
    }

    // 3. TARGET TIME EARLIER THAN OLDEST SAMPLE: clamp to oldest
    if (targetTime <= oldest.ts) {
      this.currentX = oldest.x;
      this.currentY = oldest.y;
      this.currentVx = 0;
      this.currentVy = 0;
      return {
        x: this.currentX,
        y: this.currentY,
        vx: 0,
        vy: 0,
        isExtrapolated: false,
      };
    }

    // 4. FIND BRACKETING SAMPLES [i, i+1] where targetTime falls in between
    let i0 = 0;
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i].ts <= targetTime && targetTime <= this.buffer[i + 1].ts) {
        i0 = i;
        break;
      }
    }

    const p0 = this.buffer[i0];
    const p1 = this.buffer[i0 + 1];
    const segmentDuration = Math.max(0.001, p1.ts - p0.ts);
    const alpha = Math.max(0, Math.min(1, (targetTime - p0.ts) / segmentDuration));

    if (mode === 'lerp') {
      // Linear Interpolation
      this.currentX = p0.x + (p1.x - p0.x) * alpha;
      this.currentY = p0.y + (p1.y - p0.y) * alpha;
      this.currentVx = (p1.x - p0.x) / segmentDuration;
      this.currentVy = (p1.y - p0.y) / segmentDuration;
    } else {
      // Hermite Spline (Cubic C1 continuity)
      const pPrev = i0 > 0 ? this.buffer[i0 - 1] : p0;
      const pNext = i0 + 2 < this.buffer.length ? this.buffer[i0 + 2] : p1;

      // Tangents at p0 and p1
      const m0x = (p1.x - pPrev.x) * 0.5;
      const m0y = (p1.y - pPrev.y) * 0.5;
      const m1x = (pNext.x - p0.x) * 0.5;
      const m1y = (pNext.y - p0.y) * 0.5;

      const t2 = alpha * alpha;
      const t3 = t2 * alpha;

      // Hermite basis functions
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + alpha;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;

      this.currentX = h00 * p0.x + h10 * m0x + h01 * p1.x + h11 * m1x;
      this.currentY = h00 * p0.y + h10 * m0y + h01 * p1.y + h11 * m1y;
      this.currentVx = (p1.x - p0.x) / segmentDuration;
      this.currentVy = (p1.y - p0.y) / segmentDuration;
    }

    // Clamp within bounds
    this.currentX = Math.max(0, Math.min(1, this.currentX));
    this.currentY = Math.max(0, Math.min(1, this.currentY));

    return {
      x: this.currentX,
      y: this.currentY,
      vx: this.currentVx,
      vy: this.currentVy,
      isExtrapolated: false,
    };
  }
}

/**
 * Multi-client interpolation coordinator.
 */
export class InterpolationEngine {
  private trackers = new Map<string, RemoteCursorTracker>();
  private bufferDelayMs: number = 50;
  private mode: InterpolationMode = 'hermite';

  constructor(bufferDelayMs = 50, mode: InterpolationMode = 'hermite') {
    this.bufferDelayMs = bufferDelayMs;
    this.mode = mode;
  }

  public setMode(mode: InterpolationMode): void {
    this.mode = mode;
  }

  public getMode(): InterpolationMode {
    return this.mode;
  }

  public setBufferDelay(ms: number): void {
    this.bufferDelayMs = ms;
    for (const tracker of this.trackers.values()) {
      tracker.setBufferDelay(ms);
    }
  }

  public getBufferDelay(): number {
    return this.bufferDelayMs;
  }

  public pushRemoteCursor(clientId: string, x: number, y: number, seq: number): void {
    let tracker = this.trackers.get(clientId);
    if (!tracker) {
      tracker = new RemoteCursorTracker(clientId, { bufferDelayMs: this.bufferDelayMs });
      this.trackers.set(clientId, tracker);
    }
    tracker.pushSample(x, y, seq);
  }

  public removeClient(clientId: string): void {
    this.trackers.delete(clientId);
  }

  public updateAll(now = performance.now()): Map<string, InterpolatedPosition> {
    const results = new Map<string, InterpolatedPosition>();
    for (const [clientId, tracker] of this.trackers.entries()) {
      results.set(clientId, tracker.update(now, this.mode));
    }
    return results;
  }
}
