/* 공부방 진도표 - 바닐라 JS + Supabase (빌드 과정 없음) */
"use strict";

const cfg = window.APP_CONFIG || {};
const configured = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes("YOUR-PROJECT") && cfg.SUPABASE_KEY && !cfg.SUPABASE_KEY.includes("YOUR-ANON");
const db = configured ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY) : null;

const state = {
  students: [],
  textbooks: [],
  progress: [],          // 전체 학생의 교재 진도
  recentLessons: [],     // 최근 30일 (전체 현황용)
  recentTests: [],       // 최근 90일 (전체 현황용)
  view: "overview",      // overview | evals | recs | student
  pendingRecs: 0,
  recFilter: { range: "thisWeek", start: "", end: "" },
  lessonFilter: { range: "thisWeek", start: "", end: "" },
  testFilter: { range: "thisWeek", start: "", end: "" },
  allRecs: [],
  evals: { year: new Date().getFullYear(), month: new Date().getMonth() + 1, studentId: null, data: null, loading: false, failed: false, key: "" },
  studentId: null,
  progView: "card",      // card | week (교재 진도 탭 보기 방식)
  tab: "progress",       // progress | lessons | tests | report
  report: { range: "thisWeek", start: "", end: "", comment: "" },
  detail: { lessons: [], tests: [], logs: [], logsMissing: false, recs: [] },
  showInactive: false,
  schedule: { slots: [], missing: false, draft: null },
};

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------- 유틸 ---------- */
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function todayStr() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}
function daysBetween(dateStr) {
  if (!dateStr) return null;
  const a = new Date(dateStr + "T00:00:00");
  const b = new Date(todayStr() + "T00:00:00");
  return Math.round((b - a) / 86400000);
}
function fmtDate(s) {
  if (!s) return "-";
  const [y, m, d] = s.split("-");
  return `${y.slice(2)}.${m}.${d}`;
}
function pct(score, max) {
  return max > 0 ? (score / max) * 100 : 0;
}
function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
}
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}
function fail(err, prefix = "오류") {
  console.error(err);
  toast(`${prefix}: ${err?.message || err}`);
}
async function run(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

/* ---------- 공용 입력 다이얼로그 ---------- */
function fieldHtml(f, value) {
  if (f.type === "slot") return `<div id="${esc(f.name)}"></div>`;
  const v = value ?? f.default ?? "";
  const req = f.required ? "required" : "";
  const label = esc(f.label);
  const name = esc(f.name);
  let control;
  if (f.type === "select") {
    control = `<select name="${name}" ${req}>${f.options
      .map(([val, text]) => `<option value="${esc(val)}" ${String(val) === String(v) ? "selected" : ""}>${esc(text)}</option>`)
      .join("")}</select>`;
  } else if (f.type === "textarea") {
    control = `<textarea name="${name}" ${req} rows="${f.rows || 4}" maxlength="${f.maxlength || 2000}">${esc(v)}</textarea>`;
  } else if (f.type === "checkbox") {
    return `<label class="check"><input type="checkbox" name="${name}" ${v ? "checked" : ""}> ${label}</label>`;
  } else {
    const extra = [f.min != null ? `min="${f.min}"` : "", f.max != null ? `max="${f.max}"` : "", f.step ? `step="${f.step}"` : "", f.maxlength ? `maxlength="${f.maxlength}"` : "", f.minlength ? `minlength="${f.minlength}"` : ""].join(" ");
    control = `<input type="${f.type || "text"}" name="${name}" value="${esc(v)}" ${req} ${extra}>`;
  }
  return `<label>${label}${control}</label>`;
}

function openForm({ title, fields, values = {}, submitLabel = "저장", onSubmit, onDelete, wide = false }) {
  const dlg = $("#dlg");
  dlg.classList.toggle("wide", wide);
  const form = $("#dlg-form");
  $("#dlg-title").textContent = title;
  $("#dlg-err").textContent = "";
  $("#dlg-submit").textContent = submitLabel;

  // 2열 배치: row 속성이 같은 필드를 묶음
  let html = "";
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.half && fields[i + 1]?.half) {
      html += `<div class="dlg-row">${fieldHtml(f, values[f.name])}${fieldHtml(fields[i + 1], values[fields[i + 1].name])}</div>`;
      i++;
    } else {
      html += fieldHtml(f, values[f.name]);
    }
  }
  $("#dlg-body").innerHTML = html;

  const delBtn = $("#dlg-delete");
  delBtn.hidden = !onDelete;
  delBtn.onclick = async () => {
    if (!confirm("정말 삭제할까요? 되돌릴 수 없습니다.")) return;
    try {
      await onDelete();
      dlg.close();
    } catch (e) {
      $("#dlg-err").textContent = e.message || String(e);
    }
  };
  $("#dlg-cancel").onclick = () => dlg.close();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (!el) continue;
      if (f.type === "checkbox") data[f.name] = el.checked;
      else if (f.type === "number") data[f.name] = el.value === "" ? null : Number(el.value);
      else if (f.type === "password") data[f.name] = el.value;
      else data[f.name] = el.value.trim() === "" ? null : el.value.trim();
    }
    $("#dlg-submit").disabled = true;
    try {
      await onSubmit(data);
      dlg.close();
    } catch (err) {
      $("#dlg-err").textContent = err.message || String(err);
    } finally {
      $("#dlg-submit").disabled = false;
    }
  };

  dlg.showModal();
  const first = form.querySelector("input, select, textarea");
  if (first) first.focus();
}

/* ---------- 데이터 로딩 ---------- */
async function loadCore() {
  const [students, textbooks, progress, lessons, tests] = await Promise.all([
    run(db.from("students").select("*").order("name")),
    run(db.from("textbooks").select("*").order("title")),
    run(db.from("progress").select("*").limit(5000)),
    run(db.from("lessons").select("student_id, lesson_date, attendance, textbook_id, from_unit, to_unit, next_plan, extra_books").gte("lesson_date", daysAgoStr(30)).limit(5000))
      .catch(() => run(db.from("lessons").select("student_id, lesson_date, attendance, textbook_id, from_unit, to_unit, next_plan").gte("lesson_date", daysAgoStr(30)).limit(5000))),
    run(db.from("tests").select("student_id, test_date, score, max_score").gte("test_date", daysAgoStr(90)).limit(5000)),
  ]);
  state.students = students;
  state.textbooks = textbooks;
  state.progress = progress;
  state.recentLessons = lessons;
  state.recentTests = tests;
  await loadSchedule();
  try {
    const pend = await run(db.from("recommendations").select("id, target_date, created_at").eq("status", "제안").limit(500));
    const wk = periodRange("thisWeek");
    state.pendingRecs = pend.filter((r) => recDate(r) >= wk.start && recDate(r) <= wk.end).length;
  } catch {
    state.pendingRecs = 0;
  }
}

async function loadDetail(studentId) {
  const [lessons, tests] = await Promise.all([
    run(db.from("lessons").select("*").eq("student_id", studentId).order("lesson_date", { ascending: false }).limit(300)),
    run(db.from("tests").select("*").eq("student_id", studentId).order("test_date", { ascending: false }).limit(300)),
  ]);
  let logs = [];
  let logsMissing = false;
  try {
    logs = await run(db.from("report_logs").select("*").eq("student_id", studentId).order("sent_at", { ascending: false }).limit(50));
  } catch {
    logsMissing = true; // schema.sql 업그레이드 전이면 발송 기록 테이블이 없음
  }
  let recs = [];
  try {
    recs = await run(db.from("recommendations").select("*").eq("student_id", studentId).order("created_at", { ascending: false }).limit(50));
  } catch {
    recs = [];
  }
  state.detail = { lessons, tests, logs, logsMissing, recs };
}

async function refresh() {
  await loadCore();
  if (state.view === "student" && state.studentId) {
    if (!state.students.some((s) => s.id === state.studentId)) {
      state.view = "overview";
      state.studentId = null;
    } else {
      await loadDetail(state.studentId);
    }
  }
  render();
}

/* ---------- 렌더링 ---------- */
function render() {
  if (state.view !== "overview") state.schedule.draft = null; // 편집 중 다른 화면으로 가면 편집 종료
  renderSidebar();
  if (state.view === "student") renderStudent();
  else if (state.view === "evals") renderEvals();
  else if (state.view === "recs") renderAllRecs();
  else renderOverview();
}

function renderSidebar() {
  $("#nav-overview").classList.toggle("active", state.view === "overview");
  $("#nav-evals").classList.toggle("active", state.view === "evals");
  $("#nav-recs").classList.toggle("active", state.view === "recs");
  const list = state.students.filter((s) => s.active || state.showInactive);
  $("#student-list").innerHTML = list.length
    ? list
        .map(
          (s) => `<li><button data-id="${esc(s.id)}" class="${s.id === state.studentId && state.view === "student" ? "active" : ""} ${s.active ? "" : "inactive"}">
            ${esc(s.name)}<span class="sub">${esc(s.grade || "")}</span></button></li>`
        )
        .join("")
    : `<li class="muted" style="padding:.5em .7em;font-size:.85rem">학생을 추가하세요.</li>`;
}

function bookProgressFor(studentId) {
  return state.progress
    .filter((p) => p.student_id === studentId)
    .map((p) => ({ p, book: state.textbooks.find((b) => b.id === p.textbook_id) }))
    .filter((x) => x.book);
}

/* 교재별 수업 요일 (progress.weekdays, 0=일 … 6=토; 비어 있으면 모든 수업) */
const dayList = (p) => (Array.isArray(p && p.weekdays) ? p.weekdays.map(Number).filter((n) => n >= 0 && n <= 6) : []);
function studentClassDays(studentId) {
  const set = new Set();
  state.schedule.slots.forEach((sl) => { if ((sl.student_ids || []).includes(studentId)) set.add(sl.weekday); });
  return SCH_ORDER.filter((d) => set.has(d));
}
const dayChips = (p) => {
  const ds = dayList(p);
  return ds.length ? SCH_ORDER.filter((d) => ds.includes(d)).map((d) => `<span class="dchip on">${DAY_NAME[d]}</span>`).join("") : `<span class="dchip">모든 수업</span>`;
};
/* 요일 선택 칩 (다이얼로그 안 slot 에 붙임). sel 은 Set<number> */
function mountDayPicker(hostId, sel, classDays) {
  const host = $("#" + hostId);
  const paint = () => {
    host.innerHTML = `<div class="dp-head"><span class="dp-t">수업 요일</span>
        <span class="dp-q"><button type="button" class="tb-sub plain" data-dp="class" ${classDays.length ? "" : "disabled"}>수업 요일 모두</button><button type="button" class="tb-sub plain" data-dp="none">선택 해제</button></span></div>
      <div class="dp-grid">${SCH_ORDER.map((d) => `<button type="button" class="dp-d ${sel.has(d) ? "on" : ""}" data-d="${d}" aria-pressed="${sel.has(d)}">${DAY_NAME[d]}<i class="${classDays.includes(d) ? "dot" : ""}"></i></button>`).join("")}</div>
      ${classDays.length ? `<div class="dp-leg"><i class="dot"></i>시간표에 있는 수업 요일</div>` : `<div class="dp-leg">이 학생은 시간표에 배정된 수업 요일이 없어요</div>`}
      <div class="dp-note">${sel.size ? `<b>${SCH_ORDER.filter((d) => sel.has(d)).map((d) => DAY_NAME[d]).join("·")}</b> 수업에 이 교재가 나와요.` : `요일을 고르지 않으면 <b>모든 수업</b>에서 쓰는 교재로 배정돼요.`}</div>`;
  };
  host.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.d != null) { const d = Number(b.dataset.d); sel.has(d) ? sel.delete(d) : sel.add(d); }
    else if (b.dataset.dp === "class") classDays.forEach((d) => sel.add(d));
    else if (b.dataset.dp === "none") sel.clear();
    paint();
  };
  paint();
}
const weekdaysErr = (e) => (/weekdays/i.test((e && e.message) || "") ? new Error("요일을 저장하려면 최신 schema.sql 을 Supabase 에서 먼저 실행하세요.") : e);

/* 교재 구조(트리): structure = { items: [{ name, children?: [이름…] }] }
   하위가 없는 1레벨 항목과 2레벨 항목이 "단원"이고, 위에서부터 세어 1~total_units 번호를 붙입니다.
   진도·수업 기록·추천은 이 누적 번호만 쓰고, 화면에서만 "Unit 2 › Part B" 로 풀어서 보여줍니다.
   structure 가 없는 교재는 예전처럼 "Unit 1~N" 한 줄 번호입니다. */
function bookLeaves(book) {
  if (!book || !book.structure || !Array.isArray(book.structure.items)) return null;
  if (book._leavesSrc !== book.structure) {
    const out = [];
    book.structure.items.forEach((it, ti) => {
      const kids = Array.isArray(it.children) ? it.children : [];
      if (kids.length) kids.forEach((k, ci) => out.push({ top: ti, child: ci, label: `${it.name} › ${k}`, topName: it.name, kidName: k }));
      else out.push({ top: ti, child: -1, label: it.name, topName: it.name, kidName: null });
    });
    book._leaves = out;
    book._leavesSrc = book.structure;
  }
  return book._leaves;
}
function unitName(book, n) {
  const lv = bookLeaves(book);
  if (lv) return lv[n - 1] ? lv[n - 1].label : `${n}번째`;
  return `${book.unit_label} ${n}`;
}
function curNum(book, n) {
  if (!bookLeaves(book)) return `${n}/${book.total_units}`;
  return n > 0 ? `${unitName(book, n)} (${n}/${book.total_units})` : `시작 전 (0/${book.total_units})`;
}
function curLabel(book, n) {
  return bookLeaves(book) ? curNum(book, n) : `${book.unit_label} ${n}/${book.total_units}`;
}
function rangeText(book, l) {
  const a = l.from_unit, b = l.to_unit;
  const lv = bookLeaves(book);
  if (lv) {
    if (a != null && b != null) {
      if (a === b) return ` ${unitName(book, a)}`;
      const x = lv[a - 1], y = lv[b - 1];
      if (x && y && x.top === y.top && x.kidName && y.kidName) return ` ${x.topName} › ${x.kidName}–${y.kidName}`;
      return ` ${unitName(book, a)} ~ ${unitName(book, b)}`;
    }
    if (b != null) return ` ~${unitName(book, b)}`;
    if (a != null) return ` ${unitName(book, a)}~`;
    return "";
  }
  const lab = book.unit_label;
  if (a != null && b != null) return a === b ? ` ${lab} ${a}` : ` ${lab} ${a}–${b}`;
  if (b != null) return ` ${lab} ~${b}`;
  if (a != null) return ` ${lab} ${a}~`;
  return "";
}

/* 들여쓰기 목록 ↔ 구조: 한 줄에 항목 하나, 앞에 공백(또는 탭)을 두면 바로 윗 항목의 하위 */
function parseOutline(text) {
  const items = [];
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (!raw.trim()) return;
    const sub = /^[ \t\u3000]/.test(raw);
    const name = raw.trim().replace(/^[-•*]\s*/, "").slice(0, 60);
    if (!name) return;
    if (sub) {
      if (!items.length) throw new Error(`${i + 1}번째 줄: 하위 항목 위에 상위 항목이 필요합니다.`);
      (items[items.length - 1].children ||= []).push(name);
    } else items.push({ name });
  });
  if (!items.length) throw new Error("항목을 한 줄 이상 입력하세요.");
  const leaves = items.reduce((n, it) => n + (it.children ? it.children.length : 1), 0);
  if (leaves > 500) throw new Error(`단원이 너무 많습니다 (${leaves}개, 최대 500개).`);
  return { structure: { items }, leaves };
}
function outlineText(structure) {
  return ((structure && structure.items) || []).map((it) => [it.name, ...(it.children || []).map((c) => "  " + c)].join("\n")).join("\n");
}

/* 번호 입력칸 ↔ 선택 목록: 트리형 교재는 이름으로 고르게 바꿔 줌 (값은 누적 번호 그대로) */
function swapUnitCtl(form, name, book, opts = {}) {
  const el = form.elements[name];
  if (!el) return;
  const lv = bookLeaves(book);
  const cur = el.value;
  let nel;
  if (lv) {
    nel = document.createElement("select");
    nel.innerHTML = `<option value="${opts.zero ? "0" : ""}">${opts.zero ? "시작 전" : "-"}</option>` + lv.map((l, i) => `<option value="${i + 1}">${esc(l.label)}</option>`).join("");
    nel.value = cur && Number(cur) >= (opts.zero ? 0 : 1) && Number(cur) <= lv.length ? String(Number(cur)) : (opts.zero ? "0" : "");
  } else {
    if (el.tagName === "INPUT") return;
    nel = document.createElement("input");
    nel.type = "number";
    nel.min = "0";
    nel.value = cur;
  }
  nel.name = name;
  el.replaceWith(nel);
}
function bindUnitCtls(form, names, opts = {}) {
  const sel = form.elements.textbook_id;
  const apply = () => {
    const b = state.textbooks.find((x) => x.id === sel.value);
    names.forEach((nm) => swapUnitCtl(form, nm, b, opts));
  };
  sel.addEventListener("change", apply);
  apply();
}

/* 한 번의 수업에서 나간 교재들: 첫 교재는 기존 컬럼(textbook_id…), 둘째부터는 extra_books(JSON)에 저장 */
function lessonBooks(l) {
  const out = [];
  if (l && l.textbook_id) out.push({ textbook_id: l.textbook_id, from_unit: l.from_unit, to_unit: l.to_unit, topic: l.topic });
  if (l && Array.isArray(l.extra_books)) l.extra_books.forEach((e) => { if (e && e.textbook_id) out.push(e); });
  return out;
}
function coverText(l) {
  return lessonBooks(l)
    .map((b) => {
      const book = state.textbooks.find((x) => x.id === b.textbook_id);
      return book ? book.title + rangeText(book, b) : "";
    })
    .filter(Boolean)
    .join(" · ");
}
function topicText(l) {
  return [l && l.topic, ...((l && Array.isArray(l.extra_books) ? l.extra_books : []).map((e) => e && e.topic))].filter(Boolean).join(" · ");
}

