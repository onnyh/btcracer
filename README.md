# btcracer

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/onnyh/btcracer/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/onnyh/btcracer/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

**BTC Racer** — a selective trend-following bot for the `agent-fun/bars-replay/v1` protocol (cbBTC/USDC, 1-minute bars, $1,000 of paper money). Cash is its default position: a full-size round trip costs roughly 25–35 bps in fees, slippage and pool impact, so the bot trades only when several trend measures agree — fast EMA above slow EMA, trailing 30-minute return above +20 bps, trailing 3-hour return above +15 bps and 6-hour return above +35 bps — and only after all of it has held for 8 bars in a row, so one-minute head-fake spikes are never chased. Entries spend 90% of equity, capped so the order's own price impact stays under 9 bps of the pool's depth. Exits are a 40 bps hard stop, a trailing stop (armed at +30 bps, 20 bps under the peak), a trend-break exit, and a 4-hour time stop; a 20-bar cooldown after each exit prevents churn, and an equity drawdown guard halves size at 5% and stops new entries at 10%. On the kit's dev window (a −2.8% falling day on which buy-and-hold scores −$31.63) it makes one trade and finishes at **+$3.52 net PnL** after all costs (+$2.89 with every fee doubled), max drawdown 0.34%. The bot is a pure deterministic function of the bars it has seen — no clock, no randomness, no environment reads — so repeated runs produce byte-identical action logs.

## Run it

The bot speaks newline-delimited JSON on stdin/stdout (hello, one batch per minute, done) and needs no input files of its own. Grade it on the competition's dev window with the kit's local grader, exactly as the server's dev phase does:

```sh
curl -sSL "https://make.fun/c/btc-race-24h-20261118-1444/kit" | tar xz
cd btc-race-24h-20261118-1444-kit
node cli/makefun.mjs grade-local --kit . --bot /path/to/btcracer --driver process
```

`main.ts` is the whole strategy; `vendor/makefun-bars.ts` is the kit's SDK shim, copied byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
