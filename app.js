/* ==========================================================================
   Тройка! — СТЕК ИНИЦИАТИВЫ
   ==========================================================================

   По правилам «Тройки!» инициатива — это не бросок, а ёмкость с жетонами
   (раздел 5 правил, https://troika.wishport.online/initiative):

     5.1.1  Каждый персонаж получает 2 жетона своего цвета. Здесь это
            значение можно изменить для конкретного персонажа — но по
            умолчанию остаётся 2.
     5.1.2  Враги добавляют столько жетонов, каково их значение Инициативы.
     5.1.3  Плюс один жетон уникального цвета — Жетон Конца раунда.
     5.2    Ведущий вынимает жетон наугад — тот и ходит.
     5.3    Выпал Конец раунда → все жетоны возвращаются в Стек, раунд +1,
            убираются погибшие, разбираются эффекты (огонь, яд, кровотечение).
     5.4    Приспешники дают по одному жетону, все одинаковые. Здесь тоже
            можно задать своё значение Инициативы — по умолчанию 1.
     5.5    Вытянув жетон врага, Ведущий выбирает любого из них.
     6.2.2  Прицелившийся держит свой жетон: со второго жетона бросает
            кубики дважды и выбирает лучший результат.
     6.4    Отсрочка — можно вернуть вытянутый жетон обратно в Стек.

   ГДЕ ХРАНЯТСЯ ДАННЫЕ

   • Внутри Owlbear Rodeo — в метаданных сцены (OBR.scene.setMetadata).
     Это общее состояние сцены: Ведущий меняет, все игроки видят сразу,
     в том числе те, кто открыл панель позже. Данные переживают
     закрытие и открытие окна.
   • Вне Owlbear Rodeo (просто открыли файл в браузере) — в localStorage.
     Расширение работает автономно, полный доступ на правку.

   ========================================================================== */

/* ---------- 1. Константы ------------------------------------------------- */

const META_KEY = "com.troika.initiative/state"; // ключ в метаданных сцены
const LOCAL_KEY = "troika-initiative/state";    // ключ в localStorage
const STATE_V = 2;                              // версия формата сохранения
const SDK_URL = "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk@3.1.0/+esm";
const TIMEOUT_MS = 4000;                        // защита от зависших вызовов
const MAX_HISTORY = 20;                         // сколько ходов можно отменить
const MAX_LOG = 40;                             // сколько строк в ленте

const TYPE_LABEL = { pc: "персонаж", henchman: "приспешник", enemy: "враг" };
const END_ID = "END";                           // условный id Жетона Конца раунда

// Цвета жетонов персонажей — у каждого свой (5.1.1)
const PC_COLORS = ["#2f6bff", "#16a34a", "#7c3aed", "#ff7a00",
                   "#06b6d4", "#ff7bd3", "#00a86b", "#e24bb0"];
// У приспешников жетоны одинаковые (5.4), у врагов — тоже одинаковые (5.5)
const TYPE_COLOR = { henchman: "#ffd400", enemy: "#d64545" };
const END_COLOR = "#111111";

/* ---------- 2. Мелкие помощники ----------------------------------------- */

const $ = (id) => document.getElementById(id);

