// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ================== CONFIG ==================
const token = '8531708840:AAEpS0osNc7_yOJjsfICTo4tmby3qGfkEEw'; // 🔥 use env variable
const ADMIN_ID = 5690207061;
const CHANNELS = [-1003784336023];

// ================== START ==================
console.log('🚀 Bot Starting...');

const bot = new TelegramBot(token, {
  polling: true,
});

// ================== HELPERS ==================
function formatPrice(price) {
  if (price < 1) return price.toFixed(5);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}

// ================== BTC TREND ==================
async function getBTCTrend() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
    );

    const price = res.data.bitcoin.usd;
    console.log("BTC:", price);

    if (price > 65000) return 'BULLISH';
    if (price < 50000) return 'BEARISH';
    return 'NEUTRAL';

  } catch (err) {
    console.log("BTC ERROR:", err.message);
    return 'NEUTRAL';
  }
}

// ================== TOP COINS ==================
async function getTopCoins() {
  try {
    const res = await axios.get(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=20&page=1'
    );

    return res.data.map(c => ({
      symbol: c.symbol.toUpperCase(),
      price: c.current_price,
      change: c.price_change_percentage_24h
    }));

  } catch (err) {
    console.log("TopCoins ERROR:", err.message);
    return [];
  }
}

// ================== SIGNAL ==================
function generateSignal(coin, btcTrend) {
  if (!coin.change) return null;

  let type = 'HOLD';
  let confidence = 0;

  if (coin.change > 5 && btcTrend !== 'BEARISH') {
    type = 'BUY';
    confidence = 6;
  }

  if (coin.change < -5 && btcTrend !== 'BULLISH') {
    type = 'SELL';
    confidence = 6;
  }

  if (type === 'HOLD') return null;

  const price = coin.price;

  return {
    coin: coin.symbol + '/USDT',
    type,
    entry: formatPrice(price),
    sl: formatPrice(type === 'BUY' ? price * 0.97 : price * 1.03),
    targets: [
      formatPrice(type === 'BUY' ? price * 1.03 : price * 0.97),
      formatPrice(type === 'BUY' ? price * 1.05 : price * 0.95),
    ],
    confidence,
  };
}

// ================== FORMAT ==================
function formatSignal(d) {
  return `
🔥 PRO SIGNAL 🔥

🚀 ${d.coin} → ${d.type}
💪 Confidence: ${d.confidence}/10

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

      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.log("Channel Error:", err.message);
    }
  }
}

// ================== LOOP ==================
let isRunning = false;

setInterval(async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    console.log("🔄 Market Scan Start...");

    const btcTrend = await getBTCTrend();
    console.log("📊 BTC Trend:", btcTrend);

    const coins = await getTopCoins();

    for (let coin of coins) {
      const signal = generateSignal(coin, btcTrend);

      if (signal) {
        await postSignal(signal);
      }
    }

  } catch (err) {
    console.log("🔥 LOOP ERROR:", err.message);
  }

  isRunning = false;

}, 1000 * 60 * 5);

// ================== COMMANDS ==================
bot.onText(/\/start/, (msg) => {
  if (msg.chat.id !== ADMIN_ID) {
    bot.sendMessage(msg.chat.id, "❌ Not allowed");
    return;
  }

  bot.sendMessage(msg.chat.id, "🤖 Bot Running 🚀");
});

bot.onText(/\/test/, async (msg) => {
  if (msg.chat.id !== ADMIN_ID) return;

  await postSignal({
    coin: 'BTC/USDT',
    type: 'BUY',
    entry: '65000',
    sl: '63000',
    targets: ['67000', '69000'],
    confidence: 9,
  });

  bot.sendMessage(msg.chat.id, "✅ Test sent");
});
