import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const COOLDOWN = 300;
const START_BALANCE = 1000;
const STORE_NAME = "pupu-slavery";
const LEADERBOARD_STORE_NAME = "pupu-leaderboard";

const SEED_PLAYERS = [
  { key: "54a9d82aa1", name: "່", owner: "84c100c056", price: 505, income: 40 },
  { key: "a71cc81108", name: "Jealous Eyedress", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "62cf218c52", name: "descriptecal", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "84c100c056", name: "moon", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "c970169c9c", name: "Amir", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "000304bf64", name: "qsef", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "bbad70fd57", name: "Атлантический", owner: "54a9d82aa1", price: 800, income: 109 },
  { key: "e153c7b1cc", name: ".", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "47c4260078", name: "эвочка", owner: "54a9d82aa1", price: 800, income: 150 },
  { key: "301557b376", name: "-", owner: "54a9d82aa1", price: 800, income: 150 }
];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function cleanName(value) {
  return String(value || "Игрок").trim().slice(0, 40) || "Игрок";
}

function keyFor(id) {
  return crypto.createHash("sha1").update(String(id)).digest("hex").slice(0, 10);
}

function isPlayerKey(id) {
  return Boolean(id) && !/^\d+$/.test(String(id));
}

function sanitizeLeaderboard(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((row) => row && typeof row === "object")
    .map((row) => ({
      key: String(row.key || "").slice(0, 20),
      name: cleanName(row.name),
      points: Math.max(0, Math.floor(Number(row.points) || 0)),
      snake: Math.max(0, Math.floor(Number(row.snake) || 0)),
      race: Math.max(0, Math.floor(Number(row.race) || 0)),
      g2048: Math.max(0, Math.floor(Number(row.g2048) || 0)),
      slaves: Math.max(0, Math.floor(Number(row.slaves) || 0))
    }))
    .filter((row) => row.key)
    .sort((a, b) => b.points - a.points);
}

function normalizePlayer(player, fallbackName = "Игрок") {
  const rawBalance = Number(player?.balance ?? player?.points ?? START_BALANCE);
  const balance = Number.isFinite(rawBalance) ? Math.max(0, Math.floor(rawBalance)) : START_BALANCE;
  return {
    name: cleanName(player?.name || fallbackName),
    balance,
    owner: player?.owner && isPlayerKey(player.owner) ? String(player.owner) : null,
    price: Math.max(1, Math.floor(Number(player?.price) || 150)),
    income: Math.max(1, Math.floor(Number(player?.income) || 15)),
    lastCollect: Math.max(0, Math.floor(Number(player?.lastCollect) || 0))
  };
}

function makeSeedState() {
  const players = {};
  for (const player of SEED_PLAYERS) {
    players[player.key] = normalizePlayer(
      { ...player, balance: START_BALANCE },
      player.name
    );
  }
  return { players, results: {}, updatedAt: Math.floor(Date.now() / 1000) };
}

function sanitizeState(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const players = {};
  let dirty = !raw || !source.players || Array.isArray(source.players);

  const entries = Array.isArray(source.players)
    ? source.players.map((player) => [player?.key || player?.id, player])
    : Object.entries(source.players || {});

  for (const [rawId, player] of entries) {
    const id = String(rawId || "");
    if (!isPlayerKey(id) || !player || typeof player !== "object") {
      if (rawId !== undefined) dirty = true;
      continue;
    }
    players[id] = normalizePlayer(player, player.name);
  }

  for (const [id, player] of Object.entries(players)) {
    if (player.owner && (!players[player.owner] || player.owner === id)) {
      player.owner = null;
      dirty = true;
    }
  }

  return {
    state: {
      players,
      results: source.results && typeof source.results === "object" ? source.results : {},
      updatedAt: Number(source.updatedAt) || 0
    },
    dirty
  };
}

function publicState(state, meKey) {
  const players = Object.entries(state.players || {})
    .filter(([id]) => isPlayerKey(id))
    .map(([id, player]) => ({ id, ...normalizePlayer(player) }));
  players.sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  const me = meKey && state.players[meKey]
    ? { id: meKey, ...normalizePlayer(state.players[meKey]) }
    : null;
  return {
    players,
    me,
    cooldown: COOLDOWN,
    updatedAt: Number(state.updatedAt) || 0,
    results: state.results || {}
  };
}

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return null;
  }
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + "=" + value)
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  if (calculated !== hash) return null;
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) return null;
  try {
    const user = JSON.parse(params.get("user") || "null");
    if (!user || !user.id) return null;
    return {
      id: String(user.id),
      name: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || "Игрок"
    };
  } catch {
    return null;
  }
}

function readUserFromInitData(initData) {
  try {
    const params = new URLSearchParams(initData || "");
    const parsed = JSON.parse(params.get("user") || "null");
    if (!parsed || !parsed.id) return null;
    return {
      id: String(parsed.id),
      name: [parsed.first_name, parsed.last_name].filter(Boolean).join(" ") || parsed.username || "Игрок"
    };
  } catch {
    return null;
  }
}

