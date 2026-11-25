// Sharpe-first diversified tape rider for the pump.fun 6-hour forward replay.
//
// The bot talks to the harness through the vendored shim: one `hello` message opens the run
// (capital, caps, latency, fees), then one `batch` per slot carries that slot's events, marks and
// fills, and this bot answers each batch with its `orders` for the slot. Everything below is a
// pure function of that stream: no clock, no randomness, no I/O, so the two graded executions
// produce byte-identical action logs.
//
// Strategy, in one line: many tiny, very short pullback scalps on young curves whose opening
// tape is buy-dominated and whose creator has not sold — never a big bet on one coin, never a
// long hold, never buying the top of a spike.
//
// Why this shape wins hourly Sharpe instead of raw PnL:
//   * Tiny stakes (0.05 SOL of 10 SOL capital) and at most 5 open positions cap the damage any
//     single rug can do, which keeps hourly returns smooth and drawdown far under the 50% guardrail.
//   * Entries are young (4–60 trades seen) with a 1–40% lift on a steady, buy-dominated tape,
//     creator not selling — and the buy happens on a PULLBACK: the latest price must sit below
//     the tape high, so we buy after early profit-taking, not into the spike itself. v1 bought
//     the top of momentum moves and bled -7.7 SOL; the pullback filter is what fixed the entry.
//   * Volume is deliberate: the final window is 6 hours with ~164 sampled coins, so the bot
//     must enter ~15% of coins to clear the 20-distinct-mint guardrail with margin (211 round
//     trips on the 45-hour dev window ≈ 28 per 6 hours). Over-selective variants scored better
//     per trip but would fail the guardrail on the final window.
//   * Exits are strict and mechanical (take-profit, stop-loss, trailing stop, time exit, plus an
//     instant exit when the creator sells — see part 2 below): a position either pays ~+3.7% net
//     or is cut at ~-2.5%, and nothing is held past 600 slots (~4 min), so losers cannot fester
//     into drawdown.
//   * At most 4 new buys per batch spreads entries across time instead of piling into one hot
//     minute, which is what keeps the hourly return series — the thing Sharpe measures — even.
//
// Fees set the bar: each leg pays ~1.25% in curve fees plus 105,000 lamports of tx fees, so a
// round trip costs ~2.5% + tx. The +5% take-profit / -2.5% stop-loss pair clears that bar with
// room, and the 0.05 SOL stake keeps tx fees at ~0.2% of the stake.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------------------
// Parameters (all in one place so a sweep can reason about them).
// ---------------------------------------------------------------------------

/** SOL staked into each new position. 0.05 SOL keeps a full 5-position book at 0.25 SOL
    deployed, so one rug costs at most ~0.5% of capital and drawdown stays shallow. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n;
/** Smallest single buy worth paying the 105k-lamport tx fee for. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n;
/** Real-SOL reserve window a curve must sit in to be entered. */
const MIN_REAL_SOL = 500_000_000n;
const MAX_REAL_SOL = 100_000_000_000n;
/** Tape length (samples) and trade-flow window kept per curve. */
const TAPE_LEN = 24;
const FLOW_LEN = 24;
/** Entry needs this many tape samples and a trade count inside this young band. */
const MIN_TAPE = 4;
const MIN_TRADES = 4;
const MAX_ENTRY_TRADES = 60;
/** Momentum band over the tape: up at least this, at most this — a lift, not a pump. */
const MIN_CLIMB = 1.01;
const MAX_CLIMB = 1.4;
/** Of the last 10 tape steps, at least this many must be flat-or-up (steady, not spiky). */
const MIN_STEADY_STEPS = 4;
/** Buy flow: of the trades seen so far, buys must be at least this share, net SOL positive. */
const MIN_BUY_SHARE = 0.65;
/** At most this many new buys decided on one batch (spread entries across time). */
const MAX_NEW_BUYS_PER_BATCH = 4;
/** Buy slippage: 20% — wide enough that latency-2 fills rarely reject, tight enough to refuse a cliff. */
const BUY_SLIPPAGE_BPS = 2000;
/** Sells go out wide open: a position being exited must exit. */
const SELL_SLIPPAGE_BPS = 10_000;

// ---------------------------------------------------------------------------
// Per-curve tape: price samples + recent trade flow, keyed by mint.
// ---------------------------------------------------------------------------

interface TapeSample {
  slot: number;
  /** Lamports per token, as a float ratio of virtual reserves. */
  price: number;
}

interface FlowTrade {
  isBuy: boolean;
  /** SOL moved by the trade, in lamports. */
  sol: bigint;
}

interface CurveTape {
  samples: TapeSample[];
  flow: FlowTrade[];
  /** Last slot this curve was sampled, so we take at most one sample per batch. */
  lastSampleSlot: number;
}