/* ---------- 수업 시간표 (전체 현황) ---------- */
const SCH_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월~일 순서 (0=일)
const DAY_NAME = "일월화수목금토";
const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === "x" ? r : (r & 3) | 8).toString(16); }));
const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
function timeText(a, b) {
  if (!hhmm(a) && !hhmm(b)) return "";
  return `${hhmm(a) || "?"} – ${hhmm(b) || "?"}`;
}
async function loadSchedule() {
  try {
    state.schedule.slots = await run(db.from("schedule_slots").select("*").order("weekday").order("slot_order").limit(300));
    state.schedule.missing = false;
  } catch {
    state.schedule.slots = [];
    state.schedule.missing = true; // schema.sql 업그레이드 전
  }
}
function groupDays(slots) {
  return SCH_ORDER.map((wd) => ({ wd, slots: slots.filter((s) => s.weekday === wd).sort((a, b) => (a.slot_order || 0) - (b.slot_order || 0)) })).filter((d) => d.slots.length);
}
function scheduleHtml() {
  const sc = state.schedule;
  const head = `<div class="sch-head"><h3>수업 시간표</h3><span class="muted">매주 반복 · 이름을 누르면 학생 화면으로 이동</span><span class="spacer"></span>${sc.missing ? "" : `${sc.slots.length ? `<button class="btn small" id="sch-print" type="button">시간표 미리보기</button>` : ""}`}</div>`;
  if (sc.missing) return `<section class="sch">${head}<div class="card empty">시간표를 쓰려면 최신 <code>schema.sql</code> 을 Supabase SQL Editor에서 한 번 실행하세요.</div></section>`;
  const days = groupDays(sc.slots);
  if (!days.length) return `<section class="sch">${head}<div class="card empty">아직 시간표가 없습니다. 왼쪽 아래 <strong>시간표 편집</strong>에서 요일과 타임을 만들어 보세요.</div></section>`;
  const active = state.students.filter((s) => s.active);
  const today = new Date().getDay();
  const rows = days.map((d) => d.slots.map((sl, i) => {
    const names = active.filter((s) => (sl.student_ids || []).includes(s.id));
    const tm = timeText(sl.start_time, sl.end_time);
    return `<tr class="${i === 0 ? "sch-first" : ""} ${d.wd === today ? "sch-today" : ""}">
      ${i === 0 ? `<th class="sch-day ${d.wd === today ? "today" : ""}" rowspan="${d.slots.length}" scope="rowgroup"><b>${DAY_NAME[d.wd]}</b>${d.wd === today ? "<em>오늘</em>" : ""}</th>` : ""}
      <td class="sch-slot"><b>${esc(sl.label || "타임 " + (i + 1))}</b>${tm ? `<span>${tm}</span>` : ""}</td>
      <td class="sch-names"><div class="w">${names.length ? names.map((s) => `<button type="button" class="sch-chip" data-sch-sid="${esc(s.id)}">${esc(s.name)}</button>`).join("") : `<span class="muted">-</span>`}</div></td>
      <td class="sch-cnt">${names.length}명</td></tr>`;
  }).join("")).join("");
  // 넓은 화면: 요일을 열로 펼친 격자 / 좁은 화면: 위의 요일별 목록
  const rowsN = Math.max(...days.map((d) => d.slots.length));
  const grid = Array.from({ length: rowsN }, (_, i) => {
    const first = (days.find((d) => d.slots[i]) || { slots: [] }).slots[i];
    const same = days.every((d) => !d.slots[i] || timeText(d.slots[i].start_time, d.slots[i].end_time) === timeText(first.start_time, first.end_time));
    const rtime = same ? timeText(first.start_time, first.end_time) : "";
    const cells = days.map((d) => {
      const sl = d.slots[i];
      const cls = d.wd === today ? "today" : "";
      if (!sl) return `<td class="off ${cls}"></td>`;
      const names = active.filter((s) => (sl.student_ids || []).includes(s.id));
      const tm = rtime ? "" : timeText(sl.start_time, sl.end_time);
      return `<td class="${cls}"><div class="sg-top"><span>${esc(tm)}</span><span>${names.length}명</span></div><div class="sg-chips">${names.length ? names.map((s) => `<button type="button" class="sch-chip" data-sch-sid="${esc(s.id)}">${esc(s.name)}</button>`).join("") : `<span class="muted">-</span>`}</div></td>`;
    }).join("");
    return `<tr><th class="sg-rt" scope="row"><b>${esc(first.label || "타임 " + (i + 1))}</b>${rtime ? `<span>${rtime}</span>` : ""}</th>${cells}</tr>`;
  }).join("");
  const gridHead = days.map((d) => `<th scope="col" class="${d.wd === today ? "today" : ""}">${DAY_NAME[d.wd]}${d.wd === today ? "<em>오늘</em>" : ""}</th>`).join("");
  return `<section class="sch">${head}
    <div class="card sch-card sch-wide"><table class="sch-grid"><thead><tr><th></th>${gridHead}</tr></thead><tbody>${grid}</tbody></table></div>
    <div class="card sch-card sch-narrow"><table class="sch-table"><tbody>${rows}</tbody></table></div></section>`;
}
function schedulePrintHtml(orient = "p", zoom = 1) {
  const zs = zoom < 1 ? ` style="zoom:${zoom}"` : "";
  const days = groupDays(state.schedule.slots);
  const active = state.students.filter((s) => s.active);
  const namesOf = (sl) => active.filter((s) => (sl.student_ids || []).includes(s.id));
  const chips = (names) => names.length ? names.map((s) => `<span class="tp-name">${esc(s.name)}</span>`).join("") : `<span class="tp-empty">-</span>`;
  const foot = `<div class="rp-foot"><span>${esc(ACADEMY_NAME)}</span><span>${shortDate(todayStr())} 출력</span></div>`;
  if (orient === "l") {
    const rowsN = Math.max(...days.map((d) => d.slots.length));
    const rowHead = Array.from({ length: rowsN }, (_, i) => {
      const sl = (days.find((d) => d.slots[i]) || { slots: [] }).slots[i];
      const same = days.every((d) => !d.slots[i] || timeText(d.slots[i].start_time, d.slots[i].end_time) === timeText(sl.start_time, sl.end_time));
      return { label: (sl && sl.label) || "타임 " + (i + 1), time: same && sl ? timeText(sl.start_time, sl.end_time) : "" };
    });
    const body = rowHead.map((rh, i) => `<tr><th class="tl-t"><b>${esc(rh.label)}</b>${rh.time ? `<span>${rh.time}</span>` : ""}</th>${days.map((d) => {
      const sl = d.slots[i];
      if (!sl) return `<td class="tl-off"></td>`;
      const tm = rh.time ? "" : timeText(sl.start_time, sl.end_time);
      return `<td>${tm ? `<div class="tl-tm">${tm}</div>` : ""}<div class="tl-n">${chips(namesOf(sl))}</div></td>`;
    }).join("")}</tr>`).join("");
    return `<div class="rp-page tp-page tp-land">
      <div class="tl-hd"><div><div class="pl-br">${esc(ACADEMY_NAME).toUpperCase()}</div><h1>수업 시간표</h1></div><span>매주 반복</span></div>
      <div class="tl-bd"${zs}><table class="tl-table"><thead><tr><th></th>${days.map((d) => `<th class="tl-d">${DAY_NAME[d.wd]}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
      ${foot}</div>`;
  }
  const block = (d) => `<div class="tp-day"><div class="tp-d">${DAY_NAME[d.wd]}</div><div class="tp-slots">${d.slots.map((sl, i) => {
    const tm = timeText(sl.start_time, sl.end_time);
    return `<div class="tp-slot"><div class="tp-t"><b>${esc(sl.label || "타임 " + (i + 1))}</b>${tm ? `<span>${tm}</span>` : ""}</div>
      <div class="tp-n">${chips(namesOf(sl))}</div></div>`;
  }).join("")}</div></div>`;
  return `<div class="rp-page tp-page">
    <div class="pl-hd"><div class="pl-br">${esc(ACADEMY_NAME).toUpperCase()}</div><h1>수업 시간표</h1><div class="pl-who"><span>매주 반복</span></div></div>
    <div class="tp-bd"${zs}>${days.map(block).join("")}</div>
    ${foot}
  </div>`;
}
const SCH_ORIENT_KEY = "rachel_sched_orient";
function schedOrient() {
  try { return localStorage.getItem(SCH_ORIENT_KEY) === "l" ? "l" : "p"; } catch { return "p"; }
}
function openSchedPreview(returnTo, orient = schedOrient()) {
  try { localStorage.setItem(SCH_ORIENT_KEY, orient); } catch { /* 저장 실패는 무시 */ }
  openEvalPreview(schedulePrintHtml(orient), () => {
    const area = $("#sched-print-area");
    area.innerHTML = schedulePrintHtml(orient);
    area.classList.toggle("land", orient === "l");
    document.body.classList.add("print-sched");
    try { window.print(); } finally { document.body.classList.remove("print-sched"); area.classList.remove("land"); }
  }, returnTo, "시간표 미리보기", {
    land: orient === "l",
    onRender: orient === "l" ? paginateSchedLand : paginateSchedPortrait,
    orient: { value: orient, options: [["p", "세로"], ["l", "가로"]], onChange: (v) => openSchedPreview(returnTo, v) },
  });
}
function bindSchedule() {
  const pb = $("#sch-print");
  if (pb) {
    pb.onclick = () => openSchedPreview(pb);
  }
  $("#main").querySelectorAll("[data-sch-sid]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); selectStudent(b.dataset.schSid); };
  });
}

function startScheduleEdit() {
  const days = groupDays(state.schedule.slots).map((d) => ({
    wd: d.wd,
    slots: d.slots.map((s) => ({ id: s.id, label: s.label || "", start: hhmm(s.start_time), end: hhmm(s.end_time), students: [...(s.student_ids || [])] })),
  }));
  state.schedule.draft = { days, pop: null, err: "" };
  renderScheduleEdit();
}
function renderScheduleEdit() {
  const dr = state.schedule.draft;
  const main = $("#main");
  const active = state.students.filter((s) => s.active);
  const usedDays = dr.days.map((d) => d.wd);
  const unused = SCH_ORDER.filter((w) => !usedDays.includes(w));
  const block = (d, di) => {
    const slotHtml = d.slots.map((sl, si) => {
      const chips = sl.students.map((id) => active.find((s) => s.id === id)).filter(Boolean)
        .map((s) => `<span class="sch-ec">${esc(s.name)}<button type="button" data-rm="${di}.${si}.${esc(s.id)}" aria-label="${esc(s.name)} 빼기">×</button></span>`).join("");
      const popOpen = dr.pop && dr.pop.d === di && dr.pop.s === si;
      const pop = popOpen ? `<div class="sch-pop" role="dialog" aria-label="학생 배정"><h4>${DAY_NAME[d.wd]}요일 · ${esc(sl.label || "타임 " + (si + 1))}에 배정할 학생</h4>
        ${active.length ? active.map((s) => {
          const elsewhere = d.slots.map((o, oi) => (oi !== si && o.students.includes(s.id) ? o.label || "타임 " + (oi + 1) : null)).filter(Boolean);
          return `<label><input type="checkbox" data-tg="${di}.${si}.${esc(s.id)}" ${sl.students.includes(s.id) ? "checked" : ""}>${esc(s.name)}${elsewhere.length ? ` <span class="dim">· ${DAY_NAME[d.wd]} ${esc(elsewhere.join(", "))}</span>` : ""}</label>`;
        }).join("") : `<p class="muted" style="margin:.4rem">재원 중인 학생이 없습니다.</p>`}</div>` : "";
      return `<div class="sch-es"><div class="sch-et"><input class="sch-lab" data-f="label" data-di="${di}" data-si="${si}" value="${esc(sl.label)}" maxlength="30" aria-label="타임 이름" placeholder="타임 ${si + 1}">
        <div class="sch-tm"><input type="time" data-f="start" data-di="${di}" data-si="${si}" value="${esc(sl.start)}" aria-label="시작 시간"><span>~</span><input type="time" data-f="end" data-di="${di}" data-si="${si}" value="${esc(sl.end)}" aria-label="종료 시간"></div></div>
        <div class="sch-en">${chips}<span class="sch-addwrap"><button type="button" class="sch-add" data-pop="${di}.${si}">+ 학생 추가</button>${pop}</span></div>
        <button type="button" class="sch-del" data-delslot="${di}.${si}" title="타임 삭제" aria-label="타임 삭제">🗑</button></div>`;
    }).join("");
    const opts = SCH_ORDER.filter((w) => w === d.wd || unused.includes(w)).map((w) => `<option value="${w}" ${w === d.wd ? "selected" : ""}>${DAY_NAME[w]}요일</option>`).join("");
    return `<div class="card sch-ed"><div class="sch-eh"><select data-dayset="${di}" aria-label="요일">${opts}</select><span class="muted">타임 ${d.slots.length}개</span><span class="spacer"></span>
      <button type="button" class="btn small" data-addslot="${di}">+ 타임 추가</button><button type="button" class="btn small danger" data-delday="${di}">요일 삭제</button></div>${slotHtml}</div>`;
  };
  main.innerHTML = `
    <div class="page-head"><h2>수업 시간표 편집</h2><span class="muted">요일·타임·시간을 자유롭게 바꾸고 학생을 배정하세요</span></div>
    <div class="toolbar"><button class="btn small" id="sch-addday" type="button" ${unused.length ? "" : "disabled"}>+ 요일 추가</button><span class="muted" style="font-size:.85rem">필요한 요일만 추가해서 쓸 수 있어요</span></div>
    ${dr.days.length ? dr.days.map(block).join("") : `<div class="card empty">요일이 없습니다. 위의 <strong>+ 요일 추가</strong>를 눌러 시작하세요.</div>`}
    <div class="sch-foot"><span class="muted" style="font-size:.85rem;margin-right:auto">저장하기 전까지는 화면에만 반영됩니다</span><p id="sch-err" class="error" role="alert">${esc(dr.err || "")}</p>
      <button class="btn" type="button" id="sch-cancel">취소</button><button class="btn primary" type="button" id="sch-save">저장</button></div>`;
  bindScheduleEdit();
}
let schCloser = null;
function bindScheduleEdit() {
  const dr = state.schedule.draft;
  const main = $("#main");
  const re = () => renderScheduleEdit();
  const sl = (di, si) => dr.days[di].slots[si];
  main.querySelectorAll("input[data-f]").forEach((el) => {
    el.oninput = () => { sl(+el.dataset.di, +el.dataset.si)[el.dataset.f] = el.value; };
  });
  main.querySelectorAll("[data-dayset]").forEach((el) => {
    el.onchange = () => { dr.days[+el.dataset.dayset].wd = Number(el.value); dr.days.sort((a, b) => SCH_ORDER.indexOf(a.wd) - SCH_ORDER.indexOf(b.wd)); dr.pop = null; re(); };
  });
  main.querySelectorAll("[data-addslot]").forEach((el) => {
    el.onclick = () => { const d = dr.days[+el.dataset.addslot]; d.slots.push({ id: null, label: `타임 ${d.slots.length + 1}`, start: "", end: "", students: [] }); re(); };
  });
  main.querySelectorAll("[data-delslot]").forEach((el) => {
    el.onclick = () => {
      const [di, si] = el.dataset.delslot.split(".").map(Number);
      const s = sl(di, si);
      if (s.students.length && !confirm("이 타임에 배정된 학생이 있습니다. 타임을 삭제할까요?")) return;
      dr.days[di].slots.splice(si, 1);
      if (!dr.days[di].slots.length) dr.days.splice(di, 1);
      dr.pop = null; re();
    };
  });
  main.querySelectorAll("[data-delday]").forEach((el) => {
    el.onclick = () => {
      const d = dr.days[+el.dataset.delday];
      if (d.slots.some((s) => s.students.length) && !confirm(`${DAY_NAME[d.wd]}요일 시간표를 삭제할까요?`)) return;
      dr.days.splice(+el.dataset.delday, 1); dr.pop = null; re();
    };
  });
  $("#sch-addday").onclick = () => {
    const used = dr.days.map((d) => d.wd);
    const wd = SCH_ORDER.find((w) => !used.includes(w));
    if (wd === undefined) return;
    dr.days.push({ wd, slots: [{ id: null, label: "타임 1", start: "", end: "", students: [] }] });
    dr.days.sort((a, b) => SCH_ORDER.indexOf(a.wd) - SCH_ORDER.indexOf(b.wd));
    re();
  };
  main.querySelectorAll("[data-rm]").forEach((el) => {
    el.onclick = () => { const [di, si, id] = el.dataset.rm.split("."); const s = sl(+di, +si); s.students = s.students.filter((x) => x !== id); re(); };
  });
  main.querySelectorAll("[data-pop]").forEach((el) => {
    el.onclick = (e) => {
      e.stopPropagation();
      const [d, s] = el.dataset.pop.split(".").map(Number);
      dr.pop = dr.pop && dr.pop.d === d && dr.pop.s === s ? null : { d, s };
      re();
    };
  });
  main.querySelectorAll("[data-tg]").forEach((el) => {
    el.onchange = () => {
      const [di, si, id] = el.dataset.tg.split(".");
      const s = sl(+di, +si);
      s.students = el.checked ? [...s.students, id] : s.students.filter((x) => x !== id);
      re();
    };
  });
  if (schCloser) { document.removeEventListener("click", schCloser, true); schCloser = null; }
  if (dr.pop) {
    schCloser = (e) => {
      if (e.target.closest(".sch-pop")) return;
      document.removeEventListener("click", schCloser, true);
      schCloser = null;
      if (state.schedule.draft) { state.schedule.draft.pop = null; re(); }
    };
    setTimeout(() => { if (schCloser) document.addEventListener("click", schCloser, true); }, 0);
  }
  $("#sch-cancel").onclick = () => {
    if (!confirm("편집한 내용을 버리고 돌아갈까요?")) return;
    state.schedule.draft = null; render();
  };
  $("#sch-save").onclick = saveSchedule;
}
async function saveSchedule() {
  const dr = state.schedule.draft;
  const btn = $("#sch-save");
  const rows = [];
  for (const d of dr.days) {
    for (let i = 0; i < d.slots.length; i++) {
      const s = d.slots[i];
      if (s.start && s.end && s.end <= s.start) {
        dr.err = `${DAY_NAME[d.wd]}요일 ${s.label || "타임 " + (i + 1)}: 종료 시간이 시작 시간보다 늦어야 합니다.`;
        $("#sch-err").textContent = dr.err;
        return;
      }
      rows.push({ id: s.id || newId(), weekday: d.wd, slot_order: i, label: (s.label || "").trim() || `타임 ${i + 1}`, start_time: s.start || null, end_time: s.end || null, student_ids: s.students });
    }
  }
  btn.disabled = true;
  $("#sch-err").textContent = "";
  try {
    if (rows.length) await run(db.from("schedule_slots").upsert(rows, { onConflict: "id" }));
    const keep = new Set(rows.map((r) => r.id));
    const removed = state.schedule.slots.filter((s) => !keep.has(s.id)).map((s) => s.id);
    if (removed.length) await run(db.from("schedule_slots").delete().in("id", removed));
    await loadSchedule();
    state.schedule.draft = null;
    toast("시간표를 저장했습니다");
    render();
  } catch (e) {
    dr.err = "저장하지 못했습니다: " + (e.message || e);
    $("#sch-err").textContent = dr.err;
    btn.disabled = false;
  }
}

function renderOverview() {
  const main = $("#main");
  const students = state.students.filter((s) => s.active);
  if (!students.length) {
    main.innerHTML = `<div class="page-head"><h2>전체 현황</h2></div>
      <div class="card empty">아직 학생이 없습니다. 왼쪽의 <strong>+ 추가</strong>로 학생을 등록하고, <strong>교재 관리</strong>에서 교재를 먼저 만들어 보세요.</div>`;
    return;
  }

  const rows = students.map((s) => {
    const lessons = state.recentLessons.filter((l) => l.student_id === s.id);
    const last = lessons.reduce((m, l) => (l.lesson_date > m ? l.lesson_date : m), "");
    const sortedL = [...lessons].sort((a, b) => b.lesson_date.localeCompare(a.lesson_date));
    const lastCovered = sortedL.find((l) => lessonBooks(l).length);
    const nextPlan = (sortedL.find((l) => l.next_plan) || {}).next_plan || "";
    const attended = lessons.filter((l) => l.attendance !== "결석").length;
    const tests = state.recentTests.filter((t) => t.student_id === s.id);
    const avgPct = avg(tests.map((t) => pct(t.score, t.max_score)));
    const books = bookProgressFor(s.id);
    return { s, last, lessonCount: lessons.length, attended, avgPct, testCount: tests.length, books, lastCovered, nextPlan };
  });

  const stale = rows.filter((r) => !r.last).length;
  const body = rows
    .map((r) => {
      const gap = r.last ? daysBetween(r.last) : null;
      const lastCell = r.last
        ? `${fmtDate(r.last)} <span class="muted">(${gap === 0 ? "오늘" : gap + "일 전"})</span>`
        : `<span class="badge warn">30일간 기록 없음</span>`;
      const books = r.books.length
        ? `<div class="mini-books">${r.books
            .map(({ p, book }) => {
              return `<div class="row"><span>${esc(book.title)}</span><span class="muted">${p.current_unit}/${book.total_units}</span></div>`;
            })
            .join("")}</div>`
        : `<span class="muted">배정된 교재 없음</span>`;
      return `<tr class="clickable" data-id="${esc(r.s.id)}">
        <td><strong>${esc(r.s.name)}</strong><div class="muted">${esc(r.s.grade || "")}</div></td>
        <td>${books}</td>
        <td>${lastCell}</td>
        <td>${r.lastCovered && coverText(r.lastCovered) ? esc(coverText(r.lastCovered)) + `<div class="muted">${fmtDate(r.lastCovered.lesson_date)}</div>` : '<span class="muted">-</span>'}${r.nextPlan ? `<div class="next-plan">다음: ${esc(r.nextPlan)}</div>` : ""}</td>
        <td class="num">${r.lessonCount ? `${r.attended}/${r.lessonCount}회` : "-"}</td>
        <td class="num">${r.avgPct == null ? "-" : r.avgPct.toFixed(0) + "점"}<div class="muted">${r.testCount ? r.testCount + "회" : ""}</div></td>
      </tr>`;
    })
    .join("");

  if (state.schedule.draft) return renderScheduleEdit();
  main.innerHTML = `
    <div class="page-head"><h2>전체 현황</h2><span class="muted">재원생 ${students.length}명</span>
      ${stale ? `<span class="badge warn">30일간 수업 기록이 없는 학생 ${stale}명</span>` : ""}</div>
    ${scheduleHtml()}
    <div class="card table-wrap">
      <table>
        <thead><tr><th>학생</th><th>교재 진도</th><th>최근 수업</th><th>수업 진도 · 다음 예정</th><th class="num">30일 출석</th><th class="num">90일 시험 평균</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="muted" style="margin-top:.8rem;font-size:.85rem">행을 누르면 학생 상세로 이동합니다. 시험 평균은 점수를 100점 만점으로 환산한 값입니다.</p>
    <div class="eval-print" id="sched-print-area"></div>`;
  bindSchedule();
}

function renderStudent() {
  const s = state.students.find((x) => x.id === state.studentId);
  if (!s) return renderOverview();
  const main = $("#main");
  main.innerHTML = `
    <div class="page-head">
      <h2>${esc(s.name)}</h2>
      ${s.grade ? `<span class="badge">${esc(s.grade)}</span>` : ""}
      ${s.active ? "" : `<span class="badge bad">퇴원/휴원</span>`}
      <span class="spacer"></span>
      <button class="btn small" id="btn-edit-student">정보 수정</button>
    </div>
    ${s.memo ? `<p class="card muted memo-cell" style="margin:0 0 1rem">${esc(s.memo)}</p>` : ""}
    <div class="tabs" role="tablist">
      ${[["progress", "교재 진도"], ["lessons", "수업 기록"], ["tests", "시험·단어"], ["recs", "수업 추천"]]
        .map(([k, t]) => `<button class="tab ${state.tab === k ? "active" : ""}" role="tab" data-tab="${k}">${t}</button>`)
        .join("")}
    </div>
    <div id="tab-body"></div>`;
  if (state.tab === "progress") renderProgressTab(s);
  else if (state.tab === "lessons") renderLessonsTab(s);
  else if (state.tab === "report") renderReportTab(s);
  else if (state.tab === "recs") renderRecsTab(s);
  else renderTestsTab(s);
}

function renderProgressTab(s) {
  const items = bookProgressFor(s.id);
  const assignedIds = new Set(items.map((x) => x.book.id));
  const available = state.textbooks.filter((b) => !assignedIds.has(b.id));
  const nextLesson = state.detail.lessons.find((l) => l.next_plan);
  const classDays = studentClassDays(s.id);
  const week = state.progView === "week" && items.length > 0;
  const mini = ({ p, book }) => {
    return `<button type="button" class="wk-book" data-act="days" data-pid="${esc(p.id)}" title="누르면 요일을 바꿀 수 있어요"><b>${esc(book.title)}</b><span>${p.current_unit > 0 ? esc(curLabel(book, p.current_unit)) : "시작 전"}</span></button>`;
  };
  const dayCols = (() => {
    const cols = [];
    SCH_ORDER.forEach((d) => {
      const books = items.filter((x) => dayList(x.p).includes(d));
      const on = classDays.includes(d) || books.length > 0;
      const last = cols[cols.length - 1];
      if (!on && last && !last.on) { last.days.push(d); return; }
      cols.push({ days: [d], on, books, cls: classDays.includes(d) });
    });
    return cols;
  })();
  const anyDay = items.filter((x) => !dayList(x.p).length);
  const weekHtml = `<div class="wk-scroll"><div class="wk-grid" style="grid-template-columns:repeat(${dayCols.length},minmax(150px,1fr))">${dayCols.map((c) => `<div class="wk-col ${c.on ? "on" : "off"} ${c.cls ? "cls" : ""}"><div class="wk-h">${c.days.map((d) => DAY_NAME[d]).join(" · ")}${c.cls ? `<small>수업일</small>` : ""}</div>${c.on ? c.books.map(mini).join("") || `<div class="wk-none">배정된 교재 없음</div>` : `<div class="wk-none">수업 없음</div>`}</div>`).join("")}</div></div>
    ${anyDay.length ? `<div class="wk-any"><strong>요일 미지정 · 모든 수업</strong>${anyDay.map(mini).join("")}</div>` : ""}
    <div class="muted wk-tip">교재를 누르면 요일을 바꿀 수 있어요</div>`;
  const cards = items
    .map(({ p, book }) => {
      const recent = state.detail.lessons.find((l) => lessonBooks(l).some((b) => b.textbook_id === book.id));
      const recentEnt = recent ? lessonBooks(recent).find((b) => b.textbook_id === book.id) : null;
      return `<div class="card book-card" data-pid="${esc(p.id)}">
        <h3>${esc(book.title)}</h3>
        <div class="dchips">${dayChips(p)}</div>
        <div class="stat"><strong>${bookLeaves(book) ? (p.current_unit > 0 ? esc(unitName(book, p.current_unit)) : "시작 전") : esc(book.unit_label) + " " + p.current_unit} <span class="muted" style="font-size:.9rem;font-weight:400">/ ${book.total_units}</span></strong></div>
        ${recent ? `<div style="font-size:.85rem;margin-top:.5rem">최근 수업 <span class="muted">${fmtDate(recent.lesson_date)}</span> ·${esc(rangeText(book, recentEnt) || " 범위 미입력")}</div>` : ""}
        <div class="muted" style="font-size:.8rem;margin-top:.4rem">진도 갱신 ${fmtDate((p.updated_at || "").slice(0, 10))}</div>
        <div class="book-actions">
          <button class="btn small" data-act="dec">-1</button>
          <button class="btn small primary" data-act="inc">+1</button>
          <button class="btn small" data-act="set">직접 입력</button>
          <button class="btn small" data-act="days">요일 변경</button>
          <button class="btn small danger" data-act="unassign">배정 해제</button>
        </div>
      </div>`;
    })
    .join("");
  $("#tab-body").innerHTML = `
    ${nextLesson ? `<div class="card next-card"><strong>다음 수업 예정</strong><div>${esc(nextLesson.next_plan)}</div><span class="muted">${fmtDate(nextLesson.lesson_date)} 수업 기록 기준</span></div>` : ""}
    <div class="toolbar"><button class="btn primary" id="btn-assign" ${available.length ? "" : "disabled"}>+ 교재 배정</button>
      ${items.length ? `<span class="seg" role="group" aria-label="보기 방식"><button type="button" data-pv="card" aria-pressed="${!week}">카드</button><button type="button" data-pv="week" aria-pressed="${week}">요일별</button></span>` : ""}
      ${state.textbooks.length ? "" : `<span class="muted">먼저 왼쪽 아래 <strong>교재 관리</strong>에서 교재를 만드세요.</span>`}
      <span class="spacer"></span>${classDays.length ? `<span class="muted">시간표 수업 요일: ${classDays.map((d) => DAY_NAME[d]).join(" · ")}</span>` : ""}</div>
    ${!items.length ? `<div class="card empty">배정된 교재가 없습니다.</div>` : week ? weekHtml : `<div class="grid">${cards}</div>`}`;
  $("#tab-body").querySelectorAll("[data-pv]").forEach((b) => { b.onclick = () => { state.progView = b.dataset.pv; renderProgressTab(s); }; });
}

function renderLessonsTab(s) {
  const all = state.detail.lessons;
  const rows = all.filter((l) => inRange(state.lessonFilter, l.lesson_date));
  $("#tab-body").innerHTML = filterHtml(state.lessonFilter, "lf", false) + `
    <div class="toolbar"><button class="btn primary" id="btn-add-lesson">+ 수업 기록</button>
      <span class="xl-sep" aria-hidden="true"></span>
      <button class="btn xl-btn" id="btn-xl-tpl" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>양식 다운로드</button>
      <button class="btn xl-btn" id="btn-xl-up" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m0 0L6 7m4-4l4 4M4 16h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>엑셀 업로드</button>
      <input type="file" id="xl-file" accept=".xlsx" hidden>
      ${(() => { const rg = filterRange(state.lessonFilter); return rg ? `<span class="muted" style="font-size:.82rem">양식은 위 기간(${shortDate(rg.start)} ~ ${shortDate(rg.end)})으로 만들어집니다</span>` : `<span class="muted" style="font-size:.82rem">양식을 만들려면 위에서 기간을 정하세요</span>`; })()}</div>
    ${
      rows.length
        ? `<div class="card table-wrap"><table>
            <thead><tr><th>날짜</th><th>출결</th><th>수업 진도</th><th>숙제</th><th>메모 · 다음 수업</th></tr></thead>
            <tbody>${rows
              .map(
                (l) => `<tr class="clickable" data-lid="${esc(l.id)}">
                  <td style="white-space:nowrap">${fmtDate(l.lesson_date)}</td>
                  <td class="att-${esc(l.attendance)}">${esc(l.attendance)}</td>
                  <td>${esc(coverText(l)) || '<span class="muted">-</span>'}${topicText(l) ? `<div class="muted">${esc(topicText(l))}</div>` : ""}</td>
                  <td>${esc(l.homework || "-")}${l.homework_note ? `<div class="muted">${esc(l.homework_note)}</div>` : ""}</td>
                  <td class="memo-cell">${esc(l.memo || "")}${l.next_plan ? `<div class="next-plan">다음: ${esc(l.next_plan)}</div>` : ""}${l.teacher_comment ? `<div class="lesson-comment"><strong>코멘트</strong>${esc(l.teacher_comment)}</div>` : ""}</td></tr>`
              )
              .join("")}</tbody></table></div>
          <p class="muted" style="font-size:.85rem;margin-top:.6rem">행을 누르면 수정·삭제할 수 있습니다. 최근 300건까지 표시됩니다.</p>`
        : `<div class="card empty">${all.length ? "이 기간에는 수업 기록이 없습니다. 위에서 기간을 바꿔 보세요." : "수업 기록이 없습니다."}</div>`
    }`;
  bindFilter(state.lessonFilter, "lf", () => renderLessonsTab(s));
  $("#btn-xl-tpl").onclick = () => downloadLessonTemplate(s).catch((e) => fail(e));
  const fileEl = $("#xl-file");
  $("#btn-xl-up").onclick = () => fileEl.click();
  fileEl.onchange = async () => {
    const f = fileEl.files && fileEl.files[0];
    fileEl.value = "";
    if (!f) return;
    try { await uploadLessonSheet(s, f); } catch (e) { fail(e); }
  };
}

/* ---------- 수업 기록 엑셀: 양식 다운로드 / 업로드 ----------
   양식: 검색 기간의 날짜마다 행(그날 수업 추천이 있으면 교재 수만큼)을 만들고,
   일자 · 수업 계획 · 출결 · 시작 단원 · 종료 단원 · 학습내용 · 교재 열을 둡니다.
   업로드: 같은 날의 행은 한 건의 수업 기록(교재 여러 개)으로 묶어 저장합니다. 라이브러리는 처음 쓸 때만 불러옵니다. */
const XL_ATT = ["출석", "지각", "결석", "보강"];
const XL_SAME = "↑ 위와 같음";
const XL_HEAD = ["일자", "수업 계획", "출결", "시작 단원", "종료 단원", "학습내용", "교재"];
let xlsxPromise = null;
function loadXlsx() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!xlsxPromise) {
    xlsxPromise = loadScriptOnce("vendor/exceljs.min.js")
      .then(() => window.ExcelJS)
      .catch(() => { xlsxPromise = null; throw new Error("엑셀 라이브러리를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요."); });
  }
  return xlsxPromise;
}
function datesBetween(a, b) {
  const out = [];
  for (let d = parseD(a), end = parseD(b); d <= end; d.setDate(d.getDate() + 1)) out.push(toStr(d));
  return out;
}
const xlNorm = (t) => String(t == null ? "" : t).replace(/[＞>→]/g, "›").replace(/\s*›\s*/g, " › ").replace(/\s+/g, " ").trim().toLowerCase();

function xlCellText(cell) {
  let v = cell && cell.value;
  if (v == null) return "";
  if (v instanceof Date) return toStr(new Date(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  if (typeof v === "object") {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("").trim();
    if ("result" in v) v = v.result instanceof Date ? toStr(new Date(v.result.getUTCFullYear(), v.result.getUTCMonth(), v.result.getUTCDate())) : v.result;
    else if ("text" in v) v = v.text;
  }
  return v == null ? "" : String(v).trim();
}
/* 엑셀 날짜 칸은 UTC 자정으로 써야 시간대와 무관하게 같은 날짜로 보입니다 */
const utcD = (str) => new Date(Date.UTC(Number(str.slice(0, 4)), Number(str.slice(5, 7)) - 1, Number(str.slice(8, 10))));
function xlDate(t) {
  const m = /^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(t));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? toStr(d) : null;
}
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function downloadLessonTemplate(s) {
  const rg = filterRange(state.lessonFilter);
  if (!rg) { alert("양식은 기간을 정해야 만들 수 있어요. 위에서 시작일과 종료일을 고르세요."); return; }
  const days = datesBetween(rg.start, rg.end);
  if (days.length > 62) { alert("양식은 최대 62일까지 만들 수 있어요. 기간을 줄여 주세요."); return; }
  const X = await loadXlsx();
  const items = bookProgressFor(s.id);
  const bookByTitle = (t) => (items.find((x) => x.book.title === t) || {}).book;

  const wb = new X.Workbook();
  const info = wb.addWorksheet("안내");
  const ws = wb.addWorksheet("수업기록");
  const lst = wb.addWorksheet("목록");

  // 목록: 교재별 단원 이름 + 교재 이름
  const cols = {};
  items.forEach(({ book }, i) => {
    const L = String.fromCharCode(65 + i);
    lst.getCell(`${L}1`).value = book.title;
    lst.getCell(`${L}1`).font = { bold: true };
    for (let n = 1; n <= book.total_units; n++) lst.getCell(`${L}${n + 1}`).value = unitName(book, n);
    cols[book.id] = `목록!$${L}$2:$${L}$${book.total_units + 1}`;
    lst.getColumn(i + 1).width = 22;
  });
  const bl = String.fromCharCode(65 + items.length + 1);
  lst.getCell(`${bl}1`).value = "교재 목록";
  lst.getCell(`${bl}1`).font = { bold: true };
  items.forEach(({ book }, i) => { lst.getCell(`${bl}${i + 2}`).value = book.title; });
  lst.getColumn(items.length + 2).width = 22;
  const bookListRef = items.length ? `목록!$${bl}$2:$${bl}$${items.length + 1}` : null;

  // 수업기록 시트
  ws.addRow(XL_HEAD);
  ws.getRow(1).height = 24;
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2C47" } };
    c.alignment = { horizontal: "center", vertical: "middle" };
  });
  const recsFor = (d) => (state.detail.recs || []).filter((r) => r.target_date === d && r.status !== "거절" && r.textbook_id)
    .sort((a, b) => ((state.textbooks.find((x) => x.id === a.textbook_id) || {}).title || "").localeCompare((state.textbooks.find((x) => x.id === b.textbook_id) || {}).title || ""));
  const thin = { style: "thin", color: { argb: "FFD3DBE7" } };
  const grey = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F6" } };
  const wk = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3E7EE" } };
  days.forEach((d) => {
    const recs = recsFor(d);
    const list = recs.length ? recs : [null];
    const wd = parseD(d).getDay();
    list.forEach((r, k) => {
      const b = r ? state.textbooks.find((x) => x.id === r.textbook_id) : null;
      const row = ws.addRow([utcD(d), b ? `${b.title} | ${rangeText(b, r).trim()} (${r.to_unit - r.from_unit + 1}단원)` : "", k > 0 ? XL_SAME : "", "", "", "", b ? b.title : ""]);
      row.eachCell({ includeEmpty: true }, (c, ci) => {
        c.border = { top: thin, left: thin, bottom: thin, right: thin };
        c.alignment = { vertical: "middle", wrapText: ci === 2 || ci === 6, horizontal: ci === 3 ? "center" : undefined };
      });
      row.getCell(1).numFmt = "yyyy-mm-dd";
      [1, 2].forEach((c) => { row.getCell(c).fill = wd === 0 || wd === 6 ? wk : grey; });
      if (b) row.getCell(7).fill = grey;
      if (k > 0) { row.getCell(3).fill = grey; row.getCell(3).font = { color: { argb: "FF8B95A5" } }; }
      else row.getCell(3).dataValidation = { type: "list", allowBlank: true, formulae: [`"${XL_ATT.join(",")}"`] };
      const ref = b && cols[b.id];
      if (ref) {
        row.getCell(4).dataValidation = { type: "list", allowBlank: true, formulae: [ref] };
        row.getCell(5).dataValidation = { type: "list", allowBlank: true, formulae: [ref] };
      }
      if (!b && bookListRef) row.getCell(7).dataValidation = { type: "list", allowBlank: true, formulae: [bookListRef] };
    });
  });
  [13, 42, 13, 18, 18, 30, 18].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: "frozen", ySplit: 1 }];

  // 안내 시트
  [["수업 기록 업로드 양식", ""], ["", ""], ["학생", `${s.name}${s.grade ? ` (${s.grade})` : ""}`], ["기간", `${rg.start} ~ ${rg.end}`], ["", ""], ["작성 방법", ""],
    ["1", "[수업기록] 시트의 회색 칸(일자·수업 계획·교재)은 앱이 채운 것이니 고치지 마세요."],
    ["2", "출결(출석·지각·결석·보강), 시작 단원, 종료 단원, 학습내용을 입력합니다. 단원은 칸의 ▼ 목록에서 고르거나 같은 이름으로 직접 입력합니다."],
    ["3", "출결·단원·학습내용을 모두 비워 둔 날은 건너뜁니다. 출결만 적으면(예: 결석) 진도 없이 출결만 기록됩니다. 단원을 적고 출결을 비우면 '출석'으로 저장됩니다."],
    ["4", "수업 계획이 없는 날(보강 등)은 교재 칸의 ▼에서 교재를 골라 기록할 수 있습니다."],
    ["5", "같은 날 교재가 여러 개면 일자가 같은 행이 교재 수만큼 있습니다. 출결은 그날 첫 행에만 입력하고(아래 행은 '위와 같음'), 업로드하면 같은 날은 한 건의 수업 기록으로 묶입니다."],
    ["6", "이미 수업 기록이 있는 날은 업로드할 때 건너뛰거나 덮어쓸지 고를 수 있습니다."]].forEach((r) => info.addRow(r));
  info.getCell("A1").font = { bold: true, size: 16 };
  info.getColumn(1).width = 12; info.getColumn(2).width = 95;
  [3, 4, 6].forEach((n) => { info.getCell(`A${n}`).font = { bold: true }; });

  const buf = await wb.xlsx.writeBuffer();
  saveBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `수업기록_양식_${String(s.name).replace(/[\\/:*?"<>|]/g, "_")}_${rg.start}~${rg.end}.xlsx`);
  toast("양식을 내려받았습니다");
}

/* 엑셀 한 칸의 단원 → 누적 번호 */
function xlParseUnit(book, raw) {
  const t = xlNorm(raw);
  if (!t) return { empty: true };
  const lv = bookLeaves(book);
  let n = null;
  if (lv) { const i = lv.findIndex((l) => xlNorm(l.label) === t); if (i >= 0) n = i + 1; }
  else {
    const m = new RegExp(`^${xlNorm(book.unit_label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(\\d+)$`).exec(t);
    if (m) n = Number(m[1]);
  }
  if (n == null && /^\d+$/.test(t)) n = Number(t);
  if (n == null) return { error: `'${raw}' 단원을 찾을 수 없어요` };
  if (n < 1 || n > book.total_units) return { error: `'${raw}' 은(는) 1~${book.total_units} 범위 밖이에요` };
  return { n };
}

async function readLessonSheet(s, file) {
  const X = await loadXlsx();
  const wb = new X.Workbook();
  try { await wb.xlsx.load(await file.arrayBuffer()); } catch { throw new Error("엑셀 파일(.xlsx)을 읽지 못했습니다."); }
  const ws = wb.getWorksheet("수업기록") || wb.worksheets.find((w) => w.name !== "안내" && w.name !== "목록");
  if (!ws) throw new Error("[수업기록] 시트를 찾을 수 없습니다. '양식 다운로드'로 받은 파일을 쓰세요.");
  const head = {};
  ws.getRow(1).eachCell((c, i) => { head[xlCellText(c)] = i; });
  const need = ["일자", "시작 단원", "종료 단원"];
  if (need.some((k) => !head[k])) throw new Error("양식 열(일자·시작 단원·종료 단원)을 찾을 수 없습니다. '양식 다운로드'로 받은 파일을 쓰세요.");
  const get = (row, k) => (head[k] ? xlCellText(row.getCell(head[k])) : "");

  const items = bookProgressFor(s.id);
  const rows = [];
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    let att = get(row, "출결");
    if (att === XL_SAME || att.startsWith("↑")) att = "";
    const r = { rn, dateRaw: get(row, "일자"), att, startRaw: get(row, "시작 단원"), endRaw: get(row, "종료 단원"), topic: get(row, "학습내용"), bookName: get(row, "교재") };
    if (!r.dateRaw && !r.att && !r.startRaw && !r.endRaw && !r.topic) return; // 완전히 빈 행
    rows.push(r);
  });
  const stu = wb.getWorksheet("안내") ? xlCellText(wb.getWorksheet("안내").getCell("B3")) : "";
  const match = !stu ? null : stu.startsWith(s.name);

  // 행 검사
  rows.forEach((r) => {
    r.date = xlDate(r.dateRaw);
    r.empty = !r.att && !r.startRaw && !r.endRaw && !r.topic;
    if (r.empty) { r.status = "skip"; return; }
    const fail_ = (msg) => { r.status = "error"; r.msg = msg; };
    if (!r.date) return fail_(`일자 '${r.dateRaw || "비어 있음"}' 을(를) 읽을 수 없어요`);
    if (r.att && !XL_ATT.includes(r.att)) return fail_(`출결 '${r.att}' 은(는) 출석·지각·결석·보강 중 하나여야 해요`);
    const hasUnits = r.startRaw || r.endRaw;
    if (hasUnits || r.topic || r.bookName) {
      if (r.bookName) {
        const it = items.find((x) => x.book.title === r.bookName);
        if (!it) return fail_(`'${r.bookName}' 은(는) 이 학생에게 배정되지 않은 교재예요`);
        r.book = it.book;
      } else if (hasUnits) return fail_("교재 칸에서 교재를 골라 주세요");
    }
    if (hasUnits) {
      if (!r.startRaw || !r.endRaw) return fail_("시작 단원과 종료 단원을 둘 다 입력하세요");
      const a = xlParseUnit(r.book, r.startRaw), b = xlParseUnit(r.book, r.endRaw);
      if (a.error) return fail_(`시작: ${a.error}`);
      if (b.error) return fail_(`종료: ${b.error}`);
      if (a.n > b.n) return fail_("시작 단원이 종료 단원보다 뒤예요");
      r.from = a.n; r.to = b.n;
    }
    r.status = "ok";
  });

  // 날짜별 묶음: 한 날은 한 건의 수업 기록
  const groups = new Map();
  rows.filter((r) => r.status === "ok").forEach((r) => {
    if (!groups.has(r.date)) groups.set(r.date, { date: r.date, att: "", rows: [] });
    const g = groups.get(r.date);
    if (r.att) {
      if (g.att && g.att !== r.att) { r.status = "error"; r.msg = `같은 날 출결이 다른 행(${g.att})과 달라요`; return; }
      g.att = r.att;
    }
    if (r.book && g.rows.some((x) => x.book && x.book.id === r.book.id)) { r.status = "error"; r.msg = `같은 날 ${r.book.title} 행이 두 개예요`; return; }
    g.rows.push(r);
  });
  const list = [...groups.values()].filter((g) => g.rows.length).sort((a, b) => a.date.localeCompare(b.date));
  list.forEach((g) => {
    g.attendance = g.att || "출석";
    g.existing = (state.detail.lessons || []).find((l) => l.lesson_date === g.date) || null;
  });
  return { rows, groups: list, studentName: stu, match, fileName: file.name };
}

function xlPreviewHtml(res, dupMode) {
  const g = new Map(res.groups.map((x) => [x.date, x]));
  const dayN = (dup) => res.groups.filter((x) => !(x.existing && dup === "skip")).length;
  const saveRows = (dup) => res.groups.filter((x) => !(x.existing && dup === "skip")).reduce((n, x) => n + x.rows.length, 0);
  const errN = res.rows.filter((r) => r.status === "error").length;
  const skipN = res.rows.filter((r) => r.status === "skip").length;
  const dupDays = res.groups.filter((x) => x.existing).length;
  const attCls = { 출석: "", 지각: "warn", 결석: "bad", 보강: "" };
  let lastDate = "";
  const body = res.rows.filter((r) => r.status !== "skip").map((r) => {
    const grp = r.date && g.get(r.date);
    const dupSkipped = r.status === "ok" && grp && grp.existing && dupMode === "skip";
    const first = r.date !== lastDate; lastDate = r.date || "";
    const wd = r.date ? DAY_NAME[parseD(r.date).getDay()] : "";
    const att = grp && first ? `<span class="badge ${attCls[grp.attendance] || ""}">${esc(grp.attendance)}</span>` : "";
    const range = r.book && r.from ? esc(rangeText(r.book, { from_unit: r.from, to_unit: r.to }).trim()) : (r.status === "error" ? esc([r.startRaw, r.endRaw].filter(Boolean).join(" → ")) : '<span class="muted">진도 없음</span>');
    const st = r.status === "error" ? `<span class="badge bad">오류</span><div class="xl-msg">${esc(r.msg)}</div>`
      : dupSkipped ? `<span class="badge">건너뜀</span><div class="xl-msg muted">이미 기록 있음</div>`
      : `<span class="badge done">저장</span>${grp && grp.existing ? `<div class="xl-msg muted">덮어쓰기</div>` : ""}${!r.book && !r.from ? '<div class="xl-msg muted">출결만 기록</div>' : ""}`;
    return `<tr class="${r.status === "error" ? "xl-err" : ""}"><td style="white-space:nowrap">${r.date ? `<b>${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}</b> (${wd})` : esc(r.dateRaw)}${att ? `<div>${att}</div>` : ""}</td>
      <td>${esc(r.book ? r.book.title : r.bookName || "-")}</td><td>${range}</td><td>${esc(r.topic || "")}</td><td>${st}</td></tr>`;
  }).join("");
  return `
    <div class="xl-file"><b>${esc(res.fileName)}</b><span class="muted">${res.studentName ? "양식 학생 " + esc(res.studentName) : "학생 정보 없음"}</span><span class="spacer"></span>
      ${res.match === false ? '<span class="badge bad">학생 다름</span>' : res.match ? '<span class="badge done">학생 일치</span>' : ""}</div>
    ${res.match === false ? '<p class="xl-warn">이 양식은 다른 학생의 것으로 보여요. 맞는지 확인하고 저장하세요.</p>' : ""}
    <div class="xl-sum"><div class="ok"><span>저장</span><b>${dayN(dupMode)}일 · ${saveRows(dupMode)}건</b></div><div><span>건너뜀 (비어 있음)</span><b>${skipN}행</b></div><div class="${errN ? "err" : ""}"><span>확인 필요</span><b>${errN}행</b></div></div>
    ${body ? `<div class="card table-wrap xl-tbl"><table><thead><tr><th>일자</th><th>교재</th><th>단원</th><th>학습내용</th><th>상태</th></tr></thead><tbody>${body}</tbody></table></div>` : '<div class="card empty">입력된 내용이 없습니다.</div>'}
    ${dupDays ? `<p class="muted xl-dup">이미 수업 기록이 있는 날 ${dupDays}일이 있어요.</p>` : ""}`;
}

async function uploadLessonSheet(s, file) {
  const res = await readLessonSheet(s, file);
  let dupMode = "skip";
  const bookOf = (id) => state.textbooks.find((b) => b.id === id);
  const progOf = (id) => state.progress.find((x) => x.student_id === s.id && x.textbook_id === id);
  const dupN = res.groups.filter((g) => g.existing).length;
  const fields = [{ name: "xl-prev", type: "slot" }];
  if (dupN) fields.push({ name: "dup", label: "이미 수업 기록이 있는 날", type: "select", options: [["skip", "건너뛰기 (기존 기록 유지)"], ["overwrite", "덮어쓰기 (엑셀 내용으로 바꿈)"]] });
  fields.push({ name: "sync_progress", label: "저장할 때 각 교재의 진도도 종료 단원으로 갱신 (결석은 제외)", type: "checkbox", default: true });
  const count = () => res.groups.filter((x) => !(x.existing && dupMode === "skip")).reduce((n, x) => n + x.rows.length, 0);
  openForm({
    title: "엑셀 업로드 · 수업 기록",
    wide: true,
    fields,
    values: {},
    submitLabel: `${count()}건 저장`,
    onSubmit: async (d) => {
      const dup = d.dup || "skip";
      const targets = res.groups.filter((g) => !(g.existing && dup === "skip"));
      if (!targets.length) throw new Error("저장할 내용이 없습니다. 오류 행을 고치거나 덮어쓰기를 고르세요.");
      const cur = {};
      const curOf = (id) => (id in cur ? cur[id] : ((progOf(id) || {}).current_unit ?? 0));
      let days = 0, rowsN = 0;
      for (const g of targets) {
        const blocks = g.rows.map((r) => ({ textbook_id: r.book ? r.book.id : null, from_unit: r.from ?? null, to_unit: r.to ?? null, topic: r.topic ? r.topic.slice(0, 200) : null }));
        const withBook = blocks.filter((b) => b.textbook_id);
        const first = withBook[0] || blocks[0] || { textbook_id: null, from_unit: null, to_unit: null, topic: null };
        const extras = withBook.slice(1);
        const row = { lesson_date: g.date, attendance: g.attendance, textbook_id: first.textbook_id, from_unit: first.from_unit, to_unit: first.to_unit, topic: first.topic };
        if (extras.length || (g.existing && "extra_books" in g.existing)) row.extra_books = extras;
        let lessonId;
        try {
          if (g.existing) { await run(db.from("lessons").update(row).eq("id", g.existing.id)); lessonId = g.existing.id; }
          else { const ins = await run(db.from("lessons").insert({ ...row, student_id: s.id }).select("id").single()); lessonId = ins && ins.id; }
        } catch (e) {
          if (/extra_books/i.test((e && e.message) || "")) throw new Error("교재를 여러 개 저장하려면 최신 schema.sql 을 Supabase 에서 먼저 실행하세요.");
          throw e;
        }
        // 같은 날·교재의 '제안' 추천은 채택/수정으로 처리
        for (const rc of (state.detail.recs || []).filter((x) => x.status === "제안" && x.target_date === g.date)) {
          const b = withBook.find((x) => x.textbook_id === rc.textbook_id);
          if (!b || !lessonId) continue;
          const same = b.from_unit === rc.from_unit && b.to_unit === rc.to_unit;
          await run(db.from("recommendations").update({ status: same ? "채택" : "수정", applied_lesson_id: lessonId, decided_at: new Date().toISOString() }).eq("id", rc.id));
        }
        if (d.sync_progress && g.attendance !== "결석") {
          for (const b of withBook) {
            if (b.to_unit == null) continue;
            const pr = progOf(b.textbook_id);
            if (!pr) { await run(db.from("progress").insert({ student_id: s.id, textbook_id: b.textbook_id, current_unit: b.to_unit })); cur[b.textbook_id] = b.to_unit; }
            else if (b.to_unit > curOf(b.textbook_id)) { await run(db.from("progress").update({ current_unit: b.to_unit, updated_at: new Date().toISOString() }).eq("id", pr.id)); cur[b.textbook_id] = b.to_unit; }
          }
        }
        days += 1; rowsN += g.rows.length;
      }
      await refresh();
      toast(`수업 기록 ${days}일 ${rowsN}건을 저장했습니다`);
    },
  });
  const paint = () => {
    $("#xl-prev").innerHTML = xlPreviewHtml(res, dupMode);
    $("#dlg-submit").textContent = `${count()}건 저장`;
  };
  paint();
  const sel = $("#dlg-form").elements.dup;
  if (sel) sel.onchange = () => { dupMode = sel.value; paint(); };
}

const TEST_KINDS = ["단어시험", "단원평가", "모의고사", "기타"];
function kindCard(kind, list, ci) {
  const pts = [...list].sort((a, b) => a.test_date.localeCompare(b.test_date)).slice(-15);
  const vals = pts.map((t) => pct(t.score, t.max_score));
  const last = Math.round(vals[vals.length - 1]);
  if (pts.length < 2) {
    return `<div class="card gc gone k${ci}"><div class="gk">${esc(kind)}</div><div class="gbig">${last}점 <small>· 1회</small></div><div class="muted">다음 시험부터 추이가 표시돼요</div></div>`;
  }
  const W = 300, H = 130, L = 30, R = 12, T = 14, B = 24;
  const x = (i) => L + 14 + (i * (W - L - R - 24)) / (pts.length - 1);
  const y = (v) => T + ((100 - Math.max(0, Math.min(100, v))) * (H - T - B)) / 100;
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const grid = [0, 50, 100].map((g) => `<line class="gaxis" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text class="gtick" x="${L - 6}" y="${y(g) + 3.5}" text-anchor="end">${g}</text>`).join("");
  const showAll = pts.length <= 8;
  const dots = vals.map((v, i) => {
    const isLast = i === vals.length - 1;
    return `<circle class="gdot${isLast ? " last" : ""}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${isLast ? 5 : 3.2}"><title>${fmtDate(pts[i].test_date)} ${v.toFixed(0)}점</title></circle>${showAll || isLast ? `<text class="gval${isLast ? " last" : ""}" x="${x(i).toFixed(1)}" y="${(y(v) - 9).toFixed(1)}" text-anchor="middle">${Math.round(v)}</text>` : ""}`;
  }).join("");
  const dl = (i) => { const d = parseD(pts[i].test_date); return `${d.getMonth() + 1}.${d.getDate()}`; };
  const labIdx = pts.length <= 7 ? pts.map((_, i) => i) : [0, pts.length - 1];
  const labels = labIdx.map((i) => `<text class="gtick" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${pts.length > 7 ? (i ? "end" : "start") : "middle"}">${dl(i)}</text>`).join("");
  const diff = Math.round(vals[vals.length - 1]) - Math.round(vals[vals.length - 2]);
  const chg = `<span class="gchg ${diff > 0 ? "up" : diff < 0 ? "dn" : ""}">${diff > 0 ? "▲" : diff < 0 ? "▼" : "–"} ${Math.abs(diff)}</span>`;
  return `<div class="card gc k${ci}"><div class="gh"><div><div class="gk">${esc(kind)}</div><div class="gs"><b>${last}</b>점 ${chg}</div></div><span class="gm">${list.length}회</span></div>
    <svg class="gsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(kind)} 점수 추이(100점 만점 환산)">${grid}<path class="garea" d="${area}"/><path class="gline" d="${line}"/>${dots}${labels}</svg>
    <div class="gf"><span>평균 <b>${avg(vals).toFixed(0)}</b></span><span>최고 <b>${Math.max(...vals).toFixed(0)}</b></span><span>최저 <b>${Math.min(...vals).toFixed(0)}</b></span></div></div>`;
}
// 그래프는 기간 필터와 무관하게 최근 4주(오늘 포함 28일) 기준
function trendCards(all) {
  const from = addDays(todayStr(), -27);
  const rows = all.filter((t) => t.test_date >= from && t.test_date <= todayStr());
  const kinds = TEST_KINDS.filter((k) => rows.some((t) => t.kind === k));
  if (!kinds.length) return `<h3 class="gtitle">종류별 점수 추이 <small class="muted">· 최근 4주 · 100점 환산</small></h3><div class="card empty">최근 4주 안에 시험 기록이 없습니다.</div>`;
  const cards = kinds.map((k) => kindCard(k, rows.filter((t) => t.kind === k), TEST_KINDS.indexOf(k)));
  return `<h3 class="gtitle">종류별 점수 추이 <small class="muted">· 최근 4주 · 100점 환산</small></h3><div class="gg ${kinds.length === 1 ? "one" : ""}">${cards.join("")}</div>`;
}

function renderTestsTab(s) {
  const all = state.detail.tests;
  const rows = all.filter((t) => inRange(state.testFilter, t.test_date));
  const pcts = rows.map((t) => pct(t.score, t.max_score));
  const recent = pcts.slice(0, 5);
  const scoped = state.testFilter.range !== "all";
  $("#tab-body").innerHTML = `
    <div class="toolbar"><button class="btn primary" id="btn-add-test">+ 시험 점수</button></div>
    ${all.length ? trendCards(all) : ""}
    ${filterHtml(state.testFilter, "tf", false)}
    ${
      rows.length
        ? `<div class="summary">
            <div class="card"><strong>${avg(pcts).toFixed(0)}점</strong><span>${scoped ? "기간 평균" : "전체 평균"}</span></div>
            <div class="card"><strong>${avg(recent).toFixed(0)}점</strong><span>최근 ${recent.length}회 평균</span></div>
            <div class="card"><strong>${Math.max(...pcts).toFixed(0)}점</strong><span>최고점</span></div>
            <div class="card"><strong>${rows.length}회</strong><span>${scoped ? "기간 내 시험" : "누적 시험"}</span></div>
          </div>
          <div class="card table-wrap"><table>
            <thead><tr><th>날짜</th><th>종류</th><th>이름</th><th class="num">점수</th><th class="num">환산</th></tr></thead>
            <tbody>${rows
              .map(
                (t) => `<tr class="clickable" data-tid="${esc(t.id)}">
                  <td style="white-space:nowrap">${fmtDate(t.test_date)}</td><td>${esc(t.kind)}</td><td>${esc(t.title || "")}</td>
                  <td class="num">${t.score}/${t.max_score}</td><td class="num">${pct(t.score, t.max_score).toFixed(0)}점</td></tr>`
              )
              .join("")}</tbody></table></div>`
        : `<div class="card empty">${all.length ? "이 기간에는 시험 기록이 없습니다. 위에서 기간을 바꿔 보세요." : "시험 기록이 없습니다."}</div>`
    }`;
  bindFilter(state.testFilter, "tf", () => renderTestsTab(s));
}

/* ---------- 리포트 (기간 요약 + 학부모 안내문 초안) ---------- */
const DOW = "일월화수목금토";
function parseD(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(s, n) {
  const d = parseD(s);
  d.setDate(d.getDate() + n);
  return toStr(d);
}
function shortDate(s) {
  const d = parseD(s);
  return `${d.getMonth() + 1}.${d.getDate()}(${DOW[d.getDay()]})`;
}
function periodRange(kind, customStart, customEnd) {
  const today = todayStr();
  const dow = (parseD(today).getDay() + 6) % 7; // 월요일 시작
  const monday = addDays(today, -dow);
  const t = parseD(today);
  if (kind === "thisWeek") return { start: monday, end: addDays(monday, 6), label: "주간" };
  if (kind === "lastWeek") return { start: addDays(monday, -7), end: addDays(monday, -1), label: "주간" };
  if (kind === "nextWeek") return { start: addDays(monday, 7), end: addDays(monday, 13), label: "주간" };
  if (kind === "thisMonth") return { start: toStr(new Date(t.getFullYear(), t.getMonth(), 1)), end: toStr(new Date(t.getFullYear(), t.getMonth() + 1, 0)), label: "월간" };
  if (kind === "lastMonth") return { start: toStr(new Date(t.getFullYear(), t.getMonth() - 1, 1)), end: toStr(new Date(t.getFullYear(), t.getMonth(), 0)), label: "월간" };
  const start = customStart || monday;
  const end = customEnd && customEnd >= start ? customEnd : start;
  return { start, end, label: "기간" };
}

function buildReport(studentId, start, end, src = state.detail) {
  const lessons = src.lessons
    .filter((l) => l.lesson_date >= start && l.lesson_date <= end)
    .sort((a, b) => a.lesson_date.localeCompare(b.lesson_date));
  const attended = lessons.filter((l) => l.attendance !== "결석");
  const att = { 출석: 0, 지각: 0, 결석: 0, 보강: 0 };
  lessons.forEach((l) => { if (l.attendance in att) att[l.attendance]++; });
  const hw = { 완료: 0, 일부: 0, 미제출: 0 };
  attended.forEach((l) => { if (l.homework in hw) hw[l.homework]++; });

  // 교재별 이번 기간 진도 범위
  const ranges = new Map();
  attended.forEach((l) => {
    lessonBooks(l).forEach((lb) => {
      const r = ranges.get(lb.textbook_id) || { from: null, to: null };
      const f = lb.from_unit ?? lb.to_unit;
      const t = lb.to_unit ?? lb.from_unit;
      if (f != null) r.from = r.from == null ? f : Math.min(r.from, f);
      if (t != null) r.to = r.to == null ? t : Math.max(r.to, t);
      ranges.set(lb.textbook_id, r);
    });
  });
  const books = [...ranges.entries()]
    .map(([id, r]) => {
      const book = state.textbooks.find((b) => b.id === id);
      if (!book) return null;
      const p = state.progress.find((x) => x.student_id === studentId && x.textbook_id === id);
      return { book, from: r.from, to: r.to, current: p ? p.current_unit : null };
    })
    .filter(Boolean);

  const tests = src.tests
    .filter((t) => t.test_date >= start && t.test_date <= end)
    .sort((a, b) => a.test_date.localeCompare(b.test_date));
  const testAvg = avg(tests.map((t) => pct(t.score, t.max_score)));
  const days = Math.round((parseD(end) - parseD(start)) / 86400000) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(start, -days);
  const prevTests = src.tests.filter((t) => t.test_date >= prevStart && t.test_date <= prevEnd);
  const prevAvg = avg(prevTests.map((t) => pct(t.score, t.max_score)));

  const withNext = [...src.lessons].filter((l) => l.next_plan && l.lesson_date <= end).sort((a, b) => b.lesson_date.localeCompare(a.lesson_date));
  const nextPlan = withNext.length ? withNext[0].next_plan : null;

  const hwNotes = attended.filter((l) => l.homework_note).map((l) => ({ date: l.lesson_date, note: l.homework_note, status: l.homework }));
  return { lessons, attended, att, hw, hwNotes, books, tests, testAvg, prevAvg, nextPlan, hasData: lessons.length + tests.length > 0 };
}

const ACADEMY_NAME = "Rachel English";

function buildMessage(s, label, start, end, r, comment) {
  const out = [];
  out.push(`[${ACADEMY_NAME}]`);
  out.push(`[${label} 영어 학습 리포트] ${shortDate(start)} ~ ${shortDate(end)}`);
  out.push(`${s.name} 학생`);
  out.push("");
  if (!r.hasData) {
    out.push("이 기간의 수업 기록이 없습니다.");
  } else {
    const attParts = ["출석", "지각", "결석", "보강"].filter((k) => r.att[k]).map((k) => `${k} ${r.att[k]}`);
    out.push(`■ 수업: 총 ${r.lessons.length}회${attParts.length ? ` (${attParts.join(", ")})` : ""}`);
    if (r.attended.length) {
      out.push("■ 학습 내용");
      r.attended.forEach((l) => {
        const cover = coverText(l);
        const parts = [cover, topicText(l)].filter(Boolean).join(" · ");
        out.push(`- ${shortDate(l.lesson_date)} ${parts || "수업 진행"}${l.memo ? ` (${l.memo.replace(/\s+/g, " ")})` : ""}`);
      });
    }
    const withComment = r.lessons.filter((l) => l.teacher_comment && l.teacher_comment.trim());
    if (withComment.length) {
      out.push("■ 선생님 코멘트");
      withComment.forEach((l) => out.push(`- ${shortDate(l.lesson_date)} ${l.teacher_comment.trim()}`));
    }
    if (r.books.length) {
      out.push("■ 진도");
      r.books.forEach(({ book, from, to, current }) => {
        const span = from != null && to != null ? rangeText(book, { from_unit: from, to_unit: to }).trim() : "";
        out.push(`- ${book.title}${span ? ` ${span}` : ""}${current != null ? ` (현재 ${curNum(book, current)})` : ""}`);
      });
    }
    const hwParts = ["완료", "일부", "미제출"].filter((k) => r.hw[k]).map((k) => `${k} ${r.hw[k]}회`);
    if (hwParts.length) out.push(`■ 숙제: ${hwParts.join(", ")}`);
    r.hwNotes.forEach((h) => out.push(`- ${shortDate(h.date)} ${h.note}${h.status ? ` (${h.status})` : ""}`));
    if (r.tests.length) {
      out.push("■ 시험");
      r.tests.forEach((t) => out.push(`- ${shortDate(t.test_date)} ${t.kind}${t.title ? ` ${t.title}` : ""} ${t.score}/${t.max_score}`));
      let line = `평균 ${r.testAvg.toFixed(0)}점`;
      if (r.prevAvg != null) {
        const diff = Math.round(r.testAvg - r.prevAvg);
        line += diff === 0 ? " (지난 기간과 비슷)" : ` (지난 기간 대비 ${diff > 0 ? "+" : ""}${diff}점)`;
      }
      out.push(line);
    }
  }
  if (r.nextPlan) out.push(`■ 다음 수업: ${r.nextPlan}`);
  if (comment) out.push(`■ 선생님 한마디: ${comment.trim()}`);
  out.push("");
  out.push("감사합니다.");
  return out.join("\n");
}

function renderReportTab(s) {
  const rp = state.report;
  const range = periodRange(rp.range, rp.start, rp.end);
  const r = buildReport(s.id, range.start, range.end);
  const opts = [["thisWeek", "이번 주"], ["lastWeek", "지난 주"], ["thisMonth", "이번 달"], ["lastMonth", "지난 달"], ["custom", "직접 선택"]];
  const hwTotal = r.hw.완료 + r.hw.일부 + r.hw.미제출;
  const logs = state.detail.logs || [];
  const already = logs.find((g) => g.period_start === range.start && g.period_end === range.end);
  const logBlock = state.detail.logsMissing
    ? `<p class="muted" style="margin:.6rem 0 0;font-size:.85rem">발송 기록을 쓰려면 Supabase SQL Editor에서 최신 schema.sql을 한 번 더 실행하세요.</p>`
    : `${already ? `<p class="badge warn" style="margin:.6rem 0 0">이 기간 안내문은 ${fmtDate(already.sent_at.slice(0, 10))}에 발송 기록이 있습니다</p>` : ""}
       ${logs.length ? `<div class="table-wrap" style="margin-top:.8rem"><table><thead><tr><th>기간</th><th>구분</th><th>발송 기록일</th><th></th></tr></thead><tbody>${logs
         .slice(0, 10)
         .map((g) => `<tr><td>${shortDate(g.period_start)} ~ ${shortDate(g.period_end)}</td><td>${esc(g.label || "")}</td><td>${fmtDate(g.sent_at.slice(0, 10))}</td><td><button class="btn small danger" data-logdel="${esc(g.id)}" type="button">삭제</button></td></tr>`)
         .join("")}</tbody></table></div>` : ""}`;
  $("#tab-body").innerHTML = `
    <div class="card report-controls">
      <label>기간
        <select id="rp-range">${opts.map(([v, t]) => `<option value="${v}" ${rp.range === v ? "selected" : ""}>${t}</option>`).join("")}</select>
      </label>
      <label>시작일<input type="date" id="rp-start" value="${esc(range.start)}" ${rp.range === "custom" ? "" : "disabled"}></label>
      <label>종료일<input type="date" id="rp-end" value="${esc(range.end)}" ${rp.range === "custom" ? "" : "disabled"}></label>
    </div>
    ${
      r.hasData
        ? `<div class="summary">
            <div class="card"><strong>${r.lessons.length}회</strong><span>수업 (결석 ${r.att.결석}회)</span></div>
            <div class="card"><strong>${hwTotal ? Math.round((r.hw.완료 / hwTotal) * 100) + "%" : "-"}</strong><span>숙제 완료율${hwTotal ? ` (${r.hw.완료}/${hwTotal})` : ""}</span></div>
            <div class="card"><strong>${r.tests.length ? r.testAvg.toFixed(0) + "점" : "-"}</strong><span>시험 평균${r.tests.length && r.prevAvg != null ? ` (지난 기간 ${r.prevAvg.toFixed(0)}점)` : ""}</span></div>
            <div class="card"><strong>${r.books.length}권</strong><span>이번 기간 학습 교재</span></div>
          </div>`
        : `<div class="card empty">이 기간에는 수업·시험 기록이 없습니다.</div>`
    }
    <div class="card draft-card" style="margin-top:1rem">
      <h3>학부모 안내문 초안</h3>
      <label>선생님 한마디 (선택)
        <textarea id="rp-comment" maxlength="500" placeholder="예: 단어 암기가 많이 좋아졌어요. 집에서 복습 한 번만 확인해 주세요.">${esc(rp.comment)}</textarea>
      </label>
      <label>안내문 (직접 고쳐도 됩니다. 기간·한마디를 바꾸면 다시 만들어집니다)
        <textarea id="rp-draft" class="report-draft"></textarea>
      </label>
      <div class="toolbar"><button class="btn primary" id="rp-copy" type="button">안내문 복사</button><button class="btn" id="rp-print" type="button">인쇄 / PDF 저장</button><button class="btn" id="rp-log" type="button">발송 완료로 기록</button><span class="muted" id="rp-copied"></span></div>
      ${logBlock}
    </div>
    <div class="print-only" id="rp-print-view"></div>`;
  const draft = $("#rp-draft");
  const syncPrint = () => { $("#rp-print-view").textContent = draft.value; };
  draft.value = buildMessage(s, range.label, range.start, range.end, r, rp.comment);
  syncPrint();
  draft.oninput = syncPrint;
  $("#rp-print").onclick = () => { syncPrint(); window.print(); };

  $("#rp-range").onchange = (e) => {
    rp.range = e.target.value;
    renderReportTab(s);
  };
  const onDate = () => {
    rp.start = $("#rp-start").value;
    rp.end = $("#rp-end").value;
    renderReportTab(s);
  };
  $("#rp-start").onchange = onDate;
  $("#rp-end").onchange = onDate;
  $("#rp-comment").onchange = (e) => {
    rp.comment = e.target.value;
    draft.value = buildMessage(s, range.label, range.start, range.end, r, rp.comment);
    syncPrint();
  };
  const logBtn = $("#rp-log");
  if (logBtn) {
    logBtn.disabled = !!state.detail.logsMissing;
    logBtn.onclick = async () => {
      if (already && !confirm("이 기간은 이미 발송 기록이 있습니다. 또 기록할까요?")) return;
      try {
        await run(db.from("report_logs").insert({ student_id: s.id, period_start: range.start, period_end: range.end, label: range.label }));
        await refresh();
        toast("발송 기록을 남겼습니다");
      } catch (err) {
        fail(err, "발송 기록 실패");
      }
    };
  }
  $("#tab-body").querySelectorAll("[data-logdel]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("이 발송 기록을 삭제할까요?")) return;
      try {
        await run(db.from("report_logs").delete().eq("id", b.dataset.logdel));
        await refresh();
      } catch (err) {
        fail(err);
      }
    };
  });
  $("#rp-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(draft.value);
    } catch {
      draft.select();
      document.execCommand("copy");
    }
    $("#rp-copied").textContent = "복사했습니다";
    toast("안내문을 복사했습니다");
  };
}

