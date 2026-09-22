// The maths behind /sgcasino. Kept apart from the Discord side so the odds can
// be read — and tested — on their own.
//
// Every payout here is the exact inverse of the chance of winning, so the house
// takes nothing: a bet's expected return is precisely the bet. Blackjack is the
// one exception the rules themselves impose, and `EDGE_NOTE` says so.

import { randomInt } from 'node:crypto';

/** A fair integer in [0, n). */
export const roll = (n) => randomInt(0, n);

// --- coinflip --------------------------------------------------------------

export const SIDES = ['heads', 'tails'];

/** 50/50, pays 2x. */
export function flip(side) {
  const landed = SIDES[roll(2)];
  return { landed, won: landed === side, multiplier: 2 };
}

// --- dice ------------------------------------------------------------------

export const DICE_FACES = 100;

/**
 * Roll 1-100 and bet whether it lands over or under a line.
 *   over N  wins on N+1 … 100   (100 - N outcomes)
 *   under N wins on 1 … N       (N outcomes)
 * so every roll is a win for exactly one of the two directions — no tie to
 * quietly hand the house, and the payout is 100 / (winning outcomes).
 */
export function dice(direction, line) {
  const rolled = roll(DICE_FACES) + 1;
  const wins = direction === 'over' ? DICE_FACES - line : line;
  const won = direction === 'over' ? rolled > line : rolled <= line;
  return { rolled, won, wins, multiplier: DICE_FACES / wins };
}

/** The bettable lines: both directions must be able to lose. */
export const DICE_MIN = 1;
export const DICE_MAX = DICE_FACES - 1;

// --- slots -----------------------------------------------------------------

export const REELS = ['🌱', '🎀', '🎮', '🏁', '💎', '🔥', '🟡'];
export const JACKPOT = '🟡';
// With 7 equally likely symbols on 3 reels there are 343 outcomes: 1 jackpot
// line, 6 other triples, 126 pairs, 210 duds. 25 + 6x11 + 126x2 = 343, so the
// three payouts below return exactly the stake on average.
export const SLOT_PAYS = { jackpot: 25, triple: 11, pair: 2 };

export function slots() {
  const reels = [REELS[roll(REELS.length)], REELS[roll(REELS.length)], REELS[roll(REELS.length)]];
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return { reels, kind: a === JACKPOT ? 'jackpot' : 'triple', multiplier: a === JACKPOT ? SLOT_PAYS.jackpot : SLOT_PAYS.triple };
  }
  if (a === b || b === c || a === c) return { reels, kind: 'pair', multiplier: SLOT_PAYS.pair };
  return { reels, kind: 'none', multiplier: 0 };
}

/** The exact expected return of one spin — 1 means the house takes nothing. */
export function slotsReturn() {
  const n = REELS.length;
  const outcomes = n ** 3;
  const paid = SLOT_PAYS.jackpot + (n - 1) * SLOT_PAYS.triple + 3 * n * (n - 1) * SLOT_PAYS.pair;
  return paid / outcomes;
}

// --- mines -----------------------------------------------------------------

// Four rows of five: Discord allows five rows of five components, and the last
// row is needed for Cash out.
export const TILES = 20;
export const MINES_MIN = 1;
export const MINES_MAX = 10;
export const MINES_DEFAULT = 3;

/** Where the bombs are. Decided when the game starts, never after a pick. */
export function layMines(bombs) {
  const spots = new Set();
  while (spots.size < bombs) spots.add(roll(TILES));
  return [...spots];
}

const choose = (n, k) => {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 0; i < k; i++) out = (out * (n - i)) / (i + 1);
  return out;
};

/**
 * What `picks` safe tiles are worth. Surviving k picks has probability
 * C(TILES-bombs, k) / C(TILES, k), and the payout is its inverse.
 */
export function minesMultiplier(bombs, picks) {
  if (picks <= 0) return 1;
  const survive = choose(TILES - bombs, picks) / choose(TILES, picks);
  return survive > 0 ? 1 / survive : 0;
}

/** Every tile cleared — nothing left to reveal. */
export const minesCleared = (bombs, picks) => picks >= TILES - bombs;

// --- blackjack -------------------------------------------------------------

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];

/** Cards are drawn from an endless shoe: no card counting, no shuffle state. */
export const draw = () => `${RANKS[roll(RANKS.length)]}${SUITS[roll(SUITS.length)]}`;

export const rankOf = (card) => card.slice(0, -1);

/** The best total a hand can have without busting, and whether an ace is soft. */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    const rank = rankOf(card);
    if (rank === 'A') {
      aces += 1;
      total += 11;
    } else if (['J', 'Q', 'K'].includes(rank)) total += 10;
    else total += Number(rank);
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
    soft = aces > 0;
  }
  return { total, soft, blackjack: cards.length === 2 && total === 21 };
}

/** The dealer draws to 17 and stands on everything above, soft or hard. */
export function dealerPlay(cards) {
  const hand = [...cards];
  while (handValue(hand).total < 17) hand.push(draw());
  return hand;
}

/** Returns what the stake becomes: 0 lost, 1 pushed, 2 won, 2.5 blackjack. */
export function blackjackResult(player, dealer) {
  const p = handValue(player);
  const d = handValue(dealer);
  if (p.total > 21) return { outcome: 'bust', multiplier: 0 };
  if (p.blackjack && !d.blackjack) return { outcome: 'blackjack', multiplier: 2.5 };
  if (d.blackjack && !p.blackjack) return { outcome: 'dealer-blackjack', multiplier: 0 };
  if (d.total > 21) return { outcome: 'dealer-bust', multiplier: 2 };
  if (p.total > d.total) return { outcome: 'win', multiplier: 2 };
  if (p.total < d.total) return { outcome: 'lose', multiplier: 0 };
  return { outcome: 'push', multiplier: 1 };
}

export const EDGE_NOTE =
  'Blackjack is the one game whose odds depend on how you play it — the rules ' +
  '(the dealer only draws after you, so you bust first) leave about a 0.5% edge ' +
  'even with perfect play. Everything else here pays exactly its true odds.';
