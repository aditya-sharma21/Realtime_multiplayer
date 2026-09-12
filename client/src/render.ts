/**
 * High-Performance Interactive Canvas Renderer for Multiplayer Fan Experience.
 * Renders smooth interpolated cursors, trails, emoji particle physics, and tap ripples.
 */

import type { InterpolatedPosition } from './interpolation.ts';
import type { ClientPresence } from './protocol.ts';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  rotSpeed: number;
  scale: number;
  alpha: number;
  life: number;
  maxLife: number;
  emoji: string;
}

export interface ClickRipple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  alpha: number;
  color: string;
}

export interface CursorTrailPoint {
  x: number;
  y: number;
  alpha: number;
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private ripples: ClickRipple[] = [];
  private cursorTrails = new Map<string, CursorTrailPoint[]>();
  private dpr: number = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) throw new Error('Failed to get 2D canvas context');
    this.ctx = context;
    this.handleResize();
  }

  public handleResize(): void {
    this.dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.scale(this.dpr, this.dpr);
  }

  public addReactionBurst(normalizedX: number, normalizedY: number, emoji: string): void {
    const rect = this.canvas.getBoundingClientRect();
    const cx = normalizedX * rect.width;
    const cy = normalizedY * rect.height;
    const count = 12;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = 2 + Math.random() * 5;
      this.particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.5, // upward bias
        rotation: (Math.random() - 0.5) * Math.PI,
        rotSpeed: (Math.random() - 0.5) * 0.15,
        scale: 0.6 + Math.random() * 0.6,
        alpha: 1,
        life: 0,
        maxLife: 60 + Math.random() * 30, // frames
        emoji,
      });
    }

    this.addRipple(normalizedX, normalizedY, '#ff3366');
  }

  public addRipple(normalizedX: number, normalizedY: number, color = '#38bdf8'): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ripples.push({
      x: normalizedX * rect.width,
      y: normalizedY * rect.height,
      radius: 4,
      maxRadius: 55,
      alpha: 0.85,
      color,
    });
  }

  /**
   * Main render loop frame.
   */
  public render(
    remotePositions: Map<string, InterpolatedPosition>,
    participants: ClientPresence[],
    localClientId: string
  ): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;

    this.ctx.clearRect(0, 0, width, height);

    // 1. Render and update click ripples
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.radius += (r.maxRadius - r.radius) * 0.12;
      r.alpha *= 0.94;

      this.ctx.save();
      this.ctx.beginPath();
      this.ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
      this.ctx.strokeStyle = r.color;
      this.ctx.globalAlpha = r.alpha;
      this.ctx.lineWidth = 2.5;
      this.ctx.shadowColor = r.color;
      this.ctx.shadowBlur = 10;
      this.ctx.stroke();
      this.ctx.restore();

      if (r.alpha < 0.02 || r.radius >= r.maxRadius - 1) {
        this.ripples.splice(i, 1);
      }
    }

    // Map participant metadata by clientId for quick lookup
    const peerMap = new Map<string, ClientPresence>();
    for (const p of participants) {
      peerMap.set(p.clientId, p);
    }

    // 2. Render cursor trails & cursors
    for (const [clientId, pos] of remotePositions.entries()) {
      if (clientId === localClientId) continue;

      const peer = peerMap.get(clientId);
      const color = peer?.color || '#38bdf8';
      const name = peer?.name || `Viewer-${clientId.slice(0, 4)}`;

      const px = pos.x * width;
      const py = pos.y * height;

      // Update trail points
      let trail = this.cursorTrails.get(clientId);
      if (!trail) {
        trail = [];
        this.cursorTrails.set(clientId, trail);
      }
      trail.push({ x: px, y: py, alpha: 0.7 });
      if (trail.length > 8) trail.shift();

      // Render smooth trailing glow path
      if (trail.length > 1) {
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.moveTo(trail[0].x, trail[0].y);
        for (let j = 1; j < trail.length; j++) {
          trail[j].alpha *= 0.92;
          this.ctx.lineTo(trail[j].x, trail[j].y);
        }
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 2;
        this.ctx.globalAlpha = 0.35;
        this.ctx.stroke();
        this.ctx.restore();
      }

      // Draw Cursor
      this.drawCursor(px, py, color, name, pos.isExtrapolated);
    }

    // 3. Render and update emoji particles
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15; // gravity
      p.vx *= 0.98; // drag
      p.rotation += p.rotSpeed;

      const progress = p.life / p.maxLife;
      p.alpha = Math.max(0, 1 - progress);

      this.ctx.save();
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate(p.rotation);
      this.ctx.scale(p.scale, p.scale);
      this.ctx.globalAlpha = p.alpha;
      this.ctx.font = '24px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(p.emoji, 0, 0);
      this.ctx.restore();

      if (p.life >= p.maxLife) {
        this.particles.splice(i, 1);
      }
    }
  }

  private drawCursor(x: number, y: number, color: string, name: string, isExtrapolated: boolean): void {
    this.ctx.save();

    // Subtle soft glow halo
    this.ctx.beginPath();
    this.ctx.arc(x + 2, y + 2, 12, 0, Math.PI * 2);
    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = 0.2;
    this.ctx.fill();

    // If in extrapolation mode, draw subtle prediction ring
    if (isExtrapolated) {
      this.ctx.beginPath();
      this.ctx.arc(x + 2, y + 2, 18, 0, Math.PI * 2);
      this.ctx.strokeStyle = color;
      this.ctx.setLineDash([3, 3]);
      this.ctx.lineWidth = 1;
      this.ctx.globalAlpha = 0.5;
      this.ctx.stroke();
      this.ctx.setLineDash([]);
    }

    // Modern SVG-styled Arrow Cursor
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.lineTo(x, y + 18);
    this.ctx.lineTo(x + 5, y + 14);
    this.ctx.lineTo(x + 10, y + 22);
    this.ctx.lineTo(x + 13, y + 20);
    this.ctx.lineTo(x + 8, y + 12);
    this.ctx.lineTo(x + 15, y + 12);
    this.ctx.closePath();

    this.ctx.fillStyle = color;
    this.ctx.globalAlpha = 0.95;
    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    this.ctx.shadowBlur = 6;
    this.ctx.shadowOffsetY = 2;
    this.ctx.fill();

    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 1.5;
    this.ctx.stroke();

    // User Name Tag Pill
    const tagX = x + 16;
    const tagY = y + 14;

    this.ctx.font = '600 11px "Plus Jakarta Sans", sans-serif';
    const textMetrics = this.ctx.measureText(name);
    const textWidth = textMetrics.width;
    const pillPadding = 8;
    const pillHeight = 20;
    const pillWidth = textWidth + pillPadding * 2;

    // Tag background
    this.ctx.beginPath();
    this.ctx.roundRect(tagX, tagY, pillWidth, pillHeight, 10);
    this.ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    this.ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    this.ctx.shadowBlur = 4;
    this.ctx.fill();

    // Tag border
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 1;
    this.ctx.stroke();

    // Tag text
    this.ctx.fillStyle = '#ffffff';
    this.ctx.globalAlpha = 1.0;
    this.ctx.textAlign = 'left';
    this.ctx.textBaseline = 'middle';
    this.ctx.fillText(name, tagX + pillPadding, tagY + pillHeight / 2);

    this.ctx.restore();
  }
}