/* ---------- 월말평가서 ---------- */
const EVAL_LEVELS = [[5, "매우 우수"], [4, "우수"], [3, "보통"], [2, "노력 필요"], [1, "많이 노력 필요"]];
const EVAL_SKILLS = [["listening", "듣기"], ["speaking", "말하기"], ["reading", "읽기"], ["writing", "쓰기"], ["vocab", "어휘"], ["grammar", "문법"]];
const EVAL_ATTITUDE = [["participation", "참여도"], ["focus", "집중도"], ["homework", "숙제 성실도"]];
const EVAL_TEXTS = [
  ["achievement", "이달의 성취", "예: 현재완료를 정확히 쓰기 시작했고, 단어 시험 점수가 꾸준히 올랐습니다."],
  ["improvement", "보완할 점", "예: 본문을 소리 내어 읽을 때 끊어 읽기를 더 연습하면 좋겠습니다."],
  ["next_plan", "다음 달 학습 계획", "예: Grammar Zone 1 Unit 9~12 진행, 주 1회 쓰기 활동 추가"],
  ["parent_note", "학부모께 드리는 말씀", "가정에서 도와주실 부분이나 전달 사항을 적어 주세요."],
];
const EVAL_STATUS = ["작성중", "AI 초안", "완료"];

function monthRange(y, m) {
  const pad = (n) => String(n).padStart(2, "0");
  return { start: `${y}-${pad(m)}-01`, end: toStr(new Date(y, m, 0)) };
}
function prevMonthStart(y, m) {
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}
function testsFrom(y, m) { // 시험 추이 그래프용: 해당 월 포함 최근 3개월의 첫날
  const d = new Date(y, m - 3, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
const levelLabel = (v) => (EVAL_LEVELS.find(([n]) => n === v) || [])[1] || "";

async function loadEvals() {
  const ev = state.evals;
  const { year, month } = ev;
  const key = `${year}-${month}`;
  ev.key = key;
  ev.loading = true;
  ev.failed = false;
  renderEvals();
  const range = monthRange(year, month);
  try {
    const from = prevMonthStart(year, month);
    const [lessons, tests] = await Promise.all([
      run(db.from("lessons").select("*").gte("lesson_date", from).lte("lesson_date", range.end).limit(5000)),
      run(db.from("tests").select("*").gte("test_date", testsFrom(year, month)).lte("test_date", range.end).limit(5000)),
    ]);
    let rows = [];
    let missing = false;
    try {
      rows = await run(db.from("monthly_evaluations").select("*").eq("year", year).eq("month", month).limit(1000));
    } catch {
      missing = true; // 테이블이 아직 없음
    }
    if (ev.key !== key) return; // 그 사이 다른 달을 골랐으면 버림
    ev.data = { key, range, lessons, tests, rows, missing };
  } catch (e) {
    if (ev.key !== key) return;
    ev.data = null;
    ev.failed = true;
    fail(e, "월말평가서를 불러오지 못했습니다");
  }
  ev.loading = false;
  if (state.view === "evals") renderEvals();
}

function evalSummary(s, d) {
  const src = { lessons: d.lessons.filter((l) => l.student_id === s.id), tests: d.tests.filter((t) => t.student_id === s.id) };
  const r = buildReport(s.id, d.range.start, d.range.end, src);
  const hwTotal = r.hw.완료 + r.hw.일부 + r.hw.미제출;
  return {
    r,
    attRate: r.lessons.length ? Math.round((r.attended.length / r.lessons.length) * 100) : null,
    hwRate: hwTotal ? Math.round((r.hw.완료 / hwTotal) * 100) : null,
    comments: r.lessons.filter((l) => l.teacher_comment && l.teacher_comment.trim()),
  };
}

function evalStatusBadge(row) {
  if (!row) return `<span class="badge warn">미작성</span>`;
  if (row.status === "AI 초안") return `<span class="badge ai" title="Claude가 쓴 초안입니다. 확인한 뒤 상태를 '작성 중'이나 '완료'로 바꿔 저장하세요(AI 초안 상태는 다음 예약 작업이 덮어씁니다)">AI 초안</span>`;
  return row.status === "완료" ? `<span class="badge done">완료</span>` : `<span class="badge">작성 중</span>`;
}

function renderEvals() {
  const ev = state.evals;
  const yNow = new Date().getFullYear();
  const years = [];
  for (let y = yNow - 3; y <= yNow + 1; y++) years.push(y);
  if (!years.includes(ev.year)) years.push(ev.year);
  years.sort();
  const head = `<div class="page-head"><h2>월말평가서</h2><span class="muted">${ev.year}년 ${ev.month}월</span></div>
    <div class="card report-controls eval-controls">
      <label>연도<select id="ev-year">${years.map((y) => `<option value="${y}" ${y === ev.year ? "selected" : ""}>${y}년</option>`).join("")}</select></label>
      <label>월<select id="ev-month">${Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}" ${m === ev.month ? "selected" : ""}>${m}월</option>`).join("")}</select></label>
    </div>`;
  const bind = () => {
    $("#ev-year").onchange = (e) => { ev.year = Number(e.target.value); ev.studentId = null; ev.data = null; loadEvals(); };
    $("#ev-month").onchange = (e) => { ev.month = Number(e.target.value); ev.studentId = null; ev.data = null; loadEvals(); };
  };
  const main = $("#main");
  const d = ev.data;
  if (ev.loading || !d || d.key !== `${ev.year}-${ev.month}`) {
    main.innerHTML = head + `<div class="card empty">${ev.failed ? "불러오지 못했습니다. 연도나 월을 다시 선택해 보세요." : "불러오는 중..."}</div>`;
    bind();
    if (!ev.loading && !ev.failed) loadEvals();
    return;
  }
  if (d.missing) {
    main.innerHTML = head + `<div class="card"><strong>월말평가서 저장 테이블이 아직 없습니다.</strong>
      <p class="muted">Supabase SQL Editor에서 최신 <code>schema.sql</code>을 실행한 뒤 이 화면을 새로고침하세요. 테이블이 생기면 평가서를 저장할 수 있습니다.</p></div>`;
    bind();
    return;
  }
  if (ev.studentId) {
    const s = state.students.find((x) => x.id === ev.studentId);
    if (s) return renderEvalDetail(s, d, head, bind);
    ev.studentId = null;
  }
  const students = state.students.filter((s) => s.active);
  const done = students.filter((s) => (d.rows.find((r) => r.student_id === s.id) || {}).status === "완료").length;
  const rows = students.map((s) => {
    const row = d.rows.find((r) => r.student_id === s.id);
    const sm = evalSummary(s, d);
    return `<tr class="clickable" data-eid="${esc(s.id)}">
      <td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.grade || "")}</div></td>
      <td class="num">${sm.r.lessons.length}회</td>
      <td class="num">${sm.attRate == null ? "-" : sm.attRate + "%"}</td>
      <td class="num">${sm.hwRate == null ? "-" : sm.hwRate + "%"}</td>
      <td class="num">${sm.r.testAvg == null ? "-" : sm.r.testAvg.toFixed(0) + "점"}</td>
      <td>${evalStatusBadge(row)}</td></tr>`;
  });
  main.innerHTML = head + (students.length
    ? `<p class="muted" style="margin:.2rem 0 .8rem">${students.length}명 중 ${done}명 완료 · 학생을 누르면 평가서를 작성합니다.</p>
      <div class="card table-wrap"><table>
        <thead><tr><th>학생</th><th class="num">수업</th><th class="num">출석률</th><th class="num">숙제 완료율</th><th class="num">시험 평균</th><th>평가서</th></tr></thead>
        <tbody>${rows.join("")}</tbody></table></div>`
    : `<div class="card empty">재원 중인 학생이 없습니다.</div>`);
  bind();
  main.querySelectorAll("tr[data-eid]").forEach((tr) => {
    tr.onclick = () => { ev.studentId = tr.dataset.eid; renderEvals(); window.scrollTo(0, 0); };
  });
}

function evalAutoHtml(s, d, sm) {
  const r = sm.r;
  const attParts = ["출석", "지각", "결석", "보강"].filter((k) => r.att[k]).map((k) => `${k} ${r.att[k]}`);
  const diff = r.testAvg != null && r.prevAvg != null ? Math.round(r.testAvg - r.prevAvg) : null;
  const books = r.books.length
    ? `<ul class="eval-list">${r.books.map(({ book, from, to, current }) => `<li>${esc(book.title)}${esc(rangeText(book, { from_unit: from, to_unit: to }))}${current != null ? ` <span class="muted">(현재 ${esc(curNum(book, current))})</span>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted" style="margin:0">이번 달 진도 기록이 없습니다.</p>`;
  const comments = sm.comments.length
    ? `<ul class="eval-list">${sm.comments.map((l) => `<li><span class="muted">${shortDate(l.lesson_date)}</span> ${esc(l.teacher_comment.trim())}</li>`).join("")}</ul>`
    : `<p class="muted" style="margin:0">이번 달에 적은 수업 코멘트가 없습니다.</p>`;
  return `<div class="summary">
      <div class="card"><strong>${r.lessons.length}회</strong><span>수업${attParts.length ? " · " + attParts.join(" · ") : ""}</span></div>
      <div class="card"><strong>${sm.attRate == null ? "-" : sm.attRate + "%"}</strong><span>출석률</span></div>
      <div class="card"><strong>${sm.hwRate == null ? "-" : sm.hwRate + "%"}</strong><span>숙제 완료율</span></div>
      <div class="card"><strong>${r.testAvg == null ? "-" : r.testAvg.toFixed(0) + "점"}</strong><span>시험 평균${diff == null ? "" : diff === 0 ? " · 전월과 비슷" : ` · 전월 대비 ${diff > 0 ? "+" : ""}${diff}점`}</span></div>
    </div>
    <div class="grid eval-auto">
      <div class="card"><h3>이번 달 진도</h3>${books}</div>
      <div class="card"><h3>수업 코멘트</h3>${comments}</div>
    </div>`;
}

function evalPills(name, value) {
  return `<div class="pills" role="radiogroup">
    <label class="pill none"><input type="radio" name="${name}" value="" ${value ? "" : "checked"}><span>-</span></label>
    ${EVAL_LEVELS.map(([n, t]) => `<label class="pill"><input type="radio" name="${name}" value="${n}" ${value === n ? "checked" : ""}><span>${t}</span></label>`).join("")}
  </div>`;
}

function evalValues() {
  const form = $("#ev-form");
  const num = (name) => { const c = form.querySelector(`input[name='${name}']:checked`); return c && c.value ? Number(c.value) : null; };
  const ratings = {};
  EVAL_SKILLS.forEach(([k]) => { ratings[k] = num("r_" + k); });
  const attitude = {};
  EVAL_ATTITUDE.forEach(([k]) => { attitude[k] = num("a_" + k); });
  const vals = { ratings, attitude, status: form.elements.status.value };
  EVAL_TEXTS.forEach(([k]) => { vals[k] = form.elements[k].value.trim(); });
  return vals;
}

/* 월말평가서용 시험 점수 추이 (최근 3개월, 이번 달에 본 종류만) */
function evalGraphHtml(s, d) {
  const start = testsFrom(...d.key.split("-").map(Number));
  const mine = d.tests.filter((t) => t.student_id === s.id && t.test_date >= start && t.test_date <= d.range.end);
  const kinds = TEST_KINDS.filter((k) => mine.some((t) => t.kind === k && t.test_date >= d.range.start));
  if (!kinds.length) return "";
  const card = (kind, ci) => {
    const pts = mine.filter((t) => t.kind === kind).sort((a, b) => a.test_date.localeCompare(b.test_date)).slice(-10)
      .map((t) => ({ v: Math.round(pct(t.score, t.max_score)), cur: t.test_date >= d.range.start, d: parseD(t.test_date) }));
    const cur = pts.filter((p) => p.cur);
    const avgCur = Math.round(avg(cur.map((p) => p.v)));
    const head = `<div class="rg-h"><b>${esc(kind)}</b><span>이번 달 평균 <b>${avgCur}</b>점</span></div>`;
    if (pts.length < 2) return `<div class="rg-card">${head}<div class="rg-one">${pts[0].v}점 <small>· 1회</small></div></div>`;
    const W = 300, H = 118, L = 26, R = 10, T = 12, B = 22;
    const x = (i) => L + 10 + (i * (W - L - R - 20)) / (pts.length - 1);
    const y = (v) => T + ((100 - Math.max(0, Math.min(100, v))) * (H - T - B)) / 100;
    const ci0 = pts.findIndex((p) => p.cur);
    const shade = ci0 >= 0 ? `<rect x="${(x(ci0) - 9).toFixed(1)}" y="${T - 6}" width="${(x(pts.length - 1) - x(ci0) + 18).toFixed(1)}" height="${H - T - B + 6}" rx="3" class="rg-shade"/><text class="rg-cm" x="${((x(ci0) + x(pts.length - 1)) / 2).toFixed(1)}" y="${T - 1}" text-anchor="middle">이번 달</text>` : "";
    const grid = [0, 50, 100].map((g) => `<line class="rg-ax" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text class="rg-tk" x="${L - 5}" y="${y(g) + 3}" text-anchor="end">${g}</text>`).join("");
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const dots = pts.map((p, i) => `<circle class="rg-dot${p.cur ? " cur" : ""}" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.4"/><text class="rg-vl${p.cur ? " cur" : ""}" x="${x(i).toFixed(1)}" y="${(y(p.v) - 7).toFixed(1)}" text-anchor="middle">${p.v}</text><text class="rg-tk" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${p.d.getMonth() + 1}.${p.d.getDate()}</text>`).join("");
    return `<div class="rg-card k${ci}">${head}<div class="rg-plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(kind)} 최근 3개월 점수 추이">${shade}${grid}<path class="rg-ln" d="${line}"/>${dots}</svg></div></div>`;
  };
  return `<div class="rg-sec"><h3>시험 점수 추이 <small>최근 3개월 · 100점 환산</small></h3><div class="rg-two">${kinds.map((k) => card(k, TEST_KINDS.indexOf(k))).join("")}</div></div>`;
}

function evalPrintHtml(s, d, sm, vals) {
  const r = sm.r;
  const [yy, mm] = d.key.split("-").map(Number);
  const segs = (v) => Array.from({ length: 5 }, (_, k) => `<i class="${k < (v || 0) ? "on" : ""}"></i>`).join("");
  const rateRows = (defs, obj) => defs.map(([k, t]) => `<div class="rp-rr"><span class="rp-rn">${t}</span><span class="rp-seg">${segs(obj[k])}</span><span class="rp-rl">${obj[k] ? esc(levelLabel(obj[k])) : "-"}</span></div>`).join("");
  const attParts = ["출석", "지각", "결석", "보강"].filter((k) => r.att[k]).map((k) => `${k} ${r.att[k]}`);
  const diff = r.testAvg != null && r.prevAvg != null ? Math.round(r.testAvg - r.prevAvg) : null;
  const books = r.books.length
    ? `<h3>이번 달 진도</h3>${r.books.map(({ book, from, to, current }) => {
        return `<div class="rp-bk"><div><b>${esc(book.title)}</b> <span class="rp-mut">${esc(rangeText(book, { from_unit: from, to_unit: to }).trim())}</span></div>${current != null ? `<div class="rp-mut rp-sm">현재 ${esc(curNum(book, current))}</div>` : ""}</div>`;
      }).join("")}`
    : "";
  const texts = EVAL_TEXTS.filter(([k]) => vals[k]).map(([k, t]) => `<div class="rp-tx"><h4>${t}</h4><p>${esc(vals[k])}</p></div>`).join("");
  return `<div class="rp-page">
    <div class="rp-top"><div class="rp-brand">${esc(ACADEMY_NAME)}<small>월말평가서</small></div><div class="rp-when">${yy}년<b>${mm}월</b></div></div>
    <div class="rp-body">
      <div class="rp-who"><b>${esc(s.name)}</b><span>${s.grade ? esc(s.grade) + " 학생" : "학생"}</span></div>
      <div class="rp-stats">
        <div class="rp-stat"><b>${r.lessons.length}회</b><span>수업</span>${attParts.length ? `<em>${attParts.join(" · ")}</em>` : ""}</div>
        <div class="rp-stat"><b>${sm.attRate == null ? "-" : sm.attRate + "%"}</b><span>출석률</span></div>
        <div class="rp-stat"><b>${sm.hwRate == null ? "-" : sm.hwRate + "%"}</b><span>숙제 완료율</span></div>
        <div class="rp-stat"><b>${r.testAvg == null ? "-" : r.testAvg.toFixed(0) + "점"}</b><span>시험 평균</span>${diff == null ? "" : `<em>${diff === 0 ? "전월과 비슷" : `전월 대비 ${diff > 0 ? "+" : ""}${diff}점`}</em>`}</div>
      </div>
      ${evalGraphHtml(s, d)}
      <div class="rp-two">
        <div><h3>영역별 평가</h3>${rateRows(EVAL_SKILLS, vals.ratings)}</div>
        <div><h3>학습 태도</h3>${rateRows(EVAL_ATTITUDE, vals.attitude)}${books ? `<div class="rp-gap"></div>${books}` : ""}</div>
      </div>
      ${texts}
    </div>
    <div class="rp-foot"><span>${esc(ACADEMY_NAME)} 공부방</span><span>${shortDate(todayStr())} 출력</span></div>
  </div>`;
}

/* PDF 만들기·공유 (폰의 공유 창으로 보내기). 라이브러리는 처음 쓸 때만 불러옵니다. */
let pdfLibsPromise = null;
function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("PDF 라이브러리를 불러오지 못했습니다"));
    document.head.appendChild(s);
  });
}
function loadPdfLibs() {
  if (!pdfLibsPromise) {
    pdfLibsPromise = Promise.all([loadScriptOnce("vendor/html2canvas.min.js"), loadScriptOnce("vendor/jspdf.umd.min.js")]).catch((e) => { pdfLibsPromise = null; throw e; });
  }
  return pdfLibsPromise;
}
// 평가서(.rp-page)를 A4 세로 PDF Blob 으로 만든다. 여러 장이면 블록 경계(.rp-body 의 자식 위)에서 나눈다.
async function buildPdfBlob(html) {
  await loadPdfLibs();
  const host = document.createElement("div");
  host.className = "pdf-host";
  host.innerHTML = html;
  document.body.appendChild(host);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise((r) => setTimeout(r, 200));
    const page = host.querySelector(".rp-page");
    const W = page.offsetWidth, H = page.offsetHeight;
    const scale = Math.min(2, 3000 / W);
    const canvas = await window.html2canvas(page, { scale, backgroundColor: "#ffffff", logging: false, windowWidth: W });
    const mm = W / 210;               // 화면 px per mm
    const pageH = 297 * mm, mt = 10 * mm, mb = 8 * mm;
    const body = page.querySelector(".rp-body");
    const baseTop = page.getBoundingClientRect().top;
    const tops = body ? [...body.children].map((el) => el.getBoundingClientRect().top - baseTop) : [];
    const foot = page.querySelector(".rp-foot");
    if (foot) tops.push(foot.getBoundingClientRect().top - baseTop);
    const slices = [];
    let pos = 0;
    while (pos < H - 1) {
      const avail = (slices.length ? pageH - mt : pageH) - mb;
      if (H - pos <= avail + mb) { slices.push([pos, H]); break; }
      const limit = pos + avail;
      const cands = tops.filter((t) => t > pos + 20 * mm && t <= limit);
      const cut = cands.length ? Math.max(...cands) : limit;
      slices.push([pos, cut]);
      pos = cut;
    }
    const pdf = new window.jspdf.jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    slices.forEach(([y0, y1], i) => {
      if (i) pdf.addPage();
      const sc = canvas.width / W;
      const sub = document.createElement("canvas");
      sub.width = canvas.width;
      sub.height = Math.max(1, Math.round((y1 - y0) * sc));
      const ctx = sub.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, sub.width, sub.height);
      ctx.drawImage(canvas, 0, Math.round(y0 * sc), canvas.width, sub.height, 0, 0, canvas.width, sub.height);
      pdf.addImage(sub.toDataURL("image/jpeg", 0.92), "JPEG", 0, i ? 10 : 0, 210, (y1 - y0) / mm);
    });
    return pdf.output("blob");
  } finally {
    host.remove();
  }
}
function canSharePdf() {
  return typeof navigator !== "undefined" && typeof navigator.share === "function" && typeof navigator.canShare === "function"
    && (window.matchMedia("(pointer: coarse)").matches || window.innerWidth <= 800);
}
async function sharePdfBlob(blob, filename, title) {
  const file = new File([blob], filename, { type: "application/pdf" });
  if (navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
    } catch (e) {
      if (e && e.name === "AbortError") return "cancel";   // 사용자가 공유 창을 닫음
      throw e;
    }
    return "shared";
  }
  const url = URL.createObjectURL(blob);   // 파일 공유를 못 하는 브라우저: 내려받기
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return "downloaded";
}

