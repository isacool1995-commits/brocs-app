// Replaces the Claude-artifact "window.storage" API with a real, shared
// database (Supabase) so the app works across different phones/browsers.
//
// Setup required (see README.md):
//   1. Create a free project at https://supabase.com
//   2. Run the SQL from supabase.sql in the Supabase SQL editor
//   3. Put your project URL + anon key into a .env file (see .env.example)

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error(
    "Не заданы VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — создайте файл .env по образцу .env.example"
  );
}

const supabase = createClient(supabaseUrl || "", supabaseKey || "");

async function get(key) {
  const { data, error } = await supabase
    .from("kv_store")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  return { key, value: data.value };
}

async function set(key, value) {
  const { error } = await supabase
    .from("kv_store")
    .upsert({ key, value }, { onConflict: "key" });
  if (error) {
    console.error("storage.set error:", error);
    return null;
  }
  return { key, value };
}

async function del(key) {
  const { error } = await supabase.from("kv_store").delete().eq("key", key);
  if (error) return null;
  return { key, deleted: true };
}

async function list(prefix) {
  let query = supabase.from("kv_store").select("key");
  if (prefix) query = query.like("key", `${prefix}%`);
  const { data, error } = await query;
  if (error || !data) return null;
  return { keys: data.map((row) => row.key), prefix };
}

// The app's code calls window.storage.get(key, shared) etc. — the "shared"
// flag from the Claude-artifact API is ignored here because every key in
// this database is already shared across everyone using the app.
window.storage = {
  get: (key) => get(key),
  set: (key, value) => set(key, value),
  delete: (key) => del(key),
  list: (prefix) => list(prefix),
};
