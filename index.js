// ================== IMPORTS ==================
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const ti = require('technicalindicators');

// ================== CONFIG ==================
const TOKEN = '8531708840:AAEhxxukq0c1aoytfxM6l952aFWL__rLsr0';
const ADMIN_ID = 5690207061;
const CHANNELS = [-1003784336023];

// ================== START ==================
console.log('🚀 Bot Starting...');
const bot = new TelegramBot(TOKEN, {
  polling: { interval: 3000, autoStart: true, params: { timeout: 10 } },
});
bot.on("polling_error", (error) => console.log("⚠️ Polling Error:", error.message));

process.on('uncaughtException', (err) => console.log('🔥', err.stack));
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

// ================== COINGECKO FUNCTIONS ==================

// Get BTC trend (1h EMA20)
async function getBTCTrend() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/coins/bitcoin/ohlc', {
      params: { vs_currency: 'usd', days: 1 } // 1 day, 1h candles
    });

    const closes = res.data.map(c => c[4]); // close price
    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });

    return closes.at(-1) > ema20.at(-1) ? 'BULLISH' : 'BEARISH';
  } catch {
    return 'NEUTRAL';
  }
}

// Multi-timeframe trend
async function getTrend(symbol, interval) {
  try {
    const coinId = symbol.replace('USDT', '').toLowerCase();
    const days = interval === '1h' ? 1 : 7;
    const res = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, {
      params: { vs_currency: 'usd', days }
    });
    const closes = res.data.map(c => c[4]);
    const ema20 = ti.EMA.calculate({ values: closes, period: 20 });
    const ema50 = ti.EMA.calculate({ values: closes, period: 50 });

    if (!ema20.length || !ema50.length) return 'NEUTRAL';
    return ema20.at(-1) > ema50.at(-1) ? 'UP' : 'DOWN';
  } catch {
    return 'NEUTRAL';
  }
}

// Get top coins by volume
async function getTopCoins() {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: { vs_currency: 'usd', order: 'volume_desc', per_page: 100, page: 1 }
    });
    return res.data.map(c => c.symbol.toUpperCase() + 'USDT'); // map to format SYMBOLUSDT
  } catch {
    return [];
  }
}

// Get candles (15m)
async function getCandles(symbol) {
  try {
    const coinId = symbol.replace('USDT', '').toLowerCase();
    const res = await axios.get(`https://api.coingecko.com/api/v3/coins/${coinId}/ohlc`, {
      params: { vs_currency: 'usd', days: 1 } // 1 day ~ 96 x 15min candles
    });
    return res.data; // [[timestamp, open, high, low, close], ...]
  } catch {
    return [];
  }
}

// News sentiment
async function getNewsSentiment(symbol) {
  const coin = symbol.replace('USDT', '').toLowerCase();
  if (newsCache[coin] && Date.now() - newsCache[coin].time < 600000) return newsCache[coin].score;

  try {
    const res = await axios.get(`https://api.coingecko.com/api/v3/coins/${coin}/status_updates`);
    let score = 0;
    res.data.status_updates.slice(0, 5).forEach(u => {
      const text = u.description.toLowerCase();
      if (text.includes('bull') || text.includes('up')) score++;
      if (text.includes('bear') || text.includes('down')) score--;
    });

    newsCache[coin] = { score, time: Date.now() };
    return score;
  } catch {
    return 0;
  }
}