export default async (request) => {
  const url = new URL(request.url);
  const leaderboardStore = getStore(LEADERBOARD_STORE_NAME);

  if (url.searchParams.get("leaderboard") === "1") {
    if (request.method !== "GET") {
      return json(405, { error: "Метод не поддерживается." });
    }
    const stored = await leaderboardStore.get("rows", { type: "json" });
    // В хранилище могли остаться данные в форме состояния биржи
    // ({ players: [...] }) вместо массива строк. Клиент ожидает массив,
    // поэтому приводим оба варианта к одному формату.
    const source = Array.isArray(stored) ? stored : stored?.players;
    return json(200, sanitizeLeaderboard(source));
  }

  const store = getStore(STORE_NAME);
  const raw = await store.get("state", { type: "json" });
  const { state, dirty } = sanitizeState(raw);

  if (!Object.keys(state.players).length) {
    Object.assign(state, makeSeedState());
  }

  if (dirty || !raw) {
    await store.setJSON("state", state);
  }

  if (request.method === "GET") {
    const meRaw = url.searchParams.get("me");
    const meName = url.searchParams.get("name");
    let me = null;
    if (meRaw) {
      const meKey = state.players[meRaw] ? meRaw : keyFor(meRaw);
      if (!state.players[meKey] && meName) {
        state.players[meKey] = normalizePlayer({ name: meName, balance: START_BALANCE }, meName);
        await store.setJSON("state", state);
      }
      if (state.players[meKey]) me = meKey;
    }
    return json(200, publicState(state, me));
  }

  if (request.method !== "POST") {
    return json(405, { error: "Метод не поддерживается." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Некорректный запрос." });
  }

  const user = verifyInitData(body.initData, process.env.BOT_TOKEN) || readUserFromInitData(body.initData);
  if (!user) {
    return json(401, { error: "Открой игру через Telegram, чтобы участвовать." });
  }

  const userKey = keyFor(user.id);
  const mode = String(body.mode || "action");

  if (mode === "leaderboard") {
    if (!process.env.SYNC_SECRET || String(body.secret || "") !== process.env.SYNC_SECRET) {
      return json(403, { error: "Нет доступа к таблице лидеров." });
    }
    const rows = sanitizeLeaderboard(body.rows);
    if (!rows.length) {
      return json(400, { error: "Пустая таблица лидеров." });
    }
    await leaderboardStore.setJSON("rows", rows);
    return json(200, { ok: true, count: rows.length });
  }

  if (mode === "sync") {
    if (!process.env.SYNC_SECRET || String(body.secret || "") !== process.env.SYNC_SECRET) {
      return json(403, { error: "Нет доступа к синхронизации." });
    }
    const incoming = sanitizeState({ players: body.state?.players || {} });
    if (!Object.keys(incoming.state.players).length) {
      return json(400, { error: "Пустой список участников." });
    }
    state.players = incoming.state.players;
    state.updatedAt = Math.floor(Date.now() / 1000);
    await store.setJSON("state", state);
    return json(200, publicState(state, userKey));
  }

  const action = String(body.action || "");
  if (!["buy", "improve", "collect"].includes(action)) {
    return json(400, { error: "Неизвестное действие." });
  }

  if (!state.players[userKey]) {
    state.players[userKey] = normalizePlayer({ name: user.name, balance: START_BALANCE }, user.name);
  }
  const me = state.players[userKey];
  me.name = cleanName(user.name);
  const now = Math.floor(Date.now() / 1000);

  if (action === "collect") {
    const readyAt = me.lastCollect + COOLDOWN;
    if (now < readyAt) {
      return json(400, { error: "Доход будет готов через " + (readyAt - now) + " сек." });
    }
    const total = Object.entries(state.players)
      .filter(([id, player]) => id !== userKey && player.owner === userKey)
      .reduce((sum, [, player]) => sum + Math.max(0, Number(player.income) || 0), 0);
    if (!total) {
      return json(400, { error: "У тебя пока нет рабов." });
    }
    me.lastCollect = now;
    me.balance += total;
    state.results[userKey] = { text: "Собрано " + total + " монет.", at: now };
  } else {
    const targetId = String(body.target || "");
    if (!targetId || targetId === userKey) {
      return json(400, { error: "Нельзя выбрать этого игрока." });
    }
    const target = state.players[targetId];
    if (!target) {
      return json(400, { error: "Игрок не найден." });
    }
    if (action === "improve" && target.owner !== userKey) {
      return json(400, { error: "Этот игрок уже не твой." });
    }
    if (action === "buy" && target.owner === userKey) {
      return json(400, { error: "Этот игрок уже твой." });
    }
    if (target.owner && !state.players[target.owner]) {
      target.owner = null;
    }
    const cost = Math.max(1, Number(target.price) || 150);
    if (me.balance < cost) {
      return json(400, { error: "Не хватает монет: нужно " + cost + "." });
    }
    me.balance -= cost;
    const oldOwner = target.owner;
    if (action === "buy" && oldOwner && oldOwner !== userKey) {
      state.players[oldOwner].balance += Math.floor(cost / 2);
    }
    target.owner = userKey;
    target.price = Math.max(cost + 1, Math.round(cost * 1.5));
    target.income = Math.max(
      (Number(target.income) || 15) + 1,
      Math.round((Number(target.income) || 15) * 1.4)
    );
    state.results[userKey] = {
      text: action === "buy" && oldOwner && oldOwner !== userKey
        ? target.name + " выкуплен у другого игрока."
        : target.name + " теперь твой.",
      at: now
    };
  }

  state.updatedAt = now;
  await store.setJSON("state", state);
  return json(200, { ok: true, state: publicState(state, userKey) });
};
