// Team balancing and brackets for /sgdraft — pure functions, no Discord.
//
// A player is { id, aura, girl }, where aura is the raw AURA role number
// (lower is stronger). Only team totals are compared, so the direction of the
// scale doesn't matter for balancing.
//
// Any number of 5-player teams (2, 3, 4, …) are balanced against each other,
// since in a bracket any team may meet any other. Two hard rules on top:
//  - the N strongest players (N = number of teams) are on N different teams,
//    so top tiers are never stacked — with 4 teams, GOD / KING / 1 / 1.5 are
//    split up (a tie at the cutoff is broken at random);
//  - girls are spread evenly: team girl counts differ by at most one, so as
//    many teams as possible get one.

export const TEAM_SIZE = 5;
export const MAX_TEAMS = 24; // Discord embeds hold 25 fields: 24 teams + the bench
const RESTARTS = 80;
const EPS = 1e-9;

export const teamTotal = (team) => team.reduce((s, p) => s + p.aura, 0);

/**
 * How stacked the most stacked team is: the smallest "two best players" total
 * over all teams (higher = less stacked). Used to prefer, among equally even
 * lineups, the one where no team pairs two very strong players — e.g. a spare
 * 1.5 goes to the team led by the 1.5, not the one led by GOD.
 */
export const stackOf = (teams) =>
  Math.min(
    ...teams.map((t) => {
      const [a, b] = t.map((p) => p.aura).sort((x, y) => x - y);
      return a + b;
    }),
  );

/** Highest minus lowest team total — the number people see. */
export const spreadOf = (teams) => {
  const totals = teams.map(teamTotal);
  return Math.max(...totals) - Math.min(...totals);
};

function shuffle(list, rng) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Order-independent id for a lineup, so a reshuffle can tell it's been shown. */
function lineupKey(teams) {
  return teams
    .map((t) => t.map((p) => p.id).sort().join(','))
    .sort()
    .join('|');
}

/** The `count` strongest players (lowest AURA); ties at the cutoff broken at random. */
function pickSeeds(players, count, rng) {
  const order = shuffle(players, rng).sort((a, b) => a.aura - b.aura); // stable: shuffle breaks ties
  return new Set(order.slice(0, count).map((p) => p.id));
}

/**
 * Random start that already obeys both rules: one seed per team, then girls
 * to whichever teams have the fewest (counts differ by ≤ 1), then the rest.
 */
function randomStart(players, count, seeds, rng) {
  const teams = Array.from({ length: count }, () => []);
  const isSeed = (p) => seeds.has(p.id);
  shuffle(players.filter(isSeed), rng).forEach((s, i) => teams[i].push(s));

  const girlsIn = (t) => t.filter((p) => p.girl).length;
  for (const g of shuffle(players.filter((p) => p.girl && !isSeed(p)), rng)) {
    const open = shuffle(teams.filter((t) => t.length < TEAM_SIZE), rng);
    open.sort((a, b) => girlsIn(a) - girlsIn(b));
    open[0].push(g);
  }
  const others = shuffle(players.filter((p) => !p.girl && !isSeed(p)), rng);
  for (const team of teams) while (team.length < TEAM_SIZE) team.push(others.pop());
  return teams;
}

/**
 * Improve by swapping like-for-like between teams — girl↔girl or other↔other,
 * and seed↔seed or non-seed↔non-seed — which keeps both rules intact, until no
 * swap lowers the variance of the team totals.
 */
function improve(teams, seeds) {
  const totals = teams.map(teamTotal);
  const mean = totals.reduce((a, b) => a + b, 0) / teams.length;
  const sq = (x) => (x - mean) ** 2;

  for (let improved = true; improved; ) {
    improved = false;
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        for (let x = 0; x < TEAM_SIZE; x++) {
          for (let y = 0; y < TEAM_SIZE; y++) {
            const p = teams[i][x];
            const q = teams[j][y];
            if (p.girl !== q.girl || seeds.has(p.id) !== seeds.has(q.id) || p.aura === q.aura) continue;
            const d = q.aura - p.aura;
            const before = sq(totals[i]) + sq(totals[j]);
            const after = sq(totals[i] + d) + sq(totals[j] - d);
            if (after < before - EPS) {
              teams[i][x] = q;
              teams[j][y] = p;
              totals[i] += d;
              totals[j] -= d;
              improved = true;
            }
          }
        }
      }
    }
  }
  return teams;
}

/**
 * Draft players (in join order) into `teamCount` teams of 5. Anyone past the
 * last full team sits out. With no teamCount, as many teams as the players fill.
 *
 * The first draft picks the most even lineup found. A reshuffle picks any
 * lineup within `tolerance` of the best spread that hasn't been shown yet.
 *
 * Returns { teams, benched, spread, key } — teams empty if fewer than 2 fit.
 */
