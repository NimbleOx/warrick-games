import { CODE_RE, CPU_LEVELS, DEFAULT_COLORS, MAX_PLAYERS } from "../shared/constants";
import type { BaseState, CpuLevel, LogEntry } from "../shared/protocol";
import { isMuted, setMuted, unlockAudio } from "./audio";
import { $, $$, esc, playerToken, setStorePrefix, store, toast } from "./dom";
import { Connection, type NetStatus } from "./net";

export type Screen = "home" | "lobby" | "game";

type AnyMsg = { t: string };

export interface SettingLabel {
  label: string;
  /** How a value reads in the dropdown (and for players who aren't the host). */
  fmt: (v: never) => string;
}

export interface ShellOptions<S extends BaseState, M extends AnyMsg> {
  /** The path the game is served under, its name, and its localStorage prefix ("sa" for sa.name). */
  slug: string;
  title: string;
  prefix: string;
  /** The home card: logo (HTML, with <br /> between the words), tagline (HTML), name placeholder, footer (HTML). */
  logo: string;
  tagline: string;
  placeholder: string;
  footer: string;
  /** What players are called in the lobby, like "Riders". */
  playersLabel?: string;
  /** The rules beside the settings, one HTML string per point. */
  rules?: string[];
  /** Extra top bar buttons for the lobby (HTML). */
  lobbyButtons?: string;
  colors?: readonly string[];
  maxPlayers?: number;
  minPlayers?: number;
  /** Label and formatting for each setting, in the order they're shown. */
  settings: Record<string, SettingLabel>;
  /** The allowed values of each setting (the same table the server checks against). */
  choices: Readonly<Record<string, readonly unknown[]>>;
  /** Extra tags for a player in the lobby list (HTML). */
  playerTags?(p: S["players"][number], s: S): string;

  /** See a message before the shell does; return true to stop the shell handling it. */
  intercept?(msg: M): boolean;
  /** Messages beyond the ones the shell handles (welcome, state, log); errors come here too, after the toast. */
  onMessage?(msg: M): void;
  /** The welcome arrived. Runs before its state is applied. */
  onWelcome?(msg: M): void;
  /** A state was applied. The shell has already shown the lobby or the game screen. */
  onState?(s: S, prev: S | null): void;
  /** A screen was shown. */
  onScreen?(screen: Screen): void;
  /** The player left the game or lost it for good: forget everything about it. */
  onReset?(): void;
  /** Ask before leaving: return the question, or null to leave straight away. */
  confirmLeave?(s: S): string | null;
  /** While this is true, the connection sends heartbeats (real-time games need them). */
  isLive?(s: S): boolean;
}

/**
 * Everything around a game's own screen, the same in every game: the home card and its link
 * back to the hub, creating and joining, invite links, the lobby, chat, the connection and
 * reconnecting, leaving, and the mute button. The game's index.html holds only its game
 * screen; the shell adds the rest.
 *
 * Buttons anywhere with data-action="leave", "start" or "lobby" leave the game, start it (or
 * the next round), and go back to the lobby. Every `.conn` element shows the connection,
 * every `[data-log]` list the chat and events, and every `form[data-chat]` sends chat.
 */
export class Shell<S extends BaseState, C extends AnyMsg = AnyMsg, M extends AnyMsg = AnyMsg> {
  screen: Screen = "home";
  conn: Connection<C, M> | null = null;
  code = "";
  me = "";
  state: S | null = null;
  log: LogEntry[] = [];
  /** Server clock minus ours. */
  skew = 0;
  /** The app lives under Vite's `base` ("/<slug>/"). */
  readonly base: string = import.meta.env.BASE_URL;
  readonly colors: readonly string[];
  readonly maxPlayers: number;
  private readonly minPlayers: number;
  private readonly token: string;

  constructor(private o: ShellOptions<S, M>) {
    setStorePrefix(o.prefix);
    this.token = playerToken();
    this.colors = o.colors ?? DEFAULT_COLORS;
    this.maxPlayers = o.maxPlayers ?? MAX_PLAYERS;
    this.minPlayers = o.minPlayers ?? 2;
    this.mount();
  }

  /** Wire everything up and show the screen for the current URL. Call once the game's own setup is done. */
  start(): void {
    this.wire();
    this.route();
  }

  // ---------------------------------------------------------------- for games

  send(msg: C): boolean {
    return !!this.conn?.send(msg);
  }

  serverNow(): number {
    return Date.now() + this.skew;
  }

  player(id: string | null | undefined): S["players"][number] | undefined {
    return this.state?.players.find((p) => p.id === id);
  }

