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
  view: "overview",      // overview | student
  studentId: null,
  tab: "progress",       // progress | lessons | tests | report
  report: { range: "thisWeek", start: "", end: "", comment: "" },
  detail: { lessons: [], tests: [], logs: [], logsMissing: false, recs: [] },
  recForm: { textbookId: "", perWeek: 2, withMemo: false, targetDate: "" },
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
    control = `<textarea name="${name}" ${req} maxlength="${f.maxlength || 2000}">${esc(v)}</textarea>`;
  } else if (f.type === "checkbox") {
    return `<label class="check"><input type="checkbox" name="${name}" ${v ? "checked" : ""}> ${label}</label>`;
  } else {
    const extra = [f.min != null ? `min="${f.min}"` : "", f.max != null ? `max="${f.max}"` : "", f.step ? `step="${f.step}"` : "", f.maxlength ? `maxlength="${f.maxlength}"` : "", f.minlength ? `minlength="${f.minlength}"` : ""].join(" ");
    control = `<input type="${f.type || "text"}" name="${name}" value="${esc(v)}" ${req} ${extra}>`;
  }
  return `<label>${label}${control}</label>`;
}

function openForm({ title, fields, values = {}, submitLabel = "저장", onSubmit, onDelete }) {
  const dlg = $("#dlg");
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
    recs = await run(db.from("recommendations").select("*").eq("student_id", studentId).order("created_at", { ascending: false }).limit(30));
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
  else renderOverview();
}

