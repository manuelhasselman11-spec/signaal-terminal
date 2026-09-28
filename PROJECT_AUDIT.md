# PROJECT_AUDIT.md

Facts only, taken from the code in this repository and the source HTML it embeds. Items not present in the code are marked UNVERIFIED.

**Never include real secrets.** This file uses environment-variable *names* only. No `.env` values exist in the repo (`.gitignore` lists `.env`).

---

## 1. What it is

**Purpose:** a browser “Signaal Terminal” for crypto tokens (primarily Solana memecoins, also EVM addresses). It loads a token, draws OHLCV candles, runs a long-only / spot strategy (EMA cross, RSI/sweep reversal, volume breakout) with ATR stops and TP1/TP2, shows a backtest on the loaded candles, can simulate paper trades, and can request real swaps through Phantom + Jupiter if the user enables auto-trade and signs in the wallet popup.

**Who it is for:** a Dutch-speaking retail user who already pastes DexScreener / GMGN / pump.fun token addresses. UI copy is Dutch (`lang="nl"`).

**Current status:** working single-page app plus a small Node host and a notification-only worker added for Railway. Not a company product page, no versioning beyond `package.json` `"1.0.0"`. Live vs beta vs idea: **UNVERIFIED** (no production URL, analytics, or release notes in the repo). The original deliverable was a standalone HTML file; this repo packages that file as `public/index.html` and adds `server.js` / `worker.js`.

Disclaimer in the UI: not financial advice; backtest on one token/period can overfit.

---

## 2. Tech stack

| Layer | What the code uses |
|---|---|
| Languages | HTML, CSS, browser JavaScript (IIFE in `public/index.html`); Node.js ≥20 (`server.js`, `worker.js`) |
| Frameworks | None (no React/Vue/Next). Charts: TradingView **Lightweight Charts 4.1.3** from jsDelivr CDN |
| Wallet SDK | `@solana/web3.js` 1.95.3 IIFE from jsDelivr (`solanaWeb3` global) |
| Database | None |
| Hosting intended | Railway: `npm start` serves static files; `npm run worker` is a second service. `railway.toml` is comments only |
| Fonts | Google Fonts: Inter, JetBrains Mono |

**Third-party HTTP APIs (from code):**

- `https://api.dexscreener.com/latest/dex/tokens/{address}`
- `https://api.dexscreener.com/latest/dex/pairs/{chain}/{pair}`
- `https://api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/{unit}`
- `https://lite-api.jup.ag/swap/v1/quote` and `.../swap` (browser auto-trade only)
- `https://lite-api.jup.ag/price/v2?ids={SOL_MINT}` (SOL/USD for paper trading)
- Default Solana RPC `https://api.mainnet-beta.solana.com` unless user overrides `#rpcUrl`
- `https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage` (worker only)
- Phantom wallet (`window.phantom.solana` / `window.solana`)
- Solscan links for signatures: `https://solscan.io/tx/{sig}`
- Token logos from DexScreener `info.imageUrl` (arbitrary third-party image URLs)

No npm runtime dependencies in `package.json` (empty besides scripts/engines).

---

## 3. Folder map

```
signaal-railway/
  public/index.html   Full UI + strategy + paper + Phantom/Jupiter auto-trade
  server.js           Tiny static HTTP server; binds 0.0.0.0:$PORT
  worker.js           Poll loop: DexScreener + GeckoTerminal + same engine; logs / Telegram
  package.json        name signaal-terminal-railway; scripts start / worker
  railway.toml        Comments on two-service setup; no build config
  .env.example        Variable names and documented defaults
  .gitignore          node_modules, .env, .DS_Store
  README.md           Dutch deploy instructions
  PROJECT_AUDIT.md    This file
```

No `src/`, tests, CI, Dockerfile, or lockfile.

---

## 4. How it works

### 4.1 Load a token (browser)

1. User pastes mint or DexScreener/GMGN URL into `#tokenAddr` (`public/index.html`).
2. `extractTokenAddress` / DexScreener pair lookup if the input is a DexScreener URL.
3. `fetchBestPair` → DexScreener tokens endpoint; highest USD liquidity pair wins.
4. `fetchOHLCV` + `fetchATH` → GeckoTerminal.
5. `render` → `runEngine` → Lightweight Charts candles, EMA lines, volume, RSI, markers, backtest table, signal feed.

Files: `public/index.html` only.

### 4.2 Change timeframe / settings

