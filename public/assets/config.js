/**
 * Runtime configuration for the poll page.
 *
 * apiBase decides which backend the page talks to. Both backends expose the
 * same contract (GET poll, GET results, POST vote), so this is the only line
 * that changes between deployments:
 *
 *   ""                                          -> same origin, /api/*
 *                                                  (Node server or the C#
 *                                                   service behind a proxy)
 *   "https://<ref>.supabase.co/functions/v1"    -> Supabase Edge Functions
 *
 * Leave it empty when the page is served by the API itself. Point it at
 * Supabase when the page is on static hosting (Vercel) with no API alongside.
 */
window.KPOLLS_CONFIG = {
  apiBase: "https://lhjdwjwgttxzbyhooenp.supabase.co/functions/v1",

  // Supabase rejects anonymous calls to a project unless the publishable anon
  // key is present. Safe to ship - it is a public key, and every table is
  // locked behind row level security. Leave empty for the self-hosted backends.
  supabaseAnonKey: "",

  // Set to your AdSense publisher id ("ca-pub-...") to switch ads on. While it
  // still contains REPLACE_WITH, no ad script is loaded at all.
  adsenseClient: "ca-pub-REPLACE_WITH_YOUR_ADSENSE_ID",
  adsenseSlot: "REPLACE_WITH_AD_SLOT_ID",

  // How often the live tally refreshes, in seconds.
  refreshSeconds: 20,
};
