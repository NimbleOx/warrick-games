# Stack Attack

A falling-block battle game like *Tetris 99* or a *Puyo Puyo Tetris* versus match. Read `README.md` for the rules, the architecture and how to deploy.

## Rules that the code relies on

- Everyone in a round shares one seed, so everyone gets the same piece order (7-bag).
- `Lane` in `src/shared/engine.ts` is the only model of a player's game, and the browser and the server must run it identically. Any rule change (scoring, garbage, top-out) goes there, and the checksum must cover anything that affects later play.
- Garbage timing: a clear cancels garbage up to the `known` id the lock reports; a lock without a clear lets in garbage up to the previous lock's `known`. Don't make it time-based inside `Lane`: it would differ between browser and server. Only the server puts a time floor under `known`: garbage sent more than `SEEN_AFTER_MS` (2 s) before a lock arrives counts as known whatever the lock says, and that lock is overruled. Otherwise a modified browser could keep garbage out forever by never reporting it.
- The garbage multiplier (`attackScale`) depends on time, so it's applied only on the server, to what goes out. Keep it out of `Lane`.
- The server is the authority. When it disagrees with a browser it bumps the board's epoch and sends a `fix`; it never trusts a placement it couldn't reach with `explore()`, nor locks faster than `LOCK_BURST`/`LOCK_RATE` allow (bursts of 20, 10 a second, far beyond any human).
- Super Rotation System turns and kicks, 500 ms lock delay with 15 move resets, guideline gravity curve. Keep the controls local: no input should wait on the network.

## Not in v1

Opponents' falling pieces, 180° turns, per-player targeting (like *Tetris 99*'s attacker/KO modes), key remapping, and a solo marathon or sprint mode. Design so they can be added.
