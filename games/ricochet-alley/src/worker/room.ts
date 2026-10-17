import { DurableObject } from "cloudflare:workers";
import { TICK_MS } from "../shared/constants";
import {
  CLOSE_KICKED,
  CLOSE_NOT_FOUND,
  type ClientMsg,
  type GameState,
  type LogEntry,
  type ServerMsg,
} from "../shared/protocol";
import { Game, GameError, newGameState, newLive, type Live } from "./game";

interface Attachment {
  pid: string | null;
}

/** Abandoned games are deleted after this long with nobody connected. */
const GC_MS = 12 * 60 * 60 * 1000;
const LOG_MAX = 80;
const MAX_MSG_BYTES = 4096;
/** Messages a socket may send per second before the rest are dropped (input changes are the busy ones). */
const MAX_MSGS_PER_SEC = 90;
/** If the loop falls this many ticks behind (a slow save, say), it skips ahead instead of sprinting. */
const MAX_CATCH_UP = 4;

export interface RoomInfo {
  code: string;
  phase: GameState["phase"];
  players: number;
}

/**
 * One Durable Object per game code. Holds the game state, the players' secret tokens and the chat/event log in
 * storage, and talks to browsers over hibernatable WebSockets. During a round a 30 Hz loop steps the
 * simulation and broadcasts a frame every tick; between rounds the loop stops, and the countdown, the
 * round-over pause and cleanup run off the alarm, so an idle game can hibernate.
 *
 * State is saved at round boundaries and lobby changes, never per tick. The round itself (tank positions,
 * bullets) lives only in memory; after a restart the round begins again from its saved starting positions.
 */
export class GameRoom extends DurableObject<Env> {
  private state: GameState | null = null;
  private tokens: Record<string, string> = {};
  private log: LogEntry[] = [];
  private live: Live = newLive();
  private loop: ReturnType<typeof setInterval> | null = null;
  private loopStart = 0;
  private loopTicks = 0;
  private rates = new Map<WebSocket, { at: number; n: number }>();
  /** Each socket's player id, cached: the tick loop asks every frame, and attachments are slow to read. */
  private pids = new WeakMap<WebSocket, string | null>();

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
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES || this.overLimit(ws)) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const game = this.game();
    const pid = this.pidOf(ws);
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
        this.live = newLive();
        return;
      }
      await this.reschedule();
      return;
    }
    const game = this.game();
    if (!this.live.round) game.recover(); // the room restarted mid-round
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
    this.attach(ws, player.id);
    game.setConnected(player.id, true);
    game.resetInput(player.id);
    game.wake(!!this.loop);
    send(ws, {
      t: "welcome",
      you: player.id,
      state: game.s,
      world: this.live.round?.world.snapshot() ?? null,
      log: this.log,
      now: Date.now(),
    });
  }

  private handle(ws: WebSocket, game: Game, pid: string, msg: ClientMsg): void {
    switch (msg.t) {
      case "in":
        return game.input(pid, msg.s, msg.b, msg.f === 1);
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
        this.attach(ws, null);
        game.leave(pid);
        ws.close(1000, "Left the game");
        return;
    }
  }

  private overLimit(ws: WebSocket): boolean {
    const now = Date.now();
    const r = this.rates.get(ws);
    if (!r || now - r.at >= 1000) {
      this.rates.set(ws, { at: now, n: 1 });
      return false;
    }
    return ++r.n > MAX_MSGS_PER_SEC;
  }

  private async dropSocket(ws: WebSocket): Promise<void> {
    this.rates.delete(ws);
    const pid = this.pidOf(ws);
    try {
      ws.close(1000, "Closed");
    } catch {
      // Already closed.
    }
    if (!this.state || !pid) {
      this.syncLoop();
      return;
    }
    if (this.connectedIds(ws).has(pid)) return; // still open in another tab
    const game = this.game();
    game.setConnected(pid, false);
    await this.flush(game, ws);
  }

  private disconnectPlayer(pid: string): void {
    for (const [token, id] of Object.entries(this.tokens)) {
      if (id === pid) delete this.tokens[token];
    }
    for (const ws of this.ctx.getWebSockets()) {
      if (this.pidOf(ws) !== pid) continue;
      this.attach(ws, null);
      send(ws, { t: "kicked" });
      ws.close(CLOSE_KICKED, "Removed by host");
    }
  }

  private game(): Game {
    return new Game(
      this.state!,
      {
        now: () => Date.now(),
        isConnected: (id) => this.connectedIds().has(id),
      },
      this.live,
    );
  }

  private connectedIds(except?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const pid = this.pidOf(ws);
      if (pid) ids.add(pid);
    }
    return ids;
  }

  private pidOf(ws: WebSocket): string | null {
    let pid = this.pids.get(ws);
    if (pid === undefined) {
      pid = (ws.deserializeAttachment() as Attachment | null)?.pid ?? null;
      this.pids.set(ws, pid);
    }
    return pid;
  }

  /** Bind a socket to a player (or unbind it), in the attachment so it survives hibernation. */
  private attach(ws: WebSocket, pid: string | null): void {
    ws.serializeAttachment({ pid } satisfies Attachment);
    this.pids.set(ws, pid);
  }

  // ---------------------------------------------------------------- tick loop

  /** Run the loop while a round is live and someone is connected to see it; stop it otherwise. */
  private syncLoop(except?: WebSocket): void {
    const s = this.state;
    const want = !!s && s.phase === "playing" && !!this.live.round && this.connectedIds(except).size > 0;
    if (want && !this.loop) {
      this.loopStart = Date.now();
      this.loopTicks = 0;
      this.loop = setInterval(() => this.runTicks(), TICK_MS);
    } else if (!want) {
      this.stopLoop();
    }
  }

  private stopLoop(): void {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  /** Run however many ticks are due by the wall clock (usually one). */
  private runTicks(): void {
    const s = this.state;
    if (!s || s.phase !== "playing" || !this.live.round) {
      this.syncLoop();
      return;
    }
    const now = Date.now();
    let due = Math.floor((now - this.loopStart) / TICK_MS) - this.loopTicks;
    if (due > MAX_CATCH_UP) {
      this.loopStart = now - (this.loopTicks + 1) * TICK_MS;
      due = 1;
    }
    for (let i = 0; i < due && s.phase === "playing"; i++) {
      const game = this.game();
      game.tick();
      this.loopTicks++;
      this.flush(game).catch((err) => console.error("tick flush failed", err));
    }
  }

  /** Send whatever the game queued, persist if the state changed, and re-arm the alarm and loop. */
  private async flush(game: Game, closing?: WebSocket): Promise<void> {
    const now = Date.now();
    if (game.dirty) this.broadcast({ t: "state", state: game.s, now });
    for (const msg of game.outbox) this.broadcast(msg);
    if (game.logs.length) {
      this.log.push(...game.logs);
      if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
      this.broadcast({ t: "log", entries: game.logs });
    }
    this.syncLoop(closing);
    // Mid-round log lines (kills) ride along with the next save rather than costing one each.
    if (game.dirty || (game.logs.length && game.s.phase !== "playing")) {
      await this.save();
      await this.reschedule();
    }
  }

  private broadcast(msg: ServerMsg): void {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN || !this.pidOf(ws)) continue;
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
