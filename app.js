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
  view: "overview",      // overview | summary | evals | recs | student
  pendingRecs: 0,
  recFilter: { range: "thisWeek", start: "", end: "" },
  lessonFilter: { range: "thisWeek", start: "", end: "" },
  testFilter: { range: "thisWeek", start: "", end: "" },
  allRecs: [],
  summary: { range: "thisWeek", start: "", end: "", data: null, loading: false, failed: false },
  evals: { year: new Date().getFullYear(), month: new Date().getMonth() + 1, studentId: null, data: null, loading: false, failed: false, key: "" },
  studentId: null,
  tab: "progress",       // progress | lessons | tests | report
  report: { range: "thisWeek", start: "", end: "", comment: "" },
  detail: { lessons: [], tests: [], logs: [], logsMissing: false, recs: [] },
  showInactive: false,
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
    run(db.from("lessons").select("student_id, lesson_date, attendance, textbook_id, from_unit, to_unit, next_plan").gte("lesson_date", daysAgoStr(30)).limit(5000)),
    run(db.from("tests").select("student_id, test_date, score, max_score").gte("test_date", daysAgoStr(90)).limit(5000)),
  ]);
  state.students = students;
  state.textbooks = textbooks;
  state.progress = progress;
  state.recentLessons = lessons;
  state.recentTests = tests;
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
  renderSidebar();
  if (state.view === "student") renderStudent();
  else if (state.view === "summary") renderSummary();
  else if (state.view === "evals") renderEvals();
  else if (state.view === "recs") renderAllRecs();
  else renderOverview();
}