/* 월말평가서 인쇄 미리보기 (화면에서 A4 모양 확인) */
function openEvalPreview(html, onPrint, returnTo, label = "평가서 미리보기", opts = {}) {
  const old = document.getElementById("ev-preview-overlay");
  if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "ev-preview-overlay";
  ov.className = "ev-ov";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-label", label);
  ov.innerHTML = `<div class="ev-ov-bar"><strong>${esc(label)}</strong><span class="muted" id="ev-ov-note">A4 기준</span><span class="spacer"></span>
      ${opts.orient ? `<div class="seg" role="group" aria-label="용지 방향">${opts.orient.options.map(([v, t]) => `<button type="button" class="seg-b ${v === opts.orient.value ? "on" : ""}" data-orient="${v}" aria-pressed="${v === opts.orient.value}">${t}</button>`).join("")}</div>` : ""}
      ${opts.share && canSharePdf() ? `<button class="btn" type="button" id="ev-ov-share" disabled>공유 준비 중…</button>` : ""}
      <button class="btn primary" type="button" id="ev-ov-print">인쇄 / PDF 저장</button>
      <button class="btn" type="button" id="ev-ov-close">닫기</button></div>
    <div class="ev-ov-scroll"><div class="ev-sheet ${opts.land ? "land" : ""}" id="ev-sheet">${html}</div></div>`;
  document.body.appendChild(ov);
  const sheet = ov.querySelector("#ev-sheet");
  // 화면 너비에 맞춰 축소 (쪽 나눔은 배율 1에서 계산)
  const fit = () => {
    const avail = ov.querySelector(".ev-ov-scroll").clientWidth - 32;
    const w = ((opts.land ? 297 : 210) / 25.4) * 96;
    // zoom 대신 transform 으로 줄이면 글자·줄 높이가 달라지지 않아 쪽 나눔이 화면 크기와 무관하게 같습니다
    const z = Math.min(1, avail / w);
    const box = ov.querySelector(".ev-ov-scroll").clientWidth;
    sheet.style.transformOrigin = "top left";
    sheet.style.transform = z < 1 ? `translateX(${Math.max(0, (box - 32 - w * z) / 2)}px) scale(${z})` : "";
    sheet.style.margin = z < 1 ? "0" : "";
    sheet.style.marginBottom = z < 1 ? `${-(1 - z) * sheet.offsetHeight}px` : "";
  };
  const paged = opts.onRender ? opts.onRender(sheet) : null;
  fit();
  // A4 한 장(297mm) 기준으로 몇 장이 되는지 계산 (쪽을 나눠 보여 준 화면은 그 쪽 수)
  const pageH = ((opts.land ? 210 : 297) / 25.4) * 96;
  const pages = typeof paged === "number" ? paged : Math.max(1, Math.ceil((sheet.offsetHeight - 2) / pageH));
  const pg = opts.land ? "A4 가로" : "A4";
  ov.querySelector("#ev-ov-note").textContent = pages > 1 ? `${pg} 기준 · 내용이 길어 ${pages}장으로 인쇄됩니다` : `${pg} 한 장`;
  const onResize = () => fit();
  window.addEventListener("resize", onResize);
  const close = () => {
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey, true);
    ov.remove();
    if (returnTo && returnTo.isConnected) returnTo.focus();
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };
  document.addEventListener("keydown", onKey, true);
  ov.querySelectorAll("[data-orient]").forEach((b) => {
    b.onclick = () => { if (b.dataset.orient !== opts.orient.value) { window.removeEventListener("resize", onResize); document.removeEventListener("keydown", onKey, true); opts.orient.onChange(b.dataset.orient); } };
  });
  ov.querySelector("#ev-ov-close").onclick = close;
  ov.querySelector("#ev-ov-print").onclick = onPrint;
  const shBtn = ov.querySelector("#ev-ov-share");
  if (shBtn) {
    // 공유 창은 버튼을 누른 직후에만 열 수 있어서(특히 Safari), PDF를 미리 만들어 두고 준비가 끝나면 버튼을 켠다.
    let blob = null, closed = false;
    const origClose = ov.querySelector("#ev-ov-close");
    origClose.addEventListener("click", () => { closed = true; });
    setTimeout(() => {
      buildPdfBlob(html).then((b) => {
        if (closed) return;
        blob = b; shBtn.disabled = false; shBtn.textContent = "공유";
      }).catch((e) => {
        if (closed) return;
        shBtn.textContent = "공유 불가"; shBtn.title = String((e && e.message) || e);
      });
    }, 300);
    shBtn.onclick = async () => {
      if (!blob) return;
      shBtn.disabled = true;
      try {
        const r = await sharePdfBlob(blob, opts.share.filename, opts.share.title || label);
        if (r === "downloaded") toast("PDF를 내려받았습니다");
      } catch (e) {
        toast("공유하지 못했습니다: " + ((e && e.message) || e));
      } finally {
        shBtn.disabled = false;
      }
    };
  }
  ov.querySelector("#ev-ov-close").focus();
}

