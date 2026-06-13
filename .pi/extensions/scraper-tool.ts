import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
// @ts-ignore - Suppress ESM relative extension check for local agent runtime compatibility
import { supabase } from "../services/supabase";

// 🧼 Reusable text utility to scrub HTML tags and fix unicode strings
function cleanText(text: string): string {
  let cleaned = text.replace(/\\u003C/g, '<').replace(/\\"/g, '"');
  cleaned = cleaned.replace(/<[^>]+>/g, '');
  return cleaned.trim();
}

export default function (pi: any) {
  
  pi.registerTool({
    name: "get_scraper_instructions",
    description: "Reads the geographic classification rules from the hidden SCRAPER.md specification file so the agent understands how to sort country and region metas.",
    parameters: Type.Object({}),
    execute: async (_toolCallId: string, _params: any) => {
      try {
        const pathToRules = new URL("./SCRAPER.md", import.meta.url).pathname;
        const cleanPath = pathToRules.startsWith('/') && process.platform === 'win32' 
          ? pathToRules.slice(1) 
          : pathToRules;

        if (!fs.existsSync(cleanPath)) {
          return { content: [{ type: "text", text: "ERROR: SCRAPER.md could not be found." }] };
        }
        const rules = fs.readFileSync(cleanPath, "utf8");
        return { content: [{ type: "text", text: rules }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Failed to read rules file: ${err.message}` }] };
      }
    }
  });

  pi.registerTool({
    name: "extract_raw_metas_from_url",
    description: "Fetches a learnablemeta.com map page, extracts raw location clue chunks using regular expressions, and returns them for classification.",
    parameters: Type.Object({
      mapId: Type.String({ description: "The unique ID from the learnablemeta URL (e.g., '66fda2e27e08dc03b5bb3d6e')" })
    }),
    execute: async (_toolCallId: string, params: { mapId: string }) => {
      try {
        const mapUrl = `https://learnablemeta.com/maps/${params.mapId}`;
        const htmlRes = await fetch(mapUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await htmlRes.text();

        let rawJsData: string | null = html.includes("metaList:") ? html : null;

        if (!rawJsData) {
          const matches = [...html.matchAll(/(?:href|src)=['"]([^'"]+\.js)['"]/g)]
            .map(m => m[1])
            .filter((val): val is string => typeof val === "string");

          const jsLinks = [...new Set(matches)].map(l => 
            l.startsWith('http') ? l : new URL(l, "https://learnablemeta.com").href
          );

          for (const link of jsLinks) {
            if (!link) continue;
            const jsContent = await (await fetch(link, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
            if (jsContent.includes("metaList:")) { 
              rawJsData = jsContent; 
              break; 
            }
          }
        }

        if (!rawJsData) {
          return { content: [{ type: "text", text: "ERROR: Could not locate the 'metaList:' data pool inside page sources." }] };
        }

        const chunks = rawJsData.split('name:').slice(1);
        const extractedMetas = [];

        for (const chunk of chunks) {
          const nameMatch = chunk.match(/\s*"([^"]+)"/);
          const noteMatch = chunk.match(/note:\s*"(.*?)"\s*,/s);
          const imgMatch = chunk.match(/images:\s*\[\s*"([^"]+)"/);
          
          if (nameMatch?.[1] && imgMatch?.[1]) {
            const originalImgPath = imgMatch[1];
            const absoluteImgUrl = originalImgPath.startsWith('http') 
              ? originalImgPath 
              : new URL(originalImgPath, "https://learnablemeta.com").href;

            extractedMetas.push({
              name: nameMatch[1].replace(/[\\/*?:"<>|]/g, "").trim(),
              explanation: cleanText(noteMatch?.[1] ? noteMatch[1] : "No explanation."),
              sourceImageUrl: absoluteImgUrl
            });
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify(extractedMetas) }]
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Scraper Fetch Error: ${err.message}` }] };
      }
    }
  });

  pi.registerTool({
    name: "save_scraped_meta_clue",
    description: "Takes an AI-classified location clue, streams its image to Supabase storage, and saves its relational data into Postgres tables.",
    parameters: Type.Object({
      mapName: Type.String({ description: "The plain name of the map target (e.g., 'Learnable Russia')" }),
      locationName: Type.String({ description: "The raw clean name of the location clue" }),
      category: Type.Union([Type.Literal("Country-Metas"), Type.Literal("Region-Metas")]),
      sourceImageUrl: Type.String({ description: "The absolute source web link of the asset image" }),
      explanation: Type.String({ description: "The parsed descriptive explanation content string" })
    }),
    execute: async (_toolCallId: string, params: any) => {
      try {
        const { data: mapData, error: mapErr } = await supabase
          .from("maps")
          .upsert({ name: params.mapName }, { onConflict: "name" })
          .select()
          .single();
          
        if (mapErr) throw mapErr;

        const locationSlug = params.locationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
        const bucketFolder = params.mapName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        const cloudFilePath = `${bucketFolder}/${locationSlug}.jpg`;

        const imgRes = await fetch(params.sourceImageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!imgRes.ok) throw new Error(`Image fetch failed: ${imgRes.statusText}`);
        
        const arrayBuffer = await imgRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const { error: uploadErr } = await supabase.storage
          .from("geoguessr-assets")
          .upload(cloudFilePath, buffer, {
            contentType: "image/jpeg",
            upsert: true
          });

        if (uploadErr) throw uploadErr;

        const { data: urlData } = supabase.storage
          .from("geoguessr-assets")
          .getPublicUrl(cloudFilePath);

        const { error: metaErr } = await supabase
          .from("metas")
          .upsert({
            map_id: mapData.id,
            location_slug: locationSlug,
            category: params.category,
            image_url: urlData.publicUrl,
            explanation: params.explanation
          }, { onConflict: "map_id,location_slug" });

        if (metaErr) throw metaErr;

        return { content: [{ type: "text", text: `SUCCESS: Processed and hosted clue [${params.locationName}] under ${params.category}` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Database Commit Failure [${params.locationName}]: ${err.message}` }] };
      }
    }
  });
}