function renderSidebar() {
  $("#nav-overview").classList.toggle("active", state.view === "overview");
  $("#nav-summary").classList.toggle("active", state.view === "summary");
  $("#nav-evals").classList.toggle("active", state.view === "evals");
  $("#nav-recs").classList.toggle("active", state.view === "recs");
  const rb = $("#recs-badge");
  rb.hidden = !state.pendingRecs;
  rb.textContent = state.pendingRecs;
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

function rangeText(book, l) {
  const lab = book.unit_label;
  if (l.from_unit != null && l.to_unit != null) return l.from_unit === l.to_unit ? ` ${lab} ${l.from_unit}` : ` ${lab} ${l.from_unit}–${l.to_unit}`;
  if (l.to_unit != null) return ` ${lab} ~${l.to_unit}`;
  if (l.from_unit != null) return ` ${lab} ${l.from_unit}~`;
  return "";
}

function coverText(l) {
  if (!l || !l.textbook_id) return "";
  const book = state.textbooks.find((b) => b.id === l.textbook_id);
  return book ? book.title + rangeText(book, l) : "";
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
    const lastCovered = sortedL.find((l) => l.textbook_id);
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
              const ratio = Math.min(100, Math.round((p.current_unit / book.total_units) * 100));
              return `<div class="row"><span>${esc(book.title)}</span><span class="muted">${p.current_unit}/${book.total_units}</span>
                <div class="bar ${ratio >= 100 ? "done" : ""}"><span style="width:${ratio}%"></span></div></div>`;
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

  main.innerHTML = `
    <div class="page-head"><h2>전체 현황</h2><span class="muted">재원생 ${students.length}명</span>
      ${stale ? `<span class="badge warn">30일간 수업 기록이 없는 학생 ${stale}명</span>` : ""}</div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>학생</th><th>교재 진도</th><th>최근 수업</th><th>수업 진도 · 다음 예정</th><th class="num">30일 출석</th><th class="num">90일 시험 평균</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="muted" style="margin-top:.8rem;font-size:.85rem">행을 누르면 학생 상세로 이동합니다. 시험 평균은 점수를 100점 만점으로 환산한 값입니다.</p>`;
}

function renderStudent() {
  const s = state.students.find((x) => x.id === state.studentId);
  if (!s) return renderOverview();
  const main = $("#main");
  const pendingRecs = (state.detail.recs || []).filter((r) => r.status === "제안").length;
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
        .map(([k, t]) => `<button class="tab ${state.tab === k ? "active" : ""}" role="tab" data-tab="${k}">${t}${k === "recs" && pendingRecs ? ` <span class="badge warn">${pendingRecs}</span>` : ""}</button>`)
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
  const cards = items
    .map(({ p, book }) => {
      const ratio = Math.min(100, Math.round((p.current_unit / book.total_units) * 100));
      const recent = state.detail.lessons.find((l) => l.textbook_id === book.id);
      return `<div class="card book-card" data-pid="${esc(p.id)}">
        <h3>${esc(book.title)}</h3>
        <div class="stat"><strong>${esc(book.unit_label)} ${p.current_unit} <span class="muted" style="font-size:.9rem;font-weight:400">/ ${book.total_units}</span></strong><span class="badge ${ratio >= 100 ? "" : "warn"}">${ratio}%</span></div>
        <div class="bar ${ratio >= 100 ? "done" : ""}"><span style="width:${ratio}%"></span></div>
        ${recent ? `<div style="font-size:.85rem;margin-top:.5rem">최근 수업 <span class="muted">${fmtDate(recent.lesson_date)}</span> ·${esc(rangeText(book, recent) || " 범위 미입력")}</div>` : ""}
        <div class="muted" style="font-size:.8rem;margin-top:.4rem">진도 갱신 ${fmtDate((p.updated_at || "").slice(0, 10))}</div>
        <div class="book-actions">
          <button class="btn small" data-act="dec">-1</button>
          <button class="btn small primary" data-act="inc">+1</button>
          <button class="btn small" data-act="set">직접 입력</button>
          <button class="btn small danger" data-act="unassign">배정 해제</button>
        </div>
      </div>`;
    })
    .join("");
  $("#tab-body").innerHTML = `
    ${nextLesson ? `<div class="card next-card"><strong>다음 수업 예정</strong><div>${esc(nextLesson.next_plan)}</div><span class="muted">${fmtDate(nextLesson.lesson_date)} 수업 기록 기준</span></div>` : ""}
    <div class="toolbar"><button class="btn primary" id="btn-assign" ${available.length ? "" : "disabled"}>+ 교재 배정</button>
      ${state.textbooks.length ? "" : `<span class="muted">먼저 왼쪽 아래 <strong>교재 관리</strong>에서 교재를 만드세요.</span>`}</div>
    ${cards ? `<div class="grid">${cards}</div>` : `<div class="card empty">배정된 교재가 없습니다.</div>`}`;
}

function renderLessonsTab(s) {
  const all = state.detail.lessons;
  const rows = all.filter((l) => inRange(state.lessonFilter, l.lesson_date));
  $("#tab-body").innerHTML = filterHtml(state.lessonFilter, "lf", false) + `
    <div class="toolbar"><button class="btn primary" id="btn-add-lesson">+ 수업 기록</button></div>
    ${
      rows.length
        ? `<div class="card table-wrap"><table>
            <thead><tr><th>날짜</th><th>출결</th><th>수업 진도</th><th>숙제</th><th>메모 · 다음 수업</th></tr></thead>
            <tbody>${rows
              .map(
                (l) => `<tr class="clickable" data-lid="${esc(l.id)}">
                  <td style="white-space:nowrap">${fmtDate(l.lesson_date)}</td>
                  <td class="att-${esc(l.attendance)}">${esc(l.attendance)}</td>
                  <td>${esc(coverText(l)) || '<span class="muted">-</span>'}${l.topic ? `<div class="muted">${esc(l.topic)}</div>` : ""}</td>
                  <td>${esc(l.homework || "-")}${l.homework_note ? `<div class="muted">${esc(l.homework_note)}</div>` : ""}</td>
                  <td class="memo-cell">${esc(l.memo || "")}${l.next_plan ? `<div class="next-plan">다음: ${esc(l.next_plan)}</div>` : ""}${l.teacher_comment ? `<div class="lesson-comment"><strong>코멘트</strong>${esc(l.teacher_comment)}</div>` : ""}</td></tr>`
              )
              .join("")}</tbody></table></div>
          <p class="muted" style="font-size:.85rem;margin-top:.6rem">행을 누르면 수정·삭제할 수 있습니다. 최근 300건까지 표시됩니다.</p>`
        : `<div class="card empty">${all.length ? "이 기간에는 수업 기록이 없습니다. 위에서 기간을 바꿔 보세요." : "수업 기록이 없습니다."}</div>`
    }`;
  bindFilter(state.lessonFilter, "lf", () => renderLessonsTab(s));
}

function trendSvg(tests) {
  const pts = [...tests].sort((a, b) => a.test_date.localeCompare(b.test_date)).slice(-15);
  if (pts.length < 2) return `<p class="muted" style="margin:0">추이 그래프는 시험이 2회 이상 쌓이면 표시됩니다.</p>`;
  const W = 600, H = 150, L = 28, R = 10, T = 12, B = 22;
  const x = (i) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (v) => T + ((100 - Math.min(100, v)) * (H - T - B)) / 100;
  const vals = pts.map((t) => pct(t.score, t.max_score));
  const path = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const grid = [0, 50, 100].map((g) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text x="2" y="${y(g) + 3}">${g}</text>`).join("");
  const dots = vals.map((v, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3"><title>${fmtDate(pts[i].test_date)} ${v.toFixed(0)}점</title></circle>`).join("");
  const labels = [0, pts.length - 1].map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i ? "end" : "start"}">${fmtDate(pts[i].test_date)}</text>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="시험 점수 추이(100점 만점 환산)">${grid}<path class="line" d="${path}"/>${dots}${labels}</svg>`;
}

