import { DurableObject } from "cloudflare:workers";
import type { Match } from "../shared/ai";
import { TICK_MS } from "../shared/constants";
import {
  CLOSE_KICKED,
  CLOSE_NOT_FOUND,
  type ClientMsg,
  type GameState,
  type LogEntry,
  type ServerMsg,
} from "../shared/protocol";
import { Game, GameError, newGameState } from "./game";

interface Attachment {
  pid: string | null;
}

/** Abandoned games are deleted after this long with nobody connected. */
const GC_MS = 12 * 60 * 60 * 1000;
const LOG_MAX = 80;
const MAX_MSG_BYTES = 4096;
/** After a stall, simulate at most this many ticks at once rather than fast-forwarding. */
const MAX_CATCHUP = 5;

export interface RoomInfo {
  code: string;
  phase: GameState["phase"];
  players: number;
}

/**
 * One Durable Object per game code. Holds the game state, the players' secret
 * tokens and the chat/event log, and talks to browsers over hibernatable
 * WebSockets. While a round is on it runs the arena on a fixed tick and
 * broadcasts a frame every tick; between rounds it sleeps and the alarm wakes it.
 */
export class GameRoom extends DurableObject<Env> {
  private state: GameState | null = null;
  private tokens: Record<string, string> = {};
  private log: LogEntry[] = [];
  /** The live round. In memory only: if the object restarts, the round is dealt again. */
  private match: Match | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;
  private ticking = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(["state", "tokens", "log"]);
      this.state = (stored.get("state") as GameState | undefined) ?? null;
      this.tokens = (stored.get("tokens") as Record<string, string> | undefined) ?? {};
      this.log = (stored.get("log") as LogEntry[] | undefined) ?? [];
    });
  }

  /** Claim this code for a new game. Returns false if it's already taken. */
  async init(code: string): Promise<boolean> {
    if (this.state) return false;
    this.state = newGameState(code, Date.now());
    await this.save();
    await this.reschedule();
    return true;
  }

  async info(): Promise<RoomInfo | null> {
    const s = this.state;
    if (!s) return null;
    return { code: s.code, phase: s.phase, players: s.players.filter((p) => !p.spectator).length };
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.state) return new Response("Game not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.state) {
      ws.close(CLOSE_NOT_FOUND, "Game not found");
      return;
    }
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid ?? null;

    // Movement is the hot path: straight to the arena, nothing to save.
    if (msg.t === "move" || msg.t === "bomb") {
      const arena = this.match?.arena;
      if (!pid || !arena || this.state.phase !== "playing") return;
      arena.clientMove(pid, msg.x, msg.y, msg.d);
      if (msg.t === "bomb") arena.placeBomb(pid);
      return;
    }

    const game = this.game();
    try {
      if (msg.t === "hello") {
        this.hello(ws, game, msg.token, msg.name);
      } else if (msg.t === "ping") {
        send(ws, { t: "pong", now: Date.now() });
      } else if (pid && game.player(pid)) {
        this.handle(ws, game, pid, msg);
      }
    } catch (err) {
      if (!(err instanceof GameError)) throw err;
      send(ws, { t: "error", message: err.message });
    }
    await this.flush(game);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.dropSocket(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.dropSocket(ws);
  }

  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const now = Date.now();
    if (this.connectedIds().size === 0) {
      // Nobody is watching: pause the game, and eventually throw it away.
      if (now >= s.lastActive + GC_MS - 1000) {
        this.stopLoop();
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.state = null;
        this.tokens = {};
        this.log = [];
        this.match = null;
        return;
      }
      await this.reschedule();
      return;
    }
    const game = this.game();
    game.onTimer();
    await this.flush(game);
    if (!game.dirty) await this.reschedule();
  }

  // ---------------------------------------------------------------- internals

  private hello(ws: WebSocket, game: Game, rawToken: unknown, name: string): void {
    const token = String(rawToken ?? "");
    if (!/^[\w-]{8,64}$/.test(token)) throw new GameError("Bad player token");
    let player = game.player(this.tokens[token] ?? "");
    if (player) {
      game.rename(player.id, name);
    } else {
      player = game.addHuman(name);
      this.tokens[token] = player.id;
    }
    ws.serializeAttachment({ pid: player.id } satisfies Attachment);
    game.setConnected(player.id, true);
    game.restartRound();
    const frame = this.match?.arena.snapshot(false) ?? null;
    send(ws, { t: "welcome", you: player.id, state: game.s, log: this.log, frame, now: Date.now() });
  }

  private handle(ws: WebSocket, game: Game, pid: string, msg: ClientMsg): void {
    switch (msg.t) {
      case "color":
        return game.setColor(pid, msg.color);
      case "settings":
        return game.updateSettings(pid, msg.settings ?? {});
      case "addCpu":
        return game.addCpu(pid, msg.level);
      case "kick":
        if (game.kick(pid, msg.id)) this.disconnectPlayer(msg.id);
        return;
      case "start":
        return game.start(pid);
      case "chat":
        return game.chat(pid, msg.text);
      case "lobby":
        return game.backToLobby(pid);
      case "leave":
        ws.serializeAttachment({ pid: null } satisfies Attachment);
        game.leave(pid);
        ws.close(1000, "Left the game");
        return;
    }
  }

  private async dropSocket(ws: WebSocket): Promise<void> {
    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;
    try {
      ws.close(1000, "Closed");
    } catch {
      // Already closed.
    }
    if (!this.state || !pid) return;
    if (this.connectedIds(ws).has(pid)) return; // still open in another tab
    const game = this.game();
    game.setConnected(pid, false);
    await this.flush(game);
  }

  private disconnectPlayer(pid: string): void {
    for (const [token, id] of Object.entries(this.tokens)) {
      if (id === pid) delete this.tokens[token];
    }
    for (const ws of this.ctx.getWebSockets()) {
      if ((ws.deserializeAttachment() as Attachment | null)?.pid !== pid) continue;
      ws.serializeAttachment({ pid: null } satisfies Attachment);
      send(ws, { t: "kicked" });
      ws.close(CLOSE_KICKED, "Removed by host");
    }
  }

  private game(): Game {
    const room = this;
    return new Game(this.state!, {
      now: () => Date.now(),
      isConnected: (id) => this.connectedIds().has(id),
      get match() {
        return room.match;
      },
      set match(m) {
        room.match = m;
      },
    });
  }

  private connectedIds(except?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;
      if (pid) ids.add(pid);
    }
    return ids;
  }

  // ---------------------------------------------------------------- tick loop

  /** Run the arena while there's a round on and someone to see it. */
  private syncLoop(): void {
    const run = this.state?.phase === "playing" && !!this.match && this.connectedIds().size > 0;
    if (run && !this.loop) {
      this.lastTick = Date.now();
      // Wake twice a tick and step when one is due: timers drift, and this keeps frames evenly spaced.
      this.loop = setInterval(() => {
        this.tick().catch((err) => console.error("tick failed", err));
      }, TICK_MS / 2);
    } else if (!run) {
      this.stopLoop();
    }
  }

  private stopLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private async tick(): Promise<void> {
    const m = this.match;
    if (!m || !this.state || this.ticking) return;
    const now = Date.now();
    let steps = Math.floor((now - this.lastTick) / TICK_MS);
    if (steps <= 0) return;
    if (steps > MAX_CATCHUP) {
      steps = MAX_CATCHUP;
      this.lastTick = now - steps * TICK_MS;
    }
    this.lastTick += steps * TICK_MS;
    for (let i = 0; i < steps && !m.arena.result; i++) m.step(TICK_MS);

    const frame = m.arena.snapshot(true);
    this.broadcast({ t: "frame", f: frame });
    const game = this.game();
    game.onArenaEvents(frame.ev);
    if (m.arena.result) game.roundOver();
    this.ticking = true;
    try {
      await this.flush(game);
    } finally {
      this.ticking = false;
    }
  }

  /** Send whatever the game queued, persist, re-arm the alarm, and start or stop the tick loop. */
  private async flush(game: Game): Promise<void> {
    if (game.logs.length) {
      this.log.push(...game.logs);
      if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
      this.broadcast({ t: "log", entries: game.logs });
    }
    if (game.dirty) {
      // A new round goes out with its first frame, so clients never see the round without the arena.
      const frame = this.match && this.state?.phase === "playing" ? this.match.arena.snapshot(false) : null;
      this.broadcast({ t: "state", state: game.s, now: Date.now() });
      if (frame && frame.time === 0) this.broadcast({ t: "frame", f: frame });
    }
    if (game.dirty || game.logs.length) {
      await this.save();
      await this.reschedule();
    }
    this.syncLoop();
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!(ws.deserializeAttachment() as Attachment | null)?.pid) continue;
      try {
        ws.send(data);
      } catch {
        // Socket is going away; webSocketClose will clean up.
      }
    }
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put({ state: this.state, tokens: this.tokens, log: this.log });
  }

  private async reschedule(): Promise<void> {
    const s = this.state;
    if (!s) return;
    if (s.timer && this.connectedIds().size > 0) {
      await this.ctx.storage.setAlarm(Math.max(s.timer.at, Date.now() + 10));
    } else {
      await this.ctx.storage.setAlarm(Math.max(s.lastActive + GC_MS, Date.now() + 1000));
    }
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore sends to sockets that are closing.
  }
}