// ================== SIGNAL GENERATOR ==================
async function generateSignal(symbol, btcTrend) {
  const candles = await getCandles(symbol);
  if (!candles.length) return null;

  const closes = candles.map(c => c[4]);
  const highs = candles.map(c => c[2]);
  const lows = candles.map(c => c[3]);
  const volumes = candles.map(c => c[5] || 1);

  const price = closes.at(-1);

  const trend15m = await getTrend(symbol, '15m');
  const trend1h = await getTrend(symbol, '1h');
  if (trend15m !== trend1h) return null;

  const rsi = ti.RSI.calculate({ values: closes, period: 14 });
  const ema20 = ti.EMA.calculate({ values: closes, period: 20 });
  const ema50 = ti.EMA.calculate({ values: closes, period: 50 });
  const macd = ti.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });

  const lastRSI = rsi.at(-1);
  const lastEMA20 = ema20.at(-1);
  const lastEMA50 = ema50.at(-1);
  const lastMACD = macd.at(-1);
  if (!lastRSI || !lastEMA20 || !lastEMA50 || !lastMACD) return null;

  const support = lows.slice(-20).reduce((a,b)=>a+b,0)/20;
  const resistance = highs.slice(-20).reduce((a,b)=>a+b,0)/20;
  const range = resistance - support;
  if (range/price < 0.01) return null;

  const avgVol = volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
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
  if (confidence >= 5 && trend1h === 'UP') type='BUY';
  if (confidence <= 1 && trend1h === 'DOWN') type='SELL';
  if (type==='HOLD') return null;

  if (lastSignals[symbol] === type) return null;
  lastSignals[symbol] = type;

  let sl, targets;
  if (type==='BUY'){
    sl = support*0.995;
    const risk = price-sl;
    targets = [price+risk*1.5, price+risk*2.5];
  } else {
    sl = resistance*1.005;
    const risk = sl-price;
    targets = [price-risk*1.5, price-risk*2.5];
  }

  const rr = Math.abs((targets[0]-price)/(price-sl));
  if (rr<1.5) return null;

  return { coin: symbol.replace('USDT','/USDT'), type, entry: formatPrice(price), sl: formatPrice(sl), targets: targets.map(t=>formatPrice(t)), confidence };
}

// ================== FORMAT ==================
function formatSignal(d){
  return `
🔥 PRO SIGNAL 🔥

🚀 ${d.coin} → ${d.type}
💪 Confidence: ${d.confidence}/7

💰 Entry: ${d.entry}
🛑 SL: ${d.sl}

🎯 Targets:
${d.targets.map((t,i)=>`TP${i+1}: ${t}`).join('\n')}

⚠️ Trade at your own risk
`;
}

// ================== POST ==================
async function postSignal(signal){
  for(let ch of CHANNELS){
    try{
      await bot.sendMessage(ch, formatSignal(signal));
      console.log("✅ Posted:", signal.coin);
      await new Promise(r=>setTimeout(r,800));
    }catch(err){
      console.log("❌ Channel Error:", err.message);
    }
  }
}

// ================== PROCESS ==================
async function processBatch(symbols, btcTrend){
  let sent = 0;
  for(let i=0;i<symbols.length;i+=10){
    const batch = symbols.slice(i,i+10);
    await Promise.all(batch.map(async(sym)=>{
      if(sent>=5) return;
      const signal = await generateSignal(sym, btcTrend);
      if(signal){
        await postSignal(signal);
        sent++;
      }
    }));
    await new Promise(r=>setTimeout(r,2000));
  }
}

// ================== LOOP ==================
let isRunning = false;
setInterval(async()=>{
  if(isRunning){ console.log("⏸️ Previous scan still running..."); return; }
  isRunning = true;
  try{
    console.log("🔄 Market Scan Start...");
    const btcTrend = await getBTCTrend();
    console.log("📊 BTC Trend:", btcTrend);
    const symbols = await getTopCoins();
    await processBatch(symbols, btcTrend);
  }catch(err){
    console.log("🔥 LOOP ERROR:", err.message);
  }
  isRunning=false;
}, 1000*60*1);

// ================== ADMIN ==================
bot.onText(/\/start/, msg=>{
  if(msg.chat.id!==ADMIN_ID){ bot.sendMessage(msg.chat.id,"❌ You are not authorized"); return; }
  bot.sendMessage(msg.chat.id,'🤖 Bot Running 🚀');
});

bot.onText(/\/test/, async msg=>{
  if(msg.chat.id!==ADMIN_ID) return;
  await postSignal({ coin:'TEST', type:'BUY', entry:'0', sl:'0', targets:['0','0'], confidence:7 });
  bot.sendMessage(msg.chat.id,'✅ Test sent');
});
