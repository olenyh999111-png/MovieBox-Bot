
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const receivedSecret =
    req.headers["x-telegram-bot-api-secret-token"];

  if (!secret || receivedSecret !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const adminId = process.env.ADMIN_TELEGRAM_ID;

  if (!token || !adminId) {
    return res.status(500).json({ error: "Bot not configured" });
  }

  const update = req.body;
  const message = update?.message;
  const chatId = message?.chat?.id;
  const text = message?.text || "";

  if (!chatId || !text) {
    return res.status(200).json({ ok: true });
  }

  const senderId = String(message.from?.id || "");
  const isAdmin = senderId === adminId;

  let reply = "";

  if (text.startsWith("/start")) {
    reply =
      "Добро пожаловать в MovieBox! 🎬\n\n" +
      "Поиск фильмов доступен в Mini App.\n" +
      "Команды:\n/help — помощь\n/id — узнать свой ID";
  } else if (text.startsWith("/help")) {
    reply =
      "MovieBox — помощь\n\n" +
      "/start — главное меню\n" +
      "/id — ваш Telegram ID";
  } else if (text.startsWith("/id")) {
    reply = `Ваш Telegram ID: ${senderId}`;
  } else if (text.startsWith("/admin")) {
    reply = isAdmin
      ? "Панель администратора MovieBox доступна. Управление подписками подключим следующим этапом."
      : "Эта команда доступна только администратору.";
  } else {
    reply = "Напишите /start, чтобы открыть меню MovieBox.";
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply
      })
    }
  );

  if (!response.ok) {
    console.error("Telegram sendMessage failed:", response.status);
    return res.status(502).json({ error: "Telegram API failed" });
  }

  return res.status(200).json({ ok: true });
}