`#tfPills` sets `currentTf` (`minute:1` … `day:1`) and reloads live data. Indicator inputs call `renderCurrentParamsOnly` on in-memory bars (live) or `loadManual` (CSV paste).

### 4.3 Paper trading

If `#paperToggle` is on, new events after the first render call `handlePaperTrade` → `paperBuy` / `paperSell`. State is `paperState` in memory (`solBalance`, `tokenBalance`, `startSol`). Needs `#solUsdPrice`. Reset via `#paperResetBtn`.

### 4.4 Real wallet auto-trade (browser only)

1. `#connectBtn` → Phantom `connect()` → `walletPubkey`.
2. `#autoTradeToggle` must be checked.
3. After first historical render, new BUY/TP/SL events call `handleAutoTrade`.
4. BUY: Jupiter quote SOL→token for `#tradeAmount` lamports, swap tx, `signAndSendTransaction`.
5. TP1: sell 50% of token balance; TP2/SL/TRAIL/EXIT: 100%.
6. Flag `autoPos` tracks whether a signed BUY opened the “auto” position.

Files: `public/index.html`. Worker does **not** call Jupiter or Phantom.

### 4.5 Website on Railway

`server.js`: `GET /` serves `public/index.html`. Unknown paths fall back to `index.html`. No API routes.

### 4.6 24/7 worker

`worker.js` `loop()` → `tick()` every `POLL_MS` (min 10000).

1. Resolve pair once via DexScreener; cache `ctx`.
2. Fetch OHLCV; `runEngine` (copy of browser logic).
3. First tick: record all event keys, do not notify (skip history).
4. Later new keys: `console.log` + optional Telegram.

Start command: `npm run worker`.

---

## 5. Data

**Persisted by the project:** nothing. No database, localStorage, cookies, or server-side store.

**In-memory only (browser):** candles, `seenEventKeys`, paper balances, `walletPubkey`, `autoPos`, last pair/ATH.

**In-memory only (worker):** `seen` Set, `ctx`, `first` flag. Process restart = history replay skip resets (first tick after restart is silent again).

**Money / wallets:**

- Browser may hold a Phantom public key in JS after connect.
- Browser may create and ask the user to sign Jupiter swap transactions (real mainnet SOL and tokens).
- Paper module uses user-entered start SOL and live/manual SOL-USD; not real funds.
- Worker: no keys, no balances, no swaps.
- RPC URL is a user-typed string in `#rpcUrl` (browser).

**Personal data:** Telegram `TELEGRAM_CHAT_ID` if configured (chat id, not collected by this app’s own backend). DexScreener/Gecko/Jupiter see the token address and, for Jupiter, the wallet public key and swap amounts. No account system.

**UNVERIFIED:** whether Railway logs retain OHLCV or Telegram payloads.

---

## 6. Running it

### Local website

```bash
node server.js
```

Listens on `process.env.PORT` or `3000`. Open `http://localhost:3000`.  
Alternatively open `public/index.html` as a file; Phantom may block file URLs (UI mentions this).

### Local worker

```bash
# set TOKEN_ADDRESS at least
node worker.js
```

Needs Node 18+ `fetch`. No `npm install` required (zero dependencies).

### Deploy (from README + package.json)

- Service Web: start command `npm start` (`node server.js`). Public domain required. Railway injects `PORT`.
- Service Worker: start command `npm run worker`. No public domain.

### Environment variable NAMES only

From `.env.example` / `worker.js` / `server.js`:

- `PORT` (web; Railway-provided)
- `TOKEN_ADDRESS`
- `TIMEFRAME`
- `POLL_MS`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `EMA_FAST`, `EMA_SLOW`, `ATR_LEN`, `ATR_MULT_SL`, `RR_TP1`, `RR_TP2`
- `RSI_LEN`, `RSI_OS`, `RSI_LOOKBACK`, `REV_BODY`
- `SWEEP_LEN`, `DON_LEN`, `VOL_MULT`, `TRAIL_MULT`
- `PARTIAL_FRAC`, `COST_PCT`, `COOLDOWN`
- `CONFIRM_CANDLE`, `CONFIRM_WINDOW`
- `USE_EMA`, `USE_REV`, `USE_BRK`
- `BE_AFTER_TP1`, `EXIT_ON_CROSS`

Browser Jupiter/RPC settings are DOM inputs, not env vars: trade amount, slippage bps, RPC URL.

---

## 7. Security