function clampNum(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function asText(v, def, max) {
  if (typeof v !== "string") return def;
  const t = v.trim().slice(0, max);
  return t || def;
}

// Гонка «успеть или вернуть запасное значение».
// Никогда не отдаёт отказ: упавший вызов превращается в fallback,
// иначе одна ошибка Owlbear Rodeo убивала бы весь запуск.
function withTimeout(promise, ms, fallback) {
  const safe = Promise.resolve(promise).then((v) => v, () => fallback);
  return Promise.race([
    safe,
    new Promise((res) => setTimeout(() => res(fallback), ms)),
  ]);
}

function uid() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function byId(s, id) {
  return s.participants.find((p) => p.id === id) || null;
}

function colorFor(type, index) {
  if (type === "enemy") return TYPE_COLOR.enemy;
  if (type === "henchman") return TYPE_COLOR.henchman;
  return PC_COLORS[index % PC_COLORS.length];
}

function nowTime() {
  return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

// Значение Инициативы по умолчанию: персонажу и врагу — 2 (5.1.1, 5.1.2),
// приспешнику — 1, ровно как в правилах (5.4).
function defaultInit(type) {
  return type === "henchman" ? 1 : 2;
}

// Инициатива участника: пустое, нулевое или мусорное значение считаем
// «не задано» и подставляем значение по умолчанию. В остальных случаях — 1…99.
function initValue(type, v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return defaultInit(type);
  return Math.max(1, Math.min(99, Math.round(n)));
}

// Русские числительные: 1 жетон, 2 жетона, 5 жетонов
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ---------- 3. Состояние -------------------------------------------------- */

function newState() {
  return {
    v: STATE_V,
    round: 1,
    participants: [],
    endLeft: true,     // Жетон Конца раунда ещё в Стеке
    current: null,     // { id, double } — вытянутый жетон, за которым ждут хода
    history: [],       // для отмены: { actor, snap }
    log: [],
  };
}

function sanitize(raw) {
  const s = newState();
  if (!raw || typeof raw !== "object") return s;

  s.round = clampNum(raw.round, 1, 1, 9999);
  s.endLeft = raw.endLeft !== false;

  // Сохранения старого формата (v < 2): поле Инициативы у приспешника тогда
  // было скрыто и хранило число, зашедшее туда от другого типа. По правилам
  // (5.4) приспешник давал 1 жетон — так и считаем.
  const oldSave = !(Number(raw.v) >= STATE_V);

  if (Array.isArray(raw.participants)) {
    const used = new Set();
    raw.participants.forEach((src) => {
      if (!src || typeof src !== "object") return;
      let id = asText(src.id, "", 40);
      if (!id || used.has(id)) id = "p" + s.participants.length;
      used.add(id);

      const type = TYPE_LABEL[src.type] ? src.type : "enemy";
      const p = {
        id,
        name: asText(src.name, "Без имени", 40),
        type,
        init: initValue(type, (oldSave && type === "henchman") ? 1 : src.init),
        alive: src.alive !== false,
        aiming: src.aiming === true,
        color: asText(src.color, "", 20) || colorFor(type, s.participants.length),
        tokens: 0,
      };
      // Жетоны: берём сохранённое значение, но не больше, чем дают правила
      const max = tokensFor(p);
      p.tokens = Math.min(clampNum(src.tokens, max, 0, 99), max);
      s.participants.push(p);
    });
  }

  // Текущий жетон — только если он существует
  if (raw.current && typeof raw.current === "object") {
    const id = asText(raw.current.id, "", 40);
    if (id === END_ID || byId(s, id)) {
      s.current = { id, double: raw.current.double === true };
    }
  }

  if (Array.isArray(raw.history)) {
    s.history = raw.history
      .filter((e) => e && typeof e === "object" && typeof e.actor === "string")
      .slice(-MAX_HISTORY)
      .map((e) => ({
        actor: e.actor.slice(0, 40),
        label: asText(e.label, "", 160),
        snap: sanitizeSnap(e.snap, s),
      }));
  }

  if (Array.isArray(raw.log)) {
    s.log = raw.log
      .filter((e) => e && typeof e === "object")
      .slice(-MAX_LOG)
      .map((e) => ({
        t: asText(e.t, "", 160),
        k: e.k === "rnd" || e.k === "back" ? e.k : "",
        m: asText(e.m, "", 8),
      }))
      .filter((e) => e.t);
  }

  return s;
}

// Приводит снимок к виду текущего Стека: лишние id выбрасываем,
// значения проверяем. Отсутствующие поля просто не трогаем.
function sanitizeSnap(snap, s) {
  const out = {};
  if (!snap || typeof snap !== "object") return out;
  if ("round" in snap) out.round = clampNum(snap.round, s.round, 1, 9999);
  if ("endLeft" in snap) out.endLeft = snap.endLeft !== false;
  if (snap.tokens && typeof snap.tokens === "object") {
    out.tokens = {};
    for (const p of s.participants) {
      if (p.id in snap.tokens) out.tokens[p.id] = clampNum(snap.tokens[p.id], p.tokens, 0, 99);
    }
  }
  if (snap.aiming && typeof snap.aiming === "object") {
    out.aiming = {};
    for (const p of s.participants) {
      if (p.id in snap.aiming) out.aiming[p.id] = snap.aiming[p.id] === true;
    }
  }
  // Значения Инициативы — чтобы отмена вернула и их тоже
  if (snap.init && typeof snap.init === "object") {
    out.init = {};
    for (const p of s.participants) {
      if (p.id in snap.init) out.init[p.id] = initValue(p.type, snap.init[p.id]);
    }
  }
  // Вытянутый жетон на момент снимка
  if ("current" in snap) {
    const c = snap.current;
    out.current = c && typeof c === "object"
      ? (asText(c.id, "", 40) === END_ID || byId(s, asText(c.id, "", 40))
          ? { id: asText(c.id, "", 40), double: c.double === true }
          : null)
      : null;
  }
  return out;
}

function logAdd(s, text, kind) {
  s.log.push({ t: text, k: kind || "", m: nowTime() });
  if (s.log.length > MAX_LOG) s.log = s.log.slice(-MAX_LOG);
}

/* ---------- 4. Правила: построение Стека --------------------------------- */

// Сколько жетонов даёт этот участник: ровно столько, какова его Инициатива —
// у всех трёх типов теперь считается одинаково (5.1.1, 5.1.2, 5.4)
function tokensFor(p) {
  if (!p.alive) return 0;
  return initValue(p.type, p.init);
}

// Пересобрать Стек для нового раунда (5.1 + 5.3)
function rebuild(s) {
  s.participants.forEach((p) => { p.tokens = tokensFor(p); });
  s.endLeft = true; // 5.1.3 — Жетон Конца раунда всегда возвращается
}

// Сколько жетонов сейчас лежит в Стеке
function poolSize(s) {
  let n = s.participants.reduce((a, p) => a + p.tokens, 0);
  if (s.endLeft) n++;
  return n;
}

function counts(s) {
  const c = { pc: 0, henchman: 0, enemy: 0 };
  s.participants.forEach((p) => { c[p.type] += p.tokens; });
  return c;
}

// Снимок Стека перед вытягиванием — чтобы отмена была точной
// Снимок ТОЛЬКО тех полей, которые собрались поменять.
// Так отмена одной операции не откатывает чужие: например, возврат жетона
// не трогает изменение Инициативы, сделанное после вытягивания.
//   fields: { round, endLeft, current, tokens, aiming, init }
//   для tokens/aiming/init — массив id участников или "all".
function snapBefore(s, fields) {
  const snap = {};
  if ("round" in fields) snap.round = s.round;
  if ("endLeft" in fields) snap.endLeft = s.endLeft;
  if ("current" in fields) {
    snap.current = s.current ? { id: s.current.id, double: s.current.double === true } : null;
  }
  for (const key of ["tokens", "aiming", "init"]) {
    if (!(key in fields)) continue;
    const spec = fields[key];
    const list = spec === "all" ? s.participants.slice()
                                : s.participants.filter((p) => spec.includes(p.id));
    snap[key] = {};
    list.forEach((p) => {
      snap[key][p.id] = key === "tokens" ? p.tokens
                      : key === "aiming" ? !!p.aiming
                      : p.init;
    });
  }
  return snap;
}

function restore(s, snap) {
  if (!snap) return;
  if ("round" in snap) s.round = clampNum(snap.round, s.round, 1, 9999);
  if ("endLeft" in snap) s.endLeft = snap.endLeft !== false;

  // Инициативу возвращаем раньше жетонов: от неё зависит, сколько жетонов
  // вообще может быть у участника.
  if (snap.init) {
    for (const p of s.participants) {
      if (p.id in snap.init) p.init = initValue(p.type, snap.init[p.id]);
    }
  }
  if (snap.tokens) {
    for (const p of s.participants) {
      if (p.id in snap.tokens) {
        p.tokens = Math.min(clampNum(snap.tokens[p.id], p.tokens, 0, 99), tokensFor(p));
      }
    }
  }
  if (snap.aiming) {
    for (const p of s.participants) {
      if (p.id in snap.aiming) p.aiming = snap.aiming[p.id] === true;
    }
  }
  // Вытянутый жетон: есть ли он ещё в списке (участника могли удалить)
  if ("current" in snap) {
    const c = snap.current;
    s.current = c && typeof c === "object" && (c.id === END_ID || byId(s, c.id))
      ? { id: c.id, double: c.double === true }
      : null;
  }
}

function pushHistory(s, actor, snap, label) {
  s.history.push({ actor, label: label || "", snap });
  if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
}

/* ---------- 5. Действия --------------------------------------------------- */

// 5.2 — вытянуть жетон наугад
function drawToken(s) {
  const size = poolSize(s);
  if (size === 0) return null;

  let pick = Math.floor(Math.random() * size);
  let actor = null;

  for (const p of s.participants) {
    if (p.tokens <= 0) continue;
    if (pick < p.tokens) { actor = p.id; break; }
    pick -= p.tokens;
  }
  if (actor === null && s.endLeft) actor = END_ID;
  if (actor === null) return null;

  const snap = actor === END_ID
    // Конец раунда пересобирает весь Стек и двигает раунд (5.3)
    ? snapBefore(s, { round: 1, endLeft: 1, tokens: "all", current: 1 })
    // Обычный жетон тратит только свой жетон и сбрасывает прицел
    : snapBefore(s, { tokens: [actor], aiming: [actor], current: 1 });
  pushHistory(s, actor, snap);

  // 5.3 — Жетон Конца раунда
  if (actor === END_ID) {
    s.endLeft = false;
    s.current = null;
    const from = s.round;
    s.round++;
    rebuild(s);
    logAdd(s, `Конец раунда ${from} → раунд ${s.round}`, "rnd");
    return { kind: "end", from, to: s.round };
  }

  const p = byId(s, actor);
  if (!p) return null;
  p.tokens--;

  // 6.2.2 — если уже прицелился, этот жетон даёт бросок дважды
  const double = p.aiming;
  if (p.aiming) p.aiming = false;
  s.current = { id: p.id, double };

  logAdd(s, double
    ? `Вытянут жетон: ${p.name} — двойной бросок!`
    : `Вытянут жетон: ${p.name}`, "");

  return { kind: "turn", p, double };
}

// Является ли запись истории именно вытягиванием жетона
// (правки инициативы и «Новый раунд» — нет)
function isDrawEntry(e) {
  return !!e && !e.label && e.actor !== "NEWROUND";
}

// 6.4 Отсрочка + отмена последнего действия
function undoLast(s) {
  const e = s.history.pop();
  if (!e) return null;
  restore(s, e.snap);                       // вернёт жетоны, раунд, инициативу и жетон
  const who = e.actor === "NEWROUND" ? "Новый раунд"
            : e.actor === END_ID ? "Жетон Конца раунда"
            : (byId(s, e.actor)?.name || "жетон");
  logAdd(s, e.label ? `Отменено: ${e.label}` : `Возвращено в Стек: ${who}`, "back");
  return e;
}

// 6.4 Отсрочка: кнопка «Вернуть жетон» должна возвращать именно жетон,
// даже если сверху лежит более свежая правка (например, изменение инициативы).
function returnToken(s) {
  let idx = -1;
  for (let k = s.history.length - 1; k >= 0; k--) {
    if (isDrawEntry(s.history[k])) { idx = k; break; }
  }
  if (idx < 0) return null;
  const e = s.history.splice(idx, 1)[0];
  restore(s, e.snap);
  const who = e.actor === END_ID ? "Жетон Конца раунда" : (byId(s, e.actor)?.name || "жетон");
  logAdd(s, `Возвращено в Стек: ${who}`, "back");
  return e;
}

// «Ход завершён» — засчитать ход, жетон остаётся потраченным
function commitTurn(s) {
  if (!s.current) return;
  const p = byId(s, s.current.id);
  logAdd(s, p ? `Ход завершён: ${p.name}` : "Ход завершён", "");
  s.current = null;
}

// Ручной новый раунд (если Ведущий решил не ждать Жетона Конца раунда)
function newRound(s) {
  pushHistory(s, "NEWROUND", snapBefore(s, { round: 1, endLeft: 1, tokens: "all", current: 1 }));
  s.round++;
  rebuild(s);
  s.current = null;
  logAdd(s, `Начат раунд ${s.round}`, "rnd");
}

// 6.2.2 — прицелиться (только в свой ход, только персонажу или приспешнику)
function toggleAim(s) {
  if (!s.current || s.current.id === END_ID) return null;
  const p = byId(s, s.current.id);
  if (!p || p.type === "enemy") return null;
  p.aiming = !p.aiming;
  logAdd(s, p.aiming ? `${p.name} прицеливается (6.2.2)` : `${p.name} отменил прицел`, "back");
  return p;
}

function addParticipant(s, name, type, init) {
  const p = {
    id: uid(),
    name: name.slice(0, 40),
    type,
    init: initValue(type, init),
    alive: true,
    aiming: false,
    color: colorFor(type, s.participants.length),
    tokens: 0,
  };
  p.tokens = tokensFor(p);
  s.participants.push(p);
  logAdd(s, `Добавлен: ${p.name} (${TYPE_LABEL[p.type]}) — ${p.tokens} ${plural(p.tokens, "жетон", "жетона", "жетонов")}`, "");
  return p;
}

/* ---------- 6. Хранилище -------------------------------------------------- */

const mode = { obr: false, gm: true, connecting: true };
let lastSavedJson = null; // чтобы не перетирать своё же сохранение при onMetadataChange
// Находимся ли мы во встроенном окне (iframe Owlbear Rodeo)
const embedded = (function () {
  try { return window.self !== window.top; } catch { return true; }
})();
let OBR = null;
let state = newState();

async function loadSDK() {
  try {
    // Если CDN недоступен или тормозит — не висим, а работаем автономно
    const mod = await withTimeout(import(SDK_URL).catch(() => null), TIMEOUT_MS, null);
    if (!mod) return null;
    return mod.default || mod;
  } catch (e) {
    console.warn("[стек] SDK Owlbear Rodeo не загрузился, работаем автономно:", e);
    return null;
  }
}

async function loadState() {
  if (mode.obr) {
    try {
      const meta = await withTimeout(OBR.scene.getMetadata(), TIMEOUT_MS, null);
      const raw = meta && (meta[META_KEY] || (meta.items && meta.items[META_KEY]));
      if (raw) {
        try { lastSavedJson = JSON.stringify(raw); } catch {}
        return sanitize(raw);
      }
      return newState();
    } catch (e) {
      console.warn("[стек] Не удалось прочитать метаданные сцены:", e);
      return newState();
    }
  }
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? sanitize(JSON.parse(raw)) : newState();
  } catch {
    return newState();
  }
}

async function persist() {
  if (mode.obr) {
    if (!mode.gm) return;            // игроки только смотрят
    try {
      const json = JSON.stringify(state);
      lastSavedJson = json;
      await withTimeout(OBR.scene.setMetadata({ [META_KEY]: state }), TIMEOUT_MS, null);
    } catch (e) {
      console.warn("[стек] Не удалось сохранить состояние:", e);
      toast("Не удалось сохранить состояние в сцене");
    }
  } else {
    try { 
      const json = JSON.stringify(state);
      lastSavedJson = json;
      localStorage.setItem(LOCAL_KEY, json); 
    } catch { /* переполнение */ }
  }
}

// Применить действие: изменить состояние, сохранить, перерисовать
async function act(fn) {
  const result = fn(state);
  if (result === null || result === false) return result;
  await persist();
  render();
  return result;
}

/* ---------- 7. Экран ------------------------------------------------------ */

const els = {};

function collectElements() {
  ["round", "mode", "token", "hint", "btnDraw", "btnCommit",
   "btnReturn", "btnUndo", "btnNewRound", "btnAim", "stackinfo", "list",
   "empty", "fName", "fType", "fInit", "btnAdd", "addNote", "log",
   "btnData", "dataPanel", "dataArea", "btnExport", "btnImport", "btnReset",
   "dataNote", "banner", "bannerSub", "toast"].forEach((id) => { els[id] = $(id); });
}

function participantColor(p) {
  return p.type === "enemy" ? "#d64545"
       : p.type === "henchman" ? "#ffd400"
       : p.color;
}

function render() {
  const gm = mode.gm;
  const current = state.current;
  const curP = current && current.id !== END_ID ? byId(state, current.id) : null;

  els.round.textContent = state.round;

  // --- режим работы ---
  if (mode.connecting) els.mode.textContent = "подключение…";
  else if (!mode.obr) {
    // Внутри Owlbear Rodeo автономный режим — это не норма, а признак того,
    // что SDK не подключился: тогда игроки ваши ходы не увидят.
    els.mode.textContent = embedded
      ? "⚠ SDK не подключился — автономный режим"
      : "автономный режим · сохраняется в браузере";
  }
  else if (gm) els.mode.textContent = "Ведущий · состояние видно игрокам";
  else els.mode.textContent = "только просмотр · управляет Ведущий";

  // --- вытянутый жетон ---
  if (curP) {
    const c = participantColor(curP);
    els.token.textContent = curP.name;
    els.token.style.background = c;
    els.token.style.color = (c === "#ffd400" || c === "#ff7bd3") ? "#000" : "#fff";
    els.token.classList.remove("empty");

    if (current.double) {
      els.hint.innerHTML = "<b>ДВОЙНОЙ БРОСОК</b> " + esc(curP.name) +
        " прицеливался раньше: бросает кубики дважды и выбирает лучший результат (6.2.2).";
    } else if (curP.type === "enemy") {
      els.hint.innerHTML = "Жетон врага. <b>Ведущий выбирает любого</b> из врагов — даже того, кто уже ходил (5.5).";
    } else if (curP.type === "henchman") {
      els.hint.innerHTML = "Жетон приспешника. <b>Ведущий выбирает, кто именно</b> из них ходит (5.4). " +
        "Жетонов столько, какова его Инициатива — обычно 1.";
    } else {
      els.hint.innerHTML = "Жетон персонажа — <b>свой цвет у каждого</b> (5.1.1). " +
        "Жетонов у него столько, какова Инициатива — обычно 2, и каждый даёт один ход.";
    }
  } else {
    els.token.textContent = "СТЕК";
    els.token.style.background = "";
    els.token.style.color = "";
    els.token.classList.add("empty");
    els.hint.innerHTML = poolSize(state) > 0
      ? "Жетон не вытянут. Нажмите <b>«Вытянуть жетон»</b> — Стек решит, кто ходит (5.2)."
      : "В Стеке пусто. Нажмите <b>«Новый раунд»</b>, чтобы собрать жетоны заново (5.1).";
  }

  // --- кнопки ---
  const emptyPool = poolSize(state) === 0;
  els.btnDraw.disabled = !gm || emptyPool;
  els.btnCommit.disabled = !gm || !current;
  els.btnReturn.disabled = !gm || !current;
  els.btnUndo.disabled = !gm || state.history.length === 0;
  els.btnNewRound.disabled = !gm;

  // Игроки только смотрят: форма добавления и правка — у Ведущего
  els.btnAdd.disabled = !gm;
  els.fName.disabled = !gm;
  els.fType.disabled = !gm;
  els.fInit.disabled = !gm;

  const canAim = gm && current && curP && curP.type !== "enemy";
  els.btnAim.classList.toggle("hidden", !canAim);
  els.btnAim.textContent = (canAim && curP.aiming) ? "Снять прицел" : "Прицелиться (6.2.2)";

  // --- счётчик Стека ---
  const c = counts(state);
  const total = poolSize(state);
  const parts = [];
  if (c.pc) parts.push(`персонажи ${c.pc}`);
  if (c.henchman) parts.push(`приспешники ${c.henchman}`);
  if (c.enemy) parts.push(`враги ${c.enemy}`);
  parts.push(state.endLeft ? "конец раунда 1" : "конец раунда — 0");
  els.stackinfo.innerHTML = `В Стеке: <b>${total}</b> ${plural(total, "жетон", "жетона", "жетонов")} — ${parts.join(" · ")}`;

  // --- список участников ---
  els.empty.classList.toggle("hidden", state.participants.length > 0);
  els.list.innerHTML = state.participants.map((p) => {
    const alive = p.alive;
    const cls = ["row"];
    if (!alive) cls.push("dead");
    if (current && current.id === p.id) cls.push("current");
    const hint = TYPE_LABEL[p.type];
    // Инициативу можно менять у любого участника: от неё зависит, сколько
    // жетонов он даёт в Стек (5.1.1 персонажи, 5.1.2 враги, 5.4 приспешники)
    const initBox = `
      <span class="inil">иниц</span>
      <input class="ini" type="number" min="1" max="99" step="1" value="${p.init}"
             data-act="init" title="Инициатива: сколько жетонов даёт этот участник"
             aria-label="Инициатива: ${esc(p.name)}" ${gm ? "" : "disabled"}>`;
    return `<li class="${cls.join(" ")}" style="--c:${participantColor(p)}" data-id="${p.id}">
      <span class="chip"></span>
      <span class="nm">${esc(p.name)}</span>
      <span class="ty">${esc(hint)}</span>${initBox}
      <span class="tk">${alive ? p.tokens : "—"} / ${tokensFor(Object.assign({}, p, { alive: true }))}</span>
      ${p.aiming ? `<button class="badge" data-act="aim" title="Снять прицел (6.2.2)">прицел</button>` : ""}
      <button class="ico" data-act="alive" title="${alive ? "Отметить выбывшим" : "Вернуть в бой"}">${alive ? "☠" : "↺"}</button>
      <button class="ico" data-act="del" title="Удалить">×</button>
    </li>`;
  }).join("");

  // --- лента ---
  els.log.innerHTML = state.log.length
    ? state.log.slice().reverse().map((e) =>
        `<li class="${e.k}"><time>${esc(e.m)}</time>${esc(e.t)}</li>`).join("")
    : `<li><time>—</time>Событий пока нет</li>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

/* ---------- 8. Уведомления ------------------------------------------------ */

let toastTimer = null;

function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 2600);
}

let bannerTimer = null;

function showBanner(text) {
  els.bannerSub.textContent = text;
  els.banner.classList.remove("hidden");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => els.banner.classList.add("hidden"), 4500);
}

function popToken() {
  els.token.classList.add("pop");
  setTimeout(() => els.token.classList.remove("pop"), 180);
}

/* ---------- 9. Обработчики ------------------------------------------------ */

async function doDraw() {
  const res = await act(drawToken);
  if (res === null) { toast("В Стеке пусто — начните новый раунд"); return; }
  if (res.kind === "end") showBanner(`Раунд ${res.from} → раунд ${res.to}`);
  else popToken();
}

function bindUI() {
  els.btnDraw.addEventListener("click", doDraw);

  els.btnCommit.addEventListener("click", () => act(commitTurn));
  els.btnReturn.addEventListener("click", async () => {
    const res = await act(returnToken);
    if (res === null) toast("В истории нет записи о вытягивании");
  });
  els.btnUndo.addEventListener("click", () => act(undoLast));
  els.btnNewRound.addEventListener("click", () => act(newRound));
  els.btnAim.addEventListener("click", () => act(toggleAim));

  els.banner.addEventListener("click", () => els.banner.classList.add("hidden"));

  // Поле Инициативы есть у всех типов (5.1.1, 5.1.2, 5.4):
  // у персонажа по умолчанию 2, у приспешника — 1, у врага — 2
  const syncType = () => {
    const t = els.fType.value;
    els.fInit.style.display = "";
    els.fInit.title = t === "enemy"
      ? "Значение Инициативы врага: сколько жетонов он даёт в Стек (5.1.2)"
      : t === "henchman"
        ? "Сколько жетонов даст приспешник — по умолчанию 1 (5.4)"
        : "Сколько жетонов получит персонаж — по умолчанию 2 (5.1.1)";
    els.addNote.textContent =
      t === "enemy"
        ? "Враг добавит столько жетонов, каково его значение Инициативы (5.1.2)."
        : t === "henchman"
          ? "Приспешник даст столько жетонов, какова его Инициатива — по умолчанию 1 (5.4)."
          : "Персонаж получит столько жетонов, какова его Инициатива — по умолчанию 2 (5.1.1).";
  };
  els.fType.addEventListener("change", () => {
    els.fInit.value = defaultInit(els.fType.value);   // новый тип — своё значение по умолчанию
    syncType();
  });
  syncType();

  const addFromForm = () => {
    const name = els.fName.value.trim();
    if (!name) { toast("Введите имя"); els.fName.focus(); return; }
    const type = els.fType.value;
    act((s) => addParticipant(s, name, type, els.fInit.value));
    els.fName.value = "";
    els.fName.focus();
  };
  els.btnAdd.addEventListener("click", addFromForm);
  els.fName.addEventListener("keydown", (e) => { if (e.key === "Enter") addFromForm(); });

  // Правка Инициативы прямо в строке участника
  els.list.addEventListener("change", (e) => {
    const inp = e.target.closest("input[data-act='init']");
    if (!inp) return;
    const id = inp.closest("li").dataset.id;
    act((s) => {
      const p = byId(s, id);
      if (!p) return false;
      const next = initValue(p.type, inp.value);
      inp.value = next;                       // сразу показываем проверенное число
      if (next === p.init) return false;
      const old = p.init;
      pushHistory(s, p.id, snapBefore(s, { init: [p.id], tokens: [p.id] }),
                  `${p.name}: инициатива ${old} → ${next}`);
      // Жетоны двигаем на разницу, а не заполняем заново: уже потраченный
      // в этом раунде жетон не должен вернуться просто от правки числа.
      const delta = next - old;
      p.init = next;
      p.tokens = Math.max(0, Math.min(tokensFor(p), p.tokens + delta));
      logAdd(s, `${p.name}: инициатива ${old} → ${next} — жетонов ${p.tokens}`, "");
      return true;
    });
  });

  // Кнопки внутри списка участников
  els.list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("li").dataset.id;
    const actName = btn.dataset.act;

    act((s) => {
      const p = byId(s, id);
      if (!p) return false;
      if (actName === "del") {
        s.participants = s.participants.filter((x) => x.id !== id);
        if (s.current && s.current.id === id) s.current = null;
        logAdd(s, `Удалён: ${p.name}`, "back");
        return true;
      }
      if (actName === "alive") {
        p.alive = !p.alive;
        if (!p.alive) { p.tokens = 0; p.aiming = false; }
        else p.tokens = tokensFor(p);
        logAdd(s, p.alive ? `${p.name} вернулся в бой` : `${p.name} выбыл`, "back");
        return true;
      }
      if (actName === "aim") {
        p.aiming = !p.aiming;
        logAdd(s, p.aiming ? `${p.name} прицеливается (6.2.2)` : `${p.name} отменил прицел`, "back");
        return true;
      }
      return false;
    });
  });

  // --- Данные: экспорт, импорт, сброс ---
  els.btnData.addEventListener("click", () => {
    const hidden = els.dataPanel.classList.toggle("hidden");
    els.btnData.textContent = hidden ? "Данные ▸" : "Данные ▾";
  });

  els.btnExport.addEventListener("click", async () => {
    const json = JSON.stringify(state, null, 2);
    els.dataArea.value = json;
    els.dataArea.select();
    try {
      await navigator.clipboard.writeText(json);
      els.dataNote.textContent = "JSON показан в поле и скопирован в буфер обмена.";
    } catch {
      els.dataNote.textContent = "JSON показан в поле — выделите его и скопируйте (Ctrl+C).";
    }
  });

  els.btnImport.addEventListener("click", () => {
    const text = els.dataArea.value.trim();
    if (!text) { els.dataNote.textContent = "Поле пустое — вставьте JSON."; return; }
    try {
      const parsed = JSON.parse(text);
      act((s) => { const next = sanitize(parsed); Object.assign(s, next); return true; });
      els.dataNote.textContent = "Состояние загружено.";
    } catch {
      els.dataNote.textContent = "Это не похоже на JSON — проверьте текст.";
    }
  });

  // Сброс в два шага, чтобы не нажать случайно (в iframe нельзя показывать confirm)
  let armed = false;
  els.btnReset.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      els.btnReset.textContent = "Точно сбросить?";
      setTimeout(() => {
        if (!armed) return;
        armed = false;
        els.btnReset.textContent = "Сбросить всё";
      }, 4000);
      return;
    }
    armed = false;
    els.btnReset.textContent = "Сбросить всё";
    act((s) => { Object.assign(s, newState()); logAdd(s, "Состояние сброшено", "back"); return true; });
    els.dataNote.textContent = "Все данные удалены.";
  });
}

/* ---------- 10. Запуск ---------------------------------------------------- */

// Показываем ошибку прямо в панели — иначе её никто не увидит,
// а окно консоли у расширений открыть неудобно.
function showFatal(err) {
  const msg = (err && err.message) ? err.message : String(err);
  console.error("[стек] Ошибка запуска:", err);
  const modeEl = document.getElementById("mode");
  if (modeEl) modeEl.textContent = "ошибка запуска";
  const hintEl = document.getElementById("hint");
  if (hintEl) hintEl.textContent = "Ошибка запуска: " + msg;
}

// Пустое состояние — ничего ещё не настроили
function isDefault(s) {
  return s.round === 1 && s.participants.length === 0 &&
         s.history.length === 0 && s.log.length === 0 &&
         s.endLeft && s.current === null;
}

function boot() {
  // Интерфейс поднимаем сразу, не дожидаясь Owlbear Rodeo:
  // иначе первые секунды кнопки просто не отвечают.
  try {
    collectElements();
    bindUI();
    mode.connecting = true;
    render();
  } catch (e) {
    showFatal(e);
    return;
  }
  connectOBR();
}

async function connectOBR() {
  try {
    const sdk = await loadSDK();

    if (!sdk || !sdk.isAvailable) {
      // Открыли просто в браузере — работаем на localStorage
      mode.obr = false;
      mode.gm = true;
      OBR = null;
      state = await loadState();
    } else {
      OBR = sdk;
      mode.obr = true;
      mode.gm = false;

      // SDK может быть ещё не готов — ждём, но не дольше TIMEOUT_MS
      await withTimeout(new Promise((res) => {
        try { if (OBR.isReady) res(); else OBR.onReady(res); }
        catch { res(null); }
      }), TIMEOUT_MS, null);

      // Роль и состояние сцены запрашиваем одновременно: так панель
      // подключается вдвое быстрее.
      const [role, remote] = await Promise.all([
        withTimeout(Promise.resolve().then(() => OBR.player.getRole()), TIMEOUT_MS, "PLAYER"),
        loadState(),
      ]);
      mode.gm = role === "GM";

      // Если Ведущего разжаловали в игрока — сразу блокируем кнопки
      try {
        if (typeof OBR.player.onChange === "function") {
          OBR.player.onChange((p) => {
            if (!p || !p.role) return;
            mode.gm = p.role === "GM";
            render();
          });
        }
      } catch (e) { console.warn("[стек] не подписались на смену роли:", e); }

      // Игроки узнают о новых ходах отсюда
      try {
        if (typeof OBR.scene.onMetadataChange === "function") {
          OBR.scene.onMetadataChange((meta) => {
            const raw = meta && (meta[META_KEY] || (meta.items && meta.items[META_KEY]));
            if (!raw) return;
            try {
              const incoming = JSON.stringify(raw);
              if (lastSavedJson && incoming === lastSavedJson) return;
              lastSavedJson = incoming;
            } catch { /* игнор */ }
            state = sanitize(raw);
            render();
          });
        }
      } catch (e) { console.warn("[стек] не подписались на метаданные сцены:", e); }

      // Если мы уже успели поработать в автономном режиме, пока ждали OBR, —
      // не затираем эти данные пустым состоянием сцены, а наоборот отправим их туда.
      if (!isDefault(state) && isDefault(remote)) await persist();
      else state = remote;
    }
  } catch (e) {
    showFatal(e);
  } finally {
    mode.connecting = false;
    render();
  }
}

boot();
