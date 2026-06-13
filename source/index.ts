import { Bot, InlineKeyboard, session } from "grammy";
import { supabaseAdapter } from "@grammyjs/storage-supabase";
import * as dotenv from "dotenv";

import { supabase } from "./database.ts"; // Adjust path if needed
import { MyContext, GameSession } from "./types.ts";
import { pullNextClue, evaluateGuessWithGemini, sendSafePhoto } from "./services.ts";

dotenv.config();

const bot = new Bot<MyContext>(process.env.TELEGRAM_BOT_TOKEN!);

// ---------------------------------------------------------------------------
// PERMANENT SESSION STORAGE
// ---------------------------------------------------------------------------
const storage = supabaseAdapter({
  supabase,
  table: 'sessions', 
});

bot.use(session({ 
  initial: (): GameSession => ({ 
    activeMapId: null, 
    activeMapName: null, 
    currentClue: null, 
    seenClueIds: [], 
    mode: null, 
    isProcessing: false,
    hasGuessed: false 
  }),
  storage, 
}));

// ---------------------------------------------------------------------------
// COMMANDS
// ---------------------------------------------------------------------------
bot.command("start", async (ctx) => {
  await ctx.reply("Welcome to the GeoGuessr Meta Trainer.\n\nTap the button below or type /maps to choose a map and begin.", {
    reply_markup: new InlineKeyboard().text("View Maps", "show_maps")
  });
});

async function showMapsMenu(ctx: MyContext) {
  const { data: maps } = await supabase.from("maps").select("id, name").order("name");
  if (!maps) return ctx.reply("Database error fetching maps.");

  const keyboard = new InlineKeyboard();
  maps.forEach(m => {
    keyboard.text(`${m.name}`, `select_map_${m.id}`).row();
  });

  await ctx.reply("Select a map:", { reply_markup: keyboard });
}

bot.command("maps", showMapsMenu);

bot.command("mode", async (ctx) => {
  if (!ctx.session.activeMapId) {
    return ctx.reply("You need to select a map first! Type /maps to begin.");
  }

  const keyboard = new InlineKeyboard()
    .text("🎮 Play Game", "mode_game")
    .text("📖 Study Mode", "mode_display");

  await ctx.reply(`Current map: ${ctx.session.activeMapName}\n\nChange your mode:`, { reply_markup: keyboard });
});

bot.command("stats", async (ctx) => {
  const { data: maps } = await supabase.from("maps").select("id, name").order("name");
  if (!maps) return ctx.reply("Database error fetching maps.");

  const keyboard = new InlineKeyboard();
  maps.forEach(m => {
    keyboard.text(`📊 ${m.name}`, `stats_map_${m.id}`).row();
  });

  await ctx.reply("Select a map to view your stats:", { reply_markup: keyboard });
});
bot.command("geoguessr", async (ctx) => {
  // Create an inline button that acts as a web link
  const keyboard = new InlineKeyboard()
    .url("🌍 Play GeoGuessr", "https://www.geoguessr.com/");

  await ctx.reply("Ready to test your new meta knowledge in the wild?\n\nClick the button below to head over to the official GeoGuessr website and start playing!", { 
    reply_markup: keyboard 
  });
});
bot.command("leaderboard", async (ctx) => {
  const { data: stats, error } = await supabase.from("user_stats").select("user_id, username, status");
  
  if (error || !stats) return ctx.reply("Error fetching leaderboard data.");

  const scores: Record<string, { username: string, score: number, total: number }> = {};

  stats.forEach(s => {
    if (!scores[s.user_id]) {
      scores[s.user_id] = { username: s.username || "Anonymous Player", score: 0, total: 0 };
    } else if (s.username && scores[s.user_id].username === "Anonymous Player") {
      scores[s.user_id].username = s.username;
    }

    scores[s.user_id].total += 1;
    
    // 2 points for perfect, 1 point for partial
    if (s.status === "CORRECT") {
      scores[s.user_id].score += 2;
    } else if (s.status === "PARTIALLY_CORRECT") {
      scores[s.user_id].score += 1;
    }
  });

  const sortedLeaderboard = Object.values(scores)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); 

  if (sortedLeaderboard.length === 0) return ctx.reply("No one has played yet! Be the first to get on the board.");

  let lbMessage = "🏆 **GLOBAL LEADERBOARD (TOP 10)** 🏆\n━━━━━━━━━━━━━━━━━━\n\n";
  
  sortedLeaderboard.forEach((player, index) => {
    let medal = `${index + 1}.`;
    if (index === 0) medal = "🥇";
    if (index === 1) medal = "🥈";
    if (index === 2) medal = "🥉";

    lbMessage += `${medal} **${player.username}**\n↳ ${player.score} points (${player.total} guesses)\n\n`;
  });

  lbMessage += "━━━━━━━━━━━━━━━━━━\n";
  lbMessage += "_ℹ️ Scoring: 2 pts (Correct), 1 pt (Partially Correct)_";

  await ctx.reply(lbMessage, { parse_mode: "Markdown" });
});