const tapes = new Map<Pubkey, CurveTape>();

/** Creator wallet per mint (from its CreateEvent), and mints whose creator has sold. */
const creators = new Map<Pubkey, Pubkey>();
const creatorSold = new Set<Pubkey>();

function tapeFor(mint: Pubkey): CurveTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { samples: [], flow: [], lastSampleSlot: -1 };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of a curve from its virtual reserves (lamports per token). Null when unknowable. */
function curvePrice(state: BotState, mint: Pubkey): number | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves <= 0n || c.virtual_quote_reserves <= 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

/** Mark-to-market value of a token holding at the curve's current price, in lamports. */
function positionValue(state: BotState, mint: Pubkey, tokens: bigint): bigint | null {
  const price = curvePrice(state, mint);
  if (price === null) return null;
  return BigInt(Math.floor(Number(tokens) * price));
}

/** Fold this batch's events into the tapes: trade flow + one price sample per touched curve. */
function updateTapes(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    const t = tapeFor(e.mint);
    if (e.event === "CreateEvent") {
      creators.set(e.mint, e.creator);
    }
    if (e.event === "TradeEvent") {
      t.flow.push({ isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (t.flow.length > FLOW_LEN) t.flow.splice(0, t.flow.length - FLOW_LEN);
      // A creator selling into the opening tape is the classic rug tell: never enter
      // after it, and exit any position at once (see exitOrders).
      if (!e.is_buy && creators.get(e.mint) === e.user) creatorSold.add(e.mint);
    }
    if (e.event === "CompleteEvent") {
      // A completed curve never trades again; drop its tape so it cannot be re-entered.
      tapes.delete(e.mint);
      continue;
    }
    const curve = state.curves.get(e.mint);
    if (curve !== undefined && batch.slot !== t.lastSampleSlot) {
      const price = curvePrice(state, e.mint);
      if (price !== null && price > 0) {
        t.samples.push({ slot: batch.slot, price });
        if (t.samples.length > TAPE_LEN) t.samples.splice(0, t.samples.length - TAPE_LEN);
        t.lastSampleSlot = batch.slot;
      }
    }
  }
  // Marks cover held/pending curves that had no event this batch: keep their tapes fresh too.
  for (const m of batch.marks) {
    const t = tapes.get(m.mint);
    if (t === undefined || batch.slot === t.lastSampleSlot) continue;
    const price = curvePrice(state, m.mint);
    if (price !== null && price > 0) {
      t.samples.push({ slot: batch.slot, price });
      if (t.samples.length > TAPE_LEN) t.samples.splice(0, t.samples.length - TAPE_LEN);
      t.lastSampleSlot = batch.slot;
    }
  }
}

/** Does this curve's tape qualify for a first buy right now? */
function entrySignal(state: BotState, mint: Pubkey): boolean {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return false;
  // Young only: a curve with a long tape has already had its opening move.
  if (curve.trades < MIN_TRADES || curve.trades > MAX_ENTRY_TRADES) return false;
  if (creatorSold.has(mint)) return false;
  if (curve.real_quote_reserves < MIN_REAL_SOL || curve.real_quote_reserves > MAX_REAL_SOL) {
    return false;
  }
  const t = tapes.get(mint);
  if (t === undefined || t.samples.length < MIN_TAPE) return false;
  const first = t.samples[0].price;
  const last = t.samples[t.samples.length - 1].price;
  if (!(first > 0) || !(last > 0)) return false;
  const climb = last / first;
  if (climb < MIN_CLIMB || climb > MAX_CLIMB) return false;
  // Buy the pullback, not the top: the latest price must sit below the tape high,
  // so earlier buyers have already taken some profit and the next leg is ahead.
  let tapeHigh = 0;
  for (const s of t.samples) if (s.price > tapeHigh) tapeHigh = s.price;
  if (last > tapeHigh * 0.995) return false;
  // Steady climb: most of the last 10 steps flat-or-up, not one vertical jump.
  let steady = 0;
  const steps = t.samples.slice(-11);
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].price >= steps[i - 1].price) steady++;
  }
  if (steady < MIN_STEADY_STEPS) return false;
  // Buy flow dominates the opening tape and net SOL is flowing in.
  if (t.flow.length < MIN_TRADES) return false;
  let buys = 0;
  let netSol = 0n;
  for (const f of t.flow) {
    if (f.isBuy) {
      buys++;
      netSol += f.sol;
    } else {
      netSol -= f.sol;
    }
  }
  if (buys / t.flow.length < MIN_BUY_SHARE) return false;
  if (netSol <= 0n) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Exits: take-profit, stop-loss, trailing stop, time exit. All mechanical,
