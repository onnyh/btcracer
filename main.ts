// BTC Racer: a selective trend-following bot for agent-fun/bars-replay/v1.
//
// Strategy (long only, one asset, cash is the default position):
//   cbBTC moves a few basis points a minute and a full-size round trip costs
//   roughly 25-35 bps in fees, slippage and pool impact, so this bot trades
//   rarely and only when several trend measures agree:
//
//   * entry  - the fast EMA is above the slow EMA, the trailing 30-minute
//              return clears a threshold comfortably above round-trip cost,
//              the trailing 3-hour and 6-hour returns are both positive
//              (no dip-buying into a falling market), and all of it has
//              held for several bars in a row: a one-minute spike is a
//              head-fake this bot refuses to chase;
//   * exits  - a hard stop under the entry, a trailing stop once the trade
//              is in profit, a trend-break exit (fast EMA back below slow
//              with negative 30-minute momentum), and a time stop for
//              trades that go nowhere;
//   * sizing - a fixed share of equity, additionally capped so the order's
//              own price impact on the pool stays small (sized against the
//              latest close's depth, the only depth known when deciding);
//   * guards - a cooldown after every exit (no churn), and an equity
//              drawdown guard that halves size, then stops new entries.
//
//   Everything is a deterministic function of the bars seen so far: no
//   clock, no randomness, no environment reads, so the two graded runs
//   produce byte-identical action logs.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000;

// Strategy parameters (fractions are float ratios of integer prices; the
// same inputs always produce the same outputs).
const PARAMS = {
  emaFast: 15, // fast EMA length, bars
  emaSlow: 60, // slow EMA length, bars
  momFastBars: 30, // short momentum lookback, bars
  momFastMin: 0.0020, // min trailing return over momFastBars (20 bps)
  momSlowBars: 180, // long momentum lookback, bars
  momSlowMin: 0.0015, // min trailing return over momSlowBars (15 bps)
  momXlBars: 360, // extra-long trend gate lookback
  momXlMin: 0.0035, // min trailing return over momXlBars (35 bps)
  rangeBars: 120, // range gate lookback, bars
  rangeMin: 0.0, // min (max-min)/close over rangeBars (0 = off)
  momExit: 0.0, // exit if trailing momFast return < -momExit (0 = off)
  confirmBars: 8, // entry conditions must hold this many bars in a row
  momFastMax: 0.0, // skip entry if trailing momFast return is above this (0 = off)
  emaSlopeBars: 0, // require the slow EMA to be rising over this many bars (0 = off)
  emaSlopeMin: 0.0, // min slow-EMA rise over emaSlopeBars, as a fraction
  sizeFrac: 0.90, // share of equity to spend on an entry
  impactCapBps: 9, // max own price impact of an entry, bps of pool depth
  stopBps: 40, // hard stop under the entry price, bps
  trailArmBps: 30, // profit (bps over entry) that arms the trailing stop
  trailBps: 20, // trailing stop distance under the peak close, bps
  timeStopBars: 240, // exit a trade this old if it is not clearly winning
  timeStopMinBps: 20, // "clearly winning" threshold for the time stop, bps
  cooldownBars: 20, // bars to stay flat after an exit
  ddHalf: 0.05, // equity drawdown that halves the entry size
  ddStop: 0.10, // equity drawdown that stops new entries for the run
  maxSlippageBps: 300, // slippage guard sent with every order
};

class Bot {
  closes: bigint[] = []; // every close seen, oldest first (price scale)
  emaFast: number | null = null;
  emaSlow: number | null = null;
  emaSlowHist: number[] = []; // slow EMA after every bar
  signalAge = 0; // consecutive bars the entry conditions have held
  peakEquity: bigint | null = null;
  halted = false; // drawdown guard latch
  cooldownUntil = -1; // seq through which re-entry is blocked
  entrySeq: number | null = null; // seq of the batch that first showed the position
  peakClose: bigint | null = null; // highest close since the position appeared

  /** Trailing return over `bars` bars, or null if too early. */
  ret(bars: number): number | null {
    if (this.closes.length <= bars) return null;
    const prev = this.closes[this.closes.length - 1 - bars];
    if (prev <= 0n) return null;
    return Number(this.closes[this.closes.length - 1]) / Number(prev) - 1.0;
  }

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    this.closes.push(close);
    // EMAs, seeded at the first close.
    if (this.emaFast === null || this.emaSlow === null) {
      this.emaFast = Number(close);
      this.emaSlow = Number(close);
    } else {
      const kf = 2.0 / (PARAMS.emaFast + 1);
      const ks = 2.0 / (PARAMS.emaSlow + 1);
      this.emaFast += kf * (Number(close) - this.emaFast);
      this.emaSlow += ks * (Number(close) - this.emaSlow);
    }
    this.emaSlowHist.push(this.emaSlow);

    if (this.peakEquity === null || state.equity > this.peakEquity) {
      this.peakEquity = state.equity;
    }
    const holding = state.positions.get(SYMBOL);
    if (holding !== undefined) this.signalAge = 0;
    if (holding !== undefined && this.entrySeq === null) {
      this.entrySeq = state.seq;
      this.peakClose = close;
    }
    if (holding !== undefined && this.peakClose !== null && close > this.peakClose) {
      this.peakClose = close;
    }