// ---------------------------------------------------------------------------
// CALLBACK QUERIES
// ---------------------------------------------------------------------------
bot.callbackQuery("show_maps", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await showMapsMenu(ctx);
});

bot.callbackQuery(/stats_map_(.+)/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  
  const mapId = ctx.match[1];
  const userId = ctx.from.id;

  const { data: mapData } = await supabase.from("maps").select("name").eq("id", mapId).single();
  const mapName = mapData?.name || "Unknown Map";

  const { data: stats, error } = await supabase.from("user_stats")
    .select("status")
    .eq("user_id", userId)
    .eq("map_id", mapId)
    .order("created_at", { ascending: false });

  if (error || !stats) return ctx.reply("Error fetching your stats.");
  if (stats.length === 0) return ctx.editMessageText(`You haven't played **${mapName}** yet! Type /maps to start playing.`, { parse_mode: "Markdown" });

  const calculateBlock = (records: any[]) => {
    const total = records.length;
    const correct = records.filter(s => s.status === "CORRECT").length;
    const partial = records.filter(s => s.status === "PARTIALLY_CORRECT").length;
    const wrong = records.filter(s => s.status === "INCORRECT").length;
    const winRate = total > 0 ? Math.round((correct / total) * 100) : 0;
    return { total, correct, partial, wrong, winRate };
  };

  const allTime = calculateBlock(stats);
  const last100 = calculateBlock(stats.slice(0, 100)); 

  const statsMessage = `
📊 **Stats for ${mapName}**
━━━━━━━━━━━━━━━━━━
🌍 **ALL TIME**
🎯 Total Guesses: ${allTime.total}
✅ Correct: ${allTime.correct}
⚠️ Partially Correct: ${allTime.partial}
❌ Wrong: ${allTime.wrong}
📈 Win Rate (Pure Correct): ${allTime.winRate}%

🕒 **LAST 100 GUESSES**
🎯 Total Guesses: ${last100.total}
✅ Correct: ${last100.correct}
⚠️ Partially Correct: ${last100.partial}
❌ Wrong: ${last100.wrong}
📈 Win Rate (Pure Correct): ${last100.winRate}%
  `;

  await ctx.editMessageText(statsMessage, { parse_mode: "Markdown" });
});

bot.callbackQuery(/select_map_(.+)/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {}); 
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  
  const mapId = ctx.match[1];
  const { data: mapData } = await supabase.from("maps").select("name").eq("id", mapId).single();
  
  ctx.session.activeMapId = mapId;
  ctx.session.activeMapName = mapData?.name || "Unknown Map";
  ctx.session.seenClueIds = []; 
  
  const keyboard = new InlineKeyboard()
    .text("🎮 Play Game", "mode_game")
    .text("📖 Study Mode", "mode_display");

  await ctx.reply(`Map selected: ${ctx.session.activeMapName}\n\nHow would you like to proceed?`, { reply_markup: keyboard });
});

