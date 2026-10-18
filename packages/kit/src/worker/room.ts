import { DurableObject } from "cloudflare:workers";
import { CLOSE_KICKED, CLOSE_NOT_FOUND } from "../shared/constants";
import type { BaseState, LobbyMsg, LogEntry, RoomInfo } from "../shared/protocol";
import { GameError, type GameIO, type Lobby } from "./lobby";

interface Attachment {
  pid: string | null;
}

/** Abandoned games are deleted after this long with nobody connected. */
const GC_MS = 12 * 60 * 60 * 1000;
const LOG_MAX = 80;
const MAX_MSG_BYTES = 4096;

type AnyMsg = { t: string };

/**
 * One Durable Object per game code. Holds the game state, the players' secret tokens and the
 * chat/event log in storage, and talks to browsers over hibernatable WebSockets.
 *
 * A game extends this with its `Game` class (a `Lobby`) and the messages it handles beyond the
 * lobby ones. Two ways to run time-based rules, either or both:
 * - an alarm: `timerAt()` says when, and the game's `onTimer()` runs then (turn timers, CPU turns);
 * - a tick loop every `tickMs`, while `wantsLoop()` and someone is connected, calling the game's
 *   `tick()`. It keeps the object awake, so stop it between rounds and the object can hibernate.
 *
 * `live` is the game's in-memory state (a round in progress, say). It's never saved: a restart
 * (every deploy restarts every Durable Object) loses it, so the game must cope with it being null.
 */
