# Shove Off

A turn-based marble-pushing game like *Abalone*. Two players, 14 marbles each, on a hexagonal board of 61 holes. Move 1 to 3 of your marbles in a line one hole in any direction, push the other player's marbles when you outnumber them in the line, and push six off the edge to win.

Read `README.md` for how it plays, how it's built and how to run it; this file is the rules and design the code keeps to.

## Rules for v1

- 2 players online, each on their own device, or one player against a CPU. The lobby holds 2; anyone else watches, and so does anyone who arrives mid-game.
- **Against the CPU.** On your own in the lobby, the start button says **Play the CPU**, and starting adds a normal CPU to play. To play an easy or a hard one, add it with Add CPU first. With only one person playing there's no turn timer, nothing passes while they're away, and the game waits for them however long they're gone: nobody is kept waiting.
- The board: 61 holes in a hexagon, 5 to a side, in rows A (bottom) to I (top), numbered along the diagonals (A1–A5 along the bottom, E1–E9 across the middle). Seat 0 moves first and starts at the bottom; each player sees their own marbles at the bottom (the second seat's board is turned round).
- The starting layouts (the host picks; classic by default):
  - Classic: the box's three rows. A1–A5, B1–B6, C3–C5 against I5–I9, H4–H9, G5–G7.
  - Belgian daisy: two hexagons of seven each, in opposite corners: A1 A2 B1 B2 B3 C2 C3 and G7 G8 H7 H8 H9 I8 I9, against A4 A5 B4 B5 B6 C5 C6 and G4 G5 H4 H5 H6 I5 I6.
  - German daisy: the same, a row further in: B1 B2 C1 C2 C3 D2 D3 and F7 F8 G7 G8 G9 H8 H9, against B5 B6 C5 C6 C7 D6 D7 and F3 F4 G3 G4 G5 H4 H5.
- Who moves first is a coin toss for a new pair; after that it swaps every game, so nobody always goes first.
- On your turn you move 1, 2 or 3 of your marbles that sit side by side in a straight line, one hole, in any of the six directions:
  - Along the line ("inline"), the front marble moves into the next hole. If that hole has the other player's marbles in it, you push them along, if you have more marbles in the line than they have in front of you (2 push 1, 3 push 1 or 2), and there's an empty hole or the edge of the board right behind them. A marble pushed past the edge is off the board for good.
  - Across the line (a "side step"), every marble needs an empty hole in front of it, and nothing is pushed.
  - You can't push your own marbles off, push into one of your own (a marble of yours behind theirs blocks the push), or move more than 3.
  - There's no passing by choice. If a player ever has no legal move (all boxed in), their turn passes.
- Push six of the other player's marbles off and you win at once.
- Move limit: the host picks 50, 100 or 150 moves each, or none (default 100). Once both players have had that many turns, whoever has pushed more off wins; equal is a draw. Turns that time out count.
- Turn timer: the host picks off, 30 or 60 seconds, or 2 minutes (default 60 seconds). Running out passes that one turn.
- If the player whose turn it is isn't connected, their turn passes after 10 seconds. Back in time, they get the clock they had, not a new one (the kit's turn clock). A player who misses 3 turns in a row while away loses, so a game can't stall on someone who has gone for good. Resigning, or leaving with the Leave button, loses the game straight away.
- After a game the host can start the next one at once (**Play again**: back to the lobby and start, with the other player moving first) or go back to the lobby.
- Controls:
  - Click or tap your marbles to pick up to 3 in a line. A picked marble at an end of the line drops off it when clicked; the middle one starts a new pick on its own. A marble two holes from a single picked one picks the one between too, if it's yours. Clicking anywhere else clears the pick, and so do Esc and Clear.
  - Arrows round the pick show where it can go. Hover over one (with a mouse) to see the move: ghosts where the marbles land, and a crossed-out ghost for one pushed off. An arrow for a move that isn't allowed only shows under the pointer, in red, with the reason under the board ("Two can't push two…", "Blocked: one of your marbles is behind theirs", …).
  - Click an arrow, drag the marbles in a direction, or press W E A D Z X (north-west, north-east, west, east, south-west, south-east as the board is shown) to move.
  - You can pick marbles and look at moves while you wait; moving says to wait for your turn.
- CPU players (easy, normal, hard), each about 0.9 seconds per move so everyone can follow:
  - Easy looks one move ahead, with a lot of noise in how it judges the board, and plays a random legal move about one time in eight.
  - Normal looks two moves ahead: its move and the best reply.
  - Hard searches four moves ahead with alpha-beta, within a budget of 60,000 positions, keeping the best move of its deepest finished search.
  - All of them judge a board by marbles left (most), how near the middle their marbles are, and how many of their marbles touch.
- Not in v1: 3 to 6 players (Abalone's own variants, with teams for 4 and 6), more starting layouts, undo, a move list in Abalone's notation, and handing a missing player's seat to a CPU. Design so they can be added.

## Design notes

- The board, in `src/shared/hex.ts`: holes are numbered 0–60 in reading order (top row first) from axial coordinates (q, r), and `NB` holds each hole's six neighbours (−1 off the board). Directions are numbered anticlockwise from east as shown on screen: E, NE, NW, W, SW, SE, so the opposite of `d` is `(d + 3) % 6`. `cellName` gives Abalone's names (A1–I9), which the layouts and the tests use.
- The board in the state is 61 numbers: the seat whose marble is in each hole, or −1. Players count the marbles they've pushed off (`pushed`); a player's marbles on the board are always 14 less what the other has pushed off.
- A move is `{ marbles, dir }`: the holes of 1 to 3 of your marbles, in any order, and a direction. `shove` in `rules.ts` is the one place that decides what a move does: it returns what moves and what's pushed (and pushed off), or the sentence that says why it isn't allowed. The server checks every move with it, and the client uses it for the arrows, the previews and the hint under the board.
- The state keeps the last move (the mover's marbles and the marbles they pushed, where they were, the direction, and the hole of a marble pushed off), so the client can slide it in, mark it, and play its sound. The client only slides a move in when it's the one right after the one on screen, and it never waits on the slide: the board is already the new one, so a background tab just shows it.
- The CPU has its own move generator and move maker over an `Int8Array`, with a move packed into one integer (the line's first marble, its axis, its length, the direction, and whether it pushes), so a search allocates almost nothing. A test plays random games and checks it finds exactly the moves `legalShoves` does, and makes them the same way.
- Rules, move generation and the CPU are pure functions in `src/shared/`, with no state beyond their arguments and a seeded RNG, so Vitest can test them and the client can run them for its arrows and the home-screen demo.
- Measure CPU changes with `npm run sim` (CPU against CPU, each pairing taking turns to move first, over the three layouts), never with one game. Over 100 games a pairing (October 2026): Normal beat Easy 100–0, Hard beat Normal 91–1 with 8 draws on the move limit, and Hard beat Easy 100–0. Whoever moved first won exactly half the decided games. Hard's slowest move was about half a second, its usual one well under 200 ms.
- Watch the first-move advantage in playtests: Abalone's classic layout is known to favour defence, and the daisies make for livelier games. The move limit keeps a cautious game from going on for ever.