  /** This browser's player. */
  get mine(): S["players"][number] | undefined {
    return this.player(this.me);
  }

  /** Host controls: the host, or anyone if the host has dropped. */
  canHost(s: S | null = this.state): boolean {
    if (!s) return false;
    if (s.hostId === this.me) return true;
    const host = s.players.find((p) => p.id === s.hostId);
    return !host || !host.connected;
  }

  gamePath(code: string): string {
    return `${this.base}g/${code}`;
  }

  showScreen(screen: Screen): void {
    if (screen !== this.screen) window.scrollTo(0, 0);
    this.screen = screen;
    $("screen-home").hidden = screen !== "home";
    $("screen-lobby").hidden = screen !== "lobby";
    $("screen-game").hidden = screen !== "game";
    this.o.onScreen?.(screen);
  }

  /** Apply a state from the server: show the lobby or the game screen, then let the game render. */
  applyState(s: S): void {
    const prev = this.state;
    this.state = s;
    this.conn?.heartbeat(!!this.o.isLive?.(s));
    document.title = s.phase === "lobby" ? `${this.o.title} · ${s.code} · lobby` : `${this.o.title} · ${s.code}`;
    if (s.phase === "lobby") {
      if (this.screen !== "lobby") this.showScreen("lobby");
      this.renderLobby(s);
    } else if (this.screen !== "game") {
      this.showScreen("game");
    }
    this.o.onState?.(s, prev);
  }

  leave(): void {
    const s = this.state;
    const question = s ? this.o.confirmLeave?.(s) : null;
    if (question && !confirm(question)) return;
    this.send({ t: "leave" } as C);
    store("lastGame", null);
    history.pushState(null, "", this.base);
    this.showHome(null);
  }

  renderLog(): void {
    const html = this.log
      .map((e) =>
        e.kind === "chat"
          ? `<li><span class="who" style="color:${e.color ?? "inherit"}">${esc(e.from ?? "?")}:</span> ${esc(e.text)}</li>`
          : `<li class="ev">${esc(e.text)}</li>`,
      )
      .join("");
    for (const ol of $$("[data-log]")) {
      const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
      ol.innerHTML = html;
      if (atBottom) ol.scrollTop = ol.scrollHeight;
    }
  }

  // ---------------------------------------------------------------- routing and joining

  private route(): void {
    const m = location.pathname.slice(this.base.length).match(/^g\/([A-Za-z0-9]{5})\/?$/);
    const code = m?.[1].toUpperCase();
    if (code && CODE_RE.test(code)) {
      // Coming back to a game you were in (reload, reconnect): straight back in.
      if (store("lastGame") === code && store("name")) void this.joinGame(code);
      else this.showHome(code);
    } else {
      this.showHome(null);
    }
  }

  private showHome(inviteCode: string | null): void {
    this.disconnect();
    this.showScreen("home");
    document.title = this.o.title;
    $("home-error").textContent = "";
    const nameInput = $<HTMLInputElement>("home-name");
    nameInput.value = store("name") ?? "";
    $("home-join-invite").hidden = !inviteCode;
    $("home-default").hidden = !!inviteCode;
    if (inviteCode) {
      $("home-invite-code").textContent = inviteCode;
      $("home-join-invite-btn").dataset.code = inviteCode;
    }
    if (!nameInput.value) nameInput.focus();
  }

  private readName(): string | null {
    const input = $<HTMLInputElement>("home-name");
    const name = input.value.trim().slice(0, 16);
    if (!name) {
      $("home-error").textContent = "Pick a name first.";
      input.focus();
      return null;
    }
    store("name", name);
    return name;
  }

  private async createGame(): Promise<void> {
    if (!this.readName()) return;
    const btn = $<HTMLButtonElement>("home-create");
    btn.disabled = true;
    try {
      const res = await fetch(`${this.base}api/games`, { method: "POST" });
      const body = (await res.json()) as { code?: string; error?: string };
      if (!res.ok || !body.code) throw new Error(body.error ?? "Couldn't create a game");
      history.pushState(null, "", this.gamePath(body.code));
      await this.joinGame(body.code);
    } catch (err) {
      $("home-error").textContent = err instanceof Error ? err.message : String(err);
    } finally {
      btn.disabled = false;
    }
  }