    if (state.warmingUp) return [];

    if (holding !== undefined) return this.exitOrders(state, holding.qty, holding.cost, close);
    return this.entryOrders(state, close);
  }

  exitOrders(state: BarsState, qty: bigint, cost: bigint, close: bigint): OrderInput[] {
    // Average entry price (fees included) from the position's cost:
    // cost = qty * price * 10^quote_scale / 10^(qty_scale + price_scale).
    const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL)!;
    const scale = 10n ** BigInt(sym.qty_scale + sym.price_scale);
    const denom = 10n ** BigInt(state.hello.capital.quote_scale);
    const entry = Number((cost * scale) / (qty * denom));
    const heldBars = state.seq - (this.entrySeq ?? state.seq);
    const gain = entry > 0 ? Number(close) / entry - 1.0 : 0.0;
    const peakGain = entry > 0 && this.peakClose !== null ? Number(this.peakClose) / entry - 1.0 : 0.0;

    let sell = false;
    if (gain <= -PARAMS.stopBps / BPS) {
      sell = true; // hard stop
    } else if (
      peakGain >= PARAMS.trailArmBps / BPS &&
      this.peakClose !== null &&
      Number(close) <= Number(this.peakClose) * (1.0 - PARAMS.trailBps / BPS)
    ) {
      sell = true; // trailing stop
    } else if (this.emaFast !== null && this.emaSlow !== null && this.emaFast < this.emaSlow) {
      const r = this.ret(PARAMS.momFastBars);
      if (r !== null && r < 0.0) sell = true; // trend break
    }
    if (!sell && PARAMS.momExit > 0.0) {
      const r = this.ret(PARAMS.momFastBars);
      if (r !== null && r < -PARAMS.momExit) sell = true; // momentum break
    }
    if (!sell && heldBars >= PARAMS.timeStopBars && gain < PARAMS.timeStopMinBps / BPS) {
      sell = true; // time stop
    }
    if (!sell) return [];
    this.cooldownUntil = state.seq + PARAMS.cooldownBars;
    this.entrySeq = null;
    this.peakClose = null;
    return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: PARAMS.maxSlippageBps }];
  }

  /** True when every entry gate holds on the bars seen so far. */
  conditions(close: bigint): boolean {
    if (this.closes.length <= Math.max(PARAMS.emaSlow, PARAMS.momSlowBars)) return false;
    if (this.emaFast === null || this.emaSlow === null || !(this.emaFast > this.emaSlow)) return false;
    const rFast = this.ret(PARAMS.momFastBars);
    const rSlow = this.ret(PARAMS.momSlowBars);
    if (rFast === null || rSlow === null) return false;
    if (rFast < PARAMS.momFastMin || rSlow < PARAMS.momSlowMin) return false;
    if (PARAMS.momFastMax > 0.0 && rFast > PARAMS.momFastMax) return false;
    if (PARAMS.momXlBars > 0) {
      const rXl = this.ret(PARAMS.momXlBars);
      if (rXl === null || rXl < PARAMS.momXlMin) return false;
    }
    if (PARAMS.emaSlopeBars > 0) {
      const n = PARAMS.emaSlopeBars;
      if (this.emaSlowHist.length <= n) return false;
      const prev = this.emaSlowHist[this.emaSlowHist.length - 1 - n];
      if (prev <= 0 || this.emaSlowHist[this.emaSlowHist.length - 1] / prev - 1.0 < PARAMS.emaSlopeMin) return false;
    }
    if (PARAMS.rangeMin > 0.0) {
      const window = this.closes.slice(-PARAMS.rangeBars);
      if (window.length < PARAMS.rangeBars) return false;
      let mx = window[0];
      let mn = window[0];
      for (const v of window) {
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      if (Number(mx - mn) / Number(close) < PARAMS.rangeMin) return false;
    }
    return true;
  }

  entryOrders(state: BarsState, close: bigint): OrderInput[] {
    if (this.halted || state.seq <= this.cooldownUntil) {
      this.signalAge = 0;
      return [];
    }
    // Drawdown guard.
    let dd = 0.0;
    if (this.peakEquity !== null) {
      dd = 1.0 - Number(state.equity) / Number(this.peakEquity);
      if (dd >= PARAMS.ddStop) {
        this.halted = true;
        this.signalAge = 0;
        return [];
      }
    }
    if (!this.conditions(close)) {
      this.signalAge = 0;
      return [];
    }
    this.signalAge += 1;
    if (this.signalAge < PARAMS.confirmBars) return [];
    // Size: a share of equity, halved in drawdown, capped by pool impact
    // (one hop: impact bps = amount * 10^4 / depth, amount and depth in
    // quote units) and by the cash actually held.
    const frac = PARAMS.sizeFrac * (dd >= PARAMS.ddHalf ? 0.5 : 1.0);
    let notional = BigInt(Math.trunc(Number(state.equity) * frac));
    const depth = state.depthAt(SYMBOL);
    if (depth !== null && depth.length > 0) {
      const impactCap = (BigInt(PARAMS.impactCapBps) * depth[0]) / BigInt(BPS);
      if (impactCap < notional) notional = impactCap;
    }
    if (notional > state.cash) notional = state.cash;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: PARAMS.maxSlippageBps }];
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
