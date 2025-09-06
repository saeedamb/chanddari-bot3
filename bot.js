const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PB_URL = process.env.POCKETBASE_URL;
let PB_ADMIN_TOKEN = null;

// ================== PocketBase Helpers ==================
async function pbAdminLogin() {
  if (PB_ADMIN_TOKEN) return PB_ADMIN_TOKEN;
  const email = process.env.PB_ADMIN_EMAIL;
  const pass = process.env.PB_ADMIN_PASSWORD;
  const r = await fetch(`${PB_URL}/api/admins/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: email, password: pass })
  });
  if (!r.ok) throw new Error("PB admin login failed");
  const j = await r.json();
  PB_ADMIN_TOKEN = j.token;
  return PB_ADMIN_TOKEN;
}
async function pbGet(coll, filter = "") {
  const url = `${PB_URL}/api/collections/${coll}/records?perPage=200${filter ? "&filter=" + encodeURIComponent(filter) : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PB GET error: ${coll}`);
  return res.json();
}
async function pbAuthed(method, coll, body, id = null) {
  const token = await pbAdminLogin();
  const url = `${PB_URL}/api/collections/${coll}/records${id ? "/" + id : ""}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "Authorization": `AdminAuth ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`PB ${method} error: ${coll}`);
  return res.json();
}
async function getConfig(key) {
  const data = await pbGet("config", `key="${key}"`);
  return data.items.length ? data.items[0].value : null;
}
async function getMessage(key) {
  const data = await pbGet("messages", `key="${key}"`);
  return data.items.length ? data.items[0].text : "";
}
async function getUI() {
  const data = await pbGet("ui");
  const map = {};
  data.items.forEach(i => (map[i.key] = i.value));
  return map;
}
async function getProvinces() {
  const data = await pbGet("provinces");
  return data.items.map(i => i.name);
}
async function listPlans(type, category) {
  const q = encodeURIComponent(`plan_type="${type}" && category="${category}" && active=true`);
  const j = await pbGet("plans_" + category, q);
  return j.items;
}

// ================== Telegram Helpers ==================
async function tg(method, payload) {
  const token = await getConfig("telegram_token");
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error("TG error:", await res.text());
  return res.json().catch(() => ({}));
}
const sendMessage = (chat_id, text, reply_markup = null) =>
  tg("sendMessage", { chat_id, text, reply_markup });
async function getFileUrl(fileId) {
  const token = await getConfig("telegram_token");
  const r = await tg("getFile", { file_id: fileId });
  const path = r?.result?.file_path;
  return path ? `https://api.telegram.org/file/bot${token}/${path}` : null;
}

// ================== State ==================
const S = {};
const setStep = (id, step) => { S[id] = S[id] || {}; S[id].step = step; };
const getStep = (id) => (S[id] || {}).step;
const dataOf = (id) => (S[id] || (S[id] = { data: {} })).data;
const setPending = (id, regId) => { S[id].pending = regId; };
const getPending = (id) => (S[id] || {}).pending;
const clearState = (id) => { delete S[id]; };

// ================== Helper Functions ==================
async function nextOrderId(type) {
  const counter = await pbGet("counters", `key="order"`);
  let val = counter.items.length ? parseInt(counter.items[0].value) : 1000;
  val++;
  if (counter.items.length) {
    await pbAuthed("PATCH", "counters", { value: String(val) }, counter.items[0].id);
  } else {
    await pbAuthed("POST", "counters", { key: "order", value: String(val) });
  }
  return `CD-${type}-${val}`;
}
function todayPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ================== Webhook ==================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const update = req.body;

    // Callback (پلن یا ادمین)
    if (update.callback_query) {
      const cq = update.callback_query;
      const data = cq.data || "";

      // انتخاب پلن
      if (data.startsWith("plan:")) {
        const [_, planType, category, planId] = data.split(":");
        const plan = (await pbGet("plans_" + category, `id="${planId}"`)).items[0];
        const chatId = cq.message.chat.id;
        const d = dataOf(chatId);
        const orderType = category === "first" ? "N" : "R";
        const orderId = await nextOrderId(orderType);

        // ساخت رکورد ثبت‌نام
        const reg = await pbAuthed("POST", "registrations", {
          chat_id: chatId,
          full_name: d.full_name,
          company: d.company,
          phone: d.phone,
          province: d.province,
          email: d.email,
          plan_key: plan.key,
          plan_label: plan.label,
          status: category === "first" && plan.plan_type === "Trial" ? "active" : "pending",
          start_date: todayPlus(0),
          end_date: todayPlus(plan.days),
          days_left: plan.days,
          order_id: orderId,
          paid_count: plan.plan_type === "Trial" ? 0 : 1,
          receipt_status: plan.plan_type === "Trial" ? "Successful" : "Pending",
          amount: plan.price
        });

        if (plan.plan_type === "Trial") {
          await sendMessage(chatId, await getMessage("trial_success"));
        } else {
          const msg = await getMessage("pay_msg");
          const cardNumber = await getConfig("card_number");
          const cardName = await getConfig("card_name");
          const text = msg
            .replace("{full_name}", d.full_name)
            .replace("{plan_label}", plan.label)
            .replace("{order_id}", orderId)
            .replace("{date}", new Date().toLocaleDateString("fa-IR"))
            .replace("{time}", new Date().toLocaleTimeString("fa-IR"))
            .replace("{price}", plan.price)
            .replace("{card_number}", cardNumber)
            .replace("{card_name}", cardName);
          await sendMessage(chatId, text);
          setStep(chatId, "RECEIPT");
          setPending(chatId, reg.id);
        }
      }

      // ادمین تایید/رد
      if (data.startsWith("admin_")) {
        const [_, action, regId] = data.split(":");
        if (action === "approve") {
          await pbAuthed("PATCH", "registrations", { receipt_status: "Successful", status: "active" }, regId);
          await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: "✅ تایید شد" });
        } else {
          await pbAuthed("PATCH", "registrations", { receipt_status: "Failed", status: "pending" }, regId);
          await tg("editMessageText", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, text: "❌ رد شد" });
        }
      }
      return;
    }

    // Messages
    const msg = update.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    const step = getStep(chatId);

    if (text === "/start") {
      const welcome = await getMessage("welcome_start");
      const ui = await getUI();
      await sendMessage(chatId, welcome, {
        keyboard: [
          [ui.label_start],
          [ui.label_info, ui.label_status],
          [ui.label_about],
          [ui.label_channel, ui.label_support]
        ],
        resize_keyboard: true
      });
      clearState(chatId);
      return;
    }

    if (text === "📝 شروع ثبت‌نام") {
      setStep(chatId, "NAME");
      return sendMessage(chatId, await getMessage("ask_fullname"));
    }
    if (step === "NAME") {
      if (!text.includes(" ")) return sendMessage(chatId, await getMessage("name_invalid"));
      dataOf(chatId).full_name = text;
      setStep(chatId, "COMPANY");
      return sendMessage(chatId, await getMessage("ask_company"));
    }
    if (step === "COMPANY") {
      dataOf(chatId).company = text;
      setStep(chatId, "PHONE");
      return sendMessage(chatId, await getMessage("ask_phone"));
    }
    if (step === "PHONE") {
      if (!/^09\d{9}$/.test(text)) return sendMessage(chatId, await getMessage("phone_invalid"));
      dataOf(chatId).phone = text;
      setStep(chatId, "PROVINCE");
      const provinces = await getProvinces();
      return sendMessage(chatId, await getMessage("ask_province"), {
        keyboard: provinces.map(p => [{ text: p }]),
        resize_keyboard: true
      });
    }
    if (step === "PROVINCE") {
      dataOf(chatId).province = text;
      setStep(chatId, "EMAIL");
      return sendMessage(chatId, await getMessage("ask_email"));
    }
    if (step === "EMAIL") {
      if (!/^[a-zA-Z0-9._%+-]+@gmail\.com$/.test(text)) return sendMessage(chatId, await getMessage("email_invalid"));
      dataOf(chatId).email = text;
      setStep(chatId, "PLAN");
      return sendMessage(chatId, await getMessage("ask_plan"), {
        inline_keyboard: [
          [{ text: "پلن تستی", callback_data: "plan:Trial:first:trial_id" }],
          [{ text: "پلن موبایل", callback_data: "plan:Mobile:first:mobile_id" }],
          [{ text: "پلن لپتاپ", callback_data: "plan:Laptop:first:laptop_id" }],
          [{ text: "پلن VIP", callback_data: "plan:Vip:first:vip_id" }]
        ]
      });
    }

    if (step === "RECEIPT") {
      const photo = msg.photo?.at(-1) || msg.document;
      if (!photo) return sendMessage(chatId, await getMessage("receipt_invalid"));
      const url = await getFileUrl(photo.file_id);
      const regId = getPending(chatId);
      await pbAuthed("PATCH", "registrations", { receipt_url: url, receipt_status: "Pending" }, regId);
      await sendMessage(chatId, await getMessage("receipt_waiting"));
      clearState(chatId);
      const adminId = await getConfig("admin_group_id");
      await tg("sendMessage", {
        chat_id: adminId,
        text: `📥 رسید جدید از ${dataOf(chatId).full_name}`,
        reply_markup: { inline_keyboard: [[{ text: "✅ تایید", callback_data: `admin_approve:${regId}` }, { text: "❌ رد", callback_data: `admin_reject:${regId}` }]] }
      });
      return;
    }

    return sendMessage(chatId, await getMessage("invalid_option"));
  } catch (e) {
    console.error("Error:", e.message);
  }
});

// ================== Start ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("BOT running on port", PORT));
