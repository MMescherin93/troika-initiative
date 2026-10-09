/* ==========================================================================
   Тройка! — СТЕК ИНИЦИАТИВЫ
   ==========================================================================

   По правилам «Тройки!» инициатива — это не бросок, а ёмкость с жетонами
   (раздел 5 правил, https://troika.wishport.online/initiative):

     5.1.1  Каждый персонаж получает 2 жетона своего цвета.
     5.1.2  Враги добавляют столько жетонов, каково их значение Инициативы.
     5.1.3  Плюс один жетон уникального цвета — Жетон Конца раунда.
     5.2    Ведущий вынимает жетон наугад — тот и ходит.
     5.3    Выпал Конец раунда → все жетоны возвращаются в Стек, раунд +1,
            убираются погибшие, разбираются эффекты (огонь, яд, кровотечение).
     5.4    Приспешники дают по одному жетону, все одинаковые.
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

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
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
    v: 1,
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
        init: clampNum(src.init, 2, 0, 99),
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
      .map((e) => ({ actor: e.actor.slice(0, 40), snap: sanitizeSnap(e.snap, s) }));
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

function sanitizeSnap(snap, s) {
  const out = { round: s.round, endLeft: s.endLeft, tokens: {}, aiming: {} };
  if (!snap || typeof snap !== "object") return out;
  out.round = clampNum(snap.round, s.round, 1, 9999);
  out.endLeft = snap.endLeft !== false;
  if (snap.tokens && typeof snap.tokens === "object") {
    for (const p of s.participants) {
      if (p.id in snap.tokens) {
        out.tokens[p.id] = clampNum(snap.tokens[p.id], p.tokens, 0, 99);
      }
    }
  }
  if (snap.aiming && typeof snap.aiming === "object") {
    for (const p of s.participants) {
      if (p.id in snap.aiming) out.aiming[p.id] = snap.aiming[p.id] === true;
    }
  }
  return out;
}

function logAdd(s, text, kind) {
  s.log.push({ t: text, k: kind || "", m: nowTime() });
  if (s.log.length > MAX_LOG) s.log = s.log.slice(-MAX_LOG);
}

/* ---------- 4. Правила: построение Стека --------------------------------- */

// Сколько жетонов даёт этот участник (5.1.1, 5.1.2, 5.4)
function tokensFor(p) {
  if (!p.alive) return 0;
  if (p.type === "pc") return 2;
  if (p.type === "henchman") return 1;
  return Math.max(0, Math.min(99, p.init));
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
function snapshot(s) {
  const tokens = {}, aiming = {};
  s.participants.forEach((p) => { tokens[p.id] = p.tokens; aiming[p.id] = !!p.aiming; });
  return { round: s.round, endLeft: s.endLeft, tokens, aiming };
}

function restore(s, snap) {
  if (!snap) return;
  s.round = clampNum(snap.round, s.round, 1, 9999);
  s.endLeft = snap.endLeft !== false;
  s.participants.forEach((p) => {
    if (p.id in snap.tokens) p.tokens = Math.min(clampNum(snap.tokens[p.id], p.tokens, 0, 99), tokensFor(p));
    if (p.id in snap.aiming) p.aiming = snap.aiming[p.id] === true;
  });
}

function pushHistory(s, actor, snap) {
  s.history.push({ actor, snap });
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

  const snap = snapshot(s);
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

// 6.4 Отсрочка + отмена последнего вытягивания
function undoLast(s) {
  const e = s.history.pop();
  if (!e) return null;
  restore(s, e.snap);
  s.current = null;
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
  pushHistory(s, "NEWROUND", snapshot(s));
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
    init: type === "enemy" ? clampNum(init, 2, 1, 99) : 0,
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

const mode = { obr: false, gm: true };
let OBR = null;
let state = newState();

async function loadSDK() {
  try {
    // Если CDN недоступен или тормозит — не висим, а работаем автономно
    const mod = await withTimeout(import(SDK_URL), TIMEOUT_MS, null);
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
      const raw = meta && meta[META_KEY];
      return raw ? sanitize(raw) : newState();
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
      await withTimeout(OBR.scene.setMetadata({ [META_KEY]: state }), TIMEOUT_MS, null);
    } catch (e) {
      console.warn("[стек] Не удалось сохранить состояние:", e);
      toast("Не удалось сохранить состояние в сцене");
    }
  } else {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch { /* переполнение */ }
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
  if (!mode.obr) els.mode.textContent = "автономный режим · сохраняется в браузере";
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
      els.hint.innerHTML = "Жетон приспешника. <b>Ведущий выбирает, кто именно</b> из них ходит (5.4).";
    } else {
      els.hint.innerHTML = "Жетон персонажа — <b>свой цвет у каждого</b> (5.1.1). Обычно это один ход.";
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
    const hint = `${TYPE_LABEL[p.type]}` + (p.type === "enemy" ? `, Инициатива ${p.init}` : "");
    return `<li class="${cls.join(" ")}" style="--c:${participantColor(p)}" data-id="${p.id}">
      <span class="chip"></span>
      <span class="nm">${esc(p.name)}</span>
      <span class="ty">${esc(hint)}</span>
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
  els.btnReturn.addEventListener("click", () => act(undoLast));
  els.btnUndo.addEventListener("click", () => act(undoLast));
  els.btnNewRound.addEventListener("click", () => act(newRound));
  els.btnAim.addEventListener("click", () => act(toggleAim));

  els.banner.addEventListener("click", () => els.banner.classList.add("hidden"));

  // Поле Инициативы нужно только врагам (5.1.2)
  const syncType = () => {
    const isEnemy = els.fType.value === "enemy";
    els.fInit.style.display = isEnemy ? "" : "none";
    els.addNote.textContent = isEnemy
      ? "Враг добавит столько жетонов, каково его значение Инициативы (5.1.2)."
      : "Персонажам даётся 2 жетона, приспешникам — 1 (5.1.1, 5.4).";
  };
  els.fType.addEventListener("change", syncType);
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

async function boot() {
  collectElements();

  OBR = await loadSDK();

  // Внутри Owlbear Rodeo — держим состояние в метаданных сцены
  if (OBR && OBR.isAvailable) {
    await withTimeout(new Promise((res) => {
      if (OBR.isReady) res();
      else OBR.onReady(res);
    }), TIMEOUT_MS, null);

    mode.obr = true;
    mode.gm = false;
    try {
      mode.gm = (await withTimeout(OBR.player.getRole(), TIMEOUT_MS, "PLAYER")) === "GM";
    } catch { mode.gm = false; }

    // Если Ведущего разжаловали в игрока — сразу блокируем кнопки
    OBR.player.onChange((p) => {
      if (!p || !p.role) return;
      mode.gm = p.role === "GM";
      render();
    });

    // Игроки узнают о новых ходах отсюда
    OBR.scene.onMetadataChange((meta) => {
      const raw = meta && meta[META_KEY];
      if (!raw) return;
      state = sanitize(raw);
      render();
    });
  } else {
    // Открыли просто в браузере — работаем на localStorage
    mode.obr = false;
    mode.gm = true;
    OBR = null;
  }

  state = await loadState();
  bindUI();
  render();
}

boot();