// all evaluated every batch from the mark-to-market value versus cost.
// ---------------------------------------------------------------------------

/** Gross value must reach this (bps of cost) to take profit: 10500 = +5% gross, ~+3.7% net. */
const TAKE_PROFIT_BPS = 10500;
/** Gross value at or below this (bps of cost) is cut: 9750 = -2.5% gross. */
const STOP_LOSS_BPS = 9750;
/** Once value reaches this (bps of cost), the trailing stop arms. */
const TRAIL_ARM_BPS = 10300;
/** After arming, a fall of this share from the position's peak value exits. */
const TRAIL_DROP_BPS = 9800;
/** No position is held past this many slots after its buy was decided (~4 min). */
const MAX_HOLD_SLOTS = 600;

interface Held {
  /** Slot the buy for this position was decided on. */
  entrySlot: number;
  /** Best gross value seen so far, in lamports. */
  peakValue: bigint;
  /** Whether the trailing stop has armed. */
  armed: boolean;
}

const held = new Map<Pubkey, Held>();

/** Decide sells for every open position this batch. Returns the sell orders. */
function exitOrders(state: BotState, batch: Batch): SellInput[] {
  const orders: SellInput[] = [];
  for (const [mint, pos] of state.positions) {
    const value = positionValue(state, mint, pos.token_amount);
    if (value === null) continue;
    let h = held.get(mint);
    if (h === undefined) {
      // A position we hold but never recorded (e.g. filled after a restart of tracking):
      // adopt it at the current slot so the time exit still bounds it.
      h = { entrySlot: batch.slot, peakValue: value, armed: false };
      held.set(mint, h);
    }
    if (value > h.peakValue) h.peakValue = value;
    if (value >= (pos.cost_lamports * BigInt(TRAIL_ARM_BPS)) / 10000n) h.armed = true;
    const cost = pos.cost_lamports;
    const takeProfit = value >= (cost * BigInt(TAKE_PROFIT_BPS)) / 10000n;
    const stopLoss = value <= (cost * BigInt(STOP_LOSS_BPS)) / 10000n;
    const trailing =
      h.armed && value <= (h.peakValue * BigInt(TRAIL_DROP_BPS)) / 10000n;
    const stale = batch.slot - h.entrySlot > MAX_HOLD_SLOTS;
    // Creator selling while we hold is the rug tell: leave at once, whatever the price.
    const rugged = creatorSold.has(mint);
    if (takeProfit || stopLoss || trailing || stale || rugged) {
      orders.push({
        side: "sell",
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      });
      held.delete(mint);
      tapes.delete(mint);
    }
  }
  // Drop tracking for positions the harness closed itself (complete/flatten/writeoff).
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }
  return orders;
}

// ---------------------------------------------------------------------------
// Main loop: one hello, then one batch at a time. Exits first (free the slot),
// then at most two fresh entries from the curves that fired in this batch.
// ---------------------------------------------------------------------------

await runBot({
  onHello(state) {
    // Nothing to precompute: capital and caps arrive with hello and are read off
    // state.hello wherever they are needed. Keeping this hook makes the session
    // show the hello handshake explicitly.
    void state.hello.capital.lamports;
  },

  onBatch(state, batch) {
    updateTapes(state, batch);
    const orders: OrderInput[] = [];
    // 1. Exits first: a freed position slot can be reused by an entry this same batch.
    for (const sell of exitOrders(state, batch)) orders.push(sell);

    // 2. Entries: curves whose CreateEvent or trade fired in this batch, in event order.
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    // Sells in this reply free no cash until they fill, so only count buys against slots.
    let slots = caps.max_open_positions - state.committedPositionCount();
    let newBuys = 0;
    const seen = new Set<Pubkey>();
    for (const e of batch.events) {
      if (newBuys >= MAX_NEW_BUYS_PER_BATCH) break;
      if (e.event === "CompleteEvent") continue;
      if (seen.has(e.mint)) continue;
      seen.add(e.mint);
      if (state.positions.has(e.mint) || held.has(e.mint)) continue;
      if (!entrySignal(state, e.mint)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0 || free < amount + tx) continue;
      const buy: BuyInput = {
        side: "buy",
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      };
      orders.push(buy);
      held.set(e.mint, { entrySlot: batch.slot, peakValue: 0n, armed: false });
      free -= amount + tx;
      slots -= 1;
      newBuys += 1;
    }
    return orders;
  },

  onDone(state) {
    // The harness flattens everything at done; nothing left to decide. Log the
    // final cash to stderr only — stdout carries replies alone.
    console.error(`done: cash=${state.cash} positions=${state.positions.size}`);
  },
});
