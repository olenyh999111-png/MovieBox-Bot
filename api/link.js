
import { createHash, randomBytes } from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  async function db(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set("apikey", supabaseKey);
    headers.set("Content-Type", "application/json");

    if (supabaseKey.startsWith("sb_secret_")) {
      headers.delete("Authorization");
    } else {
      headers.set("Authorization", `Bearer ${supabaseKey}`);
    }

    const response = await fetch(
      `${supabaseUrl}/rest/v1/${path}`,
      { ...options, headers }
    );

    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      console.error("Link API database error:", response.status, details);
      throw new Error("Database request failed");
    }

    if (response.status === 204) return null;

    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }

  try {
    const code = String(req.body?.code || "").trim();

    if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    const codeHash = createHash("sha256")
      .update(code)
      .digest("hex");

    const rows = await db(
      `moviebox_link_codes?code_hash=eq.${encodeURIComponent(codeHash)}&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id,telegram_id`
    );

    if (!rows?.length) {
      return res.status(400).json({
        error: "Invalid, expired, or already used code"
      });
    }

    const link = rows[0];
    const rawSession = randomBytes(32).toString("base64url");
    const sessionHash = createHash("sha256")
      .update(rawSession)
      .digest("hex");

    const updated = await db(
      `moviebox_link_codes?id=eq.${link.id}&used_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({ used_at: new Date().toISOString() })
      }
    );

    if (!updated?.length) {
      return res.status(409).json({
        error: "Code has already been used"
      });
    }

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    await db("moviebox_web_sessions", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        telegram_id: link.telegram_id,
        token_hash: sessionHash,
        expires_at: expiresAt
      })
    });

    return res.status(200).json({
      session: rawSession,
      expires_at: expiresAt
    });
  } catch (error) {
    console.error("Link API error:", error.message);
    return res.status(500).json({ error: "Could not link account" });
  }
}