  private async joinGame(code: string): Promise<void> {
    code = code.toUpperCase();
    if (!CODE_RE.test(code)) {
      $("home-error").textContent = "Codes are 5 letters/numbers.";
      return;
    }
    const name = store("name") ?? this.readName();
    if (!name) return;
    try {
      const res = await fetch(`${this.base}api/games/${code}`);
      if (res.status === 404) {
        store("lastGame", null);
        if (location.pathname !== this.base) history.replaceState(null, "", this.base);
        this.showHome(null);
        $("home-error").textContent = `No game with code ${code}. It may have expired.`;
        return;
      }
      if (!res.ok) throw new Error("The server didn't answer. Try again?");
    } catch (err) {
      this.showHome(code);
      $("home-error").textContent = err instanceof Error ? err.message : String(err);
      return;
    }

    this.disconnect();
    store("lastGame", code);
    if (location.pathname !== this.gamePath(code)) history.pushState(null, "", this.gamePath(code));
    this.code = code;
    this.state = null;
    this.log = [];
    this.me = "";
    $("lobby-code").textContent = code;
    $<HTMLInputElement>("lobby-link").value = location.origin + this.gamePath(code);
    const small = $("game-code-small");
    if (small) small.textContent = code;
    $("lobby-players").innerHTML = `<li class="muted">Connecting…</li>`;
    this.showScreen("lobby");

    this.conn = new Connection<C, M>(code, {
      hello: () => ({ t: "hello", token: this.token, name: store("name") ?? name }) as unknown as C,
      message: (msg) => this.onMessage(msg),
      status: (s) => this.onStatus(s),
      fatal: (reason) => {
        store("lastGame", null);
        history.pushState(null, "", this.base);
        this.showHome(null);
        $("home-error").textContent = reason;
      },
    });
  }

  private disconnect(): void {
    this.conn?.close();
    this.conn = null;
    this.state = null;
    this.o.onReset?.();
  }

  private onStatus(status: NetStatus): void {
    for (const el of $$(".conn")) {
      el.dataset.status = status;
      el.textContent = status === "open" ? "" : status === "connecting" ? "Connecting…" : "Reconnecting…";
    }
  }

  private onMessage(msg: M): void {
    const m = msg as AnyMsg & { now?: number; you?: string; log?: LogEntry[]; state?: S; entries?: LogEntry[]; message?: string };
    if (typeof m.now === "number") this.skew = m.now - Date.now();
    if (this.o.intercept?.(msg)) return;
    switch (m.t) {
      case "welcome":
        this.me = m.you!;
        this.log = m.log ?? [];
        this.o.onWelcome?.(msg);
        this.applyState(m.state!);
        this.renderLog();
        return;
      case "state":
        this.applyState(m.state!);
        return;
      case "log":
        this.log.push(...(m.entries ?? []));
        if (this.log.length > 120) this.log.splice(0, this.log.length - 120);
        this.renderLog();
        return;
      case "error":
        toast(m.message ?? "Something went wrong");
        this.o.onMessage?.(msg);
        return;
      case "kicked":
      case "pong":
        return;
      default:
        this.o.onMessage?.(msg);
    }
  }

  // ---------------------------------------------------------------- lobby

  private renderLobby(s: S): void {
    const host = this.canHost(s);
    const participants = s.players.filter((p) => !p.spectator);
    const full = participants.length >= this.maxPlayers;
    $("lobby-count").textContent = `${participants.length}/${this.maxPlayers}`;

    $("lobby-players").innerHTML = s.players
      .map((p) => {
        const tags = [
          p.id === this.me ? `<span class="tag tag-you">you</span>` : "",
          p.id === s.hostId ? `<span class="tag tag-host">host</span>` : "",
          p.cpu ? `<span class="tag">CPU · ${p.cpu}</span>` : "",
          p.spectator ? `<span class="tag">watching</span>` : "",
          this.o.playerTags?.(p, s) ?? "",
          !p.cpu && !p.connected ? `<span class="tag">offline</span>` : "",
        ].join("");
        const kick =
          host && p.id !== this.me
            ? `<button class="kick" data-kick="${p.id}" title="Remove ${esc(p.name)}" aria-label="Remove ${esc(p.name)}">×</button>`
            : "";
        return `<li class="${!p.cpu && !p.connected ? "offline" : ""}">
          <span class="chip" style="background:${p.color}"></span>
          <span class="pname">${esc(p.name)}</span>${tags}<span class="spacer"></span>${kick}</li>`;
      })
      .join("");

    $("lobby-cpu").hidden = !host;
    for (const b of $$<HTMLButtonElement>("#lobby-cpu button")) {
      b.disabled = full;
      b.title = full ? `The game is full (${this.maxPlayers} players)` : "";
    }

    const mine = this.mine;
    const taken = new Map(s.players.filter((p) => p.id !== this.me).map((p) => [p.color, p.name]));
    $("lobby-colors").innerHTML = this.colors
      .map(
        (c) => `<button class="swatch" style="background:${c}" data-color="${c}"
          aria-label="${taken.has(c) ? `Color taken by ${esc(taken.get(c)!)}` : `Color ${c}`}"
          title="${taken.has(c) ? `Taken by ${esc(taken.get(c)!)}` : ""}"
          aria-pressed="${mine?.color === c}" ${taken.has(c) ? "disabled" : ""}></button>`,
      )
      .join("");

    const settings = s.settings as Record<string, unknown>;
    $("lobby-settings").innerHTML = Object.entries(this.o.settings)
      .map(([key, { label, fmt }]) => {
        const show = fmt as (v: unknown) => string;
        const value = settings[key];
        const control = host
          ? `<select data-setting="${key}">${(this.o.choices[key] ?? [])
              .map((v) => `<option value="${esc(String(v))}" ${v === value ? "selected" : ""}>${esc(show(v))}</option>`)
              .join("")}</select>`
          : `<span class="value">${esc(show(value))}</span>`;
        return `<label class="setting"><span class="label">${label}</span>${control}</label>`;
      })
      .join("");

    const start = $<HTMLButtonElement>("lobby-start");
    start.hidden = !host;
    start.disabled = participants.length < this.minPlayers;
    const hostName = this.player(s.hostId)?.name ?? "the host";
    $("lobby-wait").textContent = host
      ? participants.length < this.minPlayers
        ? "Invite a friend or add a CPU to start."
        : ""
      : `Waiting for ${hostName} to start the game…`;
  }