function renderEvalDetail(s, d, head, bindHead) {
  const ev = state.evals;
  const row = d.rows.find((r) => r.student_id === s.id) || null;
  const sm = evalSummary(s, d);
  const ratings = (row && row.ratings) || {};
  const attitude = (row && row.attitude) || {};
  const val = (k) => (row && row[k]) || "";
  const rateRows = (defs, prefix, obj) => defs.map(([k, t]) => `<div class="rate-row"><span class="rate-name">${t}</span>${evalPills(prefix + k, obj[k] ?? null)}</div>`).join("");
  $("#main").innerHTML = `
    <div class="eval-edit">
      ${head}
      <div class="toolbar"><button class="btn" type="button" id="ev-back">← 학생 목록</button><strong style="font-size:1.1rem">${esc(s.name)}</strong><span class="muted">${esc(s.grade || "")}</span>${evalStatusBadge(row)}</div>
      ${row && row.status === "AI 초안" ? `<div class="ai-note"><strong>AI 초안</strong> — Claude가 작성했습니다${row.source === "ai" && row.ai_model ? ` (${esc(row.ai_model)})` : ""}. 내용을 확인·수정한 뒤 아래 상태를 '작성 중'이나 '완료'로 바꿔 저장하세요. 상태가 'AI 초안'으로 남아 있으면 다음 예약 작업이 내용을 다시 씁니다.</div>` : ""}
      ${evalAutoHtml(s, d, sm)}
      <form id="ev-form" class="eval-form" autocomplete="off">
        <div class="grid">
          <div class="card"><h3>영역별 평가</h3>${rateRows(EVAL_SKILLS, "r_", ratings)}</div>
          <div class="card"><h3>학습 태도</h3>${rateRows(EVAL_ATTITUDE, "a_", attitude)}</div>
        </div>
        ${EVAL_TEXTS.map(([k, t, ph]) => `<label class="card eval-text"><h3>${t}</h3><textarea name="${k}" rows="5" maxlength="3000" placeholder="${esc(ph)}">${esc(val(k))}</textarea></label>`).join("")}
        <div class="card eval-actions">
          <label class="check"><span>상태</span><select name="status">${EVAL_STATUS.map((x) => `<option value="${x}" ${(row ? row.status : "작성중") === x ? "selected" : ""}>${x === "작성중" ? "작성 중" : x}</option>`).join("")}</select></label>
          <span class="spacer"></span>
          <p id="ev-err" class="error" role="alert"></p>
          <button class="btn" type="button" id="ev-preview">평가서 미리보기</button>
          <button class="btn primary" type="submit" id="ev-save">저장</button>
        </div>
      </form>
    </div>
    <div class="eval-print" id="ev-print-area"></div>`;
  bindHead();
  $("#ev-back").onclick = () => { ev.studentId = null; renderEvals(); };
  const doPrint = () => {
    $("#ev-print-area").innerHTML = evalPrintHtml(s, d, sm, evalValues());
    window.print();
  };
  $("#ev-preview").onclick = () => openEvalPreview(evalPrintHtml(s, d, sm, evalValues()), doPrint, $("#ev-preview"), "평가서 미리보기", {
    onRender: paginateEvalPreview,
    share: { filename: `월말평가서_${s.name}_${ev.year}-${String(ev.month).padStart(2, "0")}.pdf`, title: `${s.name} ${ev.month}월 월말평가서` },
  });
  $("#ev-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#ev-save");
    btn.disabled = true;
    $("#ev-err").textContent = "";
    try {
      const vals = evalValues();
      const payload = { student_id: s.id, year: ev.year, month: ev.month, ...vals, source: "teacher", ai_model: null, updated_at: new Date().toISOString() };
      const saved = await run(db.from("monthly_evaluations").upsert(payload, { onConflict: "student_id,year,month" }).select("*").single());
      const merged = { ...(row || {}), ...payload, ...(saved || {}) };
      const i = d.rows.findIndex((r) => r.student_id === s.id);
      if (i >= 0) d.rows[i] = merged; else d.rows.push(merged);
      toast(vals.status === "완료" ? "저장했습니다 (완료)" : "저장했습니다");
      renderEvals();
    } catch (err) {
      $("#ev-err").textContent = "저장하지 못했습니다: " + (err.message || err);
      btn.disabled = false;
    }
  };
}

