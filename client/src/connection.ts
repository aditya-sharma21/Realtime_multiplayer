import type { ClientMessage, ServerMessage } from './protocol.ts';
import { validateServerMessage } from './protocol.ts';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface LatencyStats {
  rtt: number; // Current round trip time in ms
  avgRtt: number; // Exponential moving average Rtt in ms
  jitter: number; // Variance in Rtt
  lastPingTs: number;
}

export interface NetworkSimulationConfig {
  artificialLagMs: number; // e.g. 0, 50, 150, 300 ms
  packetDropRate: number; // e.g. 0 to 0.3 (0% to 30%)
}

export class RawConnection {
  private url: string;
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private pingInterval: any = null;
  private sendQueue: string[] = [];
  private intentionalDisconnect = false;

  // Latency metrics
  private stats: LatencyStats = {
    rtt: 0,
    avgRtt: 0,
    jitter: 0,
    lastPingTs: 0,
  };

  // Artificial network simulator for demo & degradation testing
  public simulation: NetworkSimulationConfig = {
    artificialLagMs: 0,
    packetDropRate: 0,
  };

  // Event callbacks
  private messageListeners = new Set<(msg: ServerMessage) => void>();
  private stateListeners = new Set<(state: ConnectionState) => void>();
  private latencyListeners = new Set<(stats: LatencyStats) => void>();

  constructor(url: string) {
    this.url = url;
  }

  public getState(): ConnectionState {
    return this.state;
  }

  public getStats(): LatencyStats {
    return { ...this.stats };
  }

  public connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.intentionalDisconnect = false;
    this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState('connected');
      this.startPingHeartbeat();
      this.flushQueue();
    };

    this.ws.onmessage = (event) => {
      // Simulate artificial packet drop
      if (this.simulation.packetDropRate > 0 && Math.random() < this.simulation.packetDropRate) {
        return; // Dropped packet
      }

      const processPacket = () => {
        try {
          const parsed = JSON.parse(String(event.data));
          const validated = validateServerMessage(parsed);
          if (!validated) return;

          // Process internal pong for latency stats
          if (validated.type === 'pong') {
            const now = performance.now();
            const rtt = Math.max(0, Math.round(now - validated.clientTs));
            const prevRtt = this.stats.rtt;
            const diff = Math.abs(rtt - prevRtt);

            this.stats.rtt = rtt;
            this.stats.avgRtt = this.stats.avgRtt === 0 ? rtt : Math.round(this.stats.avgRtt * 0.8 + rtt * 0.2);
            this.stats.jitter = Math.round(this.stats.jitter * 0.8 + diff * 0.2);
            this.stats.lastPingTs = now;

            for (const listener of this.latencyListeners) {
              listener({ ...this.stats });
            }
            return;
          }

          for (const listener of this.messageListeners) {
            listener(validated);
          }
        } catch (err) {
          console.warn('[RawConnection] Failed to parse message', err);
        }
      };

      // Simulate artificial lag
      if (this.simulation.artificialLagMs > 0) {
        setTimeout(processPacket, this.simulation.artificialLagMs);
      } else {
        processPacket();
      }
    };

    this.ws.onerror = () => {
      // Browser WebSocket emits error before close
    };

    this.ws.onclose = () => {
      this.stopPingHeartbeat();
      this.ws = null;

      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      } else {
        this.setState('disconnected');
      }
    };
  }

  public disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState('disconnected');
  }

  public send(msg: ClientMessage): boolean {
    const serialized = JSON.stringify(msg);

    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Only buffer critical action/join messages, drop high frequency stale cursor updates
      if (msg.type !== 'cursor' && msg.type !== 'ping') {
        this.sendQueue.push(serialized);
      }
      return false;
    }

    try {
      this.ws.send(serialized);
      return true;
    } catch {
      return false;
    }
  }

  private flushQueue(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.sendQueue.length > 0) {
      const msg = this.sendQueue.shift();
      if (msg) this.ws.send(msg);
    }
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff with random jitter: base 500ms * 1.5^attempt, capped at 8000ms
    const baseDelay = Math.min(8000, 500 * Math.pow(1.5, this.reconnectAttempts));
    const jitter = Math.random() * 300;
    const delay = Math.round(baseDelay + jitter);

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private startPingHeartbeat(): void {
    this.stopPingHeartbeat();
    // Send ping every 2 seconds for fresh RTT stats and keeping NAT tunnels alive
    this.pingInterval = setInterval(() => {
      if (this.state === 'connected') {
        this.send({
          type: 'ping',
          ts: performance.now(),
        });
      }
    }, 2000);
  }

  private stopPingHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      for (const listener of this.stateListeners) {
        listener(state);
      }
    }
  }

  public onMessage(callback: (msg: ServerMessage) => void): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  public onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  public onLatency(callback: (stats: LatencyStats) => void): () => void {
    this.latencyListeners.add(callback);
    return () => this.latencyListeners.delete(callback);
  }
}