function renderTestsTab(s) {
  const all = state.detail.tests;
  const rows = all.filter((t) => inRange(state.testFilter, t.test_date));
  const pcts = rows.map((t) => pct(t.score, t.max_score));
  const recent = pcts.slice(0, 5);
  const scoped = state.testFilter.range !== "all";
  $("#tab-body").innerHTML = filterHtml(state.testFilter, "tf", false) + `
    <div class="toolbar"><button class="btn primary" id="btn-add-test">+ 시험 점수</button></div>
    ${
      rows.length
        ? `<div class="summary">
            <div class="card"><strong>${avg(pcts).toFixed(0)}점</strong><span>${scoped ? "기간 평균" : "전체 평균"}</span></div>
            <div class="card"><strong>${avg(recent).toFixed(0)}점</strong><span>최근 ${recent.length}회 평균</span></div>
            <div class="card"><strong>${Math.max(...pcts).toFixed(0)}점</strong><span>최고점</span></div>
            <div class="card"><strong>${rows.length}회</strong><span>${scoped ? "기간 내 시험" : "누적 시험"}</span></div>
          </div>
          <div class="card" style="margin-bottom:1rem">${trendSvg(rows)}</div>
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
    if (!l.textbook_id) return;
    const r = ranges.get(l.textbook_id) || { from: null, to: null };
    const f = l.from_unit ?? l.to_unit;
    const t = l.to_unit ?? l.from_unit;
    if (f != null) r.from = r.from == null ? f : Math.min(r.from, f);
    if (t != null) r.to = r.to == null ? t : Math.max(r.to, t);
    ranges.set(l.textbook_id, r);
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
        const parts = [cover, l.topic].filter(Boolean).join(" · ");
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
        const lab = book.unit_label;
        const span = from != null && to != null ? (from === to ? `${lab} ${from}` : `${lab} ${from}–${to}`) : "";
        out.push(`- ${book.title}${span ? ` ${span}` : ""}${current != null ? ` (현재 ${current}/${book.total_units})` : ""}`);
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

/* ---------- 주간·월간 요약 (전체 학생) ---------- */
async function loadSummary() {
  const sm = state.summary;
  const range = periodRange(sm.range, sm.start, sm.end);
  const days = Math.round((parseD(range.end) - parseD(range.start)) / 86400000) + 1;
  const from = addDays(range.start, -days);
  sm.loading = true;
  sm.failed = false;
  renderSummary();
  try {
    const [lessons, tests] = await Promise.all([
      run(db.from("lessons").select("*").gte("lesson_date", from).lte("lesson_date", range.end).limit(5000)),
      run(db.from("tests").select("*").gte("test_date", from).lte("test_date", range.end).limit(5000)),
    ]);
    let logs = [];
    try {
      logs = await run(db.from("report_logs").select("*").eq("period_start", range.start).eq("period_end", range.end).limit(2000));
    } catch {
      logs = null; // 발송 기록 테이블 없음
    }
    sm.data = { range, lessons, tests, logs };
  } catch (e) {
    sm.data = null;
    sm.failed = true;
    fail(e, "요약을 불러오지 못했습니다");
  }
  sm.loading = false;
  if (state.view === "summary") renderSummary();
}

function renderSummary() {
  const sm = state.summary;
  const opts = [["thisWeek", "이번 주"], ["lastWeek", "지난 주"], ["thisMonth", "이번 달"], ["lastMonth", "지난 달"], ["custom", "직접 선택"]];
  const range = periodRange(sm.range, sm.start, sm.end);
  const head = `<div class="page-head"><h2>주간·월간 요약</h2><span class="muted">${shortDate(range.start)} ~ ${shortDate(range.end)}</span></div>
    <div class="card report-controls">
      <label>기간<select id="sm-range">${opts.map(([v, t]) => `<option value="${v}" ${sm.range === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label>시작일<input type="date" id="sm-start" value="${esc(range.start)}" ${sm.range === "custom" ? "" : "disabled"}></label>
      <label>종료일<input type="date" id="sm-end" value="${esc(range.end)}" ${sm.range === "custom" ? "" : "disabled"}></label>
    </div>`;
  const bind = () => {
    $("#sm-range").onchange = (e) => { sm.range = e.target.value; loadSummary(); };
    const onDate = () => { sm.start = $("#sm-start").value; sm.end = $("#sm-end").value; loadSummary(); };
    $("#sm-start").onchange = onDate;
    $("#sm-end").onchange = onDate;
  };
  const main = $("#main");
  const d = sm.data;
  if (sm.loading || !d) {
    main.innerHTML = head + `<div class="card empty">${sm.loading ? "불러오는 중..." : sm.failed ? "요약을 불러오지 못했습니다. 기간을 다시 선택해 보세요." : "불러오는 중..."}</div>`;
    bind();
    if (!sm.loading && !d && !sm.failed) loadSummary();
    return;
  }
  // 요약은 불러온 기간과 선택한 기간이 같을 때만 표시
  if (d.range.start !== range.start || d.range.end !== range.end) {
    main.innerHTML = head + `<div class="card empty">불러오는 중...</div>`;
    bind();
    if (!sm.loading) loadSummary();
    return;
  }
  const students = state.students.filter((s) => s.active);
  const rows = students.map((s) => {
    const src = { lessons: d.lessons.filter((l) => l.student_id === s.id), tests: d.tests.filter((t) => t.student_id === s.id) };
    const r = buildReport(s.id, range.start, range.end, src);
    const log = d.logs ? d.logs.filter((g) => g.student_id === s.id).sort((a, b) => b.sent_at.localeCompare(a.sent_at))[0] : null;
    return { s, r, log };
  });
  const noRecord = rows.filter((x) => !x.r.lessons.length).length;
  const unsent = d.logs ? rows.filter((x) => x.r.hasData && !x.log).length : null;
  const totalLessons = rows.reduce((n, x) => n + x.r.lessons.length, 0);
  const body = rows
    .map(({ s, r, log }) => {
      const hwTotal = r.hw.완료 + r.hw.일부 + r.hw.미제출;
      const books = r.books.length
        ? r.books.map(({ book, from, to }) => `<div>${esc(book.title)}${from != null && to != null ? ` <span class="muted">${esc(book.unit_label)} ${from === to ? from : from + "–" + to}</span>` : ""}</div>`).join("")
        : '<span class="muted">-</span>';
      const diff = r.testAvg != null && r.prevAvg != null ? Math.round(r.testAvg - r.prevAvg) : null;
      const sent = d.logs === null
        ? '<span class="muted">-</span>'
        : log
        ? `<span class="badge">${fmtDate(log.sent_at.slice(0, 10))} 발송</span>`
        : r.hasData
        ? '<span class="badge warn">미발송</span>'
        : '<span class="muted">-</span>';
      return `<tr class="clickable" data-sid="${esc(s.id)}">
        <td><strong>${esc(s.name)}</strong><div class="muted">${esc(s.grade || "")}</div></td>
        <td class="num">${r.lessons.length ? `${r.lessons.length}회` : '<span class="badge warn">기록 없음</span>'}${r.att.결석 ? `<div class="att-결석" style="font-size:.8rem">결석 ${r.att.결석}</div>` : ""}</td>
        <td>${books}</td>
        <td class="num">${hwTotal ? Math.round((r.hw.완료 / hwTotal) * 100) + "%" : "-"}</td>
        <td class="num">${r.tests.length ? r.testAvg.toFixed(0) + "점" : "-"}${diff != null ? `<div class="muted" style="font-size:.8rem">${diff > 0 ? "+" : ""}${diff}</div>` : ""}</td>
        <td>${r.nextPlan ? esc(r.nextPlan) : '<span class="muted">-</span>'}</td>
        <td>${sent}</td></tr>`;
    })
    .join("");
  main.innerHTML = head + (students.length
    ? `<div class="summary">
        <div class="card"><strong>${students.length}명</strong><span>재원생</span></div>
        <div class="card"><strong>${totalLessons}회</strong><span>전체 수업 횟수</span></div>
        <div class="card"><strong>${noRecord}명</strong><span>수업 기록 없음</span></div>
        <div class="card"><strong>${unsent == null ? "-" : unsent + "명"}</strong><span>안내문 미발송</span></div>
      </div>
      <div class="card table-wrap"><table>
        <thead><tr><th>학생</th><th class="num">수업</th><th>학습 교재 · 범위</th><th class="num">숙제 완료율</th><th class="num">시험 평균</th><th>다음 수업 예정</th><th>안내문</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      <p class="muted" style="margin-top:.8rem;font-size:.85rem">학생 행을 누르면 그 학생 화면으로 이동합니다. 시험 평균 아래 숫자는 직전 같은 길이 기간 대비 변화입니다.${d.logs === null ? " 안내문 발송 기록을 보려면 최신 schema.sql 을 실행하세요." : ""}</p>`
    : `<div class="card empty">재원 중인 학생이 없습니다.</div>`);
  bind();
  $("#main tbody").onclick = async (e) => {
    const tr = e.target.closest("tr[data-sid]");
    if (!tr) return;
    state.report.range = sm.range;
    state.report.start = range.start;
    state.report.end = range.end;
    await selectStudent(tr.dataset.sid);
    state.tab = "progress";
    render();
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
const EVAL_STATUS = ["작성중", "완료"];

function monthRange(y, m) {
  const pad = (n) => String(n).padStart(2, "0");
  return { start: `${y}-${pad(m)}-01`, end: toStr(new Date(y, m, 0)) };
}
function prevMonthStart(y, m) {
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
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
      run(db.from("tests").select("*").gte("test_date", from).lte("test_date", range.end).limit(5000)),
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
    ? `<ul class="eval-list">${r.books.map(({ book, from, to, current }) => `<li>${esc(book.title)}${esc(rangeText(book, { from_unit: from, to_unit: to }))}${current != null ? ` <span class="muted">(현재 ${current}/${book.total_units})</span>` : ""}</li>`).join("")}</ul>`
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

function evalPrintHtml(s, d, sm, vals) {
  const r = sm.r;
  const [yy, mm] = d.key.split("-").map(Number);
  const segs = (v) => Array.from({ length: 5 }, (_, k) => `<i class="${k < (v || 0) ? "on" : ""}"></i>`).join("");
  const rateRows = (defs, obj) => defs.map(([k, t]) => `<div class="rp-rr"><span class="rp-rn">${t}</span><span class="rp-seg">${segs(obj[k])}</span><span class="rp-rl">${obj[k] ? esc(levelLabel(obj[k])) : "-"}</span></div>`).join("");
  const attParts = ["출석", "지각", "결석", "보강"].filter((k) => r.att[k]).map((k) => `${k} ${r.att[k]}`);
  const diff = r.testAvg != null && r.prevAvg != null ? Math.round(r.testAvg - r.prevAvg) : null;
  const books = r.books.length
    ? `<h3>이번 달 진도</h3>${r.books.map(({ book, from, to, current }) => {
        const ratio = current != null && book.total_units ? Math.min(100, Math.round((current / book.total_units) * 100)) : 0;
        return `<div class="rp-bk"><div><b>${esc(book.title)}</b> <span class="rp-mut">${esc(rangeText(book, { from_unit: from, to_unit: to }).trim())}</span></div>${current != null ? `<div class="rp-bar"><span style="width:${ratio}%"></span></div><div class="rp-mut rp-sm">현재 ${current}/${book.total_units}</div>` : ""}</div>`;
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
      <div class="rp-two">
        <div><h3>영역별 평가</h3>${rateRows(EVAL_SKILLS, vals.ratings)}</div>
        <div><h3>학습 태도</h3>${rateRows(EVAL_ATTITUDE, vals.attitude)}${books ? `<div class="rp-gap"></div>${books}` : ""}</div>
      </div>
      ${texts}
    </div>
    <div class="rp-foot"><span>${esc(ACADEMY_NAME)} 공부방</span><span>${shortDate(todayStr())} 출력</span></div>
  </div>`;
}

/* 월말평가서 인쇄 미리보기 (화면에서 A4 모양 확인) */
function openEvalPreview(html, onPrint, returnTo, label = "평가서 미리보기") {
  const old = document.getElementById("ev-preview-overlay");
  if (old) old.remove();
  const ov = document.createElement("div");
  ov.id = "ev-preview-overlay";
  ov.className = "ev-ov";
  ov.setAttribute("role", "dialog");
  ov.setAttribute("aria-modal", "true");
  ov.setAttribute("aria-label", label);
  ov.innerHTML = `<div class="ev-ov-bar"><strong>${esc(label)}</strong><span class="muted" id="ev-ov-note">A4 기준</span><span class="spacer"></span>
      <button class="btn primary" type="button" id="ev-ov-print">인쇄 / PDF 저장</button>
      <button class="btn" type="button" id="ev-ov-close">닫기</button></div>
    <div class="ev-ov-scroll"><div class="ev-sheet" id="ev-sheet">${html}</div></div>`;
  document.body.appendChild(ov);
  const sheet = ov.querySelector("#ev-sheet");
  // A4 한 장(297mm) 기준으로 몇 장이 되는지 계산
  const pageH = (297 / 25.4) * 96;
  const pages = Math.max(1, Math.ceil((sheet.offsetHeight - 2) / pageH));
  ov.querySelector("#ev-ov-note").textContent = pages > 1 ? `A4 기준 · 내용이 길어 ${pages}장으로 인쇄됩니다` : "A4 한 장";
  // 화면 너비에 맞춰 축소
  const fit = () => {
    const avail = ov.querySelector(".ev-ov-scroll").clientWidth - 32;
    const w = (210 / 25.4) * 96;
    sheet.style.zoom = String(Math.min(1, avail / w));
  };
  fit();
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
  ov.querySelector("#ev-ov-close").onclick = close;
  ov.querySelector("#ev-ov-print").onclick = onPrint;
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
  $("#ev-preview").onclick = () => openEvalPreview(evalPrintHtml(s, d, sm, evalValues()), doPrint, $("#ev-preview"));
  $("#ev-form").onsubmit = async (e) => {
    e.preventDefault();
    const btn = $("#ev-save");
    btn.disabled = true;
    $("#ev-err").textContent = "";
    try {
      const vals = evalValues();
      const payload = { student_id: s.id, year: ev.year, month: ev.month, ...vals, updated_at: new Date().toISOString() };
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
      <label>시작일<input type="date" id="${p}-start" value="${esc(rg ? rg.start : "")}" ${f.range === "custom" ? "" : "disabled"}></label>
      <label>종료일<input type="date" id="${p}-end" value="${esc(rg ? rg.end : "")}" ${f.range === "custom" ? "" : "disabled"}></label>
      ${withPrint ? `<div style="align-self:end"><button class="btn" id="${p}-print" type="button">${typeof withPrint === "string" ? esc(withPrint) : "인쇄 / PDF 저장"}</button></div>` : ""}
    </div>`;
}
function bindFilter(f, p, rerender) {
  $("#" + p + "-range").onchange = (e) => { f.range = e.target.value; rerender(); };
  const onDate = () => { f.start = $("#" + p + "-start").value; f.end = $("#" + p + "-end").value; rerender(); };
  $("#" + p + "-start").onchange = onDate;
  $("#" + p + "-end").onchange = onDate;
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
function planPrintHtml(s, recs) {
  const rg = filterRange(state.recFilter);
  const title = planTitle(state.recFilter);
  const list = recs.filter((r) => r.status !== "거절").sort((a, b) => recDate(a).localeCompare(recDate(b)));
  const card = (r) => {
    const b = state.textbooks.find((x) => x.id === r.textbook_id);
    const pr = b ? state.progress.find((x) => x.student_id === s.id && x.textbook_id === b.id) : null;
    const d = r.target_date ? parseD(r.target_date) : null;
    const pct = pr && b && b.total_units ? Math.max(0, Math.min(100, Math.round((pr.current_unit / b.total_units) * 100))) : null;
    const range = b ? rangeText(b, r).trim() : `${r.from_unit}–${r.to_unit}단원`;
    return `<div class="pl-card">
      <div class="pl-date">${d ? `<div class="pl-d">${d.getDate()}</div><div class="pl-w">${DOW_FULL[d.getDay()]}</div>` : `<div class="pl-d pl-tbd">예정</div><div class="pl-w">날짜 미정</div>`}</div>
      <div class="pl-main">
        <div class="pl-bk">${esc(b ? b.title : "")}</div>
        <div class="pl-rg">${esc(range)}</div>
        ${pct !== null ? `<div class="rp-bar pl-bar"><span style="width:${pct}%"></span></div><div class="pl-pg">지금까지 ${esc(b.unit_label)} ${pr.current_unit} / ${b.total_units} · ${pct}%</div>` : ""}
        ${r.rationale ? `<div class="pl-pt">${esc(r.rationale)}</div>` : ""}
      </div></div>`;
  };
  return `<div class="rp-page pl-page">
    <div class="pl-hd"><div class="pl-br">${esc(ACADEMY_NAME).toUpperCase()}</div><h1>${esc(title)}</h1>
      <div class="pl-who"><span><b>${esc(s.name)}</b>${s.grade ? ` (${esc(s.grade)})` : ""}</span>${rg ? `<span>${shortDate(rg.start)} – ${shortDate(rg.end)}</span>` : ""}</div></div>
    <div class="pl-bd">
      <p class="pl-hello">${esc(title)}입니다. 수업 전에 한 번 훑어보고 오면 더 쉬워져요!</p>
      <h2 class="pl-h2">${esc(title.replace(/ 안내$/, ""))}</h2>
      ${list.length ? list.map(card).join("") : `<p class="pl-empty">이 기간에 예정된 수업이 없습니다.</p>`}
    </div>
    <div class="rp-foot"><span>${esc(ACADEMY_NAME)}</span><span>궁금한 점은 선생님께 언제든 물어보세요</span></div>
  </div>`;
}

/* ---------- 수업 추천 (Claude 예약 작업이 저장한 제안을 확인) ---------- */
function renderRecsTab(s) {
  const allForStudent = state.detail.recs || [];
  const recs = filterRecs(allForStudent);
  const pending = recs.filter((r) => r.status === "제안");
  const done = recs.filter((r) => r.status !== "제안");
  const card = (r) => {
    const b = state.textbooks.find((x) => x.id === r.textbook_id);
    const pr = b ? state.progress.find((x) => x.student_id === s.id && x.textbook_id === b.id) : null;
    const cls = r.status === "거절" ? "bad" : r.status === "제안" ? "warn" : "";
    return `<div class="card" style="margin-bottom:.7rem">
      <div class="toolbar" style="margin:0">
        <span class="badge ${cls}">${esc(r.status)}</span>
        <strong>${esc(b ? b.title + rangeText(b, r) : r.from_unit + "–" + r.to_unit + "단원")}</strong>
        ${r.target_date ? `<span class="muted">${fmtDate(r.target_date)} 수업 예정</span>` : ""}
        <span class="spacer"></span>
        ${r.status === "제안" ? `<button class="btn small primary" data-rec-use="${esc(r.id)}" type="button">수업 기록에 반영</button><button class="btn small danger" data-rec-no="${esc(r.id)}" type="button">거절</button>` : ""}
      </div>
      ${r.rationale ? `<div class="memo-cell" style="margin-top:.4rem">${esc(r.rationale)}</div>` : ""}
      <div class="muted" style="font-size:.8rem;margin-top:.3rem">${pr && b ? `현재 진도 ${esc(b.unit_label)} ${pr.current_unit}/${b.total_units} · ` : ""}${fmtDate((r.created_at || "").slice(0, 10))} 생성${r.model ? " · " + esc(r.model) : ""}${r.decided_at ? " · " + fmtDate(r.decided_at.slice(0, 10)) + " 처리" : ""}</div>
    </div>`;
  };
  $("#tab-body").innerHTML = `<div class="eval-edit">` + filterHtml(state.recFilter, "rf", "수업 안내 미리보기") + (recs.length
    ? `${pending.length ? `<h3>확인할 추천 (${pending.length})</h3>${pending.map(card).join("")}` : `<div class="card empty">확인할 새 추천이 없습니다.</div>`}
       ${done.length ? `<h3 style="margin-top:1.2rem">지난 추천</h3>${done.map(card).join("")}` : ""}
       <p class="muted" style="font-size:.85rem">"수업 기록에 반영"을 누르면 수업 기록 창이 추천 교재·단원으로 채워집니다. 그대로 저장하면 "채택", 고쳐서 저장하면 "수정"으로 기록됩니다. 진도표는 수업 기록을 저장할 때만 바뀝니다.</p>`
    : `<div class="card empty">${allForStudent.length ? "이 기간에는 추천이 없습니다. 위에서 기간을 바꿔 보세요." : "아직 추천이 없습니다. Claude 예약 작업이 실행되면 여기에 표시됩니다."}</div>`) + `</div><div class="eval-print" id="plan-print-area"></div>`;
  bindRecFilter(() => renderRecsTab(s));
  const doPrint = () => {
    $("#plan-print-area").innerHTML = planPrintHtml(s, recs);
    document.body.classList.add("print-plan"); // 학생 머리글·메모는 인쇄에서 제외
    try { window.print(); } finally { document.body.classList.remove("print-plan"); }
  };
  $("#rf-print").onclick = () => openEvalPreview(planPrintHtml(s, recs), doPrint, $("#rf-print"), "수업 안내 미리보기");

  $("#tab-body").querySelectorAll("[data-rec-use]").forEach((b) => {
    b.onclick = async () => {
      const rec = recs.find((r) => r.id === b.dataset.recUse);
      if (await recDateHasLesson(s, rec)) return;
      lessonForm(s, null, rec);
    };
  });
  $("#tab-body").querySelectorAll("[data-rec-no]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("이 추천을 거절로 기록할까요?")) return;
      try {
        await run(db.from("recommendations").update({ status: "거절", decided_at: new Date().toISOString() }).eq("id", b.dataset.recNo));
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
    return `<tr data-rid="${esc(r.id)}">
      <td><strong>${esc(name(r.student_id))}</strong></td>
      <td>${esc(b ? b.title + rangeText(b, r) : r.from_unit + "–" + r.to_unit + "단원")}${pr && b ? `<div class="muted" style="font-size:.8rem">현재 ${esc(b.unit_label)} ${pr.current_unit}/${b.total_units}</div>` : ""}</td>
      <td style="white-space:nowrap">${r.target_date ? fmtDate(r.target_date) : "-"}</td>
      <td class="memo-cell">${esc(r.rationale || "")}</td>
      <td style="white-space:nowrap"><span class="badge ${cls}">${esc(r.status)}</span>
        ${r.status === "제안" ? `<div class="book-actions" style="margin-top:.4rem"><button class="btn small primary" data-rec-use="${esc(r.id)}" type="button">반영</button><button class="btn small danger" data-rec-no="${esc(r.id)}" type="button">거절</button></div>` : ""}</td></tr>`;
  };
  const table = (rows) => `<div class="card table-wrap"><table>
    <thead><tr><th>학생</th><th>추천 교재 · 범위</th><th>수업 예정일</th><th>근거</th><th>상태</th></tr></thead>
    <tbody>${rows.map(row).join("")}</tbody></table></div>`;
  $("#main").innerHTML = `
    <div class="page-head"><h2>수업 추천</h2><span class="muted">이번 주 ${shortDate(wk.start)} ~ ${shortDate(wk.end)} · 학생별 다음 수업 진도 추천</span></div>
    ${pending.length ? `<h3>확인할 추천 (${pending.length})</h3>${table(pending)}` : `<div class="card empty">이번 주에 확인할 새 추천이 없습니다. 다른 주의 추천은 학생 화면의 수업 추천 탭에서 기간을 바꿔 볼 수 있습니다.</div>`}
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
                  <span style="flex:1"><strong>${esc(b.title)}</strong> <span class="muted">${b.total_units} ${esc(b.unit_label)}</span></span>
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
  openForm({
    title: book ? "교재 수정" : "교재 추가",
    fields: [
      { name: "title", label: "교재명", required: true, maxlength: 100 },
      { name: "total_units", label: "전체 단원 수", type: "number", min: 1, max: 500, required: true, half: true },
      { name: "unit_label", label: "단위 이름 (Unit, Lesson 등)", required: true, half: true, maxlength: 20 },
    ],
    values: book || { total_units: 20, unit_label: "Unit" },
    onSubmit: async (d) => {
      if (book) await run(db.from("textbooks").update(d).eq("id", book.id));
      else await run(db.from("textbooks").insert(d));
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
  const options = state.textbooks.filter((b) => !assigned.has(b.id)).map((b) => [b.id, `${b.title} (${b.total_units} ${b.unit_label})`]);
  openForm({
    title: "교재 배정",
    fields: [
      { name: "textbook_id", label: "교재", type: "select", options, required: true },
      { name: "current_unit", label: "현재 진도 (이미 나간 단원 수)", type: "number", min: 0, default: 0 },
    ],
    onSubmit: async (d) => {
      await run(db.from("progress").insert({ student_id: s.id, textbook_id: d.textbook_id, current_unit: d.current_unit || 0 }));
      await refresh();
      toast("교재를 배정했습니다");
    },
  });
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
  const rest = state.textbooks.filter((b) => !assigned.some((a) => a.id === b.id));
  const bookOptions = [["", "(교재 없음)"], ...assigned.map((b) => [b.id, b.title]), ...rest.map((b) => [b.id, `${b.title} (미배정)`])];

  let values = lesson;
  if (!lesson) {
    values = { lesson_date: todayStr(), attendance: "출석" };
    const lastBookId = (state.detail.lessons.find((l) => l.textbook_id) || {}).textbook_id || (assigned[0] && assigned[0].id);
    const book = state.textbooks.find((b) => b.id === lastBookId);
    if (book) {
      values.textbook_id = book.id;
      const pr = state.progress.find((x) => x.student_id === s.id && x.textbook_id === book.id);
      if (pr && pr.current_unit < book.total_units) values.from_unit = pr.current_unit + 1;
    }
  }

  if (!lesson && rec) {
    values = { ...values, textbook_id: rec.textbook_id || values.textbook_id, from_unit: rec.from_unit, to_unit: rec.to_unit, lesson_date: rec.target_date || values.lesson_date };
  }

  const fields = [
    { name: "lesson_date", label: "날짜", type: "date", required: true, half: true },
    { name: "attendance", label: "출결", type: "select", options: ["출석", "지각", "결석", "보강"].map((x) => [x, x]), half: true },
    { name: "textbook_id", label: "수업 교재", type: "select", options: bookOptions },
    { name: "from_unit", label: "시작 단원", type: "number", min: 0, half: true },
    { name: "to_unit", label: "종료 단원", type: "number", min: 0, half: true },
    { name: "topic", label: "학습 내용 (예: 현재완료, 본문 읽기)", maxlength: 200 },
    { name: "homework", label: "숙제", type: "select", options: [["", "-"], ["완료", "완료"], ["일부", "일부"], ["미제출", "미제출"]] },
    { name: "homework_note", label: "숙제 내용 (예: 단어 Day 5 쓰기)", maxlength: 200 },
    { name: "memo", label: "수업 메모", type: "textarea" },
    { name: "teacher_comment", label: "선생님 코멘트 (길게 적을 수 있어요, 최대 5,000자)", type: "textarea", rows: 9, maxlength: 5000 },
    { name: "next_plan", label: "다음 수업 예정 진도", maxlength: 200 },
  ];
  if (!lesson) fields.push({ name: "sync_progress", label: "저장할 때 교재 진도도 종료 단원으로 갱신 (결석은 제외)", type: "checkbox", default: true });

  openForm({
    title: lesson ? "수업 기록 수정" : "수업 기록",
    wide: true,
    fields,
    values,
    onSubmit: async (d) => {
      const { sync_progress, ...data } = d;
      const book = state.textbooks.find((b) => b.id === data.textbook_id);
      if (!book && (data.from_unit != null || data.to_unit != null)) throw new Error("단원 범위를 입력하려면 교재를 선택하세요.");
      if (book) {
        if (data.from_unit != null && data.to_unit != null && data.from_unit > data.to_unit) throw new Error("시작 단원이 종료 단원보다 클 수 없습니다.");
        if ((data.from_unit || 0) > book.total_units || (data.to_unit || 0) > book.total_units) throw new Error(`이 교재의 전체 단원 수는 ${book.total_units}입니다.`);
      }
      const row = { ...data, textbook_id: data.textbook_id || null, homework: data.homework || null };
      // 숙제 내용 칸이 비어 있고 기존 기록에도 없으면 컬럼을 보내지 않음(스키마 업그레이드 전에도 저장되도록)
      if (row.homework_note == null && !(lesson && "homework_note" in lesson)) delete row.homework_note;
      if (row.teacher_comment == null && !(lesson && "teacher_comment" in lesson)) delete row.teacher_comment;
      let newId = null;
      if (lesson) await run(db.from("lessons").update(row).eq("id", lesson.id));
      else {
        const ins = await run(db.from("lessons").insert({ ...row, student_id: s.id }).select("id").single());
        newId = ins && ins.id;
      }
      if (rec && newId) {
        const same = data.textbook_id === rec.textbook_id && data.from_unit === rec.from_unit && data.to_unit === rec.to_unit;
        await run(db.from("recommendations").update({ status: same ? "채택" : "수정", applied_lesson_id: newId, decided_at: new Date().toISOString() }).eq("id", rec.id));
      }

      let synced = false;
      if (!lesson && sync_progress && book && data.to_unit != null && data.attendance !== "결석") {
        const pr = state.progress.find((x) => x.student_id === s.id && x.textbook_id === book.id);
        if (!pr) {
          await run(db.from("progress").insert({ student_id: s.id, textbook_id: book.id, current_unit: data.to_unit }));
          synced = true;
        } else if (data.to_unit > pr.current_unit) {
          await run(db.from("progress").update({ current_unit: data.to_unit, updated_at: new Date().toISOString() }).eq("id", pr.id));
          synced = true;
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
    if (e.target.closest(".nav-btn, button[data-id], #btn-textbooks")) setMenu(false);
  });
  document.addEventListener("click", (e) => {
    if (appEl.classList.contains("menu-open") && !e.target.closest("#sidebar, #btn-menu")) setMenu(false);
  });
  $("#nav-overview").onclick = () => {
    state.view = "overview";
    state.studentId = null;
    render();
  };
  $("#nav-summary").onclick = () => {
    state.view = "summary";
    state.studentId = null;
    state.summary.data = null;
    state.summary.failed = false;
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
        else if (act.dataset.act === "set") {
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