bot.callbackQuery(/mode_(game|display)/, async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  const selectedMode = ctx.match[1] as "game" | "display";
  ctx.session.mode = selectedMode;
  ctx.session.hasGuessed = false; 

  const mapId = ctx.session.activeMapId;
  if (!mapId) return ctx.reply("Session expired. Type /maps to start over.");

  const clue = await pullNextClue(mapId, ctx.session.seenClueIds);
  if (!clue) return ctx.reply("No clues found for this map.");
  
  ctx.session.currentClue = clue;
  ctx.session.seenClueIds.push(clue.id); 

  if (selectedMode === "game") {
    await ctx.reply("Game Mode started! Take a look at the image below and type your guess.");
    await sendSafePhoto(ctx, clue.image_url, "What is your guess?");
  } else {
    await ctx.reply("Study Mode started! Read the explanations below.");
    const caption = `Target: ${clue.location_slug}\n\nMeta: ${clue.explanation}`;
    const nextButton = new InlineKeyboard().text("Next Clue", "next_clue");
    await sendSafePhoto(ctx, clue.image_url, caption, nextButton);
  }
});

bot.callbackQuery("next_clue", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {}); 
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {}); 

  if (!ctx.session.activeMapId) return ctx.reply("No active game. Type /maps to start.");
  if (ctx.session.isProcessing) return;
  ctx.session.isProcessing = true;

  try {
    const nextClue = await pullNextClue(ctx.session.activeMapId, ctx.session.seenClueIds);
    
    if (nextClue) {
      ctx.session.currentClue = nextClue;
      ctx.session.seenClueIds.push(nextClue.id); 
      ctx.session.hasGuessed = false; 

      if (ctx.session.mode === "game") {
        await sendSafePhoto(ctx, nextClue.image_url, "What is your guess?");
      } else {
        const caption = `Target: ${nextClue.location_slug}\n\nMeta: ${nextClue.explanation}`;
        const nextButton = new InlineKeyboard().text("Next Clue", "next_clue");
        await sendSafePhoto(ctx, nextClue.image_url, caption, nextButton);
      }
    } else {
      ctx.session.activeMapId = null;
      ctx.session.currentClue = null;
      ctx.session.seenClueIds = [];
      ctx.session.mode = null;
      ctx.session.hasGuessed = false; 
      await ctx.reply("You have completed all clues on this map! Type /maps to play another.");
    }
  } finally {
    ctx.session.isProcessing = false;
  }
});

// ---------------------------------------------------------------------------
// MESSAGE HANDLER (GAME LOOP)
// ---------------------------------------------------------------------------
bot.on("message:text", async (ctx) => {
  const guess = ctx.message.text;

  if (guess.startsWith("/")) return ctx.reply("Command not recognized. Use /maps, /mode, /stats, or /leaderboard.");
  if (!ctx.session.activeMapId || !ctx.session.currentClue) return; 
  if (ctx.session.isProcessing) return;
  
  if (ctx.session.hasGuessed) {
    return ctx.reply("You already guessed this clue! Click **Next Clue** below the image to continue.", { parse_mode: "Markdown" });
  }

  ctx.session.isProcessing = true;
  ctx.session.hasGuessed = true; 

  try {
    let pendingMessage;
    
    if (ctx.session.mode === "display") {
      ctx.session.mode = "game";
      pendingMessage = await ctx.reply("🎮 *Switched to Game Mode!*\n\nEvaluating your guess...", { parse_mode: "Markdown" });
    } else {
      pendingMessage = await ctx.reply("Evaluating your guess...", { parse_mode: "Markdown" });
    }

    const targetAnswer = ctx.session.currentClue.location_slug;
    const explanation = ctx.session.currentClue.explanation;
    const apiKey = process.env.GEMINI_API_KEY!;
    
    const evaluation = await evaluateGuessWithGemini(guess, targetAnswer, explanation, apiKey);
    
    const playerName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "Anonymous";

    await supabase.from("user_stats").insert({
      user_id: ctx.from.id,
      username: playerName,
      map_id: ctx.session.activeMapId,
      guess_text: guess,
      status: evaluation.status
    });

    const keyboard = new InlineKeyboard().text("Next Clue", "next_clue");

    await ctx.api.editMessageText(ctx.chat.id, pendingMessage.message_id, evaluation.responseText, { 
      reply_markup: keyboard 
    });
  } finally {
    ctx.session.isProcessing = false;
  }
});

bot.catch((err) => console.error("Global bot error caught:", err.message));

bot.start({
  onStart: (botInfo) => console.log(`Grammy Game Engine running as @${botInfo.username}`),
  drop_pending_updates: true 
});

process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());