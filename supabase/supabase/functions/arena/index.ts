
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-arena-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const encoder = new TextEncoder();

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const fail = (message: string, status = 400) =>
  json({ error: message }, status);

const toBase64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes));

const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), c => c.charCodeAt(0));

const randomBytes = (length: number) =>
  crypto.getRandomValues(new Uint8Array(length));

const randomCode = (length = 10) => {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(
    randomBytes(length),
    c => chars[c % chars.length]
  ).join("");
};

async function deriveCodeHash(code: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(code),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromBase64(salt),
      iterations: 150000,
      hash: "SHA-256",
    },
    key,
    256
  );

  return toBase64(new Uint8Array(bits));
}

async function makePasswordRecord(code: string) {
  const salt = toBase64(randomBytes(16));
  return {
    salt,
    hash: await deriveCodeHash(code, salt),
  };
}

function constantTimeEqual(a: string, b: string) {
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);

  if (aa.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa[i] ^ bb[i];
  }

  return diff === 0;
}

async function signToken(payload: Record<string, unknown>, secret: string) {
  const body = toBase64(
    encoder.encode(JSON.stringify(payload))
  );

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body)
  );

  return `${body}.${toBase64(new Uint8Array(signature))}`;
}

async function verifyToken(token: string, secret: string) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [body, signature] = parts;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64(signature),
    encoder.encode(body)
  );

  if (!valid) return null;

  const payload = JSON.parse(
    new TextDecoder().decode(fromBase64(body))
  );

  if (payload.exp < Date.now()) return null;

  return payload;
}

const service = () => {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !key) {
    throw new Error("Missing Supabase server environment variables");
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};

async function getSession(req: Request) {
  const secret = Deno.env.get("ARENA_TOKEN_SECRET");
  if (!secret) throw new Error("Missing ARENA_TOKEN_SECRET");

  const token = req.headers.get("x-arena-token");
  if (!token) return null;

  return await verifyToken(token, secret);
}

