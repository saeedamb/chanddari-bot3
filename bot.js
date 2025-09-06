import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// توکن ربات (از BotFather)
const TELEGRAM_TOKEN = "8344500488:AAFamQJNoCuoxKjAw6VmHIA0aYfXORNhsrA";
const API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// آدرس PocketBase
const PB_URL = "https://chanddari-db1.onrender.com";

// وبهوک تلگرام
app.post("/webhook", async (req, res) => {
  const update = req.body;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text;

    // نمونه ساده: جواب سلام بده
    if (text.toLowerCase() === "salam") {
      await fetch(`${API_URL}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "سلام! ربات وصله به PocketBase 🚀",
        }),
      });
    }
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server is running on port ${PORT}`);
});