/* ---------- 수업 추천 공통: 기간 필터 + 인쇄 ---------- */
function filterRange(f) {
  return f.range === "all" ? null : periodRange(f.range, f.start, f.end);
}
function inRange(f, dateStr) {
  const rg = filterRange(f);
  return !rg || (dateStr >= rg.start && dateStr <= rg.end);
}
function filterHtml(f, p, withPrint) {
  const rg = filterRange(f);
  const opts = [["all", "전체 기간"], ["thisWeek", "이번 주"], ["lastWeek", "지난 주"], ["nextWeek", "다음 주"], ["thisMonth", "이번 달"], ["lastMonth", "지난 달"], ["custom", "직접 선택"]];
  return `<div class="card report-controls">
      <label>기간<select id="${p}-range">${opts.map(([v, t]) => `<option value="${v}" ${f.range === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>시작일<input type="date" id="${p}-start" value="${esc(rg ? rg.start : "")}" aria-label="시작일 직접 입력"></label>
      <label>종료일<input type="date" id="${p}-end" value="${esc(rg ? rg.end : "")}" aria-label="종료일 직접 입력"></label>
      ${withPrint ? `<div style="align-self:end"><button class="btn" id="${p}-print" type="button">${typeof withPrint === "string" ? esc(withPrint) : "인쇄 / PDF 저장"}</button></div>` : ""}
    </div>`;
}
function bindFilter(f, p, rerender) {
  // 직접 선택으로 바꿀 때는 지금 보던 기간을 시작·종료일 초기값으로 유지
  $("#" + p + "-range").onchange = (e) => {
    if (e.target.value === "custom") {
      const cur = filterRange(f) || { start: todayStr(), end: todayStr() };
      f.start = cur.start; f.end = cur.end;
    }
    f.range = e.target.value;
    rerender();
  };
  // 날짜를 직접 입력하면 자동으로 "직접 선택"이 된다. 연도를 타이핑하는 동안은 기다렸다가 적용.
  let timer = null;
  const apply = (nextId) => {
    clearTimeout(timer);
    timer = null;
    const cur = filterRange(f) || { start: todayStr(), end: todayStr() };
    const s = $("#" + p + "-start"), e = $("#" + p + "-end");
    if (!s || !e) return;
    const ae = document.activeElement;
    const keep = typeof nextId === "string" ? nextId : (ae === s || ae === e ? ae.id : "");
    f.start = s.value || cur.start;
    f.end = e.value || cur.end;
    f.range = "custom";
    rerender();
    if (keep) { const el = $("#" + keep); if (el) el.focus(); }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(() => apply(), 700); };
  ["start", "end"].forEach((k) => {
    const el = $("#" + p + "-" + k);
    el.onchange = later;
    el.onblur = (ev) => {
      if (!timer) return;
      const rt = ev.relatedTarget;
      apply(rt && (rt.id === p + "-start" || rt.id === p + "-end") ? rt.id : "");
    };
    el.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); apply(el.id); } };
  });
  const pr = $("#" + p + "-print");
  if (pr) pr.onclick = () => window.print();
}
function recFilterRange() { return filterRange(state.recFilter); }
function recDate(r) {
  return r.target_date || (r.created_at || "").slice(0, 10);
}
function filterRecs(recs) {
  return recs.filter((r) => inRange(state.recFilter, recDate(r)));
}
function recFilterHtml() { return filterHtml(state.recFilter, "rf", true); }
function recPrintHead(title) {
  const rg = recFilterRange();
  return `<div class="print-head"><h2>[${esc(ACADEMY_NAME)}] ${esc(title)}</h2><p>${rg ? `기간: ${shortDate(rg.start)} ~ ${shortDate(rg.end)}` : "기간: 전체"} · 출력일 ${shortDate(todayStr())}</p></div>`;
}
function bindRecFilter(rerender) { bindFilter(state.recFilter, "rf", rerender); }


/* 학생용 수업 안내서 (A4) */
function planTitle(f) {
  const t = { thisWeek: "이번 주", lastWeek: "지난 주", nextWeek: "다음 주", thisMonth: "이번 달", lastMonth: "지난 달" }[f.range];
  return t ? `${t} 수업 안내` : "수업 안내";
}
const DOW_FULL = "일요일 월요일 화요일 수요일 목요일 금요일 토요일".split(" ");
/* 미리보기: 긴 내용을 A4 쪽 단위로 나눠 보여 줍니다 (블록은 쪽 사이에서 잘리지 않음, 머리글은 첫 쪽에만, 푸터는 모든 쪽에) */
function paginatePreview(sheet, cfg) {
  const first = sheet.querySelector(cfg.page);
  if (!first) return null;
  const pageH = ((cfg.h || 297) / 25.4) * 96;
  const foot = first.querySelector(".rp-foot");
  const items = (bd) => [...bd.querySelectorAll(cfg.items)];
  const pagesEls = [first];
  let page = first;
  for (let guard = 0; guard < 80; guard++) {
    const bd = page.querySelector(cfg.body);
    let next = null;
    while (page.offsetHeight > pageH + 1) {
      const kids = items(bd);
      if (kids.length <= 1) break;
      if (!next) {
        next = document.createElement("div");
        next.className = `rp-page ${cfg.cont}`;
        next.innerHTML = `<div class="${cfg.body.slice(1)}"></div>`;
        if (foot) next.appendChild(foot.cloneNode(true));
        page.after(next);
      }
      next.querySelector(cfg.body).prepend(kids[kids.length - 1]);
    }
    if (!next) break;
    pagesEls.push(next);
    page = next;
  }
  sheet.classList.add("paged");
  pagesEls.forEach((p, i) => { const n = document.createElement("div"); n.className = "pl-pn"; n.textContent = `${i + 1} / ${pagesEls.length}쪽`; p.appendChild(n); });
  return pagesEls.length;
}
const paginatePlanPreview = (sheet) => paginatePreview(sheet, { page: ".pl-page", body: ".pl-bd", items: ":scope > .pl-card, :scope > .pl-memo", cont: "pl-page pl-cont" });
const paginateSchedPortrait = (sheet) => paginatePreview(sheet, { page: ".rp-page", body: ".tp-bd", items: ":scope > .tp-day", cont: "tp-page tp-cont" });
// 가로 시간표: 표의 줄(타임)을 쪽 단위로 나누고, 요일 머리줄은 모든 쪽에 다시 붙입니다.
function paginateSchedLand(sheet) {
  const first = sheet.querySelector(".rp-page");
  const table = first && first.querySelector(".tl-table");
  if (!table) return null;
  const pageH = (210 / 25.4) * 96;
  const foot = first.querySelector(".rp-foot");
  const pagesEls = [first];
  let page = first;
  for (let guard = 0; guard < 40; guard++) {
    const tb = page.querySelector(".tl-table tbody");
    let next = null;
    const footEl = page.querySelector(".rp-foot");
    // 마지막 줄 아래(표 간격 3mm + 여백 2mm)가 푸터 위로 넘치면 한 줄씩 다음 쪽으로 보냅니다
    const over = () => tb.rows[tb.rows.length - 1].getBoundingClientRect().bottom + (5 / 25.4) * 96 > footEl.getBoundingClientRect().top + 1;
    while ((page.offsetHeight > pageH + 1 || over()) && tb.rows.length > 1) {
      if (!next) {
        next = document.createElement("div");
        next.className = "rp-page tp-page tp-land tp-cont";
        const t2 = table.cloneNode(false);
        t2.appendChild(table.tHead.cloneNode(true));
        t2.appendChild(document.createElement("tbody"));
        next.innerHTML = `<div class="tl-bd"></div>`;
        next.querySelector(".tl-bd").appendChild(t2);
        if (foot) next.appendChild(foot.cloneNode(true));
        page.after(next);
      }
      next.querySelector("tbody").prepend(tb.rows[tb.rows.length - 1]);
    }
    if (!next) break;
    pagesEls.push(next);
    page = next;
  }
  sheet.classList.add("paged");
  pagesEls.forEach((p, i) => { const n = document.createElement("div"); n.className = "pl-pn"; n.textContent = `${i + 1} / ${pagesEls.length}쪽`; p.appendChild(n); });
  return pagesEls.length;
}
const paginateEvalPreview = (sheet) => paginatePreview(sheet, { page: ".rp-page", body: ".rp-body", items: ":scope > *", cont: "rp-cont" });

function planPrintHtml(s, recs) {
  const rg = filterRange(state.recFilter);
  const title = planTitle(state.recFilter);
  const list = recs.filter((r) => r.status !== "거절").sort((a, b) => recDate(a).localeCompare(recDate(b)));
  const book = (r) => {
    const b = state.textbooks.find((x) => x.id === r.textbook_id);
    const pr = b ? state.progress.find((x) => x.student_id === s.id && x.textbook_id === b.id) : null;
    const hasPr = !!(pr && b && b.total_units);
    const range = b ? rangeText(b, r).trim() : `${r.from_unit}–${r.to_unit}단원`;
    return `<div class="pl-book">
        <div class="pl-bk">${esc(b ? b.title : "")}</div>
        <div class="pl-rg">${esc(range)}</div>
        ${hasPr ? `<div class="pl-pg">지금까지 ${bookLeaves(b) ? esc(curNum(b, pr.current_unit)) : esc(b.unit_label) + " " + pr.current_unit + " / " + b.total_units}</div>` : ""}
        ${r.rationale ? `<div class="pl-pt">${esc(r.rationale)}</div>` : ""}
        <div class="pl-wr"><div class="pl-wr-t">수업 후 기록</div>
          <div class="pl-ln"><span>실제 진도</span><i class="w1"></i><span>~</span><i class="w2"></i></div>
          <div class="pl-ln"><span>선생님 코멘트</span><i></i></div>
          <div class="pl-ln"><i></i></div></div>
      </div>`;
  };
  // 같은 수업일의 교재는 한 그룹(날짜 칸 한 번)으로 묶습니다.
  const byDate = new Map();
  list.forEach((r) => { const k = r.target_date || ""; if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(r); });
  const group = ([date, items]) => {
    const d = date ? parseD(date) : null;
    return `<div class="pl-card pl-grp">
      <div class="pl-date">${d ? `<div class="pl-d">${d.getDate()}</div><div class="pl-w">${DOW_FULL[d.getDay()]}</div>` : `<div class="pl-d pl-tbd">예정</div><div class="pl-w">날짜 미정</div>`}<div class="pl-cnt">교재 ${items.length}개</div></div>
      <div class="pl-books">${items.map(book).join("")}</div></div>`;
  };
  return `<div class="rp-page pl-page">
    <div class="pl-hd"><div class="pl-br">${esc(ACADEMY_NAME).toUpperCase()}</div><h1>${esc(title)}</h1>
      <div class="pl-who"><span><b>${esc(s.name)}</b>${s.grade ? ` (${esc(s.grade)})` : ""}</span>${rg ? `<span>${shortDate(rg.start)} – ${shortDate(rg.end)}</span>` : ""}</div></div>
    <div class="pl-bd">
      <p class="pl-hello">${esc(title)}입니다. 수업 전에 한 번 훑어보고 오면 더 쉬워져요!</p>
      <h2 class="pl-h2">${esc(title.replace(/ 안내$/, ""))}</h2>
      ${list.length ? [...byDate.entries()].map(group).join("") : `<p class="pl-empty">이 기간에 예정된 수업이 없습니다.</p>`}
      ${list.length ? `<div class="pl-ln pl-memo"><span>메모</span><i></i></div>` : ""}
    </div>
    <div class="rp-foot"><span>${esc(ACADEMY_NAME)}</span><span>궁금한 점은 선생님께 언제든 물어보세요</span></div>
  </div>`;
}

/* ---------- 수업 추천 (Claude 예약 작업이 저장한 제안을 확인) ---------- */
const REC_ICON = {
  lock: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" style="vertical-align:-2px;margin-right:.3em"><rect x="4.5" y="9" width="11" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7 9V6.5a3 3 0 016 0V9" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  pen: '<svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" style="vertical-align:-2px;margin-right:.3em"><path d="M3 17h3.5L16.5 7a2.1 2.1 0 00-3-3L3.5 14 3 17z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};

/* 추천 수정: 그날 '제안' 상태인 추천의 단원·추천 이유를 직접 고칩니다 (수업 기록이 있는 날은 불가) */
function editRecsForm(s, ids) {
  const list = (state.detail.recs || []).filter((r) => ids.includes(r.id) && r.status === "제안");
  if (!list.length) { toast("수정할 추천이 없습니다"); return; }
  const date = list[0].target_date;
  if (date && recLessonOn(s.id, { target_date: date })) { alert("이 날은 수업 기록이 있어 추천을 수정할 수 없어요."); return; }
  const unitOpts = (b, sel) => { const o = []; for (let n = 1; n <= b.total_units; n++) o.push(`<option value="${n}" ${n === sel ? "selected" : ""}>${esc(unitName(b, n))}</option>`); return o.join(""); };
  const items = list.map((r) => ({ r, b: state.textbooks.find((x) => x.id === r.textbook_id) })).filter((x) => x.b);
  const wd = date ? DAY_NAME[new Date(`${date}T00:00:00`).getDay()] : "";
  openForm({
    title: `추천 수정 · ${date ? `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일 (${wd})` : "수업일 미정"}`,
    wide: true,
    fields: [{ name: "re-slot", type: "slot" }],
    values: {},
    submitLabel: "수정 저장",
    onSubmit: async () => {
      const upd = [];
      for (const { r, b } of items) {
        const from = Number(document.querySelector(`[data-re-from="${r.id}"]`).value);
        const to = Number(document.querySelector(`[data-re-to="${r.id}"]`).value);
        const why = document.querySelector(`[data-re-why="${r.id}"]`).value.trim().slice(0, 600);
        if (from > to) throw new Error(`${b.title}: 시작 단원이 종료 단원보다 뒤예요.`);
        if (from < 1 || to > b.total_units) throw new Error(`${b.title}: 전체 단원 수(${b.total_units})를 벗어났어요.`);
        if (from !== r.from_unit || to !== r.to_unit || why !== (r.rationale || "")) upd.push({ r, patch: { from_unit: from, to_unit: to, rationale: why || null } });
      }
      if (!upd.length) throw new Error("바뀐 내용이 없습니다.");
      const when = new Date().toISOString();
      for (const { r, patch } of upd) {
        try {
          await run(db.from("recommendations").update({ ...patch, edited_at: when }).eq("id", r.id).eq("status", "제안"));
        } catch (e) {
          if (!/edited_at/i.test((e && e.message) || "")) throw e;
          await run(db.from("recommendations").update(patch).eq("id", r.id).eq("status", "제안")); // schema.sql 미적용: 표시 없이 저장
          toast("저장했어요. '직접 수정' 표시와 예약 작업 보호는 최신 schema.sql 실행 후 적용됩니다.");
        }
      }
      await refresh();
      toast(`추천 ${upd.length}개를 수정했습니다`);
    },
  });
  $("#re-slot").innerHTML = `<p class="muted" style="margin:0 0 .6rem">아직 수업 기록에 반영되지 않은 추천입니다. 저장해도 "제안" 상태로 남고 "직접 수정" 표시가 붙습니다.</p>` +
    items.map(({ r, b }) => `<fieldset class="re-box"><legend>${esc(b.title)}</legend>
      <div class="re-row"><label>시작 단원<select data-re-from="${esc(r.id)}">${unitOpts(b, r.from_unit)}</select></label>
      <label>종료 단원<select data-re-to="${esc(r.id)}">${unitOpts(b, r.to_unit)}</select></label></div>
      <label>추천 이유<textarea rows="2" maxlength="600" data-re-why="${esc(r.id)}">${esc(r.rationale || "")}</textarea></label></fieldset>`).join("");
}

function renderRecsTab(s) {
  const allForStudent = state.detail.recs || [];
  const recs = filterRecs(allForStudent);
  const pending = recs.filter((r) => r.status === "제안");
  const done = recs.filter((r) => r.status !== "제안");
  const card = (r) => {
    const b = state.textbooks.find((x) => x.id === r.textbook_id);
    const pr = b ? state.progress.find((x) => x.student_id === s.id && x.textbook_id === b.id) : null;
    const cls = r.status === "거절" ? "bad" : r.status === "제안" ? "warn" : "";
    const has = r.status === "거절" ? null : recLessonOn(s.id, r);
    return `<div class="card ${has ? "rec-has" : ""}" style="margin-bottom:.7rem">
      <div class="toolbar" style="margin:0">
        <span class="badge ${cls}">${esc(r.status)}</span>${r.edited_at ? '<span class="badge done">직접 수정</span>' : ""}
        <strong>${esc(b ? b.title + rangeText(b, r) : r.from_unit + "–" + r.to_unit + "단원")}</strong>
      </div>
      ${r.rationale ? `<div class="memo-cell" style="margin-top:.4rem">${esc(r.rationale)}</div>` : ""}
      <div class="muted" style="font-size:.8rem;margin-top:.3rem">${pr && b ? `현재 진도 ${esc(curLabel(b, pr.current_unit))} · ` : ""}${fmtDate((r.created_at || "").slice(0, 10))} 생성${r.model ? " · " + esc(r.model) : ""}${r.edited_at ? " · " + fmtDate(r.edited_at.slice(0, 10)) + " 수정" : ""}${r.decided_at ? " · " + fmtDate(r.decided_at.slice(0, 10)) + " 처리" : ""}</div>
    </div>`;
  };
  // 같은 수업일의 추천은 날짜(요일)별 그룹으로 묶어 보여줍니다.
  const groups = (list, desc) => {
    const m = new Map();
    list.forEach((r) => { const k = r.target_date || ""; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return [...m.entries()].sort((x, y) => (desc ? y[0].localeCompare(x[0]) : x[0].localeCompare(y[0])));
  };
  const group = ([date, items], isDone) => {
    const d = date ? new Date(`${date}T00:00:00`) : null;
    const wd = d && !Number.isNaN(d.getTime()) ? DAY_NAME[d.getDay()] : "";
    const has = !isDone && date ? recLessonOn(s.id, { target_date: date }) : null;
    const open = items.filter((r) => r.status === "제안");
    return `<section class="rec-grp ${isDone ? "done" : ""}">
      <div class="rec-gh">
        <span class="rec-gd" aria-hidden="true">${wd || "·"}</span>
        <div class="rec-gt"><strong>${date ? `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일${wd ? ` (${wd})` : ""}` : "수업일 미정"}</strong><span class="muted">${isDone ? "수업" : "수업 예정"} · 교재 ${items.length}개</span></div>
        ${has ? lessonChip(has) : ""}
        <span class="spacer"></span>
        ${open.length ? `${has ? `<button class="btn small" type="button" disabled title="수업 기록이 있어 수정할 수 없어요">${REC_ICON.lock}추천 수정</button><button class="btn small" type="button" disabled>기록 있음</button>` : `<button class="btn small" type="button" data-rec-edit="${open.map((r) => esc(r.id)).join(",")}">${REC_ICON.pen}추천 수정</button><button class="btn small primary" type="button" data-rec-use="${esc(open[0].id)}">수업 기록 반영</button>`}<button class="btn small danger" type="button" data-rec-no="${open.map((r) => esc(r.id)).join(",")}">거절</button>` : ""}
      </div>
      ${items.map(card).join("")}
    </section>`;
  };
  $("#tab-body").innerHTML = `<div class="eval-edit">` + filterHtml(state.recFilter, "rf", "수업 안내 미리보기") + (recs.length
    ? `${pending.length ? groups(pending, false).map((g) => group(g, false)).join("") : `<div class="card empty">확인할 새 추천이 없습니다.</div>`}
       ${done.length ? `<h3 style="margin-top:1.2rem">지난 추천</h3>${groups(done, true).map((g) => group(g, true)).join("")}` : ""}
       <p class="muted" style="font-size:.85rem">날짜별 "수업 기록 반영"을 누르면 수업 기록 창이 그날 추천 교재·단원으로 한 번에 채워집니다. "거절"은 그날 추천 전체에 적용됩니다. 그대로 저장하면 "채택", 고쳐서 저장하면 "수정"으로 기록됩니다. 진도표는 수업 기록을 저장할 때만 바뀝니다.</p>`
    : `<div class="card empty">${allForStudent.length ? "이 기간에는 추천이 없습니다. 위에서 기간을 바꿔 보세요." : "아직 추천이 없습니다. Claude 예약 작업이 실행되면 여기에 표시됩니다."}</div>`) + `</div><div class="eval-print" id="plan-print-area"></div>`;
  bindRecFilter(() => renderRecsTab(s));
  const doPrint = () => {
    $("#plan-print-area").innerHTML = planPrintHtml(s, recs);
    document.body.classList.add("print-plan"); // 학생 머리글·메모는 인쇄에서 제외
    try { window.print(); } finally { document.body.classList.remove("print-plan"); }
  };
  $("#rf-print").onclick = () => openEvalPreview(planPrintHtml(s, recs), doPrint, $("#rf-print"), "수업 안내 미리보기", { onRender: paginatePlanPreview });

  $("#tab-body").querySelectorAll("[data-rec-use]").forEach((b) => {
    b.onclick = async () => {
      const rec = recs.find((r) => r.id === b.dataset.recUse);
      if (await recDateHasLesson(s, rec)) return;
      lessonForm(s, null, rec);
    };
  });
  $("#tab-body").querySelectorAll("[data-lesson-chip]").forEach((b) => {
    b.onclick = () => {
      const l = state.detail.lessons.find((x) => x.lesson_date === b.dataset.lessonChip);
      if (l) lessonForm(s, l);
    };
  });
  $("#tab-body").querySelectorAll("[data-rec-edit]").forEach((b) => {
    b.onclick = () => editRecsForm(s, b.dataset.recEdit.split(",").filter(Boolean));
  });
  $("#tab-body").querySelectorAll("[data-rec-no]").forEach((b) => {
    b.onclick = async () => {
      const ids = b.dataset.recNo.split(",").filter(Boolean);
      if (!confirm(ids.length > 1 ? `이날 추천 ${ids.length}개를 모두 거절로 기록할까요?` : "이 추천을 거절로 기록할까요?")) return;
      try {
        await run(db.from("recommendations").update({ status: "거절", decided_at: new Date().toISOString() }).in("id", ids));
        await refresh();
      } catch (err) {
        fail(err);
      }
    };
  });
}

/* ---------- 수업 추천 (전체 학생) ---------- */
async function loadAllRecs() {
  state.allRecs = await run(db.from("recommendations").select("*").order("created_at", { ascending: false }).limit(500));
}

function renderAllRecs() {
  const wk = periodRange("thisWeek");
  const recs = state.allRecs.filter((r) => recDate(r) >= wk.start && recDate(r) <= wk.end);
  const name = (id) => (state.students.find((s) => s.id === id) || {}).name || "(삭제된 학생)";
  const pending = recs.filter((r) => r.status === "제안");
  const done = recs.filter((r) => r.status !== "제안").slice(0, 30);
  const row = (r) => {
    const b = state.textbooks.find((x) => x.id === r.textbook_id);
    const pr = b ? state.progress.find((x) => x.student_id === r.student_id && x.textbook_id === b.id) : null;
    const cls = r.status === "거절" ? "bad" : r.status === "제안" ? "warn" : "";
    const has = r.status === "거절" ? null : recLessonOn(r.student_id, r);
    return `<tr data-rid="${esc(r.id)}" class="${has ? "rec-has-row" : ""}">
      <td><strong>${esc(name(r.student_id))}</strong></td>
      <td>${esc(b ? b.title + rangeText(b, r) : r.from_unit + "–" + r.to_unit + "단원")}${pr && b ? `<div class="muted" style="font-size:.8rem">현재 ${esc(curLabel(b, pr.current_unit))}</div>` : ""}</td>
      <td style="white-space:nowrap">${r.target_date ? fmtDate(r.target_date) : "-"}${has ? `<div style="margin-top:.3rem">${lessonChip(has)}</div>` : ""}</td>
      <td class="memo-cell">${esc(r.rationale || "")}</td>
      <td style="white-space:nowrap"><span class="badge ${cls}">${esc(r.status)}</span>
        ${r.status === "제안" ? `<div class="book-actions" style="margin-top:.4rem">${has ? `<button class="btn small" type="button" disabled>기록 있음</button>` : `<button class="btn small primary" data-rec-use="${esc(r.id)}" type="button">반영</button>`}<button class="btn small danger" data-rec-no="${esc(r.id)}" type="button">거절</button></div>` : ""}</td></tr>`;
  };
  const table = (rows) => `<div class="card table-wrap"><table>
    <thead><tr><th>학생</th><th>추천 교재 · 범위</th><th>수업 예정일</th><th>근거</th><th>상태</th></tr></thead>
    <tbody>${rows.map(row).join("")}</tbody></table></div>`;
  $("#main").innerHTML = `
    <div class="page-head"><h2>수업 추천</h2><span class="muted">이번 주 ${shortDate(wk.start)} ~ ${shortDate(wk.end)} · 학생별 다음 수업 진도 추천</span></div>
    ${pending.length ? `${table(pending)}` : `<div class="card empty">이번 주에 확인할 새 추천이 없습니다. 다른 주의 추천은 학생 화면의 수업 추천 탭에서 기간을 바꿔 볼 수 있습니다.</div>`}
    ${done.length ? `<h3 style="margin-top:1.2rem">최근 처리한 추천</h3>${table(done)}` : ""}
    <p class="muted" style="font-size:.85rem;margin-top:.8rem">"반영"을 누르면 그 학생의 수업 기록 창이 추천 교재·단원으로 채워집니다. 그대로 저장하면 "채택", 고쳐서 저장하면 "수정"으로 기록되고, 진도표는 수업 기록을 저장할 때만 바뀝니다.</p>`;

  $("#main").querySelectorAll("[data-rec-use]").forEach((b) => {
    b.onclick = async () => {
      const rec = recs.find((r) => r.id === b.dataset.recUse);
      const s = state.students.find((x) => x.id === rec.student_id);
      if (!s) return toast("학생 정보를 찾을 수 없습니다");
      await selectStudent(s.id);
      state.tab = "recs";
      render();
      if (await recDateHasLesson(s, rec)) return;
      lessonForm(s, null, state.detail.recs.find((r) => r.id === rec.id) || rec);
    };
  });
  $("#main").querySelectorAll("[data-lesson-chip]").forEach((b) => {
    b.onclick = async () => {
      const rec = recs.find((r) => r.id === b.closest("tr").dataset.rid);
      const st = rec && state.students.find((x) => x.id === rec.student_id);
      if (!st) return;
      await selectStudent(st.id);
      state.tab = "recs";
      render();
      const l = state.detail.lessons.find((x) => x.lesson_date === b.dataset.lessonChip);
      if (l) lessonForm(st, l);
    };
  });
  $("#main").querySelectorAll("[data-rec-no]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("이 추천을 거절로 기록할까요?")) return;
      try {
        await run(db.from("recommendations").update({ status: "거절", decided_at: new Date().toISOString() }).eq("id", b.dataset.recNo));
        await loadAllRecs();
        await loadCore();
        render();
      } catch (err) {
        fail(err);
      }
    };
  });
}

/* ---------- 학생 / 교재 관리 ---------- */
const studentFields = [
  { name: "name", label: "이름", required: true, maxlength: 50 },
  { name: "grade", label: "학년 (예: 초5, 중2)", half: true, maxlength: 20 },
  { name: "started_on", label: "등록일", type: "date", half: true },
  { name: "memo", label: "메모 (민감한 개인정보는 가급적 적지 마세요)", type: "textarea" },
  { name: "active", label: "재원 중", type: "checkbox", default: true },
];

function addStudent() {
  openForm({
    title: "학생 추가",
    fields: studentFields,
    values: { active: true, started_on: todayStr() },
    onSubmit: async (d) => {
      const row = await run(db.from("students").insert(d).select().single());
      state.view = "student";
      state.studentId = row.id;
      state.tab = "progress";
      await refresh();
      toast("학생을 추가했습니다");
    },
  });
}

function editStudent(s) {
  openForm({
    title: "학생 정보 수정",
    fields: studentFields,
    values: s,
    onSubmit: async (d) => {
      await run(db.from("students").update(d).eq("id", s.id));
      await refresh();
      toast("저장했습니다");
    },
    onDelete: async () => {
      await run(db.from("students").delete().eq("id", s.id));
      state.view = "overview";
      state.studentId = null;
      await refresh();
      toast("학생과 관련 기록을 삭제했습니다");
    },
  });
}

function manageTextbooks() {
  const dlg = $("#dlg");
  $("#dlg-title").textContent = "교재 관리";
  $("#dlg-err").textContent = "";
  $("#dlg-delete").hidden = true;
  $("#dlg-submit").hidden = true;
  $("#dlg-cancel").textContent = "닫기";
  $("#dlg-cancel").onclick = () => dlg.close();
  $("#dlg-form").onsubmit = (e) => e.preventDefault();
  const paint = () => {
    $("#dlg-body").innerHTML = `
      <div class="toolbar"><button type="button" class="btn primary small" id="tb-add">+ 교재 추가</button></div>
      ${
        state.textbooks.length
          ? `<ul style="list-style:none;margin:0;padding:0">${state.textbooks
              .map(
                (b) => `<li style="display:flex;gap:.5rem;align-items:center;padding:.45rem 0;border-bottom:1px solid var(--border)">
                  <span style="flex:1"><strong>${esc(b.title)}</strong> <span class="muted">${bookLeaves(b) ? `${b.structure.items.length}개 항목 · ${b.total_units}단원` : `${b.total_units} ${esc(b.unit_label)}`}</span></span>
                  <button type="button" class="btn small" data-edit="${esc(b.id)}">수정</button></li>`
              )
              .join("")}</ul>`
          : `<p class="muted">등록된 교재가 없습니다.</p>`
      }`;
  };
  paint();
  const restore = () => {
    $("#dlg-submit").hidden = false;
    $("#dlg-cancel").textContent = "취소";
    dlg.removeEventListener("close", restore);
  };
  dlg.addEventListener("close", restore);
  $("#dlg-body").onclick = (e) => {
    if (e.target.id === "tb-add") {
      dlg.close();
      editTextbook(null);
    }
    const id = e.target.dataset?.edit;
    if (id) {
      dlg.close();
      editTextbook(state.textbooks.find((b) => b.id === id));
    }
  };
  dlg.showModal();
}

function editTextbook(book) {
  const wasTree = !!bookLeaves(book);
  // 항목 편집용 작업본 (표시 중인 입력값과 항상 같게 유지)
  let rows = wasTree ? book.structure.items.map((it) => ({ name: it.name, children: (it.children || []).map((c) => String(c)) })) : [{ name: "Unit 1", children: [] }];
  let textMode = false;
  let bulk = null; // { top: -1(맨 아래) | 항목 번호, prefix, count }
  let focusKey = null;

  openForm({
    title: book ? "교재 수정" : "교재 추가",
    wide: true,
    fields: [
      { name: "title", label: "교재명", required: true, maxlength: 100 },
      { name: "mode", label: "구조", type: "select", options: [["flat", "flat"], ["tree", "tree"]] },
      { name: "total_units", label: "전체 단원 수", type: "number", min: 1, max: 500, half: true },
      { name: "unit_label", label: "단위 이름 (Unit, Lesson 등)", half: true, maxlength: 20 },
      { name: "outline", label: "텍스트로 편집 (한 줄에 항목 하나, 앞에 공백을 넣으면 위 항목의 하위)", type: "textarea", rows: 10, maxlength: 12000 },
    ],
    values: book ? { ...book, mode: wasTree ? "tree" : "flat", outline: "" } : { total_units: 20, unit_label: "Unit", mode: "flat", outline: "" },
    onSubmit: async (d) => {
      const out = { title: d.title };
      if (d.mode === "tree") {
        if (textMode) rows = parseOutline(form.elements.outline.value).structure.items.map((it) => ({ name: it.name, children: it.children || [] }));
        const items = rows
          .map((r) => ({ name: r.name.trim().slice(0, 60), children: r.children.map((c) => c.trim().slice(0, 60)).filter(Boolean) }))
          .filter((r) => r.name)
          .map((r) => (r.children.length ? { name: r.name, children: r.children } : { name: r.name }));
        if (!items.length) throw new Error("항목을 한 개 이상 입력하세요.");
        const leaves = items.reduce((n, it) => n + (it.children ? it.children.length : 1), 0);
        if (leaves > 500) throw new Error(`단원이 너무 많습니다 (${leaves}개, 최대 500개).`);
        out.structure = { items };
        out.total_units = leaves;
        out.unit_label = (d.unit_label || "Unit").slice(0, 20);
      } else {
        if (!d.total_units || d.total_units < 1) throw new Error("전체 단원 수를 입력하세요.");
        if (!d.unit_label) throw new Error("단위 이름을 입력하세요.");
        out.total_units = d.total_units;
        out.unit_label = d.unit_label;
        if (book && book.structure) out.structure = null;
      }
      try {
        if (book) await run(db.from("textbooks").update(out).eq("id", book.id));
        else await run(db.from("textbooks").insert(out));
      } catch (e) {
        if (/structure/i.test((e && e.message) || "")) throw new Error("교재 구조를 저장하려면 최신 schema.sql 을 Supabase 에서 먼저 실행하세요.");
        throw e;
      }
      await refresh();
      manageTextbooks();
    },
    onDelete: book
      ? async () => {
          await run(db.from("textbooks").delete().eq("id", book.id));
          await refresh();
          manageTextbooks();
        }
      : null,
  });

  const form = $("#dlg-form");
  const modeEl = form.elements.mode;
  modeEl.closest("label").hidden = true;
  const outlineLabel = form.elements.outline.closest("label");
  const host = document.createElement("div");
  host.id = "tb-host";
  $("#dlg-body").appendChild(host);

  const leafCount = () => rows.reduce((n, r) => n + (r.children.length ? r.children.length : 1), 0);
  const esc2 = (v) => esc(v);
  const paint = () => {
    const tree = modeEl.value === "tree";
    form.elements.total_units.closest("label").hidden = tree;
    form.elements.unit_label.closest("label").hidden = tree;
    outlineLabel.hidden = !(tree && textMode);
    const segHtml = `<div class="tb-seg" role="group" aria-label="구조">
      <button type="button" class="tb-seg-b ${tree ? "" : "on"}" data-tb-mode="flat" aria-pressed="${!tree}">한 줄 번호 <span class="muted">(Unit 1, 2, 3…)</span></button>
      <button type="button" class="tb-seg-b ${tree ? "on" : ""}" data-tb-mode="tree" aria-pressed="${tree}">항목 + 하위 항목</button></div>`;
    if (!tree) { host.innerHTML = segHtml; return; }
    if (textMode) {
      host.innerHTML = segHtml + `<div class="tb-foot"><button type="button" class="btn small" data-tb="visual">← 목록 입력으로</button></div>`;
      return;
    }
    let n = 0;
    const num = (leaf) => (leaf ? `<span class="tb-n">${++n}</span>` : `<span class="tb-n grp">묶음</span>`);
    const rowsHtml = rows.map((r, i) => {
      const hasKids = r.children.length > 0;
      const top = `<div class="tb-row">${num(!hasKids)}<input type="text" data-t="${i}" aria-label="항목 이름" maxlength="60" value="${esc2(r.name)}">
        ${hasKids ? "" : `<button type="button" class="tb-sub" data-tb="addkid" data-t="${i}">+ 하위</button>`}
        <button type="button" class="tb-x" data-tb="del" data-t="${i}" aria-label="삭제">✕</button></div>`;
      const kids = r.children.map((c, j) => `<div class="tb-row tb-kid">${num(true)}<input type="text" data-t="${i}" data-c="${j}" aria-label="하위 항목 이름" maxlength="60" value="${esc2(c)}">
        <button type="button" class="tb-x" data-tb="delkid" data-t="${i}" data-c="${j}" aria-label="삭제">✕</button></div>`).join("");
      const more = hasKids ? `<div class="tb-kid tb-more"><button type="button" class="tb-link" data-tb="addkid" data-t="${i}">+ ${esc2(r.name || "항목")}에 하위 추가</button><button type="button" class="tb-link" data-tb="bulkkid" data-t="${i}">여러 개…</button></div>` : "";
      const bulkPanel = bulk && bulk.top === i ? bulkHtml() : "";
      return top + kids + more + bulkPanel;
    }).join("");
    host.innerHTML = segHtml + `<div class="tb-box">
      <div class="tb-head"><span class="muted">단원 총 ${leafCount()}개</span></div>
      ${rowsHtml}
      <div class="tb-foot"><button type="button" class="btn primary small" data-tb="add">+ 항목 추가</button>
        <button type="button" class="btn small" data-tb="bulk">여러 개 한 번에…</button><span class="spacer"></span>
        <button type="button" class="tb-link" data-tb="text">텍스트로 편집</button></div>
      ${bulk && bulk.top === -1 ? bulkHtml() : ""}</div>
      <p class="tb-note">하위 항목이 있는 줄(묶음)에는 번호가 붙지 않고, 하위 항목이 각각 한 단원이 됩니다. 진도는 “Unit 2 › Part B (3/4)”처럼 표시돼요.</p>`;
    if (focusKey) {
      const q = focusKey.c != null ? `input[data-t="${focusKey.t}"][data-c="${focusKey.c}"]` : `input[data-t="${focusKey.t}"]:not([data-c])`;
      const el = host.querySelector(q);
      if (el) { el.focus(); el.select(); }
      focusKey = null;
    }
  };
  const bulkHtml = () => {
    const pre = bulk.prefix, cnt = bulk.count;
    const sample = cnt >= 1 ? `${pre} 1, ${pre} 2${cnt > 2 ? ` … ${pre} ${cnt}` : ""}` : "";
    return `<div class="tb-bulk"><strong>여러 개 한 번에 추가</strong>
      <div class="tb-bulk-f"><label>이름 앞부분<input type="text" data-bk="prefix" maxlength="40" value="${esc2(pre)}"></label>
      <label class="tb-cnt">개수<input type="number" data-bk="count" min="1" max="500" value="${cnt}"></label></div>
      <div class="tb-prev">미리보기: <b>${esc2(sample)}</b></div>
      <div class="tb-foot"><span class="spacer"></span><button type="button" class="btn small" data-tb="bulkcancel">취소</button>
      <button type="button" class="btn primary small" data-tb="bulkok">${cnt || 0}개 추가</button></div></div>`;
  };

  host.addEventListener("click", (e) => {
    const modeBtn = e.target.closest("[data-tb-mode]");
    if (modeBtn) { modeEl.value = modeBtn.dataset.tbMode; $("#dlg-err").textContent = ""; paint(); return; }
    const b = e.target.closest("[data-tb]");
    if (!b) return;
    const t = b.dataset.t != null ? Number(b.dataset.t) : null;
    const c = b.dataset.c != null ? Number(b.dataset.c) : null;
    switch (b.dataset.tb) {
      case "add": rows.push({ name: "", children: [] }); focusKey = { t: rows.length - 1 }; break;
      case "addkid": rows[t].children.push(""); focusKey = { t, c: rows[t].children.length - 1 }; break;
      case "del": rows.splice(t, 1); if (!rows.length) rows.push({ name: "", children: [] }); break;
      case "delkid": rows[t].children.splice(c, 1); break;
      case "bulk": bulk = { top: -1, prefix: "Unit", count: 10 }; break;
      case "bulkkid": bulk = { top: t, prefix: "Part", count: 4 }; break;
      case "bulkcancel": bulk = null; break;
      case "bulkok": {
        if (!(bulk.count >= 1)) return;
        const names = Array.from({ length: Math.min(500, bulk.count) }, (_, i) => `${bulk.prefix.trim()} ${i + 1}`.trim());
        if (bulk.top === -1) {
          if (rows.length === 1 && !rows[0].name.trim() && !rows[0].children.length) rows = [];
          names.forEach((nm) => rows.push({ name: nm, children: [] }));
          focusKey = { t: rows.length - 1 };
        } else rows[bulk.top].children.push(...names);
        bulk = null;
        break;
      }
      case "text": form.elements.outline.value = outlineText({ items: rows.map((r) => ({ name: r.name, children: r.children })) }); textMode = true; break;
      case "visual":
        try { rows = parseOutline(form.elements.outline.value).structure.items.map((it) => ({ name: it.name, children: it.children || [] })); textMode = false; $("#dlg-err").textContent = ""; }
        catch (err) { $("#dlg-err").textContent = err.message; return; }
        break;
      default: return;
    }
    paint();
  });
  host.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.t != null && el.tagName === "INPUT") {
      const t = Number(el.dataset.t);
      if (el.dataset.c != null) rows[t].children[Number(el.dataset.c)] = el.value;
      else rows[t].name = el.value;
    } else if (el.dataset.bk && bulk) {
      bulk[el.dataset.bk] = el.dataset.bk === "count" ? Math.max(0, Math.min(500, Math.round(Number(el.value) || 0))) : el.value;
      const prev = el.closest(".tb-bulk");
      const pre = bulk.prefix, cnt = bulk.count;
      prev.querySelector(".tb-prev b").textContent = cnt >= 1 ? `${pre} 1, ${pre} 2${cnt > 2 ? ` … ${pre} ${cnt}` : ""}` : "";
      prev.querySelector('[data-tb="bulkok"]').textContent = `${cnt || 0}개 추가`;
    }
  });
  host.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.target.tagName !== "INPUT") return;
    e.preventDefault(); // Enter 로 대화상자가 저장되지 않게
    const el = e.target;
    if (el.dataset.bk) return;
    const t = Number(el.dataset.t);
    if (el.dataset.c != null) { const c = Number(el.dataset.c); rows[t].children.splice(c + 1, 0, ""); focusKey = { t, c: c + 1 }; }
    else { rows.splice(t + 1, 0, { name: "", children: [] }); focusKey = { t: t + 1 }; }
    paint();
  });
  paint();
  if (book && wasTree) $("#dlg-err").textContent = "이미 진도가 있는 교재는 항목을 중간에 끼워 넣거나 지우면 번호가 밀립니다. 새 항목은 뒤쪽에 추가하세요.";
}

/* ---------- 학생 상세 동작 ---------- */
async function setProgress(pid, unit) {
  const p = state.progress.find((x) => x.id === pid);
  const book = state.textbooks.find((b) => b.id === p.textbook_id);
  const next = Math.max(0, Math.min(book.total_units, unit));
  await run(db.from("progress").update({ current_unit: next, updated_at: new Date().toISOString() }).eq("id", pid));
  p.current_unit = next;
  p.updated_at = new Date().toISOString();
  renderStudent();
}

function assignBook(s) {
  const assigned = new Set(bookProgressFor(s.id).map((x) => x.book.id));
  const options = state.textbooks.filter((b) => !assigned.has(b.id)).map((b) => [b.id, `${b.title} (${bookLeaves(b) ? b.total_units + "단원" : b.total_units + " " + b.unit_label})`]);
  const sel = new Set();
  const classDays = studentClassDays(s.id);
  openForm({
    title: "교재 배정",
    fields: [
      { name: "textbook_id", label: "교재", type: "select", options, required: true },
      { name: "current_unit", label: "현재 진도 (이미 나간 단원 수)", type: "number", min: 0, default: 0 },
      { name: "as-days", type: "slot" },
    ],
    onSubmit: async (d) => {
      const row = { student_id: s.id, textbook_id: d.textbook_id, current_unit: d.current_unit || 0 };
      if (sel.size) row.weekdays = SCH_ORDER.filter((x) => sel.has(x));
      try { await run(db.from("progress").insert(row)); } catch (e) { throw weekdaysErr(e); }
      await refresh();
      toast("교재를 배정했습니다");
    },
  });
  bindUnitCtls($("#dlg-form"), ["current_unit"], { zero: true });
  mountDayPicker("as-days", sel, classDays);
}

function changeDays(s, p, book) {
  const sel = new Set(dayList(p));
  openForm({
    title: `수업 요일 · ${book.title}`,
    fields: [{ name: "cd-days", type: "slot" }],
    onSubmit: async () => {
      try { await run(db.from("progress").update({ weekdays: SCH_ORDER.filter((x) => sel.has(x)) }).eq("id", p.id)); } catch (e) { throw weekdaysErr(e); }
      await refresh();
      toast("요일을 저장했습니다");
    },
  });
  mountDayPicker("cd-days", sel, studentClassDays(s.id));
}

/* 추천 날짜에 이미 있는 수업 기록 찾기 (화면에 불러 둔 기록 기준) */
function recLessonOn(studentId, rec) {
  const date = rec.target_date || todayStr();
  const pool = [...(state.detail && state.detail.lessons ? state.detail.lessons : []), ...state.recentLessons];
  return pool.find((l) => l.student_id === studentId && l.lesson_date === date) || null;
}
function lessonChip(l) {
  return `<button type="button" class="chip-has" data-lesson-chip="${esc(l.lesson_date)}" title="그날 수업 기록 열기"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>수업 기록 있음 · ${esc(l.attendance || "")}</button>`;
}

/* 추천 → 수업 기록 반영: 같은 날짜에 이미 수업 기록이 있으면 막음 */
async function recDateHasLesson(s, rec) {
  const date = rec.target_date || todayStr();
  let exists = (state.detail.lessons || []).some((l) => l.student_id === s.id && l.lesson_date === date);
  if (!exists) {
    try {
      const rows = await run(db.from("lessons").select("id").eq("student_id", s.id).eq("lesson_date", date).limit(1));
      exists = !!(rows && rows.length);
    } catch { /* 조회 실패 시 화면의 목록만으로 판단 */ }
  }
  if (exists) alert("등록된 수업기록 내용이 있습니다.");
  return exists;
}

function lessonForm(s, lesson, rec = null) {
  const assigned = bookProgressFor(s.id).map((x) => x.book);
  const bookOf = (id) => state.textbooks.find((b) => b.id === id);
  const progOf = (id) => state.progress.find((x) => x.student_id === s.id && x.textbook_id === id);
  const autoFrom = (id) => {
    const bk = bookOf(id), pr = progOf(id);
    return bk && pr && pr.current_unit < bk.total_units ? pr.current_unit + 1 : null;
  };

  // 날짜의 요일에 배정된 교재만 기록할 수 있습니다 (요일을 지정하지 않은 교재는 모든 요일).
  const wdOf = (ds) => { const d = new Date(`${ds}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d.getDay(); };
  const dayItems = (wd) => bookProgressFor(s.id).filter((x) => !dayList(x.p).length || (wd != null && dayList(x.p).includes(wd)));
  const defaultBlocks = (wd) => {
    const items = dayItems(wd);
    const explicit = items.filter((x) => dayList(x.p).includes(wd));
    let ids = explicit.map((x) => x.book.id);
    if (!ids.length && items.length) {
      const last = (state.detail.lessons.find((l) => l.textbook_id && items.some((x) => x.book.id === l.textbook_id)) || {}).textbook_id;
      ids = [last || items[0].book.id];
    }
    return ids.map((id) => ({ textbook_id: id, from_unit: autoFrom(id), to_unit: null, topic: "" }));
  };
  // 교재 블록 작업본: 첫 블록은 lessons 의 기존 컬럼, 둘째부터는 extra_books 에 저장됩니다.
  let blocks;
  let values = lesson;
  // 같은 학생·같은 수업일의 '제안' 추천은 한 번에 블록으로 채웁니다 (눌린 추천이 맨 앞).
  const recGroup = rec ? [rec, ...((state.detail && state.detail.recs) || []).filter((r) => r.id !== rec.id && r.status === "제안" && r.student_id === s.id && (r.target_date || "") === (rec.target_date || "") && r.textbook_id && progOf(r.textbook_id))] : [];
  if (lesson) {
    blocks = lessonBooks(lesson).map((b) => ({ textbook_id: b.textbook_id, from_unit: b.from_unit ?? null, to_unit: b.to_unit ?? null, topic: b.topic || "" }));
    if (!blocks.length) blocks = lesson.topic ? [{ textbook_id: "", from_unit: null, to_unit: null, topic: lesson.topic }] : [];
  } else {
    values = { lesson_date: (rec && rec.target_date) || todayStr(), attendance: "출석" };
    blocks = defaultBlocks(wdOf(values.lesson_date));
    if (rec && rec.textbook_id) blocks = recGroup.map((r) => ({ textbook_id: r.textbook_id, from_unit: r.from_unit ?? null, to_unit: r.to_unit ?? null, topic: "" }));
  }
  let curWd = wdOf(values.lesson_date);

  const fields = [
    { name: "lesson_date", label: "날짜", type: "date", required: true, half: true },
    { name: "attendance", label: "출결", type: "select", options: ["출석", "지각", "결석", "보강"].map((x) => [x, x]), half: true },
    { name: "ls-books", type: "slot" },
    { name: "homework", label: "숙제", type: "select", options: [["", "-"], ["완료", "완료"], ["일부", "일부"], ["미제출", "미제출"]] },
    { name: "homework_note", label: "숙제 내용 (예: 단어 Day 5 쓰기)", maxlength: 200 },
    { name: "memo", label: "수업 메모", type: "textarea" },
    { name: "teacher_comment", label: "선생님 코멘트 (길게 적을 수 있어요, 최대 5,000자)", type: "textarea", rows: 9, maxlength: 5000 },
    { name: "next_plan", label: "다음 수업 예정 진도", maxlength: 200 },
  ];
  if (!lesson) fields.push({ name: "sync_progress", label: "저장할 때 각 교재의 진도도 종료 단원으로 갱신 (결석은 제외)", type: "checkbox", default: true });

  openForm({
    title: lesson ? "수업 기록 수정" : "수업 기록",
    wide: true,
    fields,
    values,
    onSubmit: async (d) => {
      const { sync_progress, ...data } = d;
      const used = new Set();
      const withBook = [];
      let topicOnly = null;
      blocks.forEach((b, i) => {
        const hasText = b.topic && b.topic.trim();
        if (!b.textbook_id) {
          if (b.from_unit != null || b.to_unit != null) throw new Error(`교재 ${i + 1}: 단원 범위를 입력하려면 교재를 선택하세요.`);
          if (hasText) { if (i > 0) throw new Error(`교재 ${i + 1}: 교재를 선택하세요.`); topicOnly = b; }
          return;
        }
        const book = bookOf(b.textbook_id);
        if (!book) throw new Error(`교재 ${i + 1}: 교재를 찾을 수 없습니다.`);
        if (used.has(b.textbook_id)) throw new Error(`${book.title} 교재가 두 번 들어 있습니다. 한 블록으로 합쳐 주세요.`);
        used.add(b.textbook_id);
        if (b.from_unit != null && b.to_unit != null && b.from_unit > b.to_unit) throw new Error(`${book.title}: 시작 단원이 종료 단원보다 클 수 없습니다.`);
        if ((b.from_unit || 0) > book.total_units || (b.to_unit || 0) > book.total_units) throw new Error(`${book.title}: 전체 단원 수는 ${book.total_units}입니다.`);
        withBook.push({ textbook_id: b.textbook_id, from_unit: b.from_unit ?? null, to_unit: b.to_unit ?? null, topic: hasText ? b.topic.trim().slice(0, 200) : null });
      });
      const primary = withBook[0] || (topicOnly ? { textbook_id: null, from_unit: null, to_unit: null, topic: topicOnly.topic.trim().slice(0, 200) } : { textbook_id: null, from_unit: null, to_unit: null, topic: null });
      const extras = withBook.slice(1);
      const row = { ...data, textbook_id: primary.textbook_id, from_unit: primary.from_unit, to_unit: primary.to_unit, topic: primary.topic, homework: data.homework || null };
      if (extras.length || (lesson && "extra_books" in lesson)) row.extra_books = extras;
      // 숙제 내용 칸이 비어 있고 기존 기록에도 없으면 컬럼을 보내지 않음(스키마 업그레이드 전에도 저장되도록)
      if (row.homework_note == null && !(lesson && "homework_note" in lesson)) delete row.homework_note;
      if (row.teacher_comment == null && !(lesson && "teacher_comment" in lesson)) delete row.teacher_comment;
      let newId = null;
      try {
        if (lesson) await run(db.from("lessons").update(row).eq("id", lesson.id));
        else {
          const ins = await run(db.from("lessons").insert({ ...row, student_id: s.id }).select("id").single());
          newId = ins && ins.id;
        }
      } catch (e) {
        if (/extra_books/i.test((e && e.message) || "")) throw new Error("교재를 여러 개 저장하려면 최신 schema.sql 을 Supabase 에서 먼저 실행하세요.");
        throw e;
      }
      if (rec && newId) {
        for (const r of recGroup) {
          const b = withBook.find((x) => x.textbook_id === r.textbook_id);
          if (!b) continue; // 빼 둔 교재의 추천은 '제안' 그대로 둡니다
          const same = b.from_unit === r.from_unit && b.to_unit === r.to_unit;
          await run(db.from("recommendations").update({ status: same ? "채택" : "수정", applied_lesson_id: newId, decided_at: new Date().toISOString() }).eq("id", r.id));
        }
      }

      let synced = false;
      if (!lesson && sync_progress && data.attendance !== "결석") {
        for (const b of withBook) {
          if (b.to_unit == null) continue;
          const pr = progOf(b.textbook_id);
          if (!pr) {
            await run(db.from("progress").insert({ student_id: s.id, textbook_id: b.textbook_id, current_unit: b.to_unit }));
            synced = true;
          } else if (b.to_unit > pr.current_unit) {
            await run(db.from("progress").update({ current_unit: b.to_unit, updated_at: new Date().toISOString() }).eq("id", pr.id));
            synced = true;
          }
        }
      }
      await refresh();
      toast(synced ? "저장했습니다. 교재 진도도 갱신했어요" : "저장했습니다");
    },
    onDelete: lesson
      ? async () => {
          await run(db.from("lessons").delete().eq("id", lesson.id));
          await refresh();
        }
      : null,
  });

  const host = $("#ls-books");
  let focusIdx = null;
  const leafNo = (book, top, child) => bookLeaves(book).findIndex((l) => l.top === top && l.child === child) + 1;
  const topRange = (book, top) => { const lv = bookLeaves(book); const ix = lv.map((l, n) => (l.top === top ? n + 1 : 0)).filter(Boolean); return [ix[0], ix[ix.length - 1]]; };
  const unitField = (b, i, key, label) => {
    const book = bookOf(b.textbook_id);
    const lv = bookLeaves(book);
    const v = b[key];
    if (!lv) return `<label>${label}<input type="number" min="0" inputmode="numeric" data-i="${i}" data-k="${key}" aria-label="${label}" value="${v == null ? "" : esc(v)}"></label>`;
    const items = book.structure.items;
    const leaf = v ? lv[v - 1] : null;
    const top = leaf ? leaf.top : null;
    const kids = top != null ? items[top].children || [] : [];
    const l1 = `<select data-i="${i}" data-k="${key}" data-lv="1" aria-label="${label} 1레벨"><option value="">-</option>${items.map((it, n) => `<option value="${n}" ${top === n ? "selected" : ""}>${esc(it.name)}</option>`).join("")}</select>`;
    const l2 = kids.length
      ? `<select data-i="${i}" data-k="${key}" data-lv="2" aria-label="${label} 2레벨"><option value="all" ${b[key + "All"] ? "selected" : ""}>${esc(items[top].name)} 전체</option>${kids.map((k, n) => `<option value="${n}" ${!b[key + "All"] && leaf && leaf.child === n ? "selected" : ""}>${esc(k)}</option>`).join("")}</select>`
      : `<select disabled aria-label="${label} 2레벨"><option>${top == null ? "-" : "하위 없음"}</option></select>`;
    return `<div class="ls-lv"><span>${label}</span><div class="ls-lv2">${l1}${l2}</div></div>`;
  };
  const paint = () => {
    const usedIds = new Set(blocks.map((b) => b.textbook_id).filter(Boolean));
    const allowed = dayItems(curWd);
    const skipped = allowed.filter((x) => !usedIds.has(x.book.id));
    const dn = curWd != null ? DAY_NAME[curWd] + "요일 " : "";
    const blockHtml = blocks.map((b, i) => {
      const book = bookOf(b.textbook_id);
      const p = book ? progOf(book.id) : null;
      const pr = p;
      const hint = book ? `<div class="ls-hint">${pr ? `현재 진도 ${esc(curLabel(book, pr.current_unit))}` : "배정이 해제된 교재예요"}${b.from_unit != null && b.to_unit != null && b.from_unit <= b.to_unit && b.from_unit >= 1 ? ` · 기록 <b>${esc(unitName(book, b.from_unit))} – ${esc(unitName(book, b.to_unit))} (${b.to_unit - b.from_unit + 1}${bookLeaves(book) ? "단원" : ""})</b>` : ""}</div>` : "";
      const days = p ? dayList(p) : [];
      return `<div class="ls-block">
        <div class="ls-head"><span class="tb-n">${i + 1}</span>
          <strong class="ls-name">${esc(book ? book.title : "교재 없음")}</strong>
          ${book ? `<span class="ls-kind">${days.length ? SCH_ORDER.filter((d) => days.includes(d)).map((d) => DAY_NAME[d]).join(" · ") : "모든 수업"}</span><span class="ls-kind">${bookLeaves(book) && bookLeaves(book).some((l) => l.child >= 0) ? "1레벨 → 2레벨" : "1레벨만"}</span>` : ""}
          <button type="button" class="btn small" data-ls="skip" data-i="${i}">오늘은 안 나감</button></div>
        ${book ? `<div class="ls-units ${bookLeaves(book) ? "tree" : ""}">${unitField(b, i, "from_unit", "시작 단원")}${unitField(b, i, "to_unit", "종료 단원")}</div>${hint}` : ""}
        <label>학습 내용 (예: 현재완료, 본문 읽기)<input type="text" maxlength="200" data-i="${i}" data-k="topic" value="${esc(b.topic || "")}"></label></div>`;
    }).join("");
    const skippedHtml = skipped.map((x) => `<div class="ls-skip"><strong>${esc(x.book.title)}</strong><span class="muted">오늘은 안 나감</span><button type="button" class="btn small" data-ls="addbook" data-id="${esc(x.book.id)}">+ 넣기</button></div>`).join("");
    const empty = !blocks.length && !skipped.length
      ? `<div class="ls-empty"><strong>${curWd != null ? DAY_NAME[curWd] + "요일에 " : ""}배정된 교재가 없어요</strong><span class="muted">교재 진도 탭에서 교재의 요일을 바꾸면 이 날에도 기록할 수 있어요. 진도 없이 출결·숙제·메모는 그대로 저장돼요.</span>${bookProgressFor(s.id).length ? `<span class="muted">현재 배정: ${bookProgressFor(s.id).map((x) => `${esc(x.book.title)} (${dayList(x.p).length ? SCH_ORDER.filter((d) => dayList(x.p).includes(d)).map((d) => DAY_NAME[d]).join("·") : "모든 수업"})`).join(", ")}</span>` : ""}</div>`
      : "";
    host.innerHTML = `${curWd != null ? `<div class="ls-banner"><b>${DAY_NAME[curWd]}요일</b> 수업 교재만 기록할 수 있어요</div>` : ""}
      <div class="ls-title"><strong>${dn}수업 교재 · 진도</strong><span class="muted">${allowed.length ? `${allowed.length}개 중 ${blocks.filter((b) => b.textbook_id).length}개 포함` : "0개"}</span></div>${blockHtml}${skippedHtml}${empty}`;
  };
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ls]");
    if (!b) return;
    if (b.dataset.ls === "skip") blocks.splice(Number(b.dataset.i), 1);
    else if (b.dataset.ls === "addbook") blocks.push({ textbook_id: b.dataset.id, from_unit: autoFrom(b.dataset.id), to_unit: null, topic: "" });
    paint();
  });
  const dateEl = $("#dlg-form [name='lesson_date']");
  let prevDate = dateEl.value;
  dateEl.addEventListener("change", () => {
    const wd = wdOf(dateEl.value);
    if (wd == null || wd === curWd) { if (wd != null) prevDate = dateEl.value; return; }
    const dirty = blocks.some((b) => b.to_unit != null || (b.topic || "").trim());
    if (dirty && !confirm(`날짜를 바꾸면 교재 목록이 ${DAY_NAME[wd]}요일 교재로 바뀌고, 입력한 진도·학습 내용은 지워져요. 계속할까요?`)) { dateEl.value = prevDate; return; }
    curWd = wd; prevDate = dateEl.value;
    blocks = defaultBlocks(wd);
    paint();
  });
  const onField = (e) => {
    const el = e.target;
    if (el.dataset.i == null || !el.dataset.k) return;
    const b = blocks[Number(el.dataset.i)];
    const k = el.dataset.k;
    if (el.dataset.lv) {
      const book = bookOf(b.textbook_id);
      const items = book.structure.items;
      const first = k === "from_unit";
      if (el.dataset.lv === "1") {
        if (el.value === "") { b[k] = null; b[k + "All"] = false; }
        else {
          const top = Number(el.value);
          if ((items[top].children || []).length) { b[k + "All"] = true; b[k] = topRange(book, top)[first ? 0 : 1]; }
          else { b[k + "All"] = false; b[k] = leafNo(book, top, -1); }
        }
      } else {
        const top = bookLeaves(book)[b[k] - 1].top;
        if (el.value === "all") { b[k + "All"] = true; b[k] = topRange(book, top)[first ? 0 : 1]; }
        else { b[k + "All"] = false; b[k] = leafNo(book, top, Number(el.value)); }
      }
      paint();
      return;
    }
    if (k === "textbook_id") { b.textbook_id = el.value; b.from_unit = el.value ? autoFrom(el.value) : null; b.to_unit = null; paint(); return; }
    if (k === "topic") b.topic = el.value;
    else b[k] = el.value === "" ? null : Number(el.value);
  };
  host.addEventListener("input", onField);
  host.addEventListener("change", onField);
  paint();
}

