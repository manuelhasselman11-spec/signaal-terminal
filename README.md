# Signaal Terminal op Railway (website + 24/7 worker)

Twee processen uit dezelfde map:

- **Web** (`npm start`) — jouw Signaal Terminal op een publieke URL
- **Worker** (`npm run worker`) — blijft candles ophalen en stuurt nieuwe BUY/SL/TP naar de logs (en optioneel Telegram)

De worker heeft **geen wallet en geen private key**. Hij handelt niet. Jij opent de website en tekent zelf in Phantom als je wilt.

## 1. Repo naar GitHub

Upload deze hele map (inclusief `public/index.html`).

## 2. Project in Railway

1. [railway.com](https://railway.com) → New Project → Deploy from GitHub repo
2. Kies de repo. Railway start standaard `npm start` → dat is de website.
3. Service → Settings → Networking → **Generate domain**
4. Open die URL: dat is je app.

## 3. Worker ernaast (het 24/7-stuk)

1. In hetzelfde project: **+ New** → **GitHub Repo** → dezelfde repo
2. Hernoem de service naar `worker`
3. Settings → Deploy → **Start Command**: `npm run worker`
4. **Geen** public domain voor de worker
5. Variables (tab Variables) invullen, minstens:

```
TOKEN_ADDRESS=jouwtokenadres
TIMEFRAME=minute:5
POLL_MS=30000
```

Kopieer de rest uit `.env.example` als je dezelfde instellingen als de website wilt.

Logs: service `worker` → Deployments → View logs.  
Als het goed is zie je elke 30s `geen nieuw signaal` of een BUY/SL/TP.

## 4. Telegram (optioneel)

1. In Telegram: @BotFather → `/newbot` → bewaar de token
2. Stuur zelf één bericht naar die bot
3. Open in de browser:  
   `https://api.telegram.org/bot<TOKEN>/getUpdates`  
   Zoek `"chat":{"id": 123456789` — dat is `TELEGRAM_CHAT_ID`
4. In Railway Variables:

```
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

Redeploy de worker. Nieuwe signalen komen als chatbericht.  
De eerste run slaat oude historische signalen over, zodat je niet 40 oude BUY's krijgt.

## Kosten / gedrag

- Web: bijna niets als weinig bezoek
- Worker: blijft 24/7 aan, dus die verbruikt wél continu een beetje CPU
- Zet `POLL_MS` niet lager dan 15000 — DexScreener/GeckoTerminal mogen je anders blokkeren

## Wat dit níét doet

Geen automatische Jupiter-swap. Dat zou een private key op de server vereisen. Houd trades in de web-app via Phantom.
