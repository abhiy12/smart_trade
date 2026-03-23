// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');
const express = require('express');

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const token = '8531708840:AAG46vk1SsLTD_c7HSt2UUfB79UyYRGfZEA'; // ✅ secure
const ADMIN_ID = 5690207061;
const CHANNELS = [-1003784336023];
const NEWS_API_KEY = '114c0dfb27784d339652844d4ed24f41';

// 🌐 Your Render URL (CHANGE THIS)
const URL = "https://your-app-name.onrender.com";

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('🚀 Trading Bot is LIVE');
});

// ================== TELEGRAM BOT (WEBHOOK) ==================
const bot = new TelegramBot(token);

// ✅ Set webhook
bot.setWebHook(`${URL}/bot${token}`);

// ✅ Webhook route
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on ${PORT}`);
});

// ================== ERROR ==================
process.on('uncaughtException', (err) =>
  console.log('🔥', err.stack),
);
process.on('unhandledRejection', (err) => console.log('🔥', err));

// ================== AXIOS ==================
const axiosInstance = axios.create({
  baseURL: 'https://api.bybit.com',
  headers: {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'application/json',
    'Referer': 'https://www.bybit.com/',
    'Origin': 'https://www.bybit.com'
  },
  timeout: 15000
});

async function safeRequest(url) {
  try {
    return await axiosInstance.get(url);
  } catch (err) {
    console.log("⚠️ Retry:", url);
    await new Promise(r => setTimeout(r, 2000));
    return await axiosInstance.get(url);
  }
}

// ================== HELPERS ==================
function formatPrice(price) {
  if (price < 1) return price.toFixed(5);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}

// ================== CACHE ==================
let newsCache = {};
let lastSignals = {};

// ================== BTC TREND ==================
async function getBTCTrend() {
  try {
    const res = await safeRequest(
      'https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=60&limit=50'
    );

    const closes = res.data.result.list.map(c => parseFloat(c[4])).reverse();
    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });

    return closes.at(-1) > ema20.at(-1) ? 'BULLISH' : 'BEARISH';
  } catch {
    return 'NEUTRAL';
  }
}

// ================== TREND ==================
async function getTrend(symbol, interval) {
  try {
    const mapInterval = { '15m': '15', '1h': '60' };

    const res = await safeRequest(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${mapInterval[interval]}&limit=50`
    );

    const closes = res.data.result.list.map(c => parseFloat(c[4])).reverse();

    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });
    const ema50 = ti.EMA.calculate({ values: closes, period: 50 });

    if (!ema20.length || !ema50.length) return 'NEUTRAL';

    return ema20.at(-1) > ema50.at(-1) ? 'UP' : 'DOWN';
  } catch {
    return 'NEUTRAL';
  }
}

// ================== NEWS ==================
async function getNewsSentiment(symbol) {
  const coin = symbol.replace('USDT', '');

  if (newsCache[coin] && Date.now() - newsCache[coin].time < 600000) {
    return newsCache[coin].score;
  }

  try {
    const res = await axiosInstance.get(
      `https://newsapi.org/v2/everything?q=${coin}&apiKey=${NEWS_API_KEY}`,
    );

    let score = 0;

    res.data.articles.slice(0, 5).forEach((a) => {
      const text = (a.title + (a.description || '')).toLowerCase();
      if (text.includes('bull') || text.includes('up')) score++;
      if (text.includes('bear') || text.includes('down')) score--;
    });

    newsCache[coin] = { score, time: Date.now() };
    return score;
  } catch {
    return 0;
  }
}

// ================== TOP COINS ==================
async function getTopCoins() {
  try {
    const res = await safeRequest(
      'https://api.bybit.com/v5/market/tickers?category=linear'
    );

    return res.data.result.list
      .sort((a, b) => b.turnover24h - a.turnover24h)
      .slice(0, 100)
      .map(c => c.symbol);

  } catch (err) {
    console.log("❌ Bybit Error:", err.message);
    return [];
  }
}

// ================== CANDLES ==================
async function getCandles(symbol) {
  try {
    const res = await safeRequest(
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=15&limit=100`
    );

    return res.data.result.list.map(c => [
      0,
      parseFloat(c[1]),
      parseFloat(c[2]),
      parseFloat(c[3]),
      parseFloat(c[4]),
      parseFloat(c[5])
    ]).reverse();

  } catch (err) {
    console.log("❌ Bybit Error:", err.message);
    return [];
  }
}

// ================== SIGNAL ==================
// ✅ YOUR LOGIC — UNCHANGED
async function generateSignal(symbol, btcTrend) {
  const candles = await getCandles(symbol);
  if (!candles.length) return null;

  const closes = candles.map((c) => parseFloat(c[4]));
  const highs = candles.map((c) => parseFloat(c[2]));
  const lows = candles.map((c) => parseFloat(c[3]));
  const volumes = candles.map((c) => parseFloat(c[5]));

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

  const rr = Math.abs((targets[0] - price) / (price - sl));
  if (rr < 1.5) return null;

  return {
    coin: symbol.replace('USDT', '/USDT'),
    type,
    entry: formatPrice(price),
    sl: formatPrice(sl),
    targets: targets.map((t) => formatPrice(t)),
    confidence,
  };
}

// ================== REST SAME ==================
function formatSignal(d) {
  return `🔥 PRO SIGNAL 🔥\n\n🚀 ${d.coin} → ${d.type}\n💪 Confidence: ${d.confidence}/7\n\n💰 Entry: ${d.entry}\n🛑 SL: ${d.sl}\n\n🎯 Targets:\n${d.targets.map((t, i) => `TP${i + 1}: ${t}`).join('\n')}\n\n⚠️ Trade at your own risk`;
}

async function postSignal(signal) {
  for (let ch of CHANNELS) {
    try {
      await bot.sendMessage(ch, formatSignal(signal));
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.log("❌ Channel Error:", err.message);
    }
  }
}

async function processBatch(symbols, btcTrend) {
  let sent = 0;

  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);

    await Promise.all(
      batch.map(async (sym) => {
        if (sent >= 5) return;

        const signal = await generateSignal(sym, btcTrend);

        if (signal) {
          await postSignal(signal);
          sent++;
        }
      })
    );

    await new Promise((r) => setTimeout(r, 2000));
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
    await processBatch(symbols, btcTrend);
  } catch (err) {
    console.log("🔥 LOOP ERROR:", err.message);
  }

  isRunning = false;

}, 1000 * 60 * 5);

// ================== ADMIN ==================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, '🤖 Bot Running 🚀');
});

bot.onText(/\/test/, async (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;

  await postSignal({
    coin: 'TEST',
    type: 'BUY',
    entry: '0',
    sl: '0',
    targets: ['0', '0'],
    confidence: 7,
  });

  bot.sendMessage(msg.chat.id, '✅ Test sent');
});
