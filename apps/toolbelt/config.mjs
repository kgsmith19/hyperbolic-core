// Not secret: the anon key is designed for client-side exposure (RLS is the
// actual boundary). Safe to commit; see SR-010 in docs/SYSTEM-REQUIREMENTS.md
// for the rule about the service-role key, which never appears here.
export const SUPABASE_URL = "https://woltgcggxaehtuypkxqk.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndvbHRnY2dneGFlaHR1eXBreHFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYwNTc1NTYsImV4cCI6MjEwMTYzMzU1Nn0.URuTQDA10GEiQUo82pyQPj3UgwvPKcg9Mjvz57v2Fv4";
