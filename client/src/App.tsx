import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Activity,
  Users,
  Wifi,
  WifiOff,
  Sliders,
  ExternalLink,
  Bot,
  Flame,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { createRoom, type RoomInstance } from './room.ts';
import { InterpolationEngine, type InterpolationMode } from './interpolation.ts';
import { CanvasRenderer } from './render.ts';
import type { ClientPresence, RoomSnapshot } from './protocol.ts';
import type { ConnectionState, LatencyStats } from './connection.ts';

const PALETTES = [
  '#ff3366', // Hot pink
  '#38bdf8', // Neon cyan
  '#a855f7', // Electric purple
  '#10b981', // Vivid emerald
  '#f59e0b', // Radiant amber
  '#ec4899', // Magenta
];

const EMOJIS = ['🔥', '❤️', '⚡', '🎉', '🚀', '👏', '⭐'];

// Generate or retrieve persistent clientId for reconnect testing
function getOrCreateClientId(): string {
  const key = 'fanpulse_client_id';
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = 'user_' + Math.random().toString(36).substring(2, 9);
    sessionStorage.setItem(key, id);
  }
  return id;
}

export const App: React.FC = () => {
  // Query parameters or defaults
  const searchParams = new URLSearchParams(window.location.search);
  const roomId = searchParams.get('room') || 'watch-party-42';
  const clientId = useRef(getOrCreateClientId()).current;

  // Persistent user customization
  const [userName] = useState(() => 'Fan-' + clientId.slice(5, 9).toUpperCase());
  const [userColor] = useState(() => PALETTES[Math.floor(Math.random() * PALETTES.length)]);

  // Room state
  const roomRef = useRef<RoomInstance | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [participants, setParticipants] = useState<ClientPresence[]>([]);
  const [hypeScore, setHypeScore] = useState<number>(142);
  const [soundEnabled, setSoundEnabled] = useState(false);

  // Latency & diagnostics
  const [stats, setStats] = useState<LatencyStats>({ rtt: 0, avgRtt: 0, jitter: 0, lastPingTs: 0 });
  const [packetCount, setPacketCount] = useState({ in: 0, out: 0 });

  // Interpolation settings
  const [interpMode, setInterpMode] = useState<InterpolationMode>('hermite');
  const [bufferDelay, setBufferDelay] = useState<number>(50);
  const [simLag, setSimLag] = useState<number>(0);
  const [simDrop, setSimDrop] = useState<number>(0);

  // Bot simulation
  const [botCount, setBotCount] = useState<number>(0);
  const botIntervalsRef = useRef<any[]>([]);

  // Canvas and Engine refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<CanvasRenderer | null>(null);
  const interpEngineRef = useRef<InterpolationEngine>(new InterpolationEngine(50, 'hermite'));

  // Initialize Room & Canvas
  useEffect(() => {
    const interpEngine = interpEngineRef.current;
    interpEngine.setMode(interpMode);
    interpEngine.setBufferDelay(bufferDelay);

    const room = createRoom({
      roomId,
      clientId,
      name: userName,
      color: userColor,
    });
    roomRef.current = room;

    room.onConnectionChange((state) => {
      setConnectionState(state);
    });

    room.onLatencyUpdate((newStats) => {
      setStats(newStats);
    });

    room.onSnapshot((snapshot: RoomSnapshot) => {
      setHypeScore(snapshot.hypeScore);
    });

    room.onPresenceChange((newParticipants) => {
      setParticipants(newParticipants);
    });

    // Remote cursor handler
    room.onRemoteCursor((senderId, x, y, seq) => {
      setPacketCount((prev) => ({ ...prev, in: prev.in + 1 }));
      interpEngine.pushRemoteCursor(senderId, x, y, seq);
    });

    // Remote action handler (reaction burst or tap)
    room.onRemoteAction((_senderId, action) => {
      setPacketCount((prev) => ({ ...prev, in: prev.in + 1 }));

      if (action.type === 'reaction' && rendererRef.current) {
        rendererRef.current.addReactionBurst(action.x, action.y, action.emoji);
        setHypeScore((prev) => prev + 1);
      } else if (action.type === 'tap' && rendererRef.current) {
        rendererRef.current.addRipple(action.x, action.y, '#38bdf8');
      } else if (action.type === 'hype') {
        setHypeScore((prev) => prev + (action.delta || 1));
      }
    });

    return () => {
      room.destroy();
    };
  }, [roomId, clientId, userName, userColor]);

  // Update interpolation mode and buffer delay on the fly
  useEffect(() => {
    interpEngineRef.current.setMode(interpMode);
    interpEngineRef.current.setBufferDelay(bufferDelay);
  }, [interpMode, bufferDelay]);

  // Update artificial network degradation simulation on the connection
  useEffect(() => {
    if (roomRef.current) {
      roomRef.current.connection.simulation = {
        artificialLagMs: simLag,
        packetDropRate: simDrop,
      };
    }
  }, [simLag, simDrop]);

  // Setup Canvas 2D render loop
  useEffect(() => {
    if (!canvasRef.current) return;

    const renderer = new CanvasRenderer(canvasRef.current);
    rendererRef.current = renderer;

    const onResize = () => renderer.handleResize();
    window.addEventListener('resize', onResize);

    let animationFrameId: number;

    const renderLoop = (time: number) => {
      const remotePositions = interpEngineRef.current.updateAll(time);
      renderer.render(remotePositions, participants, clientId);
      animationFrameId = requestAnimationFrame(renderLoop);
    };

    animationFrameId = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', onResize);
    };
  }, [participants, clientId]);

  // Handle local mouse move over the canvas
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !roomRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    // Send throttled cursor action
    roomRef.current.sendAction({ type: 'cursor', x, y });
    setPacketCount((prev) => ({ ...prev, out: prev.out + 1 }));
  }, []);

  // Handle click / tap on the canvas stage
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !roomRef.current) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));

    // Immediate local feedback
    if (rendererRef.current) {
      rendererRef.current.addRipple(x, y, userColor);
      rendererRef.current.addReactionBurst(x, y, '🔥');
    }
    setHypeScore((prev) => prev + 1);

    // Relay to peers
    roomRef.current.sendAction({
      type: 'reaction',
      emoji: '🔥',
      x,
      y,
    });
    setPacketCount((prev) => ({ ...prev, out: prev.out + 1 }));
  }, [userColor]);

  // Trigger emoji reaction from bottom dock
  const triggerReaction = (emoji: string) => {
    if (!roomRef.current) return;

    // Random location around center-bottom
    const x = 0.35 + Math.random() * 0.3;
    const y = 0.65 + Math.random() * 0.2;

    if (rendererRef.current) {
      rendererRef.current.addReactionBurst(x, y, emoji);
    }
    setHypeScore((prev) => prev + 1);

    roomRef.current.sendAction({
      type: 'reaction',
      emoji,
      x,
      y,
    });
    setPacketCount((prev) => ({ ...prev, out: prev.out + 1 }));
  };

  // Trigger Hype cheer
  const triggerHype = () => {
    if (!roomRef.current) return;

    // Fire 3 simultaneous bursts across the screen
    if (rendererRef.current) {
      rendererRef.current.addReactionBurst(0.25, 0.5, '⚡');
      rendererRef.current.addReactionBurst(0.5, 0.45, '🔥');
      rendererRef.current.addReactionBurst(0.75, 0.5, '🚀');
    }

    setHypeScore((prev) => prev + 10);
    roomRef.current.sendAction({
      type: 'hype',
      delta: 10,
    });
    setPacketCount((prev) => ({ ...prev, out: prev.out + 1 }));
  };

  // Spawn an autonomous peer bot for instant solo testing
  const togglePeerBot = () => {
    if (botCount >= 5) {
      // Clear all bots
      botIntervalsRef.current.forEach((interval) => clearInterval(interval));
      botIntervalsRef.current = [];
      setBotCount(0);
      return;
    }

    const newBotIndex = botCount + 1;
    const botId = `bot_${Math.random().toString(36).substring(2, 7)}`;
    const botName = `AI-Fan ${newBotIndex}`;
    const botColor = PALETTES[(newBotIndex + 1) % PALETTES.length];

    const botRoom = createRoom({
      roomId,
      clientId: botId,
      name: botName,
      color: botColor,
    });

    let angle = Math.random() * Math.PI * 2;
    const speed = 0.03 + Math.random() * 0.02;
    const centerX = 0.2 + Math.random() * 0.6;
    const centerY = 0.2 + Math.random() * 0.6;
    const radiusX = 0.15 + Math.random() * 0.15;
    const radiusY = 0.1 + Math.random() * 0.1;

    // Bot move loop (~30Hz)
    const moveTimer = setInterval(() => {
      angle += speed;
      const x = Math.max(0.05, Math.min(0.95, centerX + Math.cos(angle) * radiusX));
      const y = Math.max(0.05, Math.min(0.95, centerY + Math.sin(angle * 1.5) * radiusY));
      botRoom.sendAction({ type: 'cursor', x, y });
    }, 33);

    // Bot reaction loop (every 3-5 seconds)
    const reactionTimer = setInterval(() => {
      const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
      const x = centerX + (Math.random() - 0.5) * 0.2;
      const y = centerY + (Math.random() - 0.5) * 0.2;
      botRoom.sendAction({ type: 'reaction', emoji, x, y });
    }, 3500 + Math.random() * 2000);

    botIntervalsRef.current.push(moveTimer, reactionTimer);
    setBotCount((c) => c + 1);
  };

  // Open duplicate tab for side-by-side verification
  const openDuplicateTab = () => {
    window.open(window.location.href, '_blank');
  };

  return (
    <div className="app-container">
      {/* Header Bar */}
      <header className="header-bar">
        <div className="brand-section">
          <div className="live-badge">
            <span className="live-pulse-dot"></span>
            LIVE BROADCAST
          </div>
          <h1 className="brand-title">FanPulse</h1>
          <span className="room-badge">Room: {roomId}</span>
        </div>

        <div className="header-controls">
          <div className="user-pill">
            <span className="user-color-dot" style={{ backgroundColor: userColor }}></span>
            <span>{userName}</span>
          </div>

          <button
            className="btn btn-secondary"
            onClick={openDuplicateTab}
            title="Open new tab to test multiplayer cursors side-by-side"
          >
            <ExternalLink size={14} />
            Split Tab
          </button>

          <button
            className="btn btn-secondary"
            onClick={togglePeerBot}
            title="Spawn simulated peers to test smooth interpolation in a single window"
          >
            <Bot size={14} />
            {botCount > 0 ? `Bots Active (${botCount})` : 'Spawn Bot'}
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => setSoundEnabled(!soundEnabled)}
            title="Toggle stadium ambient audio"
          >
            {soundEnabled ? <Volume2 size={14} /> : <VolumeX size={14} />}
          </button>
        </div>
      </header>

      {/* Main Interactive Stage */}
      <main className="stage-wrapper">
        {/* Background Simulated Broadcast Arena */}
        <div className="broadcast-stage">
          <div className="stage-ambient-light"></div>
          <div className="broadcast-banner">
            <div className="match-league">WORLD CHAMPIONSHIP GRAND FINALS</div>
            <h2 className="match-title">SOLARIS vs CYBERPUNK</h2>
            <div className="match-score">
              <span className="team-name">SOLARIS</span>
              <span className="score-divider">3 - 2</span>
              <span className="team-name">CYBER</span>
            </div>
          </div>
        </div>

        {/* Shared Canvas Overlay */}
        <canvas
          ref={canvasRef}
          className="broadcast-canvas-overlay"
          onMouseMove={handleMouseMove}
          onClick={handleCanvasClick}
        />

        {/* Top Floating Hype Meter */}
        <div className="hype-meter-widget">
          <div className="hype-header">
            <span className="hype-title">
              <Flame size={14} />
              STADIUM HYPE METER
            </span>
            <span className="hype-count">{hypeScore} CHEERS</span>
          </div>
          <div className="hype-bar-track">
            <div
              className="hype-bar-fill"
              style={{ width: `${Math.min(100, (hypeScore % 500) / 5)}%` }}
            ></div>
          </div>
        </div>

        {/* Diagnostics HUD Panel */}
        <div className="diagnostics-panel">
          <div className="panel-title">
            <span>SYNC DIAGNOSTICS</span>
            <Activity size={13} />
          </div>

          <div className="stat-row">
            <span className="stat-label">Connection:</span>
            <span
              className={`stat-val ${
                connectionState === 'connected'
                  ? 'good'
                  : connectionState === 'reconnecting'
                  ? 'fair'
                  : 'poor'
              }`}
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              {connectionState === 'connected' ? <Wifi size={12} /> : <WifiOff size={12} />}
              {connectionState.toUpperCase()}
            </span>
          </div>

          <div className="stat-row">
            <span className="stat-label">Round Trip (RTT):</span>
            <span
              className={`stat-val ${
                stats.rtt < 30 ? 'good' : stats.rtt < 90 ? 'fair' : 'poor'
              }`}
            >
              {stats.rtt} ms
            </span>
          </div>

          <div className="stat-row">
            <span className="stat-label">Jitter:</span>
            <span className="stat-val good">±{stats.jitter} ms</span>
          </div>

          <div className="stat-row">
            <span className="stat-label">Packets (In / Out):</span>
            <span className="stat-val">
              {packetCount.in} / {packetCount.out}
            </span>
          </div>

          <div className="stat-row">
            <span className="stat-label">Active Viewers:</span>
            <span className="stat-val good" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Users size={12} />
              {participants.length}
            </span>
          </div>
        </div>

        {/* Interactive Controls & Degradation Sidebar */}
        <div className="controls-sidebar">
          <div className="panel-title">
            <span>INTERPOLATION CONTROLS</span>
            <Sliders size={13} />
          </div>

          {/* Interpolation Strategy Selector */}
          <div className="control-group">
            <label className="control-label">Smoothing Strategy</label>
            <div className="segmented-control">
              <button
                className={`segmented-btn ${interpMode === 'hermite' ? 'active' : ''}`}
                onClick={() => setInterpMode('hermite')}
                title="Hermite Cubic Spline interpolation for smooth velocity curves"
              >
                Hermite (Cubic)
              </button>
              <button
                className={`segmented-btn ${interpMode === 'lerp' ? 'active' : ''}`}
                onClick={() => setInterpMode('lerp')}
                title="Linear interpolation between known packet points"
              >
                LERP (Linear)
              </button>
              <button
                className={`segmented-btn ${interpMode === 'extrapolation' ? 'active' : ''}`}
                onClick={() => setInterpMode('extrapolation')}
                title="Predicts trajectory ahead using velocity when packets are delayed"
              >
                Extrapolation
              </button>
              <button
                className={`segmented-btn ${interpMode === 'raw' ? 'active' : ''}`}
                onClick={() => setInterpMode('raw')}
                title="No smoothing (instant snapping) to compare raw vs interpolated movement"
              >
                Raw (Snap)
              </button>
            </div>
          </div>

          {/* Buffer Delay Slider */}
          <div className="control-group">
            <label className="control-label">
              Jitter Buffer Delay
              <span className="slider-val">{bufferDelay} ms</span>
            </label>
            <input
              type="range"
              className="range-slider"
              min="0"
              max="150"
              step="5"
              value={bufferDelay}
              onChange={(e) => setBufferDelay(Number(e.target.value))}
            />
          </div>

          {/* Artificial Network Degradation Simulator */}
          <div className="control-group">
            <label className="control-label">
              Simulated Lag
              <span className="slider-val">{simLag} ms</span>
            </label>
            <div className="segmented-control">
              {[0, 50, 150, 300].map((ms) => (
                <button
                  key={ms}
                  className={`segmented-btn ${simLag === ms ? 'active' : ''}`}
                  onClick={() => setSimLag(ms)}
                >
                  {ms === 0 ? 'None' : `${ms}ms`}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label className="control-label">
              Simulated Packet Drop
              <span className="slider-val">{Math.round(simDrop * 100)}%</span>
            </label>
            <div className="segmented-control">
              {[0, 0.05, 0.15, 0.3].map((rate) => (
                <button
                  key={rate}
                  className={`segmented-btn ${simDrop === rate ? 'active' : ''}`}
                  onClick={() => setSimDrop(rate)}
                >
                  {rate === 0 ? '0%' : `${Math.round(rate * 100)}%`}
                </button>
              ))}
            </div>
          </div>

          {/* Live Participants List */}
          <div className="control-group">
            <label className="control-label">
              Viewers In Room ({participants.length})
            </label>
            <div className="presence-list">
              {participants.map((p) => (
                <div key={p.clientId} className="presence-item">
                  <div className="presence-user">
                    <span className="dot" style={{ backgroundColor: p.color }}></span>
                    <span>{p.name}</span>
                  </div>
                  <span style={{ color: p.clientId === clientId ? '#38bdf8' : '#64748b' }}>
                    {p.clientId === clientId ? 'You' : 'Peer'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Reaction Dock */}
        <div className="reaction-dock">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className="emoji-btn"
              onClick={() => triggerReaction(emoji)}
              title={`React with ${emoji}`}
            >
              {emoji}
            </button>
          ))}

          <button className="hype-burst-btn" onClick={triggerHype}>
            <Flame size={16} />
            HYPE!
          </button>
        </div>
      </main>
    </div>
  );
};

export default App;
