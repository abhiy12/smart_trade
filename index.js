// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');

// ================== CONFIG ==================
const token = '8531708840:AAE8szrKByh4p-CpdkI4macpNLMPkp3FyHQ';
const ADMIN_ID = 5690207061;

const CHANNELS = [-1003784336023];

const NEWS_API_KEY = '114c0dfb27784d339652844d4ed24f41';

// ================== START ==================
console.log('🚀 Bot Starting...');
// const bot = new TelegramBot(token, { polling: true });
const bot = new TelegramBot(token, {
  polling: {
    interval: 3000,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});
bot.on("polling_error", (error) => {
  console.log("⚠️ Polling Error:", error.message);
});

// ================== ERROR ==================
process.on('uncaughtException', (err) =>
  console.log('🔥', err.stack),
);
process.on('unhandledRejection', (err) => console.log('🔥', err));

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
    const res = await axios.get(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=50',
    );

    const closes = res.data.map((c) => parseFloat(c[4]));
    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });

    return closes.at(-1) > ema20.at(-1) ? 'BULLISH' : 'BEARISH';
  } catch {
    return 'NEUTRAL';
  }
}

// ================== TREND (MTF) ==================
async function getTrend(symbol, interval) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`,
    );

    const closes = res.data.map((c) => parseFloat(c[4]));

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
    const res = await axios.get(
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
  const res = await axios.get(
    'https://api.binance.com/api/v3/ticker/24hr',
  );

  return res.data
    .filter((c) => c.symbol.endsWith('USDT'))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 100)
    .map((c) => c.symbol);
}

// ================== CANDLES ==================
async function getCandles(symbol) {
  try {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=100`,
    );
    return res.data;
  } catch {
    return [];
  }
}

// ================== SIGNAL ==================
async function generateSignal(symbol, btcTrend) {
  const candles = await getCandles(symbol);
  if (!candles.length) return null;

  const closes = candles.map((c) => parseFloat(c[4]));
  const highs = candles.map((c) => parseFloat(c[2]));
  const lows = candles.map((c) => parseFloat(c[3]));
  const volumes = candles.map((c) => parseFloat(c[5]));

  const price = closes.at(-1);

  // Multi timeframe
  const trend15m = await getTrend(symbol, '15m');
  const trend1h = await getTrend(symbol, '1h');

  if (trend15m !== trend1h) return null;

  // Indicators
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

  // Support / Resistance
  const support = lows.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const resistance = highs.slice(-20).reduce((a, b) => a + b, 0) / 20;

  const range = resistance - support;
  if (range / price < 0.01) return null;

  // Volume
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeSpike = volumes.at(-1) > avgVol * 1.8;

  // Breakout
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

  // Duplicate filter
  if (lastSignals[symbol] === type) return null;
  lastSignals[symbol] = type;

  // SL + Targets
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

// ================== FORMAT ==================
function formatSignal(d) {
  return `
🔥 PRO SIGNAL 🔥

🚀 ${d.coin} → ${d.type}
💪 Confidence: ${d.confidence}/7

💰 Entry: ${d.entry}
🛑 SL: ${d.sl}

🎯 Targets:
${d.targets.map((t, i) => `TP${i + 1}: ${t}`).join('\n')}

⚠️ Trade at your own risk
`;
}

// ================== POST ==================
async function postSignal(signal) {
  for (let ch of CHANNELS) {
    try {
      await bot.sendMessage(ch, formatSignal(signal));

      console.log("✅ Posted:", signal.coin);

      // ✅ delay to avoid Telegram limit
      await new Promise(r => setTimeout(r, 800));

    } catch (err) {
      console.log("❌ Channel Error:", err.message);
    }
  }
}

// ================== PROCESS ==================
async function processBatch(symbols, btcTrend) {
  let sent = 0;

  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);

    await Promise.all(
      batch.map(async (sym) => {
        if (sent >= 5) return; // ✅ limit signals

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
  if (isRunning) {
    console.log("⏸️ Previous scan still running...");
    return;
  }

  isRunning = true;

  try {
    console.log("🔄 Market Scan Start...");

    const btcTrend = await getBTCTrend();
    console.log("📊 BTC Trend:", btcTrend);

    const symbols = await getTopCoins();
    await processBatch(symbols, btcTrend);

  } catch (err) {
    console.log("🔥 LOOP ERROR:", err.message);
  }

  isRunning = false;

}, 1000 * 60 * 5);

// ================== ADMIN ==================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) {
    bot.sendMessage(msg.chat.id, "❌ You are not authorized");
    return;
  }

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