function renderSidebar() {
  $("#nav-overview").classList.toggle("active", state.view === "overview");
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
      ${[["progress", "교재 진도"], ["lessons", "수업 기록"], ["tests", "시험·단어"], ["report", "리포트"], ["recs", "추천"]]
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
  const rows = state.detail.lessons;
  $("#tab-body").innerHTML = `
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
                  <td class="memo-cell">${esc(l.memo || "")}${l.next_plan ? `<div class="next-plan">다음: ${esc(l.next_plan)}</div>` : ""}</td></tr>`
              )
              .join("")}</tbody></table></div>
          <p class="muted" style="font-size:.85rem;margin-top:.6rem">행을 누르면 수정·삭제할 수 있습니다. 최근 300건까지 표시됩니다.</p>`
        : `<div class="card empty">수업 기록이 없습니다.</div>`
    }`;
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
  const rows = state.detail.tests;
  const pcts = rows.map((t) => pct(t.score, t.max_score));
  const recent = pcts.slice(0, 5);
  $("#tab-body").innerHTML = `
    <div class="toolbar"><button class="btn primary" id="btn-add-test">+ 시험 점수</button></div>
    ${
      rows.length
        ? `<div class="summary">
            <div class="card"><strong>${avg(pcts).toFixed(0)}점</strong><span>전체 평균</span></div>
            <div class="card"><strong>${avg(recent).toFixed(0)}점</strong><span>최근 ${recent.length}회 평균</span></div>
            <div class="card"><strong>${Math.max(...pcts).toFixed(0)}점</strong><span>최고점</span></div>
            <div class="card"><strong>${rows.length}회</strong><span>누적 시험</span></div>
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
        : `<div class="card empty">시험 기록이 없습니다.</div>`
    }`;
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
  if (kind === "thisMonth") return { start: toStr(new Date(t.getFullYear(), t.getMonth(), 1)), end: toStr(new Date(t.getFullYear(), t.getMonth() + 1, 0)), label: "월간" };
  if (kind === "lastMonth") return { start: toStr(new Date(t.getFullYear(), t.getMonth() - 1, 1)), end: toStr(new Date(t.getFullYear(), t.getMonth(), 0)), label: "월간" };
  const start = customStart || monday;
  const end = customEnd && customEnd >= start ? customEnd : start;
  return { start, end, label: "기간" };
}

function buildReport(studentId, start, end) {
  const lessons = state.detail.lessons
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

  const tests = state.detail.tests
    .filter((t) => t.test_date >= start && t.test_date <= end)
    .sort((a, b) => a.test_date.localeCompare(b.test_date));
  const testAvg = avg(tests.map((t) => pct(t.score, t.max_score)));
  const days = Math.round((parseD(end) - parseD(start)) / 86400000) + 1;
  const prevEnd = addDays(start, -1);
  const prevStart = addDays(start, -days);
  const prevTests = state.detail.tests.filter((t) => t.test_date >= prevStart && t.test_date <= prevEnd);
  const prevAvg = avg(prevTests.map((t) => pct(t.score, t.max_score)));

  const withNext = [...state.detail.lessons].filter((l) => l.next_plan && l.lesson_date <= end).sort((a, b) => b.lesson_date.localeCompare(a.lesson_date));
  const nextPlan = withNext.length ? withNext[0].next_plan : null;

  const hwNotes = attended.filter((l) => l.homework_note).map((l) => ({ date: l.lesson_date, note: l.homework_note, status: l.homework }));
  return { lessons, attended, att, hw, hwNotes, books, tests, testAvg, prevAvg, nextPlan, hasData: lessons.length + tests.length > 0 };
}

const ACADEMY_NAME = "레이첼잉글리쉬";

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

/* ---------- 추천 (Claude에 붙여넣는 방식, 무료) ---------- */
function paceInfo(studentId, book) {
  const ls = state.detail.lessons
    .filter((l) => l.textbook_id === book.id && l.attendance !== "결석" && l.from_unit != null && l.to_unit != null)
    .slice(0, 8);
  const sizes = ls.map((l) => l.to_unit - l.from_unit + 1).filter((n) => n > 0);
  const per = sizes.length ? avg(sizes) : null;
  return { per, sample: sizes.length };
}

function buildRecSnapshot(s, book, form) {
  const p = state.progress.find((x) => x.student_id === s.id && x.textbook_id === book.id);
  const current = p ? p.current_unit : 0;
  const pace = paceInfo(s.id, book);
  const base = pace.per ? Math.max(1, Math.round(pace.per)) : null;
  const lessons = state.detail.lessons.slice(0, 10).map((l) => {
    const b = state.textbooks.find((x) => x.id === l.textbook_id);
    const o = { date: l.lesson_date, attendance: l.attendance, homework: l.homework || null };
    if (b) o.book = b.title + rangeText(b, l);
    if (l.topic) o.topic = l.topic;
    if (form.withMemo && l.memo) o.memo = l.memo;
    return o;
  });
  const tests = state.detail.tests.slice(0, 10).map((t) => ({ date: t.test_date, kind: t.kind, percent: Math.round(pct(t.score, t.max_score)) }));
  const remaining = Math.max(0, book.total_units - current);
  return {
    student: { alias: "S01", grade: s.grade || null },
    textbook: { title: book.title, unit_label: book.unit_label, total_units: book.total_units, current_unit: current, remaining_units: remaining },
    lessons_per_week: form.perWeek,
    target_date: form.targetDate || null,
    baseline: {
      avg_units_per_lesson: pace.per == null ? null : Number(pace.per.toFixed(1)),
      sample_lessons: pace.sample,
      suggested_range: base && remaining ? { from_unit: current + 1, to_unit: Math.min(book.total_units, current + base) } : null,
      est_lessons_to_finish: base ? Math.ceil(remaining / base) : null,
    },
    recent_lessons: lessons,
    recent_tests_percent: tests,
  };
}

function buildRecPrompt(snap) {
  return `당신은 영어 공부방 선생님의 수업 계획을 돕는 조교입니다. 아래 데이터를 보고 다음 수업의 교재 진도(단원 범위)를 추천해 주세요.

