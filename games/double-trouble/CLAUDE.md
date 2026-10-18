# Double Trouble

A 2048 battle game: everyone plays their own board at once, and merges send rocks to the others. Read `README.md` for the rules, the architecture and how to deploy.

## Rules that the code relies on

- Everyone in a round shares one seed. Tile values come from their own random stream, so everyone gets the same 2s and 4s in the same order; positions (and where rocks land) come from a second stream.
- `Lane` in `src/shared/engine.ts` is the only model of a player's game, and the browser and the server must run it identically. Any rule change (merging, power, rocks, spawning, going out) goes there, and the checksum must cover anything that affects later play.
- Rock timing: a move marks rocks up to the `g` it reports as seen, a move's power smashes only seen rocks, and seen rocks land `ARM_MOVES` moves later. Don't make it time-based inside `Lane`: it would differ between browser and server. The checksum leaves out rocks the browser hadn't seen, because the server may have queued more while a move was in flight. Only the server puts a time floor under `g`: rocks sent more than `SEEN_AFTER_MS` (1.5 s) before a move arrives count as seen whatever the move says, and that move is overruled. Otherwise a modified browser that kept moving could stop rocks from ever landing.
- The rock multiplier (`attackScale`) depends on time, so it's applied only on the server, to what goes out. Keep it out of `Lane`.
- Idle drops are a server action: `Lane.drop()`, then an overrule so the browser takes the new board. Rocks with nowhere to land bury an idle player.
- The server is the authority. When it disagrees with a browser it bumps the board's epoch and sends a `fix`. Moves from an older epoch are ignored; a move with the right epoch that doesn't replay is overruled, and so is one beyond `MOVE_BURST`/`MOVE_RATE` (bursts of 20, 15 a second, faster than any human).
- Keep the controls local: no move should wait on the network. A held key moves once.

## Not in v1

Undo, a solo mode, per-player targeting, bigger boards than 5 × 5, rocks that take more than one hit (`ROCK_HP` and the cracked look are there, unused), and animations on the opponents' boards. Design so they can be added.

## Lessons from the other games

- Deploying restarts every Durable Object and drops every socket. Clients must reconnect and resync from a full snapshot.
- Blur buttons after clicks in the game screen, so the arrow keys go to the board.
- Make every limit visible. If something stops a player from acting, the UI must say why.
- Tests that depend on a random round seed must not assume who wins: pin the goal, or set up the board.

Ask before deploying, committing or pushing.