export abstract class Room<S extends BaseState, G extends Lobby<S, AnyMsg, L>, L = unknown> extends DurableObject {
  protected state: S | null = null;
  protected tokens: Record<string, string> = {};
  protected log: LogEntry[] = [];
  protected live: L | null = null;
  /** Tick loop period in ms; 0 for no loop. */
  protected readonly tickMs: number = 0;
  private loop: ReturnType<typeof setTimeout> | null = null;
  private loopStart = 0;
  private loopTicks = 0;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<unknown>(["state", "tokens", "log"]);
      this.state = (stored.get("state") as S | undefined) ?? null;
      this.tokens = (stored.get("tokens") as Record<string, string> | undefined) ?? {};
      this.log = (stored.get("log") as LogEntry[] | undefined) ?? [];
      // After a restart the saved "connected" flags are stale (those sockets died with the old
      // instance); after hibernation the sockets are still here. Either way, trust the sockets.
      if (this.state) {
        const live = this.connectedIds();
        for (const p of this.state.players) if (!p.cpu) p.connected = live.has(p.id);
      }
    });
  }

  /** A fresh game state for a new code. */
  protected abstract newState(code: string, now: number): S;
  /** The game's rules over the current state; a new one for every action. */
  protected abstract makeGame(state: S, io: GameIO, live: L | null): G;

  /** Messages beyond the lobby ones. */
  protected handle(_ws: WebSocket, _game: G, _pid: string, _msg: AnyMsg): void {}
  /** Runs when a player says hello, before the welcome (to restart a round lost to a restart, say). */
  protected afterHello(_game: G): void {}
  /** Extra fields for the welcome message. */
  protected welcome(_game: G): object {
    return {};
  }
  /** When the game's alarm should fire, if it has one pending. */
  protected timerAt(_state: S): number | null {
    return null;
  }
  /** Whether the tick loop should run (it also needs someone connected). */
  protected wantsLoop(_state: S): boolean {
    return false;
  }

  // ---------------------------------------------------------------- RPC and fetch

  /** Claim this code for a new game. Returns false if it's already taken. */
  async init(code: string): Promise<boolean> {
    if (this.state) return false;
    this.state = this.newState(code, Date.now());
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

  // ---------------------------------------------------------------- sockets

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.state) {
      ws.close(CLOSE_NOT_FOUND, "Game not found");
      return;
    }
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return;
    let msg: AnyMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== "string") return;

    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid ?? null;
    const game = this.game();
    try {
      if (msg.t === "hello") {
        const m = msg as Extract<LobbyMsg, { t: "hello" }>;
        this.hello(ws, game, m.token, m.name);
      } else if (msg.t === "ping") {
        // A real message (not the auto-answered "ping" text): it also resets the object's CPU budget.
        send(ws, { t: "pong", now: Date.now() });
      } else if (pid && game.player(pid)) {
        this.dispatch(ws, game, pid, msg);
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
    if (this.connectedIds().size === 0) {
      // Nobody is here: timers wait, and an abandoned game is eventually thrown away.
      if (Date.now() >= s.lastActive + GC_MS - 1000) {
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        this.stopLoop();
        this.state = null;
        this.tokens = {};
        this.log = [];
        this.live = null;
        return;
      }
      await this.reschedule();
      return;
    }
    if (this.timerAt(s) !== null) {
      const game = this.game();
      game.onTimer?.();
      await this.flush(game);
      if (game.dirty || game.logs.length) return; // flush rescheduled
    }
    await this.reschedule();
  }

  // ---------------------------------------------------------------- for games

  /** Every open socket's player id, optionally leaving one socket out. */
  protected connectedIds(except?: WebSocket): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;
      if (pid) ids.add(pid);
    }
    return ids;
  }

  protected broadcast(msg: object): void {
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

  protected sendTo(pid: string, msg: object): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if ((ws.deserializeAttachment() as Attachment | null)?.pid === pid) send(ws, msg);
    }
  }

  // ---------------------------------------------------------------- internals

  private dispatch(ws: WebSocket, game: G, pid: string, msg: AnyMsg): void {
    const m = msg as LobbyMsg;
    switch (m.t) {
      case "color":
        return game.setColor(pid, m.color);
      case "settings":
        return game.updateSettings(pid, m.settings ?? {});
      case "addCpu":
        return game.addCpu(pid, m.level);
      case "kick":
        if (game.kick(pid, m.id)) this.disconnectPlayer(m.id);
        return;
      case "start":
        return game.start(pid);
      case "lobby":
        return game.backToLobby(pid);
      case "chat":
        return game.chat(pid, m.text);
      case "leave":
        ws.serializeAttachment({ pid: null } satisfies Attachment);
        game.leave(pid);
        ws.close(1000, "Left the game");
        return;
      default:
        return this.handle(ws, game, pid, msg);
    }
  }

  private hello(ws: WebSocket, game: G, rawToken: unknown, name: string): void {
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
    this.afterHello(game);
    send(ws, { ...this.welcome(game), t: "welcome", you: player.id, state: game.s, log: this.log, now: Date.now() });
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

  private game(connected?: Set<string>): G {
    return this.makeGame(
      this.state!,
      {
        now: () => Date.now(),
        isConnected: (id) => (connected ?? this.connectedIds()).has(id),
      },
      this.live,
    );
  }

  /** Send whatever the game queued; persist and re-arm the alarm if anything worth keeping changed. */
  private async flush(game: G): Promise<void> {
    this.live = game.live;
    const now = Date.now();
    if (game.logs.length) {
      this.log.push(...game.logs);
      if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
      this.broadcast({ t: "log", entries: game.logs });
    }
    // A message that carries the state itself (a shot and its outcome, say) stands in for a state message.
    let carried = false;
    for (const msg of game.outbox) {
      if ("state" in msg) carried = true;
      this.broadcast(msg);
    }
    for (const { pid, msg } of game.direct) this.sendTo(pid, msg);
    if (game.dirty && !carried) this.broadcast({ t: "state", state: game.s, now });
    this.syncLoop();
    if (game.dirty || game.logs.length) {
      await this.save();
      await this.reschedule();
    }
  }

  // ---------------------------------------------------------------- tick loop

  /** Run the tick loop exactly while the game wants it and someone is here to see it. */
  private syncLoop(): void {
    const want = this.tickMs > 0 && !!this.state && this.wantsLoop(this.state) && this.connectedIds().size > 0;
    if (want && !this.loop) {
      this.loopStart = Date.now();
      this.loopTicks = 0;
      this.scheduleTick();
    } else if (!want) {
      this.stopLoop();
    }
  }

  private stopLoop(): void {
    if (this.loop) clearTimeout(this.loop);
    this.loop = null;
  }

  /** Ticks are scheduled from the loop's start, so they don't drift or bunch up after a slow one. */
  private scheduleTick(): void {
    const now = Date.now();
    let due = this.loopStart + (this.loopTicks + 1) * this.tickMs;
    if (now - due > this.tickMs * 4) {
      // Fell well behind (a slow save, say). Carry on from now rather than sprinting to catch up.
      this.loopStart = now - this.loopTicks * this.tickMs;
      due = now + this.tickMs;
    }
    this.loop = setTimeout(() => this.runTick(), Math.max(0, due - now));
  }

  private runTick(): void {
    this.loop = null;
    if (!this.state || !this.wantsLoop(this.state)) return;
    const game = this.game(this.connectedIds());
    game.tick?.();
    this.loopTicks++;
    // Re-arm before flushing: syncLoop() then leaves the running loop (and its schedule) alone,
    // and still stops it if the round just ended. Restarting it there would reset the schedule
    // every tick, so each tick would come tickMs after the last one finished and the game would
    // run slow.
    this.scheduleTick();
    this.flush(game).catch((err) => console.error("tick flush failed", err));
  }

  // ---------------------------------------------------------------- storage

  private async save(): Promise<void> {
    await this.ctx.storage.put({ state: this.state, tokens: this.tokens, log: this.log });
  }

  private async reschedule(): Promise<void> {
    const s = this.state;
    if (!s) return;
    const at = this.timerAt(s);
    if (at !== null && this.connectedIds().size > 0) {
      await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 10));
    } else {
      await this.ctx.storage.setAlarm(Math.max(s.lastActive + GC_MS, Date.now() + 1000));
    }
  }
}

function send(ws: WebSocket, msg: object): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // Ignore sends to sockets that are closing.
  }
}
