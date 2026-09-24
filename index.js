require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ---- basic checks ----
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('❌ Missing TELEGRAM_BOT_TOKEN in environment variables');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('❌ Missing GEMINI_API_KEY in environment variables');
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// 'gemini-flash-latest' is an alias that Google automatically points to its current
// Flash model, so this keeps working even after Google retires older model names
// (which is what caused the previous error). If it ever stops working, open
// https://ai.google.dev/gemini-api/docs/models and pick the current Flash model name.
const geminiModel = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

// Simple in-memory session store: chatId -> { product, lang }
// NOTE: this resets whenever the bot restarts (fine for a first version).
const sessions = {};

// ---- language detection ----
function detectLang(text) {
  if (/[\u10A0-\u10FF]/.test(text)) return 'ka'; // Georgian
  if (/[\u0400-\u04FF]/.test(text)) return 'ru'; // Cyrillic / Russian
  return 'en';
}

// ---- localized button labels ----
const BUTTONS = {
  ka: {
    full: '📊 სრული ანალიზი',
    countries: '🌍 ქვეყნები',
    growth: '📈 ზრდის ტენდენცია',
    top: '🏆 Top Products',
    prices: '💰 ფასები',
    competitors: '🛒 კონკურენტები',
    trade: '🚢 Import/Export',
    idea: '💡 ბიზნეს იდეა',
    reset: '🔄 ახალი პროდუქტი'
  },
  ru: {
    full: '📊 Полный анализ',
    countries: '🌍 Страны',
    growth: '📈 Тренд роста',
    top: '🏆 Топ продукты',
    prices: '💰 Цены',
    competitors: '🛒 Конкуренты',
    trade: '🚢 Импорт/Экспорт',
    idea: '💡 Бизнес-идея',
    reset: '🔄 Новый продукт'
  },
  en: {
    full: '📊 Full Analysis',
    countries: '🌍 Countries',
    growth: '📈 Growth Trend',
    top: '🏆 Top Products',
    prices: '💰 Prices',
    competitors: '🛒 Competitors',
    trade: '🚢 Import/Export',
    idea: '💡 Business Idea',
    reset: '🔄 New Product'
  }
};

const WAIT_MSG = { ka: '⏳ ვამზადებ ანალიზს...', ru: '⏳ Готовлю анализ...', en: '⏳ Preparing analysis...' };
const NEED_PRODUCT_MSG = {
  ka: '❗ ჯერ დაწერე პროდუქტის სახელი.',
  ru: '❗ Сначала напишите название продукта.',
  en: '❗ Please type a product name first.'
};
const ASK_NEW_MSG = {
  ka: '✍️ დაწერე ახალი პროდუქტის სახელი:',
  ru: '✍️ Напишите название нового продукта:',
  en: '✍️ Type a new product name:'
};
const WELCOME_MSG =
  '👋 გამარჯობა! დაწერე პროდუქტის სახელი ქართულად, რუსულად ან ინგლისურად და მე გავაანალიზებ ბაზარს.\n\n' +
  '👋 Привет! Напишите название продукта на грузинском, русском или английском — я проанализирую рынок.\n\n' +
  '👋 Hi! Type a product name in Georgian, Russian or English and I will analyze the market for you.';

function buildKeyboard(lang) {
  const b = BUTTONS[lang];
  return Markup.inlineKeyboard([
    [Markup.button.callback(b.full, 'full')],
    [Markup.button.callback(b.countries, 'countries'), Markup.button.callback(b.growth, 'growth')],
    [Markup.button.callback(b.top, 'top'), Markup.button.callback(b.prices, 'prices')],
    [Markup.button.callback(b.competitors, 'competitors'), Markup.button.callback(b.trade, 'trade')],
    [Markup.button.callback(b.idea, 'idea')],
    [Markup.button.callback(b.reset, 'reset')]
  ]);
}

// ---- Gemini API call (free tier) ----
async function askGemini(prompt) {
  const result = await geminiModel.generateContent(prompt);
  return result.response.text();
}