function testForm(s, test) {
  openForm({
    title: test ? "시험 점수 수정" : "시험 점수",
    fields: [
      { name: "test_date", label: "날짜", type: "date", required: true, half: true },
      { name: "kind", label: "종류", type: "select", options: ["단어시험", "단원평가", "모의고사", "기타"].map((x) => [x, x]), half: true },
      { name: "title", label: "시험 이름 (예: Unit 5 단어)", maxlength: 100 },
      { name: "score", label: "점수", type: "number", min: 0, step: "any", required: true, half: true },
      { name: "max_score", label: "만점", type: "number", min: 1, step: "any", required: true, half: true },
    ],
    values: test || { test_date: todayStr(), kind: "단어시험", max_score: 100 },
    onSubmit: async (d) => {
      if (d.score > d.max_score) throw new Error("점수가 만점보다 클 수 없습니다.");
      if (test) await run(db.from("tests").update(d).eq("id", test.id));
      else await run(db.from("tests").insert({ ...d, student_id: s.id }));
      await refresh();
      toast("저장했습니다");
    },
    onDelete: test
      ? async () => {
          await run(db.from("tests").delete().eq("id", test.id));
          await refresh();
        }
      : null,
  });
}

/* ---------- 백업 ---------- */
async function fetchAll(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await run(db.from(table).select("*").order("created_at").range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function backup() {
  try {
    toast("백업 파일을 만드는 중...");
    const tables = ["students", "textbooks", "progress", "lessons", "tests"];
    const data = { exported_at: new Date().toISOString(), version: 1 };
    for (const t of tables) data[t] = await fetchAll(t);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `study-room-backup-${todayStr()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast("백업 파일을 저장했습니다. 안전한 곳에 보관하세요.");
  } catch (e) {
    fail(e, "백업 실패");
  }
}

/* ---------- 이벤트 ---------- */
async function selectStudent(id) {
  state.view = "student";
  state.studentId = id;
  state.tab = "progress";
  try {
    await loadDetail(id);
  } catch (e) {
    return fail(e);
  }
  render();
  $("#main").focus();
}

function bindEvents() {
  const appEl = $("#app-view");
  const setMenu = (open) => {
    appEl.classList.toggle("menu-open", open);
    $("#btn-menu").setAttribute("aria-expanded", open ? "true" : "false");
  };
  $("#btn-menu").onclick = () => setMenu(!appEl.classList.contains("menu-open"));
  $("#sidebar").addEventListener("click", (e) => {
    if (e.target.closest(".nav-btn, button[data-id], #btn-textbooks, #btn-sched-edit")) setMenu(false);
  });
  document.addEventListener("click", (e) => {
    if (appEl.classList.contains("menu-open") && !e.target.closest("#sidebar, #btn-menu")) setMenu(false);
  });
  $("#nav-overview").onclick = () => {
    state.view = "overview";
    state.studentId = null;
    render();
  };
  $("#nav-evals").onclick = () => {
    const now = new Date();
    state.view = "evals";
    state.studentId = null;
    state.evals.year = now.getFullYear();
    state.evals.month = now.getMonth() + 1;
    state.evals.studentId = null;
    state.evals.data = null;
    state.evals.failed = false;
    render();
  };
  $("#nav-recs").onclick = async () => {
    state.view = "recs";
    state.studentId = null;
    try {
      await loadAllRecs();
    } catch (e) {
      return fail(e);
    }
    render();
  };
  $("#student-list").onclick = (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) selectStudent(b.dataset.id);
  };
  $("#show-inactive").onchange = (e) => {
    state.showInactive = e.target.checked;
    renderSidebar();
  };
  $("#btn-add-student").onclick = addStudent;
  $("#btn-textbooks").onclick = manageTextbooks;
  const SIDE_KEY = "rachel_side_off";
  const setSide = (off, save = true) => {
    appEl.classList.toggle("side-off", off);
    const b = $("#btn-side");
    b.textContent = off ? "▶ 메뉴 펼치기" : "◀ 메뉴 숨기기";
    b.setAttribute("aria-expanded", off ? "false" : "true");
    if (save) { try { localStorage.setItem(SIDE_KEY, off ? "1" : "0"); } catch { /* 저장 실패는 무시 */ } }
  };
  $("#btn-side").onclick = () => setSide(!appEl.classList.contains("side-off"));
  try { setSide(localStorage.getItem(SIDE_KEY) === "1", false); } catch { setSide(false, false); }
  $("#btn-sched-edit").onclick = () => {
    state.view = "overview";
    state.studentId = null;
    render();
    if (!state.schedule.missing) startScheduleEdit();
  };
  document.querySelectorAll(".js-logout").forEach((b) => {
    b.onclick = logout;
  });
  $("#btn-password").onclick = changePassword;

  $("#main").addEventListener("click", async (e) => {
    const row = e.target.closest("tr[data-id]");
    if (row) return selectStudent(row.dataset.id);

    const s = state.students.find((x) => x.id === state.studentId);
    if (!s) return;

    if (e.target.closest("#btn-edit-student")) return editStudent(s);
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab;
      return renderStudent();
    }
    if (e.target.closest("#btn-assign")) return assignBook(s);
    if (e.target.closest("#btn-add-lesson")) return lessonForm(s, null);
    if (e.target.closest("#btn-add-test")) return testForm(s, null);

    const lrow = e.target.closest("tr[data-lid]");
    if (lrow) return lessonForm(s, state.detail.lessons.find((l) => l.id === lrow.dataset.lid));
    const trow = e.target.closest("tr[data-tid]");
    if (trow) return testForm(s, state.detail.tests.find((t) => t.id === trow.dataset.tid));

    const act = e.target.closest("[data-act]");
    if (act) {
      const pid = act.closest("[data-pid]").dataset.pid;
      const p = state.progress.find((x) => x.id === pid);
      const book = state.textbooks.find((b) => b.id === p.textbook_id);
      try {
        if (act.dataset.act === "inc") await setProgress(pid, p.current_unit + 1);
        else if (act.dataset.act === "dec") await setProgress(pid, p.current_unit - 1);
        else if (act.dataset.act === "days") { changeDays(s, p, book); return; }
        else if (act.dataset.act === "set") {
          if (bookLeaves(book)) {
            openForm({
              title: `현재 진도 · ${book.title}`,
              fields: [{ name: "current_unit", label: "끝낸 마지막 단원", type: "number", min: 0 }],
              values: { current_unit: p.current_unit },
              onSubmit: async (d) => { await setProgress(pid, d.current_unit || 0); },
            });
            swapUnitCtl($("#dlg-form"), "current_unit", book, { zero: true });
            return;
          }
          const v = prompt(`현재 진도를 입력하세요 (0~${book.total_units})`, String(p.current_unit));
          if (v !== null && v.trim() !== "" && !Number.isNaN(Number(v))) await setProgress(pid, Math.round(Number(v)));
        } else if (act.dataset.act === "unassign") {
          if (!confirm("이 교재 배정을 해제할까요? 진도 기록이 사라집니다.")) return;
          await run(db.from("progress").delete().eq("id", pid));
          await refresh();
        }
      } catch (err) {
        fail(err);
      }
    }
  });
}

/* ---------- 비밀번호 ---------- */
function changePassword(title = "비밀번호 변경") {
  openForm({
    title: typeof title === "string" ? title : "비밀번호 변경",
    submitLabel: "변경",
    fields: [
      { name: "pw", label: "새 비밀번호 (8자 이상)", type: "password", required: true, minlength: 8 },
      { name: "pw2", label: "새 비밀번호 확인", type: "password", required: true },
    ],
    onSubmit: async (d) => {
      if (!d.pw || d.pw.length < 8) throw new Error("비밀번호는 8자 이상으로 입력하세요.");
      if (d.pw !== d.pw2) throw new Error("두 비밀번호가 다릅니다.");
      const { error } = await db.auth.updateUser({ password: d.pw });
      if (error) throw error;
      toast("비밀번호를 변경했습니다");
    },
  });
}

/* ---------- 유휴 자동 로그아웃 ---------- */
const IDLE_MS = (Number(cfg.IDLE_MINUTES) > 0 ? Number(cfg.IDLE_MINUTES) : 30) * 60 * 1000;
const WARN_MS = 60 * 1000;
const ACTIVITY_KEY = "study-room-last-activity";
let lastActivityMem = Date.now();
let lastMarked = 0;
let idleTimer = null;
let idleLoggedOut = false;

function getLastActivity() {
  try {
    const v = Number(localStorage.getItem(ACTIVITY_KEY));
    if (v > 0) return v;
  } catch {}
  return lastActivityMem;
}
function markActivity(force = false) {
  const now = Date.now();
  if (!force && now - lastMarked < 5000) return; // 너무 자주 쓰지 않도록 5초에 한 번만
  lastMarked = now;
  lastActivityMem = now;
  try {
    localStorage.setItem(ACTIVITY_KEY, String(now));
  } catch {}
}
async function logout() {
  try {
    await db.auth.signOut({ scope: "global" }); // 서버의 갱신 토큰까지 폐기
  } catch {
    try {
      await db.auth.signOut({ scope: "local" });
    } catch {}
  }
}
function idleCheck() {
  const elapsed = Date.now() - getLastActivity();
  const warn = $("#idle-warn");
  if (elapsed >= IDLE_MS) {
    stopIdleWatch();
    idleLoggedOut = true;
    logout();
  } else if (elapsed >= IDLE_MS - WARN_MS) {
    $("#idle-left").textContent = Math.max(1, Math.ceil((IDLE_MS - elapsed) / 1000));
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
}
function startIdleWatch() {
  stopIdleWatch();
  idleLoggedOut = false;
  idleTimer = setInterval(idleCheck, 5000);
}
function stopIdleWatch() {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  const warn = $("#idle-warn");
  if (warn) warn.hidden = true;
}
function bindIdleEvents() {
  ["mousedown", "mousemove", "keydown", "touchstart", "wheel", "scroll"].forEach((ev) =>
    window.addEventListener(ev, () => markActivity(), { passive: true, capture: true })
  );
  $("#idle-stay").onclick = () => {
    markActivity(true);
    $("#idle-warn").hidden = true;
  };
}

/* ---------- 시작 ---------- */
function showLogin() {
  stopIdleWatch();
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  if (idleLoggedOut) {
    idleLoggedOut = false;
    $("#login-err").textContent = `${Math.round(IDLE_MS / 60000)}분 동안 사용이 없어 자동 로그아웃되었습니다.`;
  }
}

async function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  startIdleWatch();
  try {
    const { data } = await db.auth.getUser();
    $("#user-email").textContent = data?.user?.email || "";
  } catch {}
  try {
    await loadCore();
    render();
  } catch (e) {
    fail(e, "데이터를 불러오지 못했습니다");
  }
}

async function init() {
  bindEvents();
  bindIdleEvents();
  if (!configured) {
    showLogin();
    $("#login-err").textContent = "config.js 에 Supabase URL과 키를 먼저 입력하세요.";
    $("#login-form button").disabled = true;
    return;
  }
  // 이메일만 이 브라우저에 저장합니다 (비밀번호는 저장하지 않음).
  const EMAIL_KEY = "study-room-email";
  try {
    const saved = localStorage.getItem(EMAIL_KEY);
    if (saved) {
      $("#login-form").elements.email.value = saved;
      $("#remember-email").checked = true;
    }
  } catch {}

  $("#login-form").onsubmit = async (e) => {
    e.preventDefault();
    $("#login-err").textContent = "";
    const f = e.target;
    markActivity(true); // 방금 로그인했으므로 이전 활동 시각은 무시
    const { error } = await db.auth.signInWithPassword({ email: f.elements.email.value.trim(), password: f.elements.password.value });
    if (error) $("#login-err").textContent = "로그인에 실패했습니다. 이메일과 비밀번호를 확인하세요.";
    else {
      f.elements.password.value = "";
      try {
        if ($("#remember-email").checked) localStorage.setItem(EMAIL_KEY, f.elements.email.value.trim());
        else localStorage.removeItem(EMAIL_KEY);
      } catch {}
    }
  };

  $("#btn-forgot").onclick = async () => {
    const email = $("#login-form").elements.email.value.trim();
    const err = $("#login-err");
    err.classList.remove("login-msg");
    if (!email) {
      err.textContent = "위 칸에 이메일을 입력한 뒤 다시 눌러 주세요.";
      return;
    }
    const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    err.textContent = error ? "메일을 보내지 못했습니다. 잠시 후 다시 시도하세요." : "재설정 메일을 보냈습니다. 메일의 링크를 열어 주세요.";
  };

  let appShown = false;
  db.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      markActivity(true);
      setTimeout(() => changePassword("새 비밀번호 설정"), 400);
    }
    // 콜백 안에서 바로 supabase 호출을 await 하면 교착될 수 있어 다음 틱으로 넘깁니다.
    setTimeout(() => {
      if (session && !appShown) {
        appShown = true;
        showApp();
      } else if (!session) {
        appShown = false;
        state.students = [];
        state.progress = [];
        state.view = "overview";
        state.studentId = null;
        showLogin();
      }
    }, 0);
  });

  const { data } = await db.auth.getSession();
  if (!data.session) showLogin();
}

init();

// PWA: 홈 화면에 설치할 수 있도록 서비스 워커 등록 (실패해도 앱 동작에는 영향 없음)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
