'use strict';

// ================== IMPORTS ==================
const http = require('http');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');

// ================== CONFIG ==================
const TOKEN = process.env.RAILWAY_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '5690207061', 10);
const CHANNELS = (process.env.CHANNELS || '-1003784336023')
  .split(',')
  .map((id) => parseInt(id.trim(), 10));
const NEWS_API_KEY = process.env.NEWS_API_KEY || '';
const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || '';

// ================== VALIDATE ==================
if (!TOKEN) {
  console.error('❌ FATAL: RAILWAY_BOT_TOKEN environment variable is not set.');
  process.exit(1);
}

// ================== HELPERS ==================
function formatPrice(price) {
  if (price < 1) return price.toFixed(5);
  if (price < 100) return price.toFixed(3);
  return price.toFixed(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  } catch (err) {
    console.warn('⚠️ getBTCTrend error:', err.message);
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
  } catch (err) {
    console.warn(`⚠️ getTrend(${symbol}, ${interval}) error:`, err.message);
    return 'NEUTRAL';
  }
}

// ================== NEWS ==================
async function getNewsSentiment(symbol) {
  if (!NEWS_API_KEY) return 0;

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
  } catch (err) {
    console.warn(`⚠️ getNewsSentiment(${coin}) error:`, err.message);
    return 0;
  }
}

// ================== TOP COINS ==================
async function getTopCoins() {
  const res = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
  return res.data
    .filter((c) => c.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
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
  } catch (err) {
    console.warn(`⚠️ getCandles(${symbol}) error:`, err.message);
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

  // Multi-timeframe trend alignment
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

  // Volume spike
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volumeSpike = volumes.at(-1) > avgVol * 1.8;

  // Breakout detection
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

  // Deduplicate consecutive identical signals
  if (lastSignals[symbol] === type) return null;
  lastSignals[symbol] = type;

  // Stop-loss and targets
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
  return (
    `\n🔥 PRO SIGNAL 🔥\n\n` +
    `🚀 ${d.coin} → ${d.type}\n` +
    `💪 Confidence: ${d.confidence}/7\n\n` +
    `💰 Entry: ${d.entry}\n` +
    `🛑 SL: ${d.sl}\n\n` +
    `🎯 Targets:\n` +
    `${d.targets.map((t, i) => `TP${i + 1}: ${t}`).join('\n')}\n\n` +
    `⚠️ Trade at your own risk\n`
  );
}

// ================== POST ==================
async function postSignal(bot, signal) {
  for (const ch of CHANNELS) {
    try {
      await bot.sendMessage(ch, formatSignal(signal));
      console.log('✅ Posted:', signal.coin, '→', ch);
      await sleep(800); // respect Telegram rate limits
    } catch (err) {
      console.error('❌ Channel post error:', ch, err.message);
    }
  }
}

// ================== PROCESS BATCH ==================
async function processBatch(bot, symbols, btcTrend) {
  let sent = 0;

  for (let i = 0; i < symbols.length; i += 10) {
    const batch = symbols.slice(i, i + 10);

    await Promise.all(
      batch.map(async (sym) => {
        if (sent >= 5) return; // cap signals per scan cycle
        const signal = await generateSignal(sym, btcTrend);
        if (signal) {
          await postSignal(bot, signal);
          sent++;
        }
      }),
    );

    await sleep(2000);
  }
}

// ================== MARKET SCAN LOOP ==================
function startScanLoop(bot) {
  let isRunning = false;

  const runScan = async () => {
    if (isRunning) {
      console.log('⏸️  Previous scan still running, skipping cycle.');
      return;
    }
    isRunning = true;
    try {
      console.log('🔄 Market scan started...');
      const btcTrend = await getBTCTrend();
      console.log('📊 BTC Trend:', btcTrend);
      const symbols = await getTopCoins();
      await processBatch(bot, symbols, btcTrend);
      console.log('✅ Market scan complete.');
    } catch (err) {
      console.error('🔥 Scan loop error:', err.message);
    } finally {
      isRunning = false;
    }
  };

  // Run immediately on start, then every 60 seconds
  runScan();
  return setInterval(runScan, 60 * 1000);
}

// ================== COMMAND HANDLERS ==================
function registerCommands(bot) {
  bot.onText(/\/start/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) {
      bot.sendMessage(msg.chat.id, '❌ You are not authorized.').catch(() => {});
      return;
    }
    bot.sendMessage(msg.chat.id, '🤖 Bot is running 🚀').catch(() => {});
  });

  bot.onText(/\/test/, async (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    await postSignal(bot, {
      coin: 'TEST/USDT',
      type: 'BUY',
      entry: '0.00000',
      sl: '0.00000',
      targets: ['0.00000', '0.00000'],
      confidence: 7,
    });
    bot.sendMessage(msg.chat.id, '✅ Test signal sent.').catch(() => {});
  });

  bot.onText(/\/status/, (msg) => {
    if (msg.chat.id !== ADMIN_ID) return;
    bot
      .sendMessage(msg.chat.id, `✅ Bot online\n📡 Mode: Webhook\n🌐 Domain: ${PUBLIC_DOMAIN || 'not set'}`)
      .catch(() => {});
  });
}

