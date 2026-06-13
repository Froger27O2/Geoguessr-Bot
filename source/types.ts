import { Context, SessionFlavor } from "grammy";

export interface Clue {
  id: string;
  map_id: string;
  location_slug: string;
  explanation: string;
  image_url: string;
}

export interface GameSession {
  activeMapId: string | null;
  activeMapName: string | null;
  currentClue: Clue | null; 
  seenClueIds: string[]; 
  mode: "game" | "display" | null; 
  isProcessing: boolean; 
  hasGuessed: boolean; 
}

export type MyContext = Context & SessionFlavor<GameSession>;