function categoryPrompt(category, product, lang) {
  const langName = { ka: 'Georgian', ru: 'Russian', en: 'English' }[lang];
  const base =
    `You are a market research assistant analyzing the product "${product}" for someone considering selling it ` +
    `(e-commerce / dropshipping / import-export). Respond ONLY in ${langName}. Use emojis and short lines/bullet ` +
    `points, formatted for a Telegram message. Be concise, concrete and useful. Present the analysis confidently, ` +
    `but where you don't have precise real data, use realistic qualitative ranges (e.g. "high/medium/low", ` +
    `"~15-25%") instead of inventing exact fake statistics. Do not mention that you are an AI or that this is an estimate.`;

  const sections = {
    full:
      `${base}\nGive a FULL analysis with clearly separated sections (each with its own emoji header) covering: ` +
      `1) demand overview, 2) growth trend, 3) top countries by demand, 4) whether it's a trending/top product, ` +
      `5) typical price range across markets, 6) main competitor types, 7) import/export picture, ` +
      `8) one concrete business idea. Keep each section short (2-4 lines).`,
    countries:
      `${base}\nList the 5-8 countries where demand for this product is currently highest. For each, show a flag ` +
      `emoji, the country name, and a qualitative demand level (high / medium-high / medium / low).`,
    growth:
      `${base}\nDescribe the demand growth trend for this product over roughly the last 3 years and going forward. ` +
      `Give an overall trend label (growing / stable / declining) and an approximate growth percentage range.`,
    top:
      `${base}\nSay clearly whether this product currently counts as a globally trending / high-demand product, ` +
      `and briefly describe the kind of products that lead this category.`,
    prices:
      `${base}\nGive a typical retail price range for this product in a few major markets (e.g. USA, EU, ` +
      `local/regional market), and briefly note how and why prices differ between them.`,
    competitors:
      `${base}\nList the main types of sellers/competitors in this product category (e.g. budget brands, premium ` +
      `brands, marketplace resellers, local manufacturers) and how each tends to position itself.`,
    trade:
      `${base}\nDescribe the general import/export picture for this product: main exporting countries/regions, ` +
      `main importing countries/regions, and the overall trade volume trend (growing/shrinking).`,
    idea:
      `${base}\nGive one concrete, practical business idea based on everything above: which country/market looks ` +
      `interesting, what product variation or niche could work better, what the main risks are, and how someone ` +
      `could differentiate from existing competitors.`
  };
  return sections[category];
}

// ---- bot handlers ----
bot.start((ctx) => ctx.reply(WELCOME_MSG));

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  const lang = detectLang(text);
  sessions[ctx.chat.id] = { product: text, lang };

  await ctx.reply(`🔎 ${text}`, buildKeyboard(lang));
});

bot.action('reset', async (ctx) => {
  await ctx.answerCbQuery();
  const lang = sessions[ctx.chat.id]?.lang || 'en';
  await ctx.reply(ASK_NEW_MSG[lang]);
});

const CATEGORIES = ['full', 'countries', 'growth', 'top', 'prices', 'competitors', 'trade', 'idea'];

CATEGORIES.forEach((cat) => {
  bot.action(cat, async (ctx) => {
    await ctx.answerCbQuery();
    const session = sessions[ctx.chat.id];
    if (!session) {
      await ctx.reply(NEED_PRODUCT_MSG.en);
      return;
    }
    await ctx.reply(WAIT_MSG[session.lang]);
    try {
      const prompt = categoryPrompt(cat, session.product, session.lang);
      const result = await askGemini(prompt);
      await ctx.reply(result, buildKeyboard(session.lang));
    } catch (err) {
      console.error(err);
      await ctx.reply('⚠️ Error: ' + err.message);
    }
  });
});

// ---- keep Render web service alive (health check) ----
const app = express();
app.get('/', (req, res) => res.send('Telegram market bot is running ✅'));
app.listen(process.env.PORT || 3000, () => {
  console.log('HTTP health server listening on port', process.env.PORT || 3000);
});

bot.launch().then(() => console.log('🤖 Bot started'));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
