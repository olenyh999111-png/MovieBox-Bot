
import { randomBytes, createHash } from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const adminId = process.env.ADMIN_TELEGRAM_ID;
  const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const tmdbKey = process.env.TMDB_API_KEY;

  if (!token || !secret || !adminId || !supabaseUrl || !supabaseKey) {
    console.error("Missing required environment variable");
    return res.status(500).json({ error: "Server configuration error" });
  }

  if (req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const update = req.body || {};
  const preCheckoutQuery = update.pre_checkout_query;
  const message = update.message;
  const chatId = message?.chat?.id;
  const rawSenderId = message?.from?.id ?? preCheckoutQuery?.from?.id;

  if (!rawSenderId) {
    return res.status(200).json({ ok: true });
  }

  const senderId = String(rawSenderId);
  const text = (message?.text || "").trim();
  const isAdmin = senderId === String(adminId);

  async function telegram(method, body) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }
    );

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.ok) {
      console.error(`Telegram ${method} failed:`, response.status);
      throw new Error(`Telegram ${method} request failed`);
    }

    return result;
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

    const response = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...options,
      headers
    });

    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      console.error("Supabase request failed:", response.status, details);
      throw new Error(`Supabase request failed (${response.status})`);
    }

    if (response.status === 204) return null;

    const result = await response.text();
    return result ? JSON.parse(result) : null;
  }

  // Подтверждаем предварительную проверку счёта Telegram Stars.
  if (preCheckoutQuery) {
    let approved = false;
    const validationError =
      "Не удалось проверить заказ. Вернитесь в MovieBox и создайте новый счёт.";

    try {
      const queryId = preCheckoutQuery.id;
      const payload = preCheckoutQuery.invoice_payload;

      if (queryId && payload && preCheckoutQuery.from?.id) {
        const rows = await db(
          `moviebox_star_orders?invoice_payload=eq.${encodeURIComponent(payload)}&select=invoice_payload,telegram_id,plan,stars_amount,currency,duration_days,status`
        );
        const order = Array.isArray(rows) ? rows[0] : null;

        approved = Boolean(
          order &&
          String(order.telegram_id) === String(preCheckoutQuery.from.id) &&
          order.status === "pending" &&
          ["premium", "vip"].includes(order.plan) &&
          Number(order.duration_days) === 30 &&
          order.currency === "XTR" &&
          Number(order.stars_amount) === Number(preCheckoutQuery.total_amount) &&
          preCheckoutQuery.currency === "XTR"
        );
      }

      await telegram("answerPreCheckoutQuery", {
        pre_checkout_query_id: preCheckoutQuery.id,
        ok: approved,
        ...(approved ? {} : { error_message: validationError })
      });

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error(
        "MovieBox pre-checkout validation failed:",
        error.message
      );

      try {
        if (preCheckoutQuery.id) {
          await telegram("answerPreCheckoutQuery", {
            pre_checkout_query_id: preCheckoutQuery.id,
            ok: false,
            error_message: validationError
          });
        }
      } catch (answerError) {
        console.error(
          "Could not answer Telegram pre-checkout:",
          answerError.message
        );
      }

      return res.status(200).json({ ok: true });
    }
  }

  async function reply(value) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: value,
      disable_web_page_preview: true
    });
  }

  async function getUser(telegramId = senderId) {
    const rows = await db(
      `moviebox_users?telegram_id=eq.${encodeURIComponent(telegramId)}&select=*`
    );

    if (rows.length) return rows[0];

    const created = await db("moviebox_users", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        telegram_id: telegramId,
        free_searches_used: 0,
        daily_searches_used: 0
      })
    });

    if (!created?.length) {
      throw new Error("User creation returned no row");
    }

    return created[0];
  }

  async function grant(telegramId, tier, days) {
    if (!["premium", "vip"].includes(tier)) {
      throw new Error("Invalid subscription tier");
    }

    if (![7, 14, 30, 365].includes(days)) {
      throw new Error("Invalid subscription duration");
    }

    const user = await getUser(telegramId);
    const column = tier === "premium" ? "premium_until" : "vip_until";
    const existing = user[column] ? new Date(user[column]) : new Date();
    const now = new Date();
    const start = existing > now ? existing : now;

    start.setUTCDate(start.getUTCDate() + days);

    await db(
      `moviebox_users?telegram_id=eq.${encodeURIComponent(telegramId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ [column]: start.toISOString() })
      }
    );

    return start;
  }

  async function searchMovies(searchQuery) {
    if (!tmdbKey) {
      await reply("Поиск временно недоступен. Попробуй позже.");
      return;
    }

    const limitResult = await db("rpc/consume_moviebox_search", {
      method: "POST",
      body: JSON.stringify({ p_telegram_id: senderId })
    });

    if (!limitResult || limitResult.allowed !== true) {
      await reply(
        "⛔ Лимит поисков исчерпан.\n\n" +
        `Тариф: ${(limitResult?.tier || "free").toUpperCase()}\n` +
        `Использовано: ${limitResult?.used ?? 0} из ${limitResult?.limit ?? 5}.`
      );
      return;
    }

    const url = new URL("https://api.themoviedb.org/3/search/movie");
    url.searchParams.set("api_key", tmdbKey);
    url.searchParams.set("language", "ru-RU");
    url.searchParams.set("include_adult", "false");
    url.searchParams.set("page", "1");
    url.searchParams.set("query", searchQuery);

    const response = await fetch(url);

    if (!response.ok) {
      console.error("TMDB search failed:", response.status);
      await reply("Не удалось получить фильмы. Попробуй позже.");
      return;
    }

    const data = await response.json();
    const movies = (data.results || []).slice(0, 5);

    if (!movies.length) {
      await reply(
        `По запросу «${searchQuery}» ничего не найдено.\n` +
        "Учти: поисковая попытка уже учтена в лимите."
      );
      return;
    }

    const lines = movies.map((movie, index) => {
      const year = movie.release_date
        ? movie.release_date.slice(0, 4)
        : "год неизвестен";

      const overview = String(movie.overview || "")
        .replace(/\s+/g, " ")
        .slice(0, 300);

      const poster = movie.poster_path
        ? "\nПостер: https://image.tmdb.org/t/p/w500" + movie.poster_path
        : "";

      return (
        `${index + 1}. ${movie.title || "Без названия"} (${year})` +
        (overview ? `\n${overview}` : "") +
        poster
      );
    });

    await reply(
      `🎬 Результаты: ${searchQuery}\n` +
      `Тариф: ${(limitResult.tier || "free").toUpperCase()}\n` +
      `Использовано: ${limitResult.used}/${limitResult.limit}; ` +
      `осталось ${Math.max(0, limitResult.limit - limitResult.used)}.\n\n` +
      lines.join("\n\n")
    );
  }

  try {
    // Только successful_payment подтверждает завершённый платёж.
    if (message?.successful_payment) {
      const payment = message.successful_payment;
      const payload = payment.invoice_payload;
      const chargeId = payment.telegram_payment_charge_id;

      try {
        if (!payload || !chargeId || !message.from?.id || !chatId) {
          throw new Error("Successful payment update is missing required fields");
        }

        const rows = await db(
          `moviebox_star_orders?invoice_payload=eq.${encodeURIComponent(payload)}&select=*`
        );
        const order = Array.isArray(rows) ? rows[0] : null;

        if (!order) {
          console.error("Paid Telegram invoice has no matching MovieBox order");

          await telegram("sendMessage", {
            chat_id: adminId,
            text:
              "⚠️ MovieBox: подтверждён платёж Stars, но заказ не найден.\n" +
              `Telegram ID: ${senderId}\n` +
              `Payload: ${String(payload).slice(0, 120)}\n` +
              `Charge ID: ${String(chargeId).slice(0, 120)}`
          });

          await reply(
            "Telegram сообщил об оплате, но заказ не удалось найти автоматически. " +
            "Не оплачивай повторно. Напиши /paysupport для помощи."
          );

          return res.status(200).json({ ok: true });
        }

        const sameAlreadyPaidCharge =
          order.status === "paid" &&
          order.telegram_payment_charge_id === chargeId;

        const statusCanBeProcessed =
          order.status === "pending" || sameAlreadyPaidCharge;

        if (
          String(order.telegram_id) !== senderId ||
          !statusCanBeProcessed ||
          order.currency !== "XTR" ||
          payment.currency !== "XTR" ||
          Number(order.stars_amount) !== Number(payment.total_amount)
        ) {
          console.error("Paid Telegram invoice does not match its MovieBox order");

          await telegram("sendMessage", {
            chat_id: adminId,
            text:
              "⚠️ MovieBox: платёж Stars требует проверки.\n" +
              `Telegram ID: ${senderId}\n` +
              `Payload: ${String(payload).slice(0, 120)}\n` +
              `Charge ID: ${String(chargeId).slice(0, 120)}`
          });

          await reply(
            "Telegram сообщил об оплате, но данные заказа не совпали. " +
            "Не оплачивай повторно. Напиши /paysupport для помощи."
          );

          return res.status(200).json({ ok: true });
        }

        const fulfilled = await db("rpc/fulfill_moviebox_star_payment", {
          method: "POST",
          body: JSON.stringify({
            p_payload: payload,
            p_telegram_id: senderId,
            p_currency: payment.currency,
            p_total_amount: Number(payment.total_amount),
            p_telegram_payment_charge_id: chargeId,
            p_provider_payment_charge_id:
              payment.provider_payment_charge_id || null,
            p_payment_json: payment
          })
        });

        if (!fulfilled || fulfilled.ok !== true) {
          console.error(
            "MovieBox payment activation rejected:",
            fulfilled?.error || "unknown error"
          );

          await telegram("sendMessage", {
            chat_id: adminId,
            text:
              "⚠️ MovieBox: Telegram подтвердил платёж, но активация требует проверки.\n" +
              `Telegram ID: ${senderId}\n` +
              `Payload: ${String(payload).slice(0, 120)}\n` +
              `Charge ID: ${String(chargeId).slice(0, 120)}\n` +
              `Причина: ${String(fulfilled?.error || "unknown").slice(0, 120)}`
          });

          await reply(
            "Оплата получена Telegram, но активация подписки требует проверки. " +
            "Не оплачивай повторно. Напиши /paysupport."
          );

          return res.status(200).json({ ok: true });
        }

        const tier = String(fulfilled.tier || order.plan).toUpperCase();
        const expiry = fulfilled.expires_at
          ? new Date(fulfilled.expires_at).toLocaleDateString(
              "ru-RU",
              { timeZone: "Europe/Amsterdam" }
            )
          : null;

        await reply(
          `✅ Оплата подтверждена!\n\n` +
          `Тариф: ${tier}\n` +
          `Срок: ${fulfilled.duration_days || order.duration_days || 30} дней\n` +
          (expiry ? `Действует до: ${expiry}\n` : "") +
          "Подписка активирована. Спасибо за покупку! 🎬"
        );

        return res.status(200).json({ ok: true });
      } catch (paymentError) {
        console.error(
          "MovieBox successful-payment processing failed:",
          paymentError.message
        );

        try {
          await telegram("sendMessage", {
            chat_id: adminId,
            text:
              "🚨 MovieBox: ошибка обработки платежа; Telegram может повторить событие.\n" +
              `Telegram ID: ${senderId}\n` +
              `Charge ID: ${String(chargeId || "unknown").slice(0, 120)}\n` +
              `Ошибка: ${String(paymentError.message || "unknown").slice(0, 200)}`
          });
        } catch (alertError) {
          console.error(
            "Could not alert MovieBox admin:",
            alertError.message
          );
        }

        return res.status(500).json({ ok: false });
      }
    }

    if (!text) {
      return res.status(200).json({ ok: true });
    }

    if (text === "/link") {
      await getUser();

      const code = randomBytes(24).toString("base64url");
      const codeHash = createHash("sha256").update(code).digest("hex");

      await db(
        `moviebox_link_codes?telegram_id=eq.${encodeURIComponent(senderId)}&used_at=is.null`,
        { method: "DELETE" }
      );

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await db("moviebox_link_codes", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          telegram_id: senderId,
          code_hash: codeHash,
          expires_at: expiresAt
        })
      });

      await reply(
        "🔐 Код привязки MovieBox:\n\n" +
        code +
        "\n\nКод действует 10 минут и используется один раз. " +
        "Введи его в поле привязки на сайте."
      );

    } else if (text === "/start") {
      await getUser();

      await reply(
        "Добро пожаловать в MovieBox! 🎬\n\n" +
        "Просто напиши название фильма для поиска.\n\n" +
        "Команды:\n" +
        "/search название — поиск фильма\n" +
        "/status — статус Premium/VIP\n" +
        "/link — код привязки сайта\n" +
        "/redeem CODE — активировать промокод\n" +
        "/help — помощь\n" +
        "/id — ваш Telegram ID"
      );

    } else if (text === "/help") {
      await reply(
        "MovieBox — помощь 🎬\n\n" +
        "Отправь название фильма обычным сообщением.\n" +
        "/search Интерстеллар — поиск фильма\n" +
        "/status — статус подписки\n" +
        "/link — код привязки сайта\n" +
        "/redeem CODE — активировать промокод\n" +
        "/id — узнать свой ID"
      );

    } else if (text === "/id") {
      await reply(`Ваш Telegram ID: ${senderId}`);

    } else if (text === "/status") {
      const user = await getUser();
      const now = new Date();

      const premium =
        user.premium_until && new Date(user.premium_until) > now;
      const vip =
        user.vip_until && new Date(user.vip_until) > now;

      await reply(
        "Ваш статус MovieBox 🎬\n\n" +
        `Premium: ${
          premium
            ? "активен до " + new Date(user.premium_until).toLocaleDateString("ru-RU")
            : "не активен"
        }\n` +
        `VIP: ${
          vip
            ? "активен до " + new Date(user.vip_until).toLocaleDateString("ru-RU")
            : "не активен"
        }`
      );

    } else if (text.startsWith("/grant ")) {
      if (!isAdmin) {
        await reply("Эта команда доступна только администратору.");
      } else {
        const parts = text.split(/\s+/);
        const targetId = parts[1];
        const tier = (parts[2] || "").toLowerCase();
        const days = Number(parts[3]);

        if (
          !targetId ||
          !["premium", "vip"].includes(tier) ||
          ![7, 14, 30, 365].includes(days)
        ) {
          await reply(
            "Формат:\n/grant TELEGRAM_ID premium 7\n" +
            "Доступные сроки: 7, 14, 30, 365 дней."
          );
        } else {
          await grant(targetId, tier, days);
          await reply(
            `✅ ${tier.toUpperCase()} выдан на ${days} дней пользователю ${targetId}.`
          );
        }
      }

    } else if (text.startsWith("/promo ")) {
      if (!isAdmin) {
        await reply("Эта команда доступна только администратору.");
      } else {
        const parts = text.split(/\s+/);
        const code = (parts[1] || "").toUpperCase();
        const tier = (parts[2] || "").toLowerCase();
        const days = Number(parts[3]);
        const maxActivations = Number(parts[4]);

        if (
          !/^[A-Z0-9_-]{3,40}$/.test(code) ||
          !["premium", "vip"].includes(tier) ||
          ![7, 14, 30, 365].includes(days) ||
          !Number.isInteger(maxActivations) ||
          maxActivations < 1
        ) {
          await reply("Формат: /promo MOVIE2026 premium 7 10");
        } else {
          await db("moviebox_promo_codes", {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              code,
              tier,
              duration_days: days,
              max_activations: maxActivations,
              activations: 0,
              active: true
            })
          });

          await reply(`Промокод ${code} создан.`);
        }
      }

    } else if (text.startsWith("/redeem ")) {
      const code = (text.split(/\s+/)[1] || "").toUpperCase();

      if (!code) {
        await reply("Использование: /redeem CODE");
      } else {
        const codes = await db(
          `moviebox_promo_codes?code=eq.${encodeURIComponent(code)}&active=eq.true&select=*`
        );
        const promo = codes[0];

        if (!promo || promo.activations >= promo.max_activations) {
          await reply("Промокод не найден, отключён или лимит активаций исчерпан.");
        } else {
          const previous = await db(
            `moviebox_promo_redemptions?code=eq.${encodeURIComponent(code)}&telegram_id=eq.${encodeURIComponent(senderId)}&select=id`
          );

          if (previous.length) {
            await reply("Ты уже активировал этот промокод.");
          } else {
            await grant(senderId, promo.tier, Number(promo.duration_days));

            await db("moviebox_promo_redemptions", {
              method: "POST",
              headers: { Prefer: "return=minimal" },
              body: JSON.stringify({
                code,
                telegram_id: senderId
              })
            });

            await db(
              `moviebox_promo_codes?code=eq.${encodeURIComponent(code)}`,
              {
                method: "PATCH",
                headers: { Prefer: "return=minimal" },
                body: JSON.stringify({
                  activations: promo.activations + 1
                })
              }
            );

            await reply(
              `Промокод активирован! 🎉\n` +
              `Подписка ${promo.tier} выдана на ${promo.duration_days} дней.`
            );
          }
        }
      }

    } else if (text === "/paysupport") {
      await reply(
        "Поддержка оплаты MovieBox ⭐\n\n" +
        "Если Telegram списал Stars, а подписка не активировалась, не оплачивай повторно. " +
        "Пришли администратору скрин статуса платежа и свой Telegram ID из команды /id. " +
        "Не отправляй коды входа или другие секретные данные."
      );

      try {
        await telegram("sendMessage", {
          chat_id: adminId,
          text:
            "🧾 Запрос поддержки оплаты MovieBox\n" +
            `Telegram ID: ${senderId}\n` +
            `Имя пользователя: ${
              message.from?.username
                ? "@" + message.from.username
                : "не указано"
            }\n` +
            "Проверьте последние платежи/заказы этого пользователя в Supabase."
        });
      } catch (supportError) {
        console.error(
          "Could not notify admin about payment support:",
          supportError.message
        );
      }

    } else if (text === "/admin") {
      await reply(
        isAdmin
          ? "Команды администратора:\n" +
            "/grant TELEGRAM_ID premium 30\n" +
            "/promo CODE premium 7 10"
          : "Эта команда доступна только администратору."
      );

    } else {
      const searchQuery = text.startsWith("/search")
        ? text.replace(/^\/search(?:@\w+)?\s*/i, "").trim()
        : text.startsWith("/")
          ? ""
          : text;

      if (!searchQuery) {
        await reply(
          "🎬 Напиши название фильма обычным сообщением.\n" +
          "Например: Интерстеллар\n" +
          "Или используй /search Интерстеллар"
        );
      } else if (searchQuery.length > 100) {
        await reply("Название слишком длинное. Максимум 100 символов.");
      } else {
        await getUser();
        await searchMovies(searchQuery);
      }
    }

    return res.status(200).json({ ok: true });

  } catch (error) {
    console.error("MovieBox bot error:", error.message);

    try {
      await reply("Не удалось выполнить команду. Попробуй позже.");
    } catch {
      console.error("Telegram error while sending failure reply");
    }

    return res.status(200).json({ ok: true });
  }
}