  // ---------------------------------------------------------------- markup and wiring

  /** Add the home and lobby screens (and the toast) to the page, ahead of the game's own screen. */
  private mount(): void {
    const o = this.o;
    const rules = o.rules?.length ? `<ul class="rules">${o.rules.map((r) => `<li>${r}</li>`).join("")}</ul>` : "";
    const cpu = CPU_LEVELS.map((l) => `<button class="btn btn-small" data-cpu="${l}">${l[0].toUpperCase()}${l.slice(1)}</button>`).join("");
    const html = `
    <section id="screen-home" class="screen screen-home">
      <canvas id="attract" class="attract" aria-hidden="true"></canvas>
      <a class="btn btn-small hub-link" href="/"><span aria-hidden="true">←</span> All games</a>
      <div class="home-card">
        <h1 class="logo">${o.logo}</h1>
        <p class="tagline">${o.tagline}</p>
        <label class="field">
          <span class="label">Your name</span>
          <input id="home-name" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="${esc(o.placeholder)}" />
        </label>
        <div id="home-join-invite" class="invite" hidden>
          <span class="label">You're invited to game</span>
          <div class="invite-code" id="home-invite-code"></div>
          <button id="home-join-invite-btn" class="btn btn-primary btn-big">Join game</button>
          <button id="home-not-this" class="link-btn">Start my own game instead</button>
        </div>
        <div id="home-default">
          <button id="home-create" class="btn btn-primary btn-big">Create game</button>
          <div class="divider"><span>or join with a code</span></div>
          <form id="home-join-form" class="join-row">
            <input id="home-code" class="code-input" maxlength="5" autocomplete="off" autocapitalize="characters"
              spellcheck="false" placeholder="CODE" aria-label="Game code" />
            <button class="btn">Join</button>
          </form>
        </div>
        <p id="home-error" class="error" role="alert"></p>
      </div>
      <footer class="home-foot">${o.footer}</footer>
    </section>

    <section id="screen-lobby" class="screen screen-lobby" hidden>
      <header class="topbar">
        <div class="brand">${esc(o.title.toUpperCase())}</div>
        <div class="topbar-right">
          <span class="conn" id="lobby-conn"></span>
          ${o.lobbyButtons ?? ""}
          <button class="btn btn-ghost" data-action="leave">Leave</button>
        </div>
      </header>
      <div class="lobby">
        <div class="panel code-panel">
          <span class="label">Game code</span>
          <div class="big-code" id="lobby-code"></div>
          <div class="share-row">
            <input id="lobby-link" readonly aria-label="Invite link" />
            <button id="lobby-copy" class="btn">Copy link</button>
          </div>
          <p class="hint">Send this link to friends. Anyone with it can join — no sign-up.</p>
        </div>
        <div class="panel players-panel">
          <div class="panel-head">
            <h2>${esc(o.playersLabel ?? "Players")} <span id="lobby-count" class="muted"></span></h2>
          </div>
          <ul id="lobby-players" class="lobby-players"></ul>
          <div id="lobby-cpu" class="cpu-row"><span class="label">Add CPU</span>${cpu}</div>
          <div class="color-row">
            <span class="label">Your color</span>
            <div id="lobby-colors" class="swatches"></div>
          </div>
        </div>
        <div class="panel settings-panel">
          <div class="panel-head"><h2>Settings</h2></div>
          <div id="lobby-settings" class="settings"></div>
          ${rules}
          <button id="lobby-start" class="btn btn-primary btn-big">Start game</button>
          <p id="lobby-wait" class="hint center"></p>
        </div>
        <div class="panel chat-panel">
          <div class="panel-head"><h2>Chat</h2></div>
          <ol class="log" data-log></ol>
          <form class="chat-form" data-chat>
            <input maxlength="200" placeholder="Say something…" aria-label="Chat message" />
          </form>
        </div>
      </div>
    </section>`;
    document.body.insertAdjacentHTML("afterbegin", html);
    if (!$("toast")) document.body.insertAdjacentHTML("beforeend", `<div class="toast" id="toast" role="status" hidden></div>`);
  }

