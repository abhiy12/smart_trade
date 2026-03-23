// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');
const express = require('express');

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const TOKEN = process.env.TELEGRAM_TOKEN;  // set in Render environment variables
const ADMIN_ID = Number(process.env.ADMIN_ID || '5690207061');
const CHANNELS = JSON.parse(process.env.CHANNELS || '[-1003784336023]');
const NEWS_API_KEY = process.env.NEWS_API_KEY;

const RENDER_URL = process.env.RENDER_APP_URL; // your Render app URL

// ================== TELEGRAM BOT ==================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${RENDER_URL}/bot${TOKEN}`);

// Webhook endpoint for Telegram
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🚀 Trading Bot is LIVE'));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on ${PORT}`));

// ================== AXIOS ==================
const axiosInstance = axios.create({
  baseURL: 'https://api.bybit.com',
  headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
  timeout: 15000,
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
let lastSignals = {};

// ================== GET TOP COINS (LIMITED) ==================
async function getTopCoins() {
  try {
    const res = await safeRequest('/v5/market/tickers?category=linear');
    // Limit to top 10 to reduce API calls
    return res.data.result.list
      .sort((a, b) => b.turnover24h - a.turnover24h)
      .slice(0, 10)
      .map(c => c.symbol);
  } catch (err) {
    console.log("❌ Bybit Error:", err.message);
    return [];
  }
}

// ================== GET CANDLES ==================
async function getCandles(symbol, interval = 15, limit = 50) {
  try {
    const res = await safeRequest(
      `/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    return res.data.result.list.map(c => [
      0,
      parseFloat(c[1]),
      parseFloat(c[2]),
      parseFloat(c[3]),
      parseFloat(c[4]),
      parseFloat(c[5]),
    ]).reverse();
  } catch (err) {
    console.log("❌ Bybit Error:", err.message);
    return [];
  }
}

// ================== GENERATE SIGNAL ==================
async function generateSignal(symbol) {
  const candles = await getCandles(symbol);
  if (!candles.length) return null;

  const closes = candles.map(c => c[4]);
  const ema20 = ti.EMA.calculate({ values: closes, period: 20 });
  const ema50 = ti.EMA.calculate({ values: closes, period: 50 });
  if (!ema20.length || !ema50.length) return null;

  const lastEMA20 = ema20.at(-1);
  const lastEMA50 = ema50.at(-1);
  const price = closes.at(-1);

  let type = 'HOLD';
  if (lastEMA20 > lastEMA50) type = 'BUY';
  if (lastEMA20 < lastEMA50) type = 'SELL';

  if (lastSignals[symbol] === type) return null;
  lastSignals[symbol] = type;

  return {
    coin: symbol.replace('USDT', '/USDT'),
    type,
    entry: formatPrice(price),
    sl: formatPrice(price * (type === 'BUY' ? 0.995 : 1.005)),
    targets: [
      formatPrice(price * (type === 'BUY' ? 1.01 : 0.99)),
      formatPrice(price * (type === 'BUY' ? 1.02 : 0.98))
    ]
  };
}

// ================== POST SIGNAL ==================
async function postSignal(signal) {
  for (let ch of CHANNELS) {
    try {
      await bot.sendMessage(ch, `
🚀 ${signal.coin} → ${signal.type}
💰 Entry: ${signal.entry}
🛑 SL: ${signal.sl}
🎯 Targets: ${signal.targets.join(', ')}
⚠️ Trade at your own risk
      `);
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.log("❌ Channel Error:", err.message);
    }
  }
}

// ================== CRON ENDPOINT ==================
// Triggered by Render cron job every 5–10 min
app.get('/scan', async (req, res) => {
  const symbols = await getTopCoins();
  for (let sym of symbols) {
    const signal = await generateSignal(sym);
    if (signal) await postSignal(signal);
  }
  res.send('Scan completed ✅');
});

// ================== ADMIN COMMANDS ==================
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
    targets: ['0', '0']
  });
  bot.sendMessage(msg.chat.id, '✅ Test sent');
});
