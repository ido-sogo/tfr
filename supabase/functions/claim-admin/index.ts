import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN");
const adminSetupPassword = Deno.env.get("ADMIN_SETUP_PASSWORD");

if (!supabaseUrl || !serviceRoleKey || !allowedOrigin || !adminSetupPassword) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN, and ADMIN_SETUP_PASSWORD are required."
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin"
};

function jsonResponse(body: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function passwordsMatch(candidate: string, expected: string) {
  const encoder = new TextEncoder();
  const candidateBytes = encoder.encode(candidate);
  const expectedBytes = encoder.encode(expected);
  let difference = candidateBytes.length ^ expectedBytes.length;
  const length = Math.max(candidateBytes.length, expectedBytes.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (candidateBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }

  return difference === 0;
}

Deno.serve(async (request) => {
  const origin = request.headers.get("Origin");
  if (origin !== allowedOrigin) {
    return jsonResponse({ error: "Origin is not allowed." }, 403);
  }

  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const authorization = request.headers.get("Authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    return jsonResponse({ error: "Sign in before administrator verification." }, 401);
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return jsonResponse({ error: "A valid signed-in account is required." }, 401);
  }

  let password: unknown;
  try {
    ({ password } = await request.json());
  } catch {
    return jsonResponse({ error: "A JSON password is required." }, 400);
  }

  if (typeof password !== "string" || password.length === 0 || password.length > 256) {
    return jsonResponse({ error: "A valid administrator password is required." }, 400);
  }

  const { data: allowed, error: rateLimitError } = await supabase.rpc(
    "reserve_traffic_report_admin_attempt",
    { p_user_id: userData.user.id }
  );

  if (rateLimitError) {
    console.error("Could not reserve administrator verification attempt:", rateLimitError);
    return jsonResponse({ error: "Administrator verification is unavailable." }, 503);
  }

  if (allowed !== true) {
    return jsonResponse({ error: "Too many attempts. Try again in one hour." }, 429);
  }

  if (!passwordsMatch(password, adminSetupPassword)) {
    return jsonResponse({ error: "Administrator password is incorrect." }, 403);
  }

  const { error: grantError } = await supabase
    .from("traffic_report_admins")
    .upsert({ user_id: userData.user.id }, { onConflict: "user_id", ignoreDuplicates: true });

  if (grantError) {
    console.error("Could not grant administrator access:", grantError);
    return jsonResponse({ error: "Administrator access could not be granted." }, 503);
  }

  return jsonResponse({ message: "Administrator access granted." });
});
