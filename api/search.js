
import { createHash } from "node:crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Vary", "Cookie");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const query = String(req.query.q || "").trim();
  const language = req.query.language === "uk-UA" ? "uk-UA" : "ru-RU";

  if (query.length > 100) {
    return res.status(400).json({ error: "Слишком длинный запрос" });
  }

  const tmdbKey = process.env.TMDB_API_KEY;
  if (!tmdbKey) {
    return res.status(500).json({ error: "Server configuration error" });
  }

  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  async function db(path, options = {}) {
    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase configuration is missing");
    }

    const headers = new Headers(options.headers || {});
    headers.set("apikey", supabaseKey);
    headers.set("Content-Type", "application/json");

    if (supabaseKey.startsWith("sb_secret_")) {
      headers.delete("Authorization");
    } else {
      headers.set("Authorization", `Bearer ${supabaseKey}`);
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers
    });

    if (!response.ok) {
      console.error(
        "Search database error:",
        response.status,
        (await response.text()).slice(0, 300)
      );
      throw new Error("Database request failed");
    }

    if (response.status === 204) return null;

    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }

  try {
    // No query means the homepage's popular collection.
    // Loading it must not consume a search.
    const url = new URL(
      query
        ? "https://api.themoviedb.org/3/search/movie"
        : "https://api.themoviedb.org/3/movie/popular"
    );

    url.searchParams.set("api_key", tmdbKey);
    url.searchParams.set("language", language);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("page", "1");

    if (!query) {
      const response = await fetch(url);

      if (!response.ok) {
        console.error("TMDB popular endpoint status:", response.status);
        return res.status(502).json({
          error: "Не удалось загрузить популярные фильмы"
        });
      }

      const data = await response.json();

      return res.status(200).json({
        results: (data.results || []).map(movie => ({
          id: movie.id,
          title: movie.title,
          original_title: movie.original_title,
          year: movie.release_date
            ? movie.release_date.slice(0, 4)
            : null,
          overview: movie.overview,
          poster: movie.poster_path
            ? "https://image.tmdb.org/t/p/w500" + movie.poster_path
            : null
        }))
      });
    }

    // A real search requires a valid Telegram-linked session.
    const cookieHeader = req.headers.cookie || "";
    const sessionCookie = cookieHeader
      .split(";")
      .map(part => part.trim())
      .find(part => part.startsWith("moviebox_session="));

    const sessionToken = sessionCookie
      ? sessionCookie.slice("moviebox_session=".length)
      : "";

    if (!/^[A-Za-z0-9_-]{40,100}$/.test(sessionToken)) {
      return res.status(401).json({
        error: "Сначала подключи Telegram через команду /link."
      });
    }

    const tokenHash = createHash("sha256")
      .update(sessionToken)
      .digest("hex");

    const now = new Date().toISOString();

    const sessions = await db(
      "moviebox_web_sessions" +
      `?token_hash=eq.${tokenHash}` +
      "&revoked_at=is.null" +
      `&expires_at=gt.${encodeURIComponent(now)}` +
      "&select=telegram_id&limit=1"
    );

    if (!sessions?.length || !sessions[0].telegram_id) {
      return res.status(401).json({
        error: "Сессия истекла. Отправь /link боту и подключи аккаунт снова."
      });
    }

    const telegramId = String(sessions[0].telegram_id);

    // Consume exactly one search through the database function.
    const limitResult = await db("rpc/consume_moviebox_search", {
      method: "POST",
      body: JSON.stringify({ p_telegram_id: telegramId })
    });

    if (!limitResult || limitResult.allowed !== true) {
      return res.status(429).json({
        error: "Лимит поисков исчерпан.",
        tier: limitResult?.tier || "free",
        limit: limitResult?.limit ?? 5,
        used: limitResult?.used ?? 0,
        remaining: 0
      });
    }

    url.searchParams.set("query", query);

    const response = await fetch(url);

    if (!response.ok) {
      console.error("TMDB search endpoint status:", response.status);
      return res.status(502).json({
        error: "Не удалось получить фильмы из TMDB"
      });
    }

    const data = await response.json();

    return res.status(200).json({
      tier: limitResult.tier,
      limit: limitResult.limit,
      used: limitResult.used,
      remaining: Math.max(0, limitResult.limit - limitResult.used),
      results: (data.results || []).map(movie => ({
        id: movie.id,
        title: movie.title,
        original_title: movie.original_title,
        year: movie.release_date
          ? movie.release_date.slice(0, 4)
          : null,
        overview: movie.overview,
        poster: movie.poster_path
          ? "https://image.tmdb.org/t/p/w500" + movie.poster_path
          : null
      }))
    });
  } catch (error) {
    console.error("Search API error:", error.message);
    return res.status(500).json({
      error: "Ошибка поиска фильмов"
    });
  }
}