async function handle(req: Request) {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return fail("Method not allowed", 405);
  }

  try {
    const body = await req.json();
    const action = body.action;

    const db = service();

    if (action === "bootstrap") {
      const setupKey = Deno.env.get("ARENA_SETUP_KEY");

      if (
        !setupKey ||
        !constantTimeEqual(
          String(body.setup_key || ""),
          setupKey
        )
      ) {
        return fail("Invalid setup key", 401);
      }

      const { data: existing } = await db
        .from("arena_matches")
        .select("id")
        .limit(1);

      if (existing && existing.length > 0) {
        return fail("Arena has already been initialized", 409);
      }

      const hostCode = randomCode(14);
      const slug = "coca-cola-arena";

      const hostRecord = await makePasswordRecord(hostCode);

      const teams = [];

      for (let i = 1; i <= 10; i++) {
        const code = randomCode(10);
        const record = await makePasswordRecord(code);

        teams.push({
          team_number: i,
          display_name: `الفوج ${String(i).padStart(2, "0")}`,
          code,
          code_salt: record.salt,
          code_hash: record.hash,
        });
      }

      const { data: matchId, error } = await db.rpc(
        "arena_bootstrap",
        {
          p_slug: slug,
          p_title: "Coca-Cola Quiz Arena",
          p_host_salt: hostRecord.salt,
          p_host_hash: hostRecord.hash,
          p_teams: teams.map(t => ({
            team_number: t.team_number,
            display_name: t.display_name,
            code_salt: t.code_salt,
            code_hash: t.code_hash,
          })),
        }
      );

      if (error) throw error;

      return json({
        success: true,
        match_id: matchId,
        host_code: hostCode,
        teams: teams.map(t => ({
          team_number: t.team_number,
          display_name: t.display_name,
          code: t.code,
        })),
      });
    }

    if (action === "login") {
      const role = body.role;
      const code = String(body.code || "").trim().toUpperCase();

      if (!code) return fail("Enter access code");

      const { data: matches, error } = await db
        .from("arena_matches")
        .select("*")
        .limit(1);

      if (error) throw error;
      const match = matches?.[0];

      if (!match) return fail("Arena is not initialized", 404);

      let identity: Record<string, unknown>;

      if (role === "host") {
        const hash = await deriveCodeHash(code, match.host_code_salt);

        if (!constantTimeEqual(hash, match.host_code_hash)) {
          return fail("Invalid host code", 401);
        }

        identity = {
          role: "host",
          match_id: match.id,
        };
      } else {
        const teamNumber = Number(body.team_number);

        const { data: team, error: teamError } = await db
          .from("arena_teams")
          .select("*")
          .eq("match_id", match.id)
          .eq("team_number", teamNumber)
          .maybeSingle();

        if (teamError) throw teamError;
        if (!team) return fail("Team not found", 404);

        const hash = await deriveCodeHash(code, team.code_salt);

        if (!constantTimeEqual(hash, team.code_hash)) {
          return fail("Invalid team code", 401);
        }

        identity = {
          role: "team",
          match_id: match.id,
          team_id: team.id,
          team_number: team.team_number,
        };
      }

      const secret = Deno.env.get("ARENA_TOKEN_SECRET");
      if (!secret) throw new Error("Missing token secret");

      const token = await signToken(
        {
          ...identity,
          exp: Date.now() + 8 * 60 * 60 * 1000,
        },
        secret
      );

      return json({
        success: true,
        token,
        identity,
      });
    }

    const session = await getSession(req);

    if (!session) {
      return fail("Invalid or expired session", 401);
    }

    const matchId = session.match_id;

    if (action === "state") {
      const { data: match, error } = await db
        .from("arena_matches")
        .select("*")
        .eq("id", matchId)
        .single();

      if (error) throw error;

      const { data: teams, error: teamsError } = await db
        .from("arena_teams")
        .select("id,team_number,display_name,score")
        .eq("match_id", matchId)
        .order("team_number");

      if (teamsError) throw teamsError;

      let question = null;
      let queue = [];

      if (match.current_question_id) {
        const { data: q, error: qError } = await db
          .from("arena_questions")
          .select("id,question_order,prompt,options")
          .eq("id", match.current_question_id)
          .single();

        if (qError) throw qError;
        question = q;

        const { data: rows, error: queueError } = await db
          .from("arena_buzz_queue")
          .select("id,team_id,pressed_at,answered_at,result")
          .eq("question_id", match.current_question_id)
          .order("id");

        if (queueError) throw queueError;
        queue = rows || [];
      }

      const team = session.role === "team"
        ? teams.find(t => t.id === session.team_id)
        : null;

      return json({
        match,
        teams,
        question,
        queue,
        me: team,
        role: session.role,
      });
    }

    if (session.role !== "host" && [
      "start_question",
      "finish",
      "reset",
    ].includes(action)) {
      return fail("Host access required", 403);
    }

    if (action === "start_question") {
      const { data, error } = await db.rpc(
        "arena_start_question",
        {
          p_match_id: matchId,
          p_prompt: String(body.prompt || ""),
          p_options: body.options,
          p_correct_option: Number(body.correct_option),
        }
      );

      if (error) throw error;
      return json({ success: true, result: data });
    }

    if (action === "buzz") {
      if (session.role !== "team") {
        return fail("Team access required", 403);
      }

      const { error } = await db.rpc("arena_register_buzz", {
        p_match_id: matchId,
        p_team_id: session.team_id,
      });

      if (error) throw error;
      return json({ success: true });
    }

    if (action === "answer") {
      if (session.role !== "team") {
        return fail("Team access required", 403);
      }

      const { data, error } = await db.rpc(
        "arena_submit_answer",
        {
          p_match_id: matchId,
          p_team_id: session.team_id,
          p_option: Number(body.option),
        }
      );

      if (error) throw error;
      return json({ success: true, result: data });
    }

    if (action === "finish") {
      const { error } = await db
        .from("arena_matches")
        .update({
          status: "finished",
          updated_at: new Date().toISOString(),
        })
        .eq("id", matchId);

      if (error) throw error;
      return json({ success: true });
    }

    if (action === "reset") {
      const { error: queueError } = await db
        .from("arena_buzz_queue")
        .delete()
        .eq("match_id", matchId);

      if (queueError) throw queueError;

      const { error: teamsError } = await db
        .from("arena_teams")
        .update({ score: 0 })
        .eq("match_id", matchId);

      if (teamsError) throw teamsError;

      const { error: matchError } = await db
        .from("arena_matches")
        .update({
          status: "lobby",
          current_question_id: null,
          countdown_ends_at: null,
          buzz_open_until: null,
          answer_deadline: null,
          active_queue_id: null,
          round_number: 1,
          fill_percent: 0,
          updated_at: new Date().toISOString(),
        })
        .eq("id", matchId);

      if (matchError) throw matchError;
      return json({ success: true });
    }

    return fail("Unknown action", 400);
  } catch (error) {
    console.error("Arena function error:", error);
    return fail(
      error instanceof Error ? error.message : "Unexpected server error",
      500
    );
  }
}

Deno.serve(handle);
