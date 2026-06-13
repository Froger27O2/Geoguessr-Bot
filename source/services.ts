import { InputFile, InlineKeyboard } from "grammy";
import { Readable } from "stream";
import { supabase } from "./database.ts"; // Adjust path if using your old import
import { Clue, MyContext } from "./types.ts";

export async function pullNextClue(mapId: string, seenIds: string[]): Promise<Clue | null> {
  const { data: clues, error } = await supabase.from("metas").select("*").eq("map_id", mapId);
  if (error || !clues || clues.length === 0) return null;

  const unseenClues = clues.filter(clue => !seenIds.includes(clue.id));
  if (unseenClues.length === 0) return null;

  return unseenClues[Math.floor(Math.random() * unseenClues.length)] as Clue;
}

export async function evaluateGuessWithGemini(guess: string, target: string, explanation: string, apiKey: string): Promise<{ status: string, responseText: string }> {
  try {
    const prompt = `
         You are a precise, analytical GeoGuessr expert.
      The database target/slug is: "${target}". 
      The raw meta explanation is: "${explanation}".
      The user guessed: "${guess}".

      Your task:
      1. Evaluate the guess.
         - If they guessed the correct geographical location, they are CORRECT.
         - If the target is a specific region/state and they only guessed the country, they are PARTIALLY_CORRECT.
         - If they are completely geographically wrong, they are INCORRECT.
      2. Write a highly readable, structured, and direct response.
         - You MUST start your response with exactly one of these phrases in bold: **CORRECT**, **INCORRECT**, or **PARTIALLY CORRECT**.
         - Leave a blank line after the status.
         - State the true target location cleanly.
         - Rewrite the meta explanation. CRITICAL RULE: The user can ONLY see the street view. They CANNOT see maps or secondary images. Intelligently rewrite the sentence to explicitly name the location instead.
         - DO NOT be reassuring, encouraging, or conversational. Be completely objective, blunt, and strictly analytical.
         - NEVER use emojis under any circumstances.

      Reply strictly with a JSON object in this format:
      {"status": "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT", "message": "Your formatted response here"}
    `;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, responseMimeType: "application/json" } 
      })
    });

    const data = await response.json();
    const textResult = data.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(textResult);
    
    return { status: parsed.status, responseText: parsed.message };
  } catch (error) {
    console.error("Gemini API error:", error);
    const fallbackCorrect = guess.toLowerCase().includes(target.split('-')[0].toLowerCase());
    const fallbackStatus = fallbackCorrect ? "CORRECT" : "INCORRECT";
    const fallbackText = `**${fallbackStatus}**\n\nThe target was ${target}. ${explanation}`;
    return { status: fallbackStatus, responseText: fallbackText };
  }
}

export async function sendSafePhoto(ctx: MyContext, url: string, caption: string, keyboard?: InlineKeyboard) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const stream = Readable.fromWeb(response.body as any);

    await ctx.replyWithPhoto(new InputFile(stream), { 
      caption: caption,
      reply_markup: keyboard 
    });
    
  } catch (err) {
    console.error("Failed to stream photo:", err);
    await ctx.reply(`Image failed to load directly. Here is the link: ${url}\n\n${caption}`, {
      reply_markup: keyboard
    });
  }
}