// ================== HEALTH CHECK SERVER ==================
function startHealthServer(port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is alive 🤖\n');
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(port, () => {
    console.log(`🌐 Health server listening on port ${port}`);
  });

  server.on('error', (err) => {
    console.error('❌ Health server error:', err.message);
  });

  return server;
}

// ================== GRACEFUL SHUTDOWN ==================
function setupShutdown(bot, scanInterval, healthServer) {
  let shuttingDown = false;

  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);

    clearInterval(scanInterval);

    try {
      await bot.deleteWebHook();
      console.log('✅ Webhook deleted.');
    } catch (err) {
      console.warn('⚠️ Could not delete webhook:', err.message);
    }

    healthServer.close(() => {
      console.log('✅ Health server closed.');
      process.exit(0);
    });

    // Force exit after 10 seconds if something hangs
    setTimeout(() => {
      console.error('⏱️  Forced exit after timeout.');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ================== MAIN ==================
async function main() {
  console.log('🚀 Bot starting...');

  // 1. Start health check server first so Railway sees a live port immediately
  const healthServer = startHealthServer(PORT);

  // 2. Initialise bot
  let bot;

  if (PUBLIC_DOMAIN) {
    // Webhook mode — preferred in production (no polling conflicts)
    const webhookUrl = `https://${PUBLIC_DOMAIN}/bot${TOKEN}`;
    console.log('📡 Initialising in webhook mode...');

    bot = new TelegramBot(TOKEN, {
      webHook: {
        port: PORT + 1, // internal webhook port, separate from health server
        host: '0.0.0.0',
        autoOpen: true,
      },
    });

    try {
      await bot.setWebHook(webhookUrl);
      console.log('✅ Webhook registered:', webhookUrl);
    } catch (err) {
      console.error('❌ Failed to set webhook:', err.message);
      console.warn('⚠️  Falling back to polling mode...');
      await bot.closeWebHook();
      bot = new TelegramBot(TOKEN, {
        polling: { interval: 3000, params: { timeout: 10 } },
      });
    }
  } else {
    // Polling mode — used when no public domain is configured (e.g. local dev)
    console.log('📡 No RAILWAY_PUBLIC_DOMAIN set — using polling mode.');
    bot = new TelegramBot(TOKEN, {
      polling: { interval: 3000, params: { timeout: 10 } },
    });
  }

  // 3. Wire up error listeners
  bot.on('webhook_error', (err) => {
    console.error('⚠️  Webhook error:', err.message);
  });
  bot.on('polling_error', (err) => {
    // 409 Conflict is expected when switching modes; suppress the noise
    if (err.code === 'ETELEGRAM' && err.message.includes('409')) {
      console.warn('⚠️  Polling conflict (409) — another instance may be running.');
    } else {
      console.error('⚠️  Polling error:', err.message);
    }
  });

  // 4. Register command handlers
  registerCommands(bot);

  // 5. Start market scan loop
  const scanInterval = startScanLoop(bot);

  // 6. Graceful shutdown
  setupShutdown(bot, scanInterval, healthServer);

  console.log('✅ Bot fully initialised and running.');
}

// ================== PROCESS-LEVEL ERROR GUARDS ==================
process.on('uncaughtException', (err) => {
  console.error('🔥 Uncaught exception:', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('🔥 Unhandled rejection:', reason);
});

main().catch((err) => {
  console.error('🔥 Fatal startup error:', err.stack || err.message);
  process.exit(1);
});
