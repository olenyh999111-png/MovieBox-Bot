export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const query = String(req.query.q || "").trim();
  const language = req.query.language === "uk-UA"
    ? "uk-UA"
    : "ru-RU";

  if (!query) {
    return res.status(400).json({
      error: "Введите название фильма"
    });
  }

  if (query.length > 100) {
    return res.status(400).json({
      error: "Слишком длинный запрос"
    });
  }

  const apiKey = process.env.TMDB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "TMDB API key is not configured"
    });
  }

  try {
    const url = new URL(
      "https://api.themoviedb.org/3/search/movie"
    );

    url.searchParams.set("api_key", apiKey);
    url.searchParams.set("query", query);
    url.searchParams.set("language", language);
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("page", "1");

    const response = await fetch(url);

    if (!response.ok) {
      return res.status(502).json({
        error: "Не удалось получить фильмы из TMDB"
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
          ? "https://image.tmdb.org/t/p/w500" +
            movie.poster_path
          : null
      }))
    });
  } catch {
    return res.status(500).json({
      error: "Ошибка поиска фильмов"
    });
  }
}
