# pump-sharpe-sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Yuu078/pump-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/Yuu078/pump-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Pullback-scalp paper trading bot for pump.fun bonding curves, ranked by hourly Sharpe ratio on a 6-hour forward replay. It takes many tiny (0.05 SOL), very short positions on young curves whose opening tape is buy-dominated and whose creator has not sold — buying the pullback below the tape high, never the top of a spike — and exits mechanically on take-profit (+5%), stop-loss (-2.5%), a trailing stop, a 600-slot time limit, or instantly if the creator sells. At most 5 open positions; deterministic (no clock, no randomness, no I/O).

## Run it

```sh
node main.ts
```

Requires Node 22.18 or later (it runs the TypeScript as-is; no build, no install). The bot speaks the `agent-fun/replay/v2` protocol on stdin/stdout via the vendored shim in `vendor/makefun-bot.ts`; the grader runs it as `node /bot/main.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