**Login / auth / admin:** none. Anyone with the URL can use the UI. Worker has no HTTP server.

**Keys in repo:** none. `.gitignore` includes `.env`.

**Key / secret names if deployed:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. User may type an RPC URL in the page. No server-side wallet secret is read by this repo.

**Wallet model:** Phantom popup; `signAndSendTransaction` on a Jupiter-built VersionedTransaction. Auto-trade still requires that popup per swap. Comment in UI: nothing is sent without wallet confirmation.

**Known weak spots (from code):**

- Public unauthenticated static site; enabling auto-trade on a shared machine is a user risk.
- Default public Solana RPC if `#rpcUrl` is empty.
- Jupiter `lite-api.jup.ag` from the browser; CORS/availability is outside this repo.
- `server.js` has no HTTPS itself (expects Railway proxy); no security headers, no rate limit.
- DexScreener `imageUrl` is injected into `img src` after `esc()` of HTML specials; still a third-party image.
- Worker Telegram token lives in host env; a leaked Railway project leaks the bot.
- `autoPos` is only in-page memory: refresh can desync “server thinks flat / wallet still holds tokens”.
- Strategy and swap path are client-side and inspectable; not a vulnerability by itself but there is no integrity check that the page was not modified.
- No Content-Security-Policy; scripts load from `cdn.jsdelivr.net`.
- EVM addresses are accepted for charting; Jupiter path is Solana-only (`SOL_MINT` + Phantom). Enabling auto-trade on an EVM token is not guarded in `handleAutoTrade` beyond using `extractTokenAddress` as Jupiter mint — **fragile**.

**UNVERIFIED:** Railway project access control, domain, and whether the HTML is served with cache headers.

---

## 8. Problems

Present in code / comments; not a separate issue tracker (**UNVERIFIED** if the author tracked more).

- Worker and browser engines are duplicated by hand. Drift is likely if only one side is edited.
- Worker `seen` is not durable; restart skips one poll of “new” events (by design) and can also miss events that occurred while down.
- `fetchATH` uses daily candles only; UI disclaimer says migrated bonding-curve tokens may show a low ATH.
- Paper and live auto-trade do not share position state.
- `tradeBusy` drops overlapping signals (“Vorige trade nog bezig”).
- `executeSell` sells parsed token accounts for that mint; other accounts / wrapped SOL edge cases not handled beyond Jupiter wrap flag.
- No retry/backoff beyond resetting `ctx` on worker tick error.
- `railway.toml` does not define the two services; operator must create them in the dashboard.
- No `package-lock.json`.
- `server.js` maps any missing file to `index.html` (fine for one page; no `/health` distinct from the app).
- HTML references file:// Phantom permission — local-file use is fragile.
- `costPct` is applied in paper and backtest, not in real Jupiter quotes (real cost = slippage + fees on chain).
- Confirm-window / cooldown comments exist; behavior is encoded, not separately tested.

No `TODO` / `FIXME` strings found in the Node files. HTML has product comments, not a bug list.

---

## 9. Tests

None. No test runner, no fixtures, no CI config. Strategy math, API parsers, and swap helpers are untested in-repo.

---

## 10. Numbers

No user counts, revenue, traffic, or error-rate metrics appear in the code or in this workspace’s logs.

Hardcoded defaults (not metrics): paper start `1` SOL, buy 40% of SOL, sell 90% of tokens, slippage `300` bps, EMA 5/13, ATR 14, RSI 14 / OS 32, poll 30s in HTML select and `.env.example`, worker `POLL_MS` minimum 10000, OHLCV limit 300, ATH daily limit 1000, feed last 30 events, backtest last 8 trades.

---

## 11. Top 5 questions for a reviewer

1. Should real mainnet swaps (Phantom + Jupiter) stay in this same public page as paper trading, or be split / disabled by default for any hosted URL?
2. Who is allowed to open the Railway domain, and is auto-trade expected to run on a shared or public link?
3. Will the worker stay notification-only, and if auto-execution is ever added, where would a private key live? (It does not live here today.)
4. How will browser `runEngine` and `worker.js` `runEngine` be kept identical as parameters change?
5. What is the intended production host, budget, and token-watch list (single `TOKEN_ADDRESS` vs many), given there is no DB and no multi-tenant model?

---

## Reviewer bundle

- This file: `PROJECT_AUDIT.md`
- Code: this directory with `.env` excluded (none committed). Zip of the same tree without secrets is appropriate for read-only review.