export function draft(
  players,
  { teamCount, reshuffle = false, avoid = new Set(), current = null, tolerance = 1, rng = Math.random } = {},
) {
  const fits = Math.min(MAX_TEAMS, Math.floor(players.length / TEAM_SIZE));
  const count = Math.min(teamCount || fits, fits);
  if (count < 2) return { teams: [], benched: players, spread: 0, key: '' };

  const playing = players.slice(0, count * TEAM_SIZE);
  const benched = players.slice(count * TEAM_SIZE);

  const found = new Map(); // key -> lineup
  for (let r = 0; r < RESTARTS; r++) {
    const seeds = pickSeeds(playing, count, rng);
    const teams = improve(randomStart(playing, count, seeds, rng), seeds);
    const key = lineupKey(teams);
    if (!found.has(key)) found.set(key, { teams, spread: spreadOf(teams), stack: stackOf(teams), key });
  }

  const lineups = [...found.values()];
  const best = Math.min(...lineups.map((l) => l.spread));
  const even = lineups.filter((l) => l.spread <= best + (reshuffle ? tolerance : 0) + EPS);
  // Lineups not shown yet (else anything but the one on screen), then only the
  // least stacked of those — in that order, or Reshuffle can keep landing on
  // the same least-stacked lineup.
  const fresh = even.filter((l) => !avoid.has(l.key));
  const other = even.filter((l) => l.key !== current);
  const candidates = fresh.length ? fresh : other.length ? other : even;
  const leastStacked = Math.max(...candidates.map((l) => l.stack));
  const pool = candidates.filter((l) => l.stack >= leastStacked - EPS);
  const chosen = pool[Math.floor(rng() * pool.length)];
  return { teams: chosen.teams, benched, spread: chosen.spread, key: chosen.key };
}

// ---------------------------------------------------------------------------
// Single-elimination bracket
// ---------------------------------------------------------------------------
//
// Teams are referred to by index into the drafted teams array. rounds[r][m] is
// { a, b, winner } where a/b are team indexes (null = bye / not decided yet).
// Only round 1 has byes; later rounds are filled from the winners before them.

/** How many round-1 matches a bracket of `count` teams has (the rest get byes). */
export function firstRoundMatches(count) {
  let size = 1;
  while (size < count) size *= 2;
  return count - size / 2;
}

/**
 * @param totals  each team's total aura
 * @param mode    'random' | 'aura' | 'manual' — aura pairs the closest totals
 *                and gives byes to the weakest teams (highest totals); manual
 *                takes the order the host picked
 * @param order   for 'manual': team indexes as [a1, b1, a2, b2, …, byes…]
 */
export function createBracket(totals, mode, rng = Math.random, order = null) {
  const count = totals.length;
  let size = 1;
  while (size < count) size *= 2;

  if (mode === 'manual') {
    const seen = new Set(order ?? []);
    if (!order || order.length !== count || seen.size !== count) {
      throw new Error('manual bracket needs every team exactly once');
    }
  } else {
    order =
      mode === 'aura'
        ? totals.map((t, i) => i).sort((x, y) => totals[x] - totals[y])
        : shuffle(
            totals.map((_, i) => i),
            rng,
          );
  }

  // count − size/2 real matches in round 1; everyone else gets a bye.
  const playing = 2 * (count - size / 2);
  const first = [];
  for (let i = 0; i < playing; i += 2) first.push({ a: order[i], b: order[i + 1], winner: null });
  for (let i = playing; i < count; i++) first.push({ a: order[i], b: null, winner: order[i] });

  const rounds = [first];
  for (let n = first.length / 2; n >= 1; n /= 2) {
    rounds.push(Array.from({ length: n }, () => ({ a: null, b: null, winner: null })));
  }
  const bracket = { mode, rounds, history: [] };
  fill(bracket);
  return bracket;
}

/** Carry winners forward into the next round's slots. */
function fill(bracket) {
  const { rounds } = bracket;
  for (let r = 1; r < rounds.length; r++) {
    rounds[r].forEach((match, m) => {
      match.a = rounds[r - 1][2 * m].winner;
      match.b = rounds[r - 1][2 * m + 1].winner;
    });
  }
}

/** Matches ready to play: both teams known, no winner yet. */
export function openMatches(bracket) {
  const out = [];
  bracket.rounds.forEach((round, r) =>
    round.forEach((match, m) => {
      if (match.a != null && match.b != null && match.winner == null) out.push({ r, m, match });
    }),
  );
  return out;
}

export function champion(bracket) {
  return bracket.rounds.at(-1)[0].winner;
}

/** Record a result. Returns an error message, or null. */
export function markWinner(bracket, r, m, team) {
  const match = bracket.rounds[r]?.[m];
  if (!match || match.a == null || match.b == null) return 'That match isn’t ready yet.';
  if (match.winner != null) return 'That match already has a winner — use Undo to change it.';
  if (team !== match.a && team !== match.b) return 'That team isn’t in this match.';
  match.winner = team;
  bracket.history.push([r, m]);
  fill(bracket);
  return null;
}

/** Undo the most recent result. Returns false if there was nothing to undo. */
export function undoWinner(bracket) {
  const last = bracket.history.pop();
  if (!last) return false;
  bracket.rounds[last[0]][last[1]].winner = null;
  fill(bracket);
  return true;
}

/** "Final", "Semifinals", "Quarterfinals", else "Round n" — counted from the end. */
export function roundName(r, totalRounds) {
  return ['Final', 'Semifinals', 'Quarterfinals'][totalRounds - 1 - r] ?? `Round ${r + 1}`;
}
