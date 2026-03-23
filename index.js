// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');
const express = require('express');

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const token = process.env.TELEGRAM_TOKEN || 'YOUR_BOT_TOKEN';
const ADMIN_ID = 5690207061;
const CHANNELS = [-1003784336023];

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🚀 Trading Bot is LIVE');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on ${PORT}`);
});

// ================== TELEGRAM BOT ==================
const bot = new TelegramBot(token, { polling: true });

bot.on("polling_error", (err) => {
  console.log("⚠️ Polling Error:", err.message);
});

// ================== HELPERS ==================
function formatPrice(price) {
  if (price < 1) return price.toFixed(5);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}

let lastSignals = {};

// ================== BINANCE API ==================
const BASE = 'https://api.binance.com';

// ================== BTC TREND ==================
async function getBTCTrend() {
  try {
    const res = await axios.get(`${BASE}/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=50`);

    const closes = res.data.map(c => parseFloat(c[4]));
    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });

    return closes.at(-1) > ema20.at(-1) ? 'BULLISH' : 'BEARISH';
  } catch {
    return 'NEUTRAL';
  }
}

// ================== TREND ==================
async function getTrend(symbol, interval) {
  try {
    const map = { '15m': '15m', '1h': '1h' };

    const res = await axios.get(
      `${BASE}/api/v3/klines?symbol=${symbol}&interval=${map[interval]}&limit=50`
    );

    const closes = res.data.map(c => parseFloat(c[4]));

    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });
    const ema50 = ti.EMA.calculate({ values: closes, period: 50 });

    if (!ema20.length || !ema50.length) return 'NEUTRAL';

    return ema20.at(-1) > ema50.at(-1) ? 'UP' : 'DOWN';

  } catch {
    return 'NEUTRAL';
  }
}

// ================== TOP COINS ==================
async function getTopCoins() {
  try {
    const res = await axios.get(`${BASE}/api/v3/ticker/24hr`);

    return res.data
      .filter(c => c.symbol.endsWith('USDT'))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 50) // reduced to avoid overload
      .map(c => c.symbol);

  } catch (err) {
    console.log("❌ Binance Error:", err.message);
    return [];
  }
}

// ================== CANDLES ==================
async function getCandles(symbol) {
  try {
    const res = await axios.get(
      `${BASE}/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`
    );

    return res.data.map(c => [
      0,
      parseFloat(c[1]),
      parseFloat(c[2]),
      parseFloat(c[3]),
      parseFloat(c[4]),
      parseFloat(c[5])
    ]);

  } catch (err) {
    console.log("❌ Candle Error:", err.message);
    return [];
  }
}

// ================== SIGNAL ==================
async function generateSignal(symbol, btcTrend) {
  const candles = await getCandles(symbol);
  if (!candles.length) return null;

  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5]);

  const price = closes.at(-1);

  const trend15m = await getTrend(symbol, '15m');
  const trend1h = await getTrend(symbol, '1h');
  if (trend15m !== trend1h) return null;

  const rsi = ti.RSI.calculate({ values: closes, period: 14 });
  const ema20 = ti.EMA.calculate({ values: closes, period: 20 });
  const ema50 = ti.EMA.calculate({ values: closes, period: 50 });

  const macd = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
  });

  const lastRSI = rsi.at(-1);
  const lastEMA20 = ema20.at(-1);
  const lastEMA50 = ema50.at(-1);
  const lastMACD = macd.at(-1);

  if (!lastRSI || !lastEMA20 || !lastEMA50 || !lastMACD) return null;

  const support = lows.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const resistance = highs.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const range = resistance - support;
  if (range / price < 0.01) return null;

  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeSpike = volumes.at(-1) > avgVol * 1.8;

  const lastHigh = Math.max(...highs.slice(-20));
  const lastLow = Math.min(...lows.slice(-20));

  const breakoutUp = price > lastHigh * 1.002;
  const breakoutDown = price < lastLow * 0.998;

  let confidence = 0;

  if (lastRSI < 35) confidence++;
  if (price > lastEMA20 && lastEMA20 > lastEMA50) confidence++;
  if (lastMACD.MACD > lastMACD.signal) confidence++;
  if (volumeSpike) confidence++;

  if (btcTrend === 'BULLISH') confidence++;
  if (btcTrend === 'BEARISH') confidence--;

  if (breakoutUp || breakoutDown) confidence += 2;

  let type = 'HOLD';
  if (confidence >= 5 && trend1h === 'UP') type = 'BUY';
  if (confidence <= 1 && trend1h === 'DOWN') type = 'SELL';

  if (type === 'HOLD') return null;

  if (lastSignals[symbol] === type) return null;
  lastSignals[symbol] = type;

  let sl, targets;

  if (type === 'BUY') {
    sl = support * 0.995;
    const risk = price - sl;
    targets = [price + risk * 1.5, price + risk * 2.5];
  } else {
    sl = resistance * 1.005;
    const risk = sl - price;
    targets = [price - risk * 1.5, price - risk * 2.5];
  }

  return {
    coin: symbol.replace('USDT', '/USDT'),
    type,
    entry: formatPrice(price),
    sl: formatPrice(sl),
    targets: targets.map(formatPrice),
    confidence,
  };
}

// ================== SEND ==================
function formatSignal(d) {
  return `🔥 PRO SIGNAL 🔥

🚀 ${d.coin} → ${d.type}
💪 Confidence: ${d.confidence}/7

💰 Entry: ${d.entry}
🛑 SL: ${d.sl}

🎯 Targets:
${d.targets.map((t, i) => `TP${i + 1}: ${t}`).join('\n')}

⚠️ Trade at your own risk`;
}

async function postSignal(signal) {
  for (let ch of CHANNELS) {
    await bot.sendMessage(ch, formatSignal(signal));
  }
}

// ================== LOOP ==================
let isRunning = false;

setInterval(async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const btcTrend = await getBTCTrend();
    const symbols = await getTopCoins();
    for (let sym of symbols) {
      const signal = await generateSignal(sym, btcTrend);
      if (signal) await postSignal(signal);
    }
  } catch (err) {
    console.log("🔥 ERROR:", err.message);
  }

  isRunning = false;

}, 1000 * 60 * 5);

// ================== ADMIN ==================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, '🤖 Bot Running 🚀');
});