규칙:
- 학생은 가명(S01)입니다. 실명을 추측하거나 묻지 마세요.
- baseline.suggested_range 는 최근 평균 속도로 계산한 기준안입니다. 시험 점수, 숙제 상태, 출결을 보고 필요하면 늘리거나 줄이세요.
- 점수가 낮거나 숙제가 밀려 있으면 범위를 줄이거나 복습을 권하고, 안정적이면 기준안을 유지하세요.
- from_unit 은 1 이상, to_unit 은 from_unit 이상이며 textbook.total_units 를 넘지 않아야 합니다.
- 아래 JSON 한 개만 출력하세요. 설명 문장이나 코드 블록 표시는 쓰지 마세요.

{"from_unit": 정수, "to_unit": 정수, "rationale": "근거 1~3문장(한국어)"}

데이터:
${JSON.stringify(snap, null, 2)}`;
}

function parseRecReply(text, book) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSON을 찾지 못했습니다. Claude 답변 전체를 붙여넣어 주세요.");
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch {
    throw new Error("JSON 형식이 올바르지 않습니다.");
  }
  const from = Number(o.from_unit);
  const to = Number(o.to_unit);
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error("from_unit, to_unit 은 정수여야 합니다.");
  if (from < 1 || to < from) throw new Error("단원 범위가 올바르지 않습니다.");
  if (to > book.total_units) throw new Error(`이 교재의 전체 단원 수(${book.total_units})를 넘습니다.`);
  const rationale = String(o.rationale || "").slice(0, 600) || null;
  return { from_unit: from, to_unit: to, rationale };
}

function renderRecsTab(s) {
  const items = bookProgressFor(s.id);
  const rf = state.recForm;
  if (!rf.textbookId || !items.some((x) => x.book.id === rf.textbookId)) rf.textbookId = items[0] ? items[0].book.id : "";
  if (!rf.targetDate) rf.targetDate = todayStr();
  const book = state.textbooks.find((b) => b.id === rf.textbookId);
  const recs = state.detail.recs || [];
  const statusBadge = (st) => `<span class="badge ${st === "거절" ? "bad" : st === "제안" ? "warn" : ""}">${esc(st)}</span>`;

  $("#tab-body").innerHTML = items.length
    ? `<div class="card">
        <h3>1. 추천 요청문 만들기</h3>
        <p class="muted" style="margin-top:0">학생 이름은 빼고 가명(S01)으로 만든 요청문을 Claude 채팅에 붙여넣어 답을 받는 방식입니다. 추가 비용은 없습니다.</p>
        <div class="report-controls">
          <label>교재<select id="rc-book">${items.map(({ book: b }) => `<option value="${esc(b.id)}" ${b.id === rf.textbookId ? "selected" : ""}>${esc(b.title)}</option>`).join("")}</select></label>
          <label>수업 예정일<input type="date" id="rc-date" value="${esc(rf.targetDate)}"></label>
          <label>주당 수업 횟수<input type="number" id="rc-week" min="1" max="7" value="${rf.perWeek}"></label>
        </div>
        <label class="check"><input type="checkbox" id="rc-memo" ${rf.withMemo ? "checked" : ""}> 수업 메모도 포함 (개인정보가 적혀 있지 않은지 확인하세요)</label>
        <label>요청문
          <textarea id="rc-prompt" class="report-draft" readonly style="min-height:12rem"></textarea>
        </label>
        <div class="toolbar"><button class="btn primary" id="rc-copy" type="button">요청문 복사</button><span class="muted" id="rc-copied"></span></div>
      </div>
      <div class="card" style="margin-top:1rem">
        <h3>2. Claude 답변 붙여넣기</h3>
        <label>답변 (JSON)<textarea id="rc-reply" placeholder='{"from_unit": 8, "to_unit": 9, "rationale": "..."}'></textarea></label>
        <p id="rc-err" class="error" role="alert"></p>
        <button class="btn primary" id="rc-save" type="button">추천으로 저장</button>
      </div>
      <h3 style="margin-top:1.2rem">추천 이력</h3>
      ${
        recs.length
          ? recs
              .map((r) => {
                const b = state.textbooks.find((x) => x.id === r.textbook_id);
                const rt = b ? `${b.title}${rangeText(b, r)}` : `${r.from_unit}–${r.to_unit}단원`;
                return `<div class="card" style="margin-bottom:.7rem">
                  <div class="toolbar" style="margin:0">${statusBadge(r.status)}<strong>${esc(rt)}</strong><span class="muted">${r.target_date ? fmtDate(r.target_date) + " 수업 예정" : ""}</span><span class="spacer"></span>
                    ${r.status === "제안" ? `<button class="btn small primary" data-rec-use="${esc(r.id)}" type="button">수업 기록에 반영</button><button class="btn small danger" data-rec-no="${esc(r.id)}" type="button">거절</button>` : ""}</div>
                  ${r.rationale ? `<div class="memo-cell" style="margin-top:.4rem">${esc(r.rationale)}</div>` : ""}
                  <div class="muted" style="font-size:.8rem;margin-top:.3rem">${fmtDate((r.created_at || "").slice(0, 10))} 저장</div></div>`;
              })
              .join("")
          : `<div class="card empty">아직 추천 이력이 없습니다.</div>`
      }`
    : `<div class="card empty">추천을 받으려면 먼저 교재 진도 탭에서 교재를 배정하세요.</div>`;
  if (!items.length || !book) return;

  const refreshPrompt = () => {
    $("#rc-prompt").value = buildRecPrompt(buildRecSnapshot(s, book, rf));
  };
  refreshPrompt();
  $("#rc-book").onchange = (e) => { rf.textbookId = e.target.value; renderRecsTab(s); };
  $("#rc-date").onchange = (e) => { rf.targetDate = e.target.value; refreshPrompt(); };
  $("#rc-week").onchange = (e) => { rf.perWeek = Math.min(7, Math.max(1, Math.round(Number(e.target.value) || 2))); e.target.value = rf.perWeek; refreshPrompt(); };
  $("#rc-memo").onchange = (e) => { rf.withMemo = e.target.checked; refreshPrompt(); };
  $("#rc-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("#rc-prompt").value);
    } catch {
      $("#rc-prompt").select();
      document.execCommand("copy");
    }
    $("#rc-copied").textContent = "복사했습니다. Claude 채팅에 붙여넣으세요";
  };
  $("#rc-save").onclick = async () => {
    $("#rc-err").textContent = "";
    try {
      const parsed = parseRecReply($("#rc-reply").value, book);
      const snap = buildRecSnapshot(s, book, rf);
      snap.student = { alias: "S01" }; // 저장본에는 학년도 남기지 않음
      await run(db.from("recommendations").insert({ student_id: s.id, textbook_id: book.id, target_date: rf.targetDate || null, ...parsed, input_snapshot: snap, model: "Claude(수동 붙여넣기)", status: "제안" }));
      await refresh();
      toast("추천을 저장했습니다");
    } catch (err) {
      $("#rc-err").textContent = err.message || String(err);
    }
  };
  $("#tab-body").querySelectorAll("[data-rec-use]").forEach((b) => {
    b.onclick = () => lessonForm(s, null, recs.find((r) => r.id === b.dataset.recUse));
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
    { name: "next_plan", label: "다음 수업 예정 진도", maxlength: 200 },
  ];
  if (!lesson) fields.push({ name: "sync_progress", label: "저장할 때 교재 진도도 종료 단원으로 갱신 (결석은 제외)", type: "checkbox", default: true });

  openForm({
    title: lesson ? "수업 기록 수정" : "수업 기록",
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
  $("#nav-overview").onclick = () => {
    state.view = "overview";
    state.studentId = null;
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
    b.onclick = async () => {
      await db.auth.signOut();
    };
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

/* ---------- 시작 ---------- */
function showLogin() {
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
}

async function showApp() {
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
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
    if (event === "PASSWORD_RECOVERY") setTimeout(() => changePassword("새 비밀번호 설정"), 400);
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
