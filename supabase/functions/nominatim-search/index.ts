import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN");
const searchEndpoint = Deno.env.get("NOMINATIM_SEARCH_URL");

if (!supabaseUrl || !serviceRoleKey || !allowedOrigin || !searchEndpoint) {
  throw new Error(
    "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGIN, and NOMINATIM_SEARCH_URL are required."
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

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
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

  let query: unknown;
  try {
    ({ query } = await request.json());
  } catch {
    return jsonResponse({ error: "A JSON query is required." }, 400);
  }

  if (typeof query !== "string" || query.trim().length < 2 || query.trim().length > 200) {
    return jsonResponse({ error: "Query must be between 2 and 200 characters." }, 400);
  }

  const normalizedQuery = query.trim().replace(/\s+/g, " ");
  const { data: reservation, error: reservationError } = await supabase
    .rpc("reserve_nominatim_search", { p_query: normalizedQuery })
    .single();

  if (reservationError) {
    console.error("Could not reserve Nominatim search:", reservationError);
    return jsonResponse({ error: "Search service is unavailable." }, 503);
  }

  if (reservation.cache_hit) {
    return jsonResponse({ results: reservation.cached_results });
  }

  if (!reservation.request_allowed) {
    const retryAfterMs = Math.max(1, Number(reservation.retry_after_ms) || 1000);
    return jsonResponse(
      { error: "Search rate limit exceeded.", retryAfterMs },
      429,
      { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) }
    );
  }

  let upstreamResponse: Response;
  try {
    const url = new URL(searchEndpoint);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("accept-language", "ja");

    upstreamResponse = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": `TrafficReport/1.0 (+${allowedOrigin})`,
        "Referer": allowedOrigin
      },
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    console.error("Nominatim request failed:", error);
    return jsonResponse({ error: "Place search is temporarily unavailable." }, 502);
  }

  if (!upstreamResponse.ok) {
    console.error("Nominatim returned an error:", upstreamResponse.status);
    return jsonResponse({ error: "Place search is temporarily unavailable." }, 502);
  }

  let results: unknown;
  try {
    results = await upstreamResponse.json();
  } catch (error) {
    console.error("Nominatim returned invalid JSON:", error);
    return jsonResponse({ error: "Place search returned an invalid response." }, 502);
  }

  if (!Array.isArray(results)) {
    return jsonResponse({ error: "Place search returned an invalid response." }, 502);
  }

  const { error: cacheError } = await supabase
    .from("nominatim_search_cache")
    .upsert(
      {
        query_key: reservation.query_key,
        results,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
      },
      { onConflict: "query_key" }
    );

  if (cacheError) {
    console.error("Could not cache Nominatim results:", cacheError);
    return jsonResponse({ error: "Search results could not be cached." }, 503);
  }

  return jsonResponse({ results });
});
