require('dotenv').config();

const axios = require('axios');
const ti = require('technicalindicators');
const TelegramBot = require('node-telegram-bot-api');

// ================= CONFIG =================
const bot = new TelegramBot(process.env.TOKEN, { polling: false });

const CHAT_ID = process.env.CHAT_ID;
const NEWS_KEY = process.env.NEWS_API_KEY;

const INTERVAL = '15m';
const SCAN_TIME = 60 * 1000;

// ================= SAFE =================
async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    console.log("Error:", e.message);
    return null;
  }
}

// ================= GET TOP COINS =================
async function getCoins() {
  return safe(async () => {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
    return res.data
      .filter(c => c.symbol.endsWith('USDT'))
      .sort((a, b) => b.quoteVolume - a.quoteVolume)
      .slice(0, 50)
      .map(c => c.symbol);
  }) || [];
}

// ================= GET DATA =================
async function getData(symbol) {
  return safe(async () => {
    const res = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=100`
    );

    return res.data.map(k => ({
      close: parseFloat(k[4]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3])
    }));
  }) || [];
}

// ================= INDICATORS =================
function calcIndicators(data) {
  const closes = data.map(d => d.close);

  const rsi = ti.RSI.calculate({ values: closes, period: 14 });
  const ema9 = ti.EMA.calculate({ values: closes, period: 9 });
  const ema21 = ti.EMA.calculate({ values: closes, period: 21 });
  const macd = ti.MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9
  });

  return {
    rsi: rsi.at(-1),
    ema9: ema9.at(-1),
    ema21: ema21.at(-1),
    macd: macd.at(-1)
  };
}

// ================= SUPPORT / RESIST =================
function getSR(data) {
  const recent = data.slice(-20);
  return {
    support: Math.min(...recent.map(d => d.low)),
    resistance: Math.max(...recent.map(d => d.high))
  };
}

// ================= NEWS =================
async function getNews(symbol) {
  return safe(async () => {
    const coin = symbol.replace("USDT", "");
    const res = await axios.get(
      `https://newsapi.org/v2/everything?q=${coin}&apiKey=${NEWS_KEY}`
    );

    let score = 0;

    res.data.articles.slice(0, 5).forEach(a => {
      const t = a.title.toLowerCase();
      if (t.includes("bull") || t.includes("rise")) score++;
      if (t.includes("crash") || t.includes("hack")) score--;
    });

    return score > 1 ? "POSITIVE" : score < -1 ? "NEGATIVE" : "NEUTRAL";
  }) || "NEUTRAL";
}

// ================= SIGNAL =================
async function generateSignal(symbol, data) {
  const ind = calcIndicators(data);
  const sr = getSR(data);
  const price = data.at(-1).close;
  const news = await getNews(symbol);

  // BUY
  if (
    ind.rsi < 35 &&
    ind.ema9 > ind.ema21 &&
    ind.macd.MACD > ind.macd.signal &&
    price <= sr.support * 1.03 &&
    news === "POSITIVE"
  ) {
    return {
      type: "BUY",
      entry: price,
      sl: sr.support * 0.98,
      tp: price + (price - sr.support) * 2,
      rsi: ind.rsi,
      news
    };
  }

  // SELL
  if (
    ind.rsi > 65 &&
    ind.ema9 < ind.ema21 &&
    ind.macd.MACD < ind.macd.signal &&
    price >= sr.resistance * 0.97 &&
    news === "NEGATIVE"
  ) {
    return {
      type: "SELL",
      entry: price,
      sl: sr.resistance * 1.02,
      tp: price - (sr.resistance - price) * 2,
      rsi: ind.rsi,
      news
    };
  }

  return null;
}

// ================= SEND TO TELEGRAM =================
async function sendSignal(symbol, s) {
  const msg = `
🚨 AUTO SIGNAL 🚨

🪙 Coin: ${symbol}
📊 Type: ${s.type}

💰 Entry: ${s.entry}
🎯 Target: ${s.tp}
🛑 StopLoss: ${s.sl}

📉 RSI: ${s.rsi.toFixed(2)}
📰 News: ${s.news}

⏱ Timeframe: ${INTERVAL}
  `;

  await safe(() => bot.sendMessage(CHAT_ID, msg));
}

// ================= MAIN LOOP =================
async function scan() {
  console.log("🔍 Scanning...");

  const coins = await getCoins();

  for (let symbol of coins) {
    const data = await getData(symbol);
    if (!data || data.length < 50) continue;

    const signal = await generateSignal(symbol, data);

    if (signal) {
      console.log(`🔥 ${symbol} ${signal.type}`);
      await sendSignal(symbol, signal);
    }
  }
}

// ================= START =================
setInterval(scan, SCAN_TIME);
scan();