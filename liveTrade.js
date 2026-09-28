/**
 * Optional live swaps from the WORKER only.
 * Private key MUST come from Railway Variables, never from GitHub.
 *
 * ENABLE_LIVE_TRADES=0  → this file does nothing useful
 * PRIVATE_KEY=           base58 secret OR JSON array [1,2,3,...]
 */
const web3 = require('@solana/web3.js');
const bs58 = require('bs58');

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUP_BASE = 'https://lite-api.jup.ag/swap/v1';

function liveEnabled() {
  const v = (process.env.ENABLE_LIVE_TRADES || '0').toLowerCase();
  return v === '1' || v === 'true';
}

function loadKeypair() {
  const raw = (process.env.PRIVATE_KEY || '').trim();
  if (!raw || raw.includes('PASTE_') || raw === 'YOUR_PRIVATE_KEY_HERE') {
    throw new Error('PRIVATE_KEY ontbreekt of is nog een placeholder');
  }
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw);
    return web3.Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return web3.Keypair.fromSecretKey(bs58.decode(raw));
}

function connection() {
  const url = (process.env.RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
  return new web3.Connection(url, 'confirmed');
}

async function fetchJson(url, opts, ms = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(res.status + ' ' + text.slice(0, 200));
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

async function quoteAndSwap(inputMint, outputMint, amountRaw, owner) {
  const slippage = Number(process.env.SLIPPAGE_BPS) || 300;
  const qUrl = JUP_BASE + '/quote?inputMint=' + inputMint +
    '&outputMint=' + outputMint + '&amount=' + amountRaw + '&slippageBps=' + slippage;
  const quoteResponse = await fetchJson(qUrl);
  const swap = await fetchJson(JUP_BASE + '/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: owner.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    })
  });
  if (!swap.swapTransaction) throw new Error('Jupiter gaf geen swapTransaction');
  const buf = Buffer.from(swap.swapTransaction, 'base64');
  const tx = web3.VersionedTransaction.deserialize(buf);
  tx.sign([owner]);
  const sig = await connection().sendRawTransaction(tx.serialize(), { skipPreflight: false });
  return sig;
}

async function tokenRawBalance(owner, mintStr) {
  const conn = connection();
  const resp = await conn.getParsedTokenAccountsByOwner(owner.publicKey, {
    mint: new web3.PublicKey(mintStr)
  });
  let raw = 0n;
  resp.value.forEach(acc => {
    raw += BigInt(acc.account.data.parsed.info.tokenAmount.amount);
  });
  return raw;
}

let inPos = false;

async function handleLiveEvents(events, tokenMint) {
  if (!liveEnabled()) return;
  if (!events || !events.length) return;
  const owner = loadKeypair();
  const buySol = Number(process.env.TRADE_AMOUNT_SOL) || 0.01;
  const slippage = Number(process.env.SLIPPAGE_BPS) || 300;

  for (const e of events) {
    try {
      if (e.type === 'BUY') {
        if (inPos) {
          console.log('LIVE BUY overgeslagen: positie al open');
          continue;
        }
        const lamports = Math.floor(buySol * 1e9);
        console.log('LIVE BUY', buySol, 'SOL', 'slippage', slippage);
        const sig = await quoteAndSwap(SOL_MINT, tokenMint, lamports, owner);
        inPos = true;
        console.log('LIVE BUY ok', sig);
      } else if (e.type === 'TP1') {
        const raw = await tokenRawBalance(owner, tokenMint);
        const half = raw / 2n;
        if (half <= 0n) continue;
        const sig = await quoteAndSwap(tokenMint, SOL_MINT, half.toString(), owner);
        console.log('LIVE TP1 ok', sig);
      } else if (['TP2', 'SL', 'TRAIL', 'EXIT'].includes(e.type)) {
        const raw = await tokenRawBalance(owner, tokenMint);
        if (raw <= 0n) {
          inPos = false;
          continue;
        }
        const sig = await quoteAndSwap(tokenMint, SOL_MINT, raw.toString(), owner);
        inPos = false;
        console.log('LIVE', e.type, 'ok', sig);
      }
    } catch (err) {
      console.error('LIVE trade fout', e.type, err.message);
    }
  }
}

module.exports = { liveEnabled, handleLiveEvents, loadKeypair };