  private wire(): void {
    window.addEventListener("popstate", () => this.route());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.conn?.nudge();
    });
    // A new network: the old socket is probably dead.
    window.addEventListener("online", () => this.conn?.nudge());
    for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, unlockAudio, { passive: true });

    // Home
    $("home-name").addEventListener("change", (e) => store("name", (e.target as HTMLInputElement).value.trim()));
    $("home-create").addEventListener("click", () => void this.createGame());
    $("home-join-form").addEventListener("submit", (e) => {
      e.preventDefault();
      if (this.readName()) void this.joinGame($<HTMLInputElement>("home-code").value.trim());
    });
    $("home-code").addEventListener("input", (e) => {
      const el = e.target as HTMLInputElement;
      el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    $("home-join-invite-btn").addEventListener("click", (e) => {
      if (this.readName()) void this.joinGame((e.currentTarget as HTMLElement).dataset.code ?? "");
    });
    $("home-not-this").addEventListener("click", () => {
      history.pushState(null, "", this.base);
      this.showHome(null);
    });

    // Anywhere
    for (const b of $$("[data-action=leave]")) b.addEventListener("click", () => this.leave());
    for (const b of $$("[data-action=start]")) b.addEventListener("click", () => this.send({ t: "start" } as C));
    for (const b of $$("[data-action=lobby]")) b.addEventListener("click", () => this.send({ t: "lobby" } as C));
    for (const form of $$<HTMLFormElement>("[data-chat]")) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = form.querySelector("input")!;
        const text = input.value.trim();
        if (text) this.send({ t: "chat", text } as unknown as C);
        input.value = "";
        // Hand the keyboard back to the game after chatting mid-game.
        if (this.screen === "game") input.blur();
      });
    }

    // Lobby
    $("lobby-copy").addEventListener("click", async () => {
      const link = $<HTMLInputElement>("lobby-link");
      try {
        await navigator.clipboard.writeText(link.value);
        toast("Invite link copied", "info");
      } catch {
        link.select();
        toast("Press Ctrl/⌘+C to copy", "info");
      }
    });
    $("lobby-link").addEventListener("focus", (e) => (e.target as HTMLInputElement).select());
    $("lobby-players").addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-kick]")?.dataset.kick;
      if (id) this.send({ t: "kick", id } as unknown as C);
    });
    $("lobby-cpu").addEventListener("click", (e) => {
      const level = (e.target as HTMLElement).closest<HTMLElement>("[data-cpu]")?.dataset.cpu as CpuLevel | undefined;
      if (level) this.send({ t: "addCpu", level } as unknown as C);
    });
    $("lobby-colors").addEventListener("click", (e) => {
      const color = (e.target as HTMLElement).closest<HTMLElement>("[data-color]")?.dataset.color;
      if (color) this.send({ t: "color", color } as unknown as C);
    });
    $("lobby-settings").addEventListener("change", (e) => {
      const el = e.target as HTMLSelectElement;
      const key = el.dataset.setting;
      if (!key) return;
      // Send the value as its real type: the server only accepts the exact values in `choices`.
      const value = (this.o.choices[key] ?? []).find((v) => String(v) === el.value);
      if (value !== undefined) this.send({ t: "settings", settings: { [key]: value } } as unknown as C);
    });
    $("lobby-start").addEventListener("click", () => this.send({ t: "start" } as C));

    const mute = $("mute");
    if (mute) {
      const paint = () => {
        mute.textContent = isMuted() ? "🔇" : "🔊";
        mute.setAttribute("aria-pressed", String(isMuted()));
      };
      paint();
      mute.addEventListener("click", () => {
        setMuted(!isMuted());
        paint();
        mute.blur();
      });
    }
  }
}
