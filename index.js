// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');
const express = require('express');

const app = express();
app.use(express.json());

// ================== CONFIG ==================
const TOKEN = process.env.TELEGRAM_TOKEN;  // Telegram Bot token
const ADMIN_ID = Number(process.env.ADMIN_ID || '5690207061');
const CHANNELS = JSON.parse(process.env.CHANNELS || '[-1003784336023]');
const RENDER_URL = process.env.RENDER_APP_URL; // Render app URL

// ================== TELEGRAM BOT ==================
const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${RENDER_URL}/bot${TOKEN}`);

// Webhook endpoint
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ================== SERVER ==================
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('🚀 CoinGecko Trading Bot is LIVE'));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on ${PORT}`));

// ================== CACHE ==================
let lastSignals = {};

// ================== HELPERS ==================
function formatPrice(price) {
  if (price < 1) return price.toFixed(5);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}

// ================== COINGECKO API ==================
async function getTopCoins(limit = 10) {
  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/coins/markets`, {
      params: {
        vs_currency: 'usd',
        order: 'market_cap_desc',
        per_page: limit,
        page: 1,
        price_change_percentage: '1h'
      }
    });
    return res.data.map(c => c.id); // CoinGecko coin IDs
  } catch (err) {
    console.log("❌ CoinGecko Error:", err.message);
    return [];
  }
}

async function getCandles(coinId = 'bitcoin', days = 1, interval = 'hourly') {
  try {
    const res = await axios.get(
      `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart`,
      { params: { vs_currency: 'usd', days, interval } }
    );
    // Convert CoinGecko prices to [timestamp, open, high, low, close, volume]
    return res.data.prices.map(p => [0, p[1], p[1], p[1], p[1], 0]).reverse();
  } catch (err) {
    console.log("❌ CoinGecko Error:", err.message);
    return [];
  }
}

// ================== SIGNAL LOGIC ==================
async function generateSignal(coinId) {
  const candles = await getCandles(coinId);
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

  if (lastSignals[coinId] === type || type === 'HOLD') return null;
  lastSignals[coinId] = type;

  return {
    coin: coinId.toUpperCase(),
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
// Use Render Cron Job to hit this endpoint every 5–10 minutes
app.get('/scan', async (req, res) => {
  const coins = await getTopCoins(10);
  for (let coin of coins) {
    const signal = await generateSignal(coin);
    if (signal) await postSignal(signal);
  }
  res.send('Scan completed ✅');
});

// ================== ADMIN COMMANDS ==================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;
  bot.sendMessage(msg.chat.id, '🤖 CoinGecko Bot Running 🚀');
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
  bot.sendMessage(msg.chat.id, '✅ Test signal sent');
});
