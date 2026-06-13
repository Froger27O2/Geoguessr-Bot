import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://pssiwhgluodipfrzfbzc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_xHSK5cxeo0N5hQgQdHNQKg_QyjnnIkE"
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth:{
        persistSession: false
    }
})