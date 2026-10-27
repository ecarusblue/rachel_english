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
  view: "overview",      // overview | makeup | evals | recs | kinds | student
  pendingRecs: 0,
  recFilter: { range: "thisWeek", start: "", end: "" },
  lessonFilter: { range: "thisWeek", start: "", end: "" },
  testFilter: { range: "thisWeek", start: "", end: "" },
  wrFilter: { range: "thisWeek", start: "", end: "" },   // 라이팅 첨삭 목록 기간
  allRecs: [],
  evals: { year: new Date().getFullYear(), month: new Date().getMonth() + 1, studentId: null, data: null, loading: false, failed: false, key: "" },
  studentId: null,
  progView: "card",      // card | week (교재 진도 탭 보기 방식)
  tab: "progress",       // progress | lessons | tests | report
  report: { range: "thisWeek", start: "", end: "", comment: "" },
  detail: { lessons: [], tests: [], logs: [], logsMissing: false, recs: [] },
  showInactive: false,
  schedule: { slots: [], missing: false, draft: null, fsel: null },
  kinds: { rows: [], missing: false, counts: {} },   // 선생님이 만든 시험 종류
  makeup: { rows: [], quotas: [], absences: [], missing: false, tab: "need", calMonth: null, calSel: null },   // 결석·보강
  makeupNeed: 0,
  recsUi: { mode: "student", sid: null },   // 수업 추천 화면: 학생별/날짜별
  wr: { sid: null, rows: [], missing: false, loading: false, openId: null },   // 라이팅 첨삭 (학생 화면의 라이팅 탭)
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

function openForm({ title, fields, values = {}, submitLabel = "저장", onSubmit, onDelete, wide = false, deleteLabel = "삭제", deleteConfirm = "정말 삭제할까요? 되돌릴 수 없습니다." }) {
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
  delBtn.textContent = deleteLabel;
  delBtn.onclick = async () => {
    if (!confirm(deleteConfirm)) return;
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

  // 첫 칸이 날짜면 열자마자 달력이 뜨므로, 날짜는 건너뛰고 첫 입력 대상에 포커스한다.
  // (터치 기기에서는 키보드가 올라오지 않도록 선택 목록만 대상으로 함)
  form.querySelectorAll("[autofocus]").forEach((el) => el.removeAttribute("autofocus"));
  const coarse = !!(window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const target = [...form.querySelectorAll("input, select, textarea")].find(
    (el) => el.type !== "date" && el.type !== "hidden" && el.type !== "radio" && (!coarse || el.tagName === "SELECT")
  );
  if (target) target.setAttribute("autofocus", "");
  else { const t = $("#dlg-title"); t.tabIndex = -1; t.setAttribute("autofocus", ""); }
  dlg.showModal();
  if (target) target.focus({ preventScroll: true });
  else $("#dlg-title").focus({ preventScroll: true });
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
  await loadKinds();
  await loadMakeups();
  try {
    const pend = await run(db.from("recommendations").select("id, student_id, target_date, created_at").eq("status", "제안").limit(500));
    const wk = periodRange("thisWeek");
    const act = new Set(students.filter((s) => s.active).map((s) => s.id));
    state.pendingRecs = pend.filter((r) => act.has(r.student_id) && recDate(r) >= wk.start && recDate(r) <= wk.end).length;
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
  // 저장은 이미 끝난 뒤에 부르는 함수라, 화면을 다시 그리다 실패해도 저장 창이 열린 채 남지 않게 안내만 합니다.
  try { await refreshInner(); }
  catch (e) { console.error(e); toast(`저장은 됐지만 화면을 새로 불러오지 못했어요 (${(e && e.message) || e}). 새로고침해 주세요.`); }
}
async function refreshInner() {
  await loadCore();
  if (state.view === "recs") { try { await loadAllRecs(); } catch { /* 이전 목록 유지 */ } }
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

/* ---------- 결석·보강 ---------- */
const MK_WINDOW_DAYS = 45; // 이 기간 안의 결석만 '보강 필요'로 올립니다
const MK_DEFAULT_QUOTA = 1; // 월 기본 보강 횟수의 앱 기본값

async function loadMakeups() {
  const mk = state.makeup;
  try {
    const [rows, quotas, absences] = await Promise.all([
      run(db.from("makeups").select("*").order("created_at", { ascending: false }).limit(2000)),
      run(db.from("makeup_quota").select("*").limit(1000)),
      run(db.from("lessons").select("*").eq("attendance", "결석").gte("lesson_date", daysAgoStr(MK_WINDOW_DAYS)).order("lesson_date").limit(1000)),
    ]);
    Object.assign(mk, { rows, quotas, absences, missing: false });
  } catch {
    Object.assign(mk, { rows: [], quotas: [], absences: [], missing: true }); // schema.sql 업그레이드 전
  }
  state.makeupNeed = mk.missing ? 0 : pendingAbsences().length;
}

const monthOfDate = (ds) => (ds || "").slice(0, 7);
function makeupMonth(r) { return monthOfDate((r.status === "완료" ? r.done_date : null) || r.planned_date || r.done_date); }

// 월 기본 횟수: 학생+달 > 학생 기본 > 전체 기본 > 1회
function makeupQuota(sid, month) {
  const q = state.makeup.quotas;
  const find = (st, mo) => q.find((x) => (x.student_id || null) === st && (x.month || null) === mo);
  const r = (sid && month && find(sid, month)) || (sid && find(sid, null)) || find(null, null);
  return r ? r.count : MK_DEFAULT_QUOTA;
}
function makeupUsed(sid, month, exceptId) {
  return state.makeup.rows.filter((r) => r.student_id === sid && r.status !== "제외" && r.kind === "기본" && r.id !== exceptId && makeupMonth(r) === month).length;
}
function pendingAbsences() {
  const mk = state.makeup;
  const has = new Set(mk.rows.filter((r) => r.absent_lesson_id).map((r) => r.absent_lesson_id));
  const active = new Set(state.students.filter((s) => s.active).map((s) => s.id));
  const since = daysAgoStr(MK_WINDOW_DAYS);
  return mk.absences.filter((a) => a.lesson_date >= since && !has.has(a.id) && active.has(a.student_id));
}

const mkMin = (t) => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ""); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const mkHHMM = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
const studentName = (id) => (state.students.find((s) => s.id === id) || {}).name || "(삭제된 학생)";

function mkUsageHtml(sid, month) {
  const q = makeupQuota(sid, month);
  const u = makeupUsed(sid, month);
  const dots = Array.from({ length: Math.min(q, 5) }, (_, i) => `<i class="mk-dot ${i < u ? "on" : ""}"></i>`).join("");
  const left = u < q;
  return `<div class="mk-usage">${dots ? `<span class="mk-dots" aria-hidden="true">${dots}</span>` : ""}<span>기본 ${u}/${q}${q === 0 ? "회" : ""}</span></div>
    <div class="mk-sub">${left ? `<span class="muted">기본 보강이 남아 있어요</span>` : `<span class="mk-chip extra">추가 보강으로 기록돼요</span>`}</div>`;
}

function renderMakeup() {
  const main = $("#main");
  const mk = state.makeup;
  const month = todayStr().slice(0, 7);
  const gq = makeupQuota(null, null);
  const head = `<div class="page-head"><h2>결석·보강</h2><span class="muted">결석한 수업을 잊지 않고 보강으로 채워요</span><span class="spacer"></span>
    <button class="btn small" id="mk-add" type="button">+ 보강 직접 추가</button>
    <button class="btn small" id="mk-set" type="button">월 기본 보강 <b>${gq}회</b> · 횟수 설정</button></div>`;
  if (mk.missing) {
    main.innerHTML = head.replace(/<button[\s\S]*<\/button>/, "") + `<div class="card"><strong>결석·보강 저장 테이블이 아직 없습니다.</strong>
      <p class="muted">Supabase SQL Editor에서 최신 <code>schema.sql</code>의 "결석·보강" 부분을 실행한 뒤 이 화면을 새로고침하세요.</p></div>`;
    return;
  }
  const need = pendingAbsences();
  const needStudents = new Set(need.map((a) => a.student_id));
  const old = need.filter((a) => daysBetween(a.lesson_date) >= 7).length;
  const planned = mk.rows.filter((r) => r.status === "예정").sort((a, b) => (a.planned_date || "").localeCompare(b.planned_date || "") || (a.planned_start || "").localeCompare(b.planned_start || ""));
  const wk = periodRange("thisWeek");
  const weekPlan = planned.filter((r) => r.planned_date && r.planned_date >= wk.start && r.planned_date <= wk.end);
  const nextP = weekPlan[0];
  const monthRows = mk.rows.filter((r) => r.status !== "제외" && makeupMonth(r) === month);
  const base = monthRows.filter((r) => r.kind === "기본").length;
  const extra = monthRows.length - base;
  const finished = mk.rows.filter((r) => r.status !== "planned" && (r.status === "완료" || r.status === "제외")).sort((a, b) => (b.done_date || b.created_at || "").localeCompare(a.done_date || a.created_at || "")).slice(0, 60);

  const tab = mk.tab || "need";
  const cards = `<div class="mk-sum">
    <div class="mk-card warm"><span class="muted">보강 필요</span><div><b>${needStudents.size}명</b>${old ? `<small class="mk-warn">${old}건은 7일이 지났어요</small>` : ""}</div></div>
    <div class="mk-card"><span class="muted">이번 주 보강 예정</span><div><b>${weekPlan.length}건</b>${nextP ? `<small class="muted">${shortDate(nextP.planned_date)}${nextP.planned_start ? " " + hhmm(nextP.planned_start) : ""}</small>` : ""}</div></div>
    <div class="mk-card plain"><span class="muted">${Number(month.slice(5))}월 보강 (완료+예정)</span><div><b>${monthRows.length}건</b><small class="muted">기본 ${base} · 추가 ${extra}</small></div></div>
  </div>`;
  const tabs = `<div class="tabs mk-tabs" role="tablist">${[["need", "보강 필요", need.length], ["plan", "보강 예정", planned.length], ["done", "완료·제외", finished.length]]
    .map(([k, t, n]) => `<button class="tab ${tab === k ? "active" : ""}" role="tab" data-mktab="${k}">${t} <span class="mk-n">${n}</span></button>`).join("")}</div>`;

  const nameCell = (sid) => { const s = state.students.find((x) => x.id === sid); return `<strong>${esc(studentName(sid))}</strong> <span class="muted">${esc((s && s.grade) || "")}</span>`; };
  const absInfo = (a) => {
    if (!a) return `<span class="muted">직접 추가한 보강</span>`;
    return `${shortDate(a.lesson_date)}`;
  };
  let list = "";
  if (tab === "need") {
    list = need.length
      ? `<div class="mk-hd"><span>학생</span><span>결석한 수업</span><span>그날 진도 · 메모</span><span>${Number(month.slice(5))}월 보강 (기본 월 ${gq}회)</span><span class="r">처리</span></div>` +
        need.map((a) => {
          const age = daysBetween(a.lesson_date);
          const cover = coverText(a) || topicText(a);
          const used = makeupUsed(a.student_id, month), q = makeupQuota(a.student_id, month);
          return `<div class="mk-row">
            <div class="mk-c0">${nameCell(a.student_id)}</div>
            <div class="mk-c1">${shortDate(a.lesson_date)}<div>${age >= 7 ? `<span class="mk-chip warn">${age}일째</span>` : `<span class="muted">${age}일째</span>`}</div></div>
            <div class="mk-c2">${cover ? esc(cover) : `<span class="muted">진도 기록 없음</span>`}${a.memo ? `<div class="muted">${esc(a.memo)}</div>` : ""}</div>
            <div class="mk-c3">${mkUsageHtml(a.student_id, month)}</div>
            <div class="mk-c4"><button class="btn small mk-quiet" type="button" data-mk="skip" data-id="${esc(a.id)}">보강 안 함</button>
              <button class="btn small ${used < q ? "primary" : "mk-outline"}" type="button" data-mk="plan" data-id="${esc(a.id)}">${used < q ? "보강 잡기" : "추가 보강 잡기"}</button></div>
          </div>`;
        }).join("")
      : `<div class="empty">보강이 필요한 결석이 없어요.<div class="muted" style="margin-top:.3rem">수업 기록에서 출결을 "결석"으로 저장하면 여기에 올라와요.</div></div>`;
  } else if (tab === "plan") {
    list = planned.length
      ? `<div class="mk-hd"><span>학생</span><span>보강 일정</span><span>결석한 수업</span><span>구분</span><span class="r">처리</span></div>` +
        planned.map((r) => {
          const a = mk.absences.find((x) => x.id === r.absent_lesson_id);
          const t = r.planned_start ? `${hhmm(r.planned_start)}${r.planned_end ? "–" + hhmm(r.planned_end) : ""}` : "";
          return `<div class="mk-row">
            <div class="mk-c0">${nameCell(r.student_id)}</div>
            <div class="mk-c1">${r.planned_date ? shortDate(r.planned_date) : "-"} <span class="muted">${t}</span></div>
            <div class="mk-c2">${absInfo(a)}${a && (coverText(a) || topicText(a)) ? `<div class="muted">${esc(coverText(a) || topicText(a))}</div>` : ""}${r.memo ? `<div class="muted">${esc(r.memo)}</div>` : ""}</div>
            <div class="mk-c3"><span class="mk-chip ${r.kind === "추가" ? "extra" : ""}">${r.kind} 보강</span></div>
            <div class="mk-c4"><button class="btn small mk-quiet" type="button" data-mk="cancel" data-id="${esc(r.id)}">취소</button>
              <button class="btn small" type="button" data-mk="edit" data-id="${esc(r.id)}">일정 변경</button>
              <button class="btn small primary" type="button" data-mk="rec" data-id="${esc(r.id)}">보강 수업 기록</button></div>
          </div>`;
        }).join("")
      : `<div class="empty">잡아 둔 보강이 없어요.</div>`;
  } else {
    list = finished.length
      ? `<div class="mk-hd"><span>학생</span><span>날짜</span><span>결석한 수업</span><span>구분</span><span class="r">처리</span></div>` +
        finished.map((r) => {
          const a = mk.absences.find((x) => x.id === r.absent_lesson_id);
          return `<div class="mk-row">
            <div class="mk-c0">${nameCell(r.student_id)}</div>
            <div class="mk-c1">${r.status === "완료" ? shortDate(r.done_date || r.planned_date) : `<span class="muted">${a ? shortDate(a.lesson_date) : ""}</span>`}</div>
            <div class="mk-c2">${absInfo(a)}${r.memo ? `<div class="muted">${esc(r.memo)}</div>` : ""}</div>
            <div class="mk-c3">${r.status === "완료" ? `<span class="badge done">보강 완료</span> <span class="mk-chip ${r.kind === "추가" ? "extra" : ""}">${r.kind}</span>` : `<span class="badge">보강 안 함</span>`}</div>
            <div class="mk-c4">${r.status === "제외" ? `<button class="btn small" type="button" data-mk="undo" data-id="${esc(r.id)}">되돌리기</button>` : ""}</div>
          </div>`;
        }).join("")
      : `<div class="empty">완료하거나 제외한 보강이 아직 없어요.</div>`;
  }

  main.innerHTML = head + cards + tabs + `<div class="card mk-list">${list}</div>
    ${makeupCalHtml()}
    <div class="mk-note"><b>기본 횟수를 넘겨도 막지 않아요.</b> 월 기본 횟수를 다 쓴 뒤의 보강은 "추가 보강"으로 표시만 해서 언제든 잡을 수 있어요. 기본 횟수는 학생마다 따로 정하고, 특정 달만 바꿀 수도 있어요.
      <br>결석은 수업 기록에서 출결을 "결석"으로 저장하면 이 목록에 올라오고, 보강 수업을 기록하면 자동으로 완료돼요. 결석한 지 ${MK_WINDOW_DAYS}일이 지난 건은 목록에 올리지 않아요.</div>`;

  $("#mk-add").onclick = () => makeupForm({ student: null, absence: null, row: null });
  main.querySelectorAll("[data-mcnav]").forEach((b) => (b.onclick = () => {
    const n = Number(b.dataset.mcnav);
    const [y, m] = (mk.calMonth || todayStr().slice(0, 7)).split("-").map(Number);
    const d = n === 0 ? new Date() : new Date(y, m - 1 + n, 1);
    mk.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    mk.calSel = null;
    renderMakeup();
  }));
  main.querySelectorAll("[data-mcday]").forEach((b) => (b.onclick = () => { mk.calSel = mk.calSel === b.dataset.mcday ? null : b.dataset.mcday; renderMakeup(); const p = $(".mc-panel"); if (p) p.scrollIntoView({ block: "nearest" }); }));
  main.querySelectorAll("[data-mcadd]").forEach((b) => (b.onclick = () => makeupForm({ student: null, absence: null, row: null, date: b.dataset.mcadd })));
  $("#mk-set").onclick = makeupSettings;
  main.querySelectorAll("[data-mktab]").forEach((b) => (b.onclick = () => { mk.tab = b.dataset.mktab; renderMakeup(); }));
  main.querySelectorAll("[data-mk]").forEach((b) => (b.onclick = () => makeupAction(b.dataset.mk, b.dataset.id)));
}


/* 보강 달력: 등록된 보강(예정·완료)만 보여줍니다 */
function makeupCalDate(r) { return r.status === "완료" ? r.done_date || r.planned_date : r.planned_date; }
function makeupCalHtml() {
  const mk = state.makeup;
  const today = todayStr();
  if (!mk.calMonth) mk.calMonth = today.slice(0, 7);
  const [Y, M] = mk.calMonth.split("-").map(Number);
  const items = mk.rows.filter((r) => r.status !== "제외" && makeupCalDate(r) && makeupCalDate(r).slice(0, 7) === mk.calMonth)
    .sort((a, b) => (a.planned_start || "99").localeCompare(b.planned_start || "99"));
  const by = new Map();
  items.forEach((r) => { const d = makeupCalDate(r); if (!by.has(d)) by.set(d, []); by.get(d).push(r); });
  const first = new Date(Y, M - 1, 1), days = new Date(Y, M, 0).getDate();
  const off = (first.getDay() + 6) % 7; // 월요일 시작
  const total = Math.ceil((off + days) / 7) * 7;
  const kindCls = (r) => (r.status === "완료" ? "done" : r.kind === "추가" ? "extra" : "plan");
  let cells = "";
  for (let i = 0; i < total; i++) {
    const d = i - off + 1;
    const wk = i % 7;
    if (d < 1 || d > days) { cells += `<div class="mc-cell empty" aria-hidden="true"></div>`; continue; }
    const ds = `${mk.calMonth}-${String(d).padStart(2, "0")}`;
    const list = by.get(ds) || [];
    const pills = list.map((r) => `<span class="mc-ev ${kindCls(r)}"><span class="mc-t">${r.status === "완료" ? "✓ " : ""}${r.planned_start ? hhmm(r.planned_start) + " " : ""}</span><b>${esc(studentName(r.student_id))}</b></span>`).join("");
    const dots = list.map((r) => `<i class="mc-dot ${kindCls(r)}"></i>`).join("");
    cells += `<button type="button" class="mc-cell ${wk >= 5 ? "we" : ""} ${ds === today ? "today" : ""} ${mk.calSel === ds ? "sel" : ""}" data-mcday="${ds}" aria-label="${M}월 ${d}일${list.length ? ` 보강 ${list.length}건` : ""}" aria-pressed="${mk.calSel === ds}">
      <span class="mc-d">${d}</span><span class="mc-evs">${pills}</span><span class="mc-dots">${dots}</span></button>`;
  }
  const planned = items.filter((r) => r.status === "예정");
  const doneN = items.length - planned.length;
  const extraN = items.filter((r) => r.kind === "추가").length;
  const sel = mk.calSel && mk.calSel.slice(0, 7) === mk.calMonth ? mk.calSel : null;
  let panel = "";
  if (sel) {
    const L = by.get(sel) || [];
    panel = `<div class="mc-panel"><div class="mc-ph"><b>${shortDate(sel)} 보강 ${L.length}건</b><span class="spacer"></span><button class="btn small primary" type="button" data-mcadd="${sel}">+ 이 날 보강 추가</button></div>
      ${L.length ? L.map((r) => {
        const a = mk.absences.find((x) => x.id === r.absent_lesson_id);
        const t = r.planned_start ? `${hhmm(r.planned_start)}${r.planned_end ? "–" + hhmm(r.planned_end) : ""}` : "시간 미정";
        return `<div class="mc-pr"><b class="mc-pt">${t}</b><span class="mc-pn"><b>${esc(studentName(r.student_id))}</b><span class="muted">${a ? ` · 결석 ${shortDate(a.lesson_date)} 분` : " · 직접 추가"}${r.memo ? " · " + esc(r.memo) : ""}</span></span>
          <span class="mk-chip ${r.kind === "추가" ? "extra" : ""}">${r.kind}</span>${r.status === "완료" ? `<span class="badge done">완료</span>` : `<button class="btn small" type="button" data-mk="edit" data-id="${esc(r.id)}">일정 변경</button><button class="btn small primary" type="button" data-mk="rec" data-id="${esc(r.id)}">수업 기록</button>`}</div>`;
      }).join("") : `<div class="muted" style="padding:.5rem 0">이 날은 등록된 보강이 없어요.</div>`}</div>`;
  }
  return `<section class="mc" aria-label="보강 달력"><div class="mc-head"><h3>보강 달력</h3>
      <button class="btn small" type="button" data-mcnav="-1" aria-label="이전 달">◀</button><b class="mc-title">${Y}년 ${M}월</b><button class="btn small" type="button" data-mcnav="1" aria-label="다음 달">▶</button>
      <button class="btn small" type="button" data-mcnav="0">오늘</button><span class="spacer"></span>
      <span class="mc-leg"><i class="mc-dot plan"></i>예정(기본)<i class="mc-dot extra"></i>예정(추가)<i class="mc-dot done"></i>완료</span></div>
    <div class="mc-grid" role="group">${"월화수목금토일".split("").map((n, i) => `<div class="mc-dow ${i >= 5 ? "we" : ""}">${n}</div>`).join("")}${cells}</div>
    <div class="muted mc-sum">${M}월 보강 ${items.length}건 · 예정 ${planned.length} · 완료 ${doneN}${extraN ? ` · 추가 ${extraN}` : ""} — 날짜를 누르면 그날 보강이 열려요.</div>${panel}</section>`;
}

async function makeupAction(act, id) {
  const mk = state.makeup;
  const reload = async (msg) => { await loadMakeups(); renderSidebar(); renderMakeup(); if (msg) toast(msg); };
  try {
    if (act === "plan") {
      const a = mk.absences.find((x) => x.id === id);
      if (a) makeupForm({ student: state.students.find((s) => s.id === a.student_id), absence: a, row: null });
    } else if (act === "skip") {
      const a = mk.absences.find((x) => x.id === id);
      if (!a || !confirm("보강 없이 처리할까요? '완료·제외' 탭에서 되돌릴 수 있어요.")) return;
      await run(db.from("makeups").insert({ student_id: a.student_id, absent_lesson_id: a.id, status: "제외", kind: "기본" }));
      await reload("보강 안 함으로 처리했어요");
    } else if (act === "edit") {
      const r = mk.rows.find((x) => x.id === id);
      if (r) makeupForm({ student: state.students.find((s) => s.id === r.student_id), absence: mk.absences.find((x) => x.id === r.absent_lesson_id) || null, row: r });
    } else if (act === "cancel") {
      const r = mk.rows.find((x) => x.id === id);
      if (!r || !confirm(r.absent_lesson_id ? "보강 일정을 취소할까요? 결석은 '보강 필요'로 돌아가요." : "보강 일정을 삭제할까요?")) return;
      await run(db.from("makeups").delete().eq("id", id));
      await reload("취소했어요");
    } else if (act === "undo") {
      await run(db.from("makeups").delete().eq("id", id));
      await reload("'보강 필요'로 되돌렸어요");
    } else if (act === "rec") {
      const r = mk.rows.find((x) => x.id === id);
      const s = r && state.students.find((x) => x.id === r.student_id);
      if (!s) return;
      const a = mk.absences.find((x) => x.id === r.absent_lesson_id);
      await loadDetail(s.id);
      const blocks = a ? lessonBooks(a).map((b) => ({ textbook_id: b.textbook_id, from_unit: b.from_unit ?? null, to_unit: b.to_unit ?? null, topic: b.topic || "" })) : null;
      lessonForm(s, null, null, { date: r.planned_date || todayStr(), attendance: "보강", blocks: blocks && blocks.length ? blocks : null, makeupId: r.id });
    }
  } catch (e) {
    fail(e);
  }
}

// 보강 수업을 기록하면 '보강 예정'을 완료로 바꿉니다 (preset.makeupId 가 있으면 그 건, 없으면 그 학생의 가장 이른 예정 건)
async function completeMakeupFor(studentId, lessonId, date, makeupId) {
  const mk = state.makeup;
  if (mk.missing) return;
  const r = (makeupId && mk.rows.find((x) => x.id === makeupId)) ||
    mk.rows.filter((x) => x.student_id === studentId && x.status === "예정").sort((a, b) => (a.planned_date || "").localeCompare(b.planned_date || ""))[0];
  if (!r) return;
  try {
    await run(db.from("makeups").update({ status: "완료", done_date: date, lesson_id: lessonId }).eq("id", r.id));
  } catch { /* 기록은 이미 저장됨 */ }
}

function makeupForm({ student, absence, row, date = null }) {
  const mk = state.makeup;
  const active = state.students.filter((s) => s.active);
  const tomorrow = addDays(todayStr(), 1);
  const fields = [];
  if (!student) fields.push({ name: "student_id", label: "학생", type: "select", required: true, options: active.map((s) => [s.id, `${s.name}${s.grade ? " (" + s.grade + ")" : ""}`]) });
  fields.push(
    { name: "mkinfo", type: "slot" },
    { name: "mkkind", type: "slot" },
    { name: "planned_date", label: "보강 날짜", type: "date", required: true },
    { name: "planned_start", label: "시작", type: "time", half: true },
    { name: "planned_end", label: "끝", type: "time", half: true },
    { name: "mkwarn", type: "slot" },
    { name: "mkfree", type: "slot" },
    { name: "memo", label: "메모 (선택)", maxlength: 300 }
  );
  const values = row
    ? { planned_date: row.planned_date, planned_start: hhmm(row.planned_start), planned_end: hhmm(row.planned_end), memo: row.memo }
    : { planned_date: date || tomorrow, planned_start: "", planned_end: "", memo: "" };
  let touched = !!row; // 구분을 직접 바꿨다면 날짜가 바뀌어도 유지
  openForm({
    title: row ? "보강 일정 변경" : absence ? "보강 잡기" : "보강 직접 추가",
    fields,
    values,
    submitLabel: "보강 저장",
    onSubmit: async (d) => {
      const f = $("#dlg-form");
      const sid = student ? student.id : d.student_id;
      if (!sid) throw new Error("학생을 선택하세요.");
      const s0 = mkMin(d.planned_start), e0 = mkMin(d.planned_end);
      if (e0 != null && s0 == null) throw new Error("끝 시간만 있어요. 시작 시간도 넣어 주세요.");
      if (s0 != null && e0 != null && e0 <= s0) throw new Error("끝 시간은 시작 시간보다 뒤여야 해요.");
      const kind = (f.querySelector('input[name="mk_kind"]:checked') || {}).value || "기본";
      const payload = {
        planned_date: d.planned_date, planned_start: d.planned_start || null,
        planned_end: s0 != null ? (d.planned_end || mkHHMM(s0 + 60)) : null, kind, memo: d.memo,
      };
      if (row) await run(db.from("makeups").update(payload).eq("id", row.id));
      else await run(db.from("makeups").insert({ ...payload, student_id: sid, absent_lesson_id: absence ? absence.id : null, status: "예정" }));
      await loadMakeups();
      renderSidebar();
      if (state.view === "makeup") renderMakeup();
      toast(row ? "보강 일정을 바꿨어요" : "보강을 잡았어요");
    },
  });
  const form = $("#dlg-form");
  const sidNow = () => (student ? student.id : (form.elements.student_id || {}).value);
  // 결석한 수업 요약
  const infoEl = $("#mkinfo");
  const updInfo = () => {
    const s = state.students.find((x) => x.id === sidNow());
    if (absence) {
      const cv = coverText(absence) || topicText(absence);
      infoEl.innerHTML = `<div class="mk-info"><b>${esc(studentName(absence.student_id))}</b> · ${shortDate(absence.lesson_date)} 수업 결석<br><span class="muted">그날 진도</span> ${cv ? `<b>${esc(cv)}</b> <span class="muted">— 보강 기록에 자동으로 들어가요</span>` : `<span class="muted">기록 없음</span>`}</div>`;
    } else infoEl.innerHTML = `<div class="mk-info muted">${s ? esc(s.name) : "학생"}의 보강을 결석과 상관없이 직접 추가해요. 추가로 하는 보강도 여기서 잡아요.</div>`;
  };
  const dateEl = form.elements.planned_date, sEl = form.elements.planned_start, eEl = form.elements.planned_end;
  const kindEl = $("#mkkind"), warnEl = $("#mkwarn"), freeEl = $("#mkfree");
  const render = () => {
    const sid = sidNow();
    const month = monthOfDate(dateEl.value) || todayStr().slice(0, 7);
    const q = makeupQuota(sid, month), u = makeupUsed(sid, month, row && row.id);
    const cur = (form.querySelector('input[name="mk_kind"]:checked') || {}).value || (row ? row.kind : u < q ? "기본" : "추가");
    const def = !touched ? (u < q ? "기본" : "추가") : cur;
    kindEl.innerHTML = `<div class="mk-kind"><span class="muted">보강 구분</span><div class="mk-seg" role="radiogroup" aria-label="보강 구분">
      ${["기본", "추가"].map((k) => `<label><input type="radio" name="mk_kind" value="${k}" ${def === k ? "checked" : ""}><span>${k} 보강</span></label>`).join("")}</div>
      <div class="muted mk-kind-note">${Number(month.slice(5))}월 기본 보강 ${q}회 중 <b>${u}회</b> 사용 · ${u < q ? "기본으로 기록하는 게 기본이에요." : "기본을 다 썼다면 추가 보강으로 기록돼요."} 횟수를 넘겨도 저장할 수 있어요.</div></div>`;
    kindEl.querySelectorAll("input").forEach((i) => (i.onchange = () => { touched = true; }));
    // 시간 겹침과 비어 있는 시간
    const ds = dateEl.value;
    if (!ds) { warnEl.innerHTML = ""; freeEl.innerHTML = ""; return; }
    const wd = parseD(ds).getDay();
    const busy = [];
    state.schedule.slots.filter((x) => x.weekday === wd).forEach((x) => {
      const a = mkMin(hhmm(x.start_time)), b = mkMin(hhmm(x.end_time));
      if (a == null || b == null) return;
      const names = state.students.filter((st) => (x.student_ids || []).includes(st.id)).map((st) => st.name);
      busy.push({ a, b, who: names.join("·") || x.label || "수업" });
    });
    mk.rows.filter((x) => x.status === "예정" && x.planned_date === ds && x.planned_start && (!row || x.id !== row.id)).forEach((x) => {
      const a = mkMin(hhmm(x.planned_start)); const b = x.planned_end ? mkMin(hhmm(x.planned_end)) : a + 60;
      busy.push({ a, b, who: `${studentName(x.student_id)} 보강` });
    });
    const s0 = mkMin(sEl.value); let e0 = mkMin(eEl.value);
    const dur = s0 != null ? (e0 != null && e0 > s0 ? e0 - s0 : 60) : 60;
    if (s0 != null && (e0 == null || e0 <= s0)) e0 = s0 + 60;
    const hit = s0 == null ? [] : busy.filter((x) => s0 < x.b && x.a < e0);
    warnEl.innerHTML = hit.length ? `<div class="mk-warnbox"><b>${shortDate(ds)} ${mkHHMM(s0)}에는 ${esc([...new Set(hit.map((x) => x.who))].join(", "))} 일정이 있어요.</b><br>아래 비어 있는 시간을 눌러 바꿀 수 있어요. 그대로 저장해도 돼요.</div>` : "";
    const free = [];
    for (let t = 13 * 60; t + dur <= 21 * 60 + 30 && free.length < 8; t += 30) if (!busy.some((x) => t < x.b && x.a < t + dur)) free.push(t);
    freeEl.innerHTML = `<div class="mk-free"><span class="muted">${shortDate(ds)}에 비어 있는 시간 (${dur}분 기준)</span><div class="mk-free-chips">${free.length ? free.map((t) => `<button type="button" class="mk-fc ${s0 === t ? "on" : ""}" data-t="${t}">${mkHHMM(t)}</button>`).join("") : `<span class="muted">비어 있는 시간이 없어요</span>`}</div></div>`;
    freeEl.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => {
      const t = Number(b.dataset.t); sEl.value = mkHHMM(t); eEl.value = mkHHMM(t + dur); render();
    }));
  };
  updInfo();
  [dateEl, sEl, eEl].forEach((el) => el.addEventListener("change", render));
  if (form.elements.student_id) form.elements.student_id.addEventListener("change", () => { updInfo(); render(); });
  render();
}

function makeupSettings() {
  const mk = state.makeup;
  const month = todayStr().slice(0, 7);
  const active = state.students.filter((s) => s.active);
  const stuRow = (sid, mo) => mk.quotas.find((x) => x.student_id === sid && (x.month || null) === mo);
  const gRow = mk.quotas.find((x) => !x.student_id && !x.month);
  openForm({
    title: "월 보강 횟수 설정",
    fields: [
      { name: "info", type: "slot" },
      { name: "g", label: "전체 기본 (매달 몇 회)", type: "number", min: 0, max: 20, required: true },
      ...active.map((s) => ({ name: `q_${s.id}`, label: `${s.name}${s.grade ? " (" + s.grade + ")" : ""} · 이 학생만 다르게 (비우면 전체 기본)`, type: "number", min: 0, max: 20 })),
      { name: "thisMonth", label: `학생별 횟수는 ${Number(month.slice(5))}월에만 적용 (다음 달은 원래 횟수로 돌아와요)`, type: "checkbox" },
    ],
    values: Object.fromEntries([["g", gRow ? gRow.count : MK_DEFAULT_QUOTA], ...active.map((s) => [`q_${s.id}`, (stuRow(s.id, null) || {}).count ?? null])]),
    onSubmit: async (d) => {
      const save = async (sid, mo, count) => {
        const ex = mk.quotas.find((x) => (x.student_id || null) === sid && (x.month || null) === mo);
        if (count == null) { if (ex) await run(db.from("makeup_quota").delete().eq("id", ex.id)); return; }
        if (ex) await run(db.from("makeup_quota").update({ count }).eq("id", ex.id));
        else await run(db.from("makeup_quota").insert({ student_id: sid, month: mo, count }));
      };
      if (d.g == null || d.g < 0) throw new Error("전체 기본 횟수를 입력하세요.");
      await save(null, null, d.g);
      for (const s of active) await save(s.id, d.thisMonth ? month : null, d[`q_${s.id}`]);
      await loadMakeups();
      renderMakeup();
      toast("저장했습니다");
    },
  });
  $("#info").innerHTML = `<p class="muted" style="margin:0 0 .6rem;font-size:.88rem">횟수를 넘겨도 보강은 잡을 수 있어요. 넘긴 보강은 "추가 보강"으로 표시돼요.</p>`;
}

/* ---------- 렌더링 ---------- */
function render() {
  if (state.view !== "overview") state.schedule.draft = null; // 편집 중 다른 화면으로 가면 편집 종료
  renderSidebar();
  if (state.view === "student") renderStudent();
  else if (state.view === "evals") renderEvals();
  else if (state.view === "recs") renderAllRecs();
  else if (state.view === "kinds") renderKinds();
  else if (state.view === "backup") renderBackup();
  else if (state.view === "makeup") renderMakeup();
  else renderOverview();
}

function renderSidebar() {
  $("#nav-overview").classList.toggle("active", state.view === "overview");
  $("#nav-makeup").classList.toggle("active", state.view === "makeup");
  $("#nav-makeup-n").hidden = !state.makeupNeed; // 숫자 대신 점으로만 표시
  $("#nav-evals").classList.toggle("active", state.view === "evals");
  $("#nav-recs").classList.toggle("active", state.view === "recs");
  $("#btn-kinds").classList.toggle("active", state.view === "kinds");
  const bkb = $("#btn-backup"); if (bkb) bkb.classList.toggle("active", state.view === "backup");
  const list = state.students.filter((s) => s.active || state.showInactive);
  const nAct = state.students.filter((s) => s.active).length;
  const cnt = $("#student-count");
  if (cnt) { cnt.textContent = `${list.length}명`; cnt.title = state.showInactive ? `재원 ${nAct}명 · 퇴원/휴원 ${state.students.length - nAct}명` : "재원생"; }
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
/* 0.5 단위 단원 번호: x.5 는 단원의 절반입니다.
   종료(to)·현재 진도 = "끝낸 단원 수" → 8.5 는 "9단원 중간까지", 시작(from) = "시작 단원 번호" → 9.5 는 "9단원 중간부터".
   분량 = to - from + 1 (from 8 ~ to 8.5 = 1.5단원, from 8 ~ to 7.5 = 8단원 앞 절반) */
const isHalfN = (v) => v != null && Math.round(v * 2) % 2 === 1;
const snapHalf = (v) => Math.round(v * 2) / 2;
const fmtN = (n) => String(Number(n));
const amountN = (from, to) => (from != null && to != null ? to - from + 1 : null);
function unitNameH(book, v, role) {
  if (v == null || !Number.isFinite(Number(v))) return "";
  v = Number(v);
  if (role === "from") return isHalfN(v) ? `${unitName(book, Math.floor(v))} 중간부터` : `${unitName(book, v)} 처음부터`;
  if (v <= 0) return "시작 전";
  return isHalfN(v) ? `${unitName(book, Math.ceil(v))} 중간까지` : `${unitName(book, v)} 끝까지`;
}
function curNum(book, n) {
  if (isHalfN(n)) return `${unitName(book, Math.ceil(n))} 중간까지 (${fmtN(n)}/${book.total_units})`;
  if (!bookLeaves(book)) return `${n}/${book.total_units}`;
  return n > 0 ? `${unitName(book, n)} (${n}/${book.total_units})` : `시작 전 (0/${book.total_units})`;
}
function curLabel(book, n) {
  if (isHalfN(n)) return curNum(book, n);
  return bookLeaves(book) ? curNum(book, n) : `${book.unit_label} ${n}/${book.total_units}`;
}
// 카드 큰 글씨용: 현재 진도 한 줄
function curShort(book, n) {
  if (isHalfN(n)) return `${unitName(book, Math.ceil(n))} 중간까지`;
  if (bookLeaves(book)) return n > 0 ? unitName(book, n) : "시작 전";
  return `${book.unit_label} ${n}`;
}
function rangeText(book, l) {
  const a = l.from_unit, b = l.to_unit;
  const lv = bookLeaves(book);
  if (a != null && b != null && (isHalfN(a) || isHalfN(b))) {
    // 반 단원이 끼어 있을 때
    if (!isHalfN(a) && isHalfN(b) && b === a - 0.5) return ` ${unitName(book, a)} 앞 절반`;
    if (isHalfN(a) && !isHalfN(b) && b === a - 0.5) return ` ${unitName(book, b)} 뒤 절반`;
    const left = isHalfN(a) ? `${unitName(book, Math.floor(a))} 중간` : unitName(book, a);
    const right = isHalfN(b) ? `${unitName(book, Math.ceil(b))} 중간` : unitName(book, b);
    return ` ${left} ~ ${right}`;
  }
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

/* 단원 번호 입력 칸(−0.5 / +0.5 버튼 + 직접 입력). 아래 이벤트는 문서 전체에서 한 번만 연결합니다.
   입력 칸에는 data-half 가 붙고, 바깥 .us 에 data-book(교재 id)·data-role(from/to)이 있어 칸 밑에 단원 이름을 풀어 줍니다. */
function unitStep(book, role, value, attrs = "", minOverride = null) {
  const lo = minOverride != null ? minOverride : role === "from" ? 1 : 0.5;
  return `<div class="us" data-book="${esc(book.id)}" data-role="${role}">
    <span class="dr-st us-st"><button type="button" data-ust="-0.5" aria-label="0.5 줄이기">−0.5</button><input type="number" data-half min="${lo}" max="${book.total_units}" step="0.5" inputmode="decimal" ${attrs} value="${value == null ? "" : esc(fmtN(value))}"><button type="button" data-ust="0.5" aria-label="0.5 늘리기">+0.5</button></span>
    <div class="us-nm">${esc(unitNameH(book, value, role))}</div></div>`;
}
function usRefresh(inp) {
  const box = inp.closest(".us");
  if (!box) return;
  const book = state.textbooks.find((b) => b.id === box.dataset.book);
  const nm = box.querySelector(".us-nm");
  const st = box.querySelector(".us-st");
  const v = inp.value === "" ? null : Number(inp.value);
  const bad = v != null && (!Number.isFinite(v) || v * 2 !== Math.round(v * 2));
  if (st) st.classList.toggle("bad", bad);
  if (nm && book) {
    nm.classList.toggle("bad", bad);
    nm.textContent = bad ? "0.5 단위로 입력해 주세요. 예: 9, 9.5" : unitNameH(book, v, box.dataset.role);
  }
}
function usClamp(inp, v) {
  const mn = Number(inp.min) || 0, mx = Number(inp.max) || 500;
  return Math.max(mn, Math.min(mx, snapHalf(v)));
}
document.addEventListener("click", (e) => {
  const b = e.target.closest && e.target.closest("[data-ust]");
  if (!b) return;
  const inp = b.parentElement.querySelector("input[data-half]");
  if (!inp) return;
  const d = Number(b.dataset.ust);
  const cur = inp.value === "" ? null : Number(inp.value);
  const next = cur == null || !Number.isFinite(cur) ? (d > 0 ? Number(inp.min) || 1 : 0) : usClamp(inp, snapHalf(cur) + d);
  inp.value = fmtN(usClamp(inp, next));
  usRefresh(inp);
  inp.dispatchEvent(new Event("input", { bubbles: true }));
  inp.dispatchEvent(new Event("change", { bubbles: true }));
});
// 칸에서 벗어나면 0.5 단위로 맞춤(9.3 → 9.5). 다른 change 처리보다 먼저 실행되도록 capture 로 받습니다.
document.addEventListener("change", (e) => {
  const inp = e.target;
  if (!(inp && inp.matches && inp.matches("input[data-half]"))) return;
  if (inp.value !== "" && Number.isFinite(Number(inp.value))) inp.value = fmtN(usClamp(inp, Number(inp.value)));
  usRefresh(inp);
}, true);
document.addEventListener("input", (e) => { if (e.target && e.target.matches && e.target.matches("input[data-half]")) usRefresh(e.target); }, true);

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
    nel.step = "0.5";
    nel.inputMode = "decimal";
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
  const activeAll = state.students.filter((x) => x.active);
  const sel = sc.fsel && activeAll.some((x) => x.id === sc.fsel) ? sc.fsel : null;
  const selSt = sel ? activeAll.find((x) => x.id === sel) : null;
  const head = `<div class="sch-head"><h3>수업 시간표</h3><span class="muted">매주 반복 · 이름을 누르면 학생 화면으로 이동</span><span class="spacer"></span>${sc.missing || !sc.slots.length ? "" : `<div class="rc-seg" role="group" aria-label="시간표 보기 방식"><button type="button" data-schmode="all" class="${sel ? "" : "on"}" aria-pressed="${!sel}">전체 보기</button><button type="button" data-schmode="student" class="${sel ? "on" : ""}" aria-pressed="${!!sel}">학생별 보기</button></div><button class="btn small" id="sch-print" type="button">${selSt ? esc(selSt.name) + " 시간표 미리보기" : "시간표 미리보기"}</button>`}</div>`;
  if (sc.missing) return `<section class="sch">${head}<div class="card empty">시간표를 쓰려면 최신 <code>schema.sql</code> 을 Supabase SQL Editor에서 한 번 실행하세요.</div></section>`;
  const days = groupDays(sc.slots);
  if (!days.length) return `<section class="sch">${head}<div class="sch-empty"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/></svg><div><strong>아직 시간표가 없어요</strong><div class="muted">요일과 시간을 만들면 학생 이름이 여기에 시간순으로 나와요.</div></div><button class="btn primary" id="sch-new" type="button">시간표 만들기</button></div></section>`;
  const active = activeAll;
  const today = new Date().getDay();
  // 학생별 보기: 선택한 학생은 강조, 다른 학생은 흐리게(눌러서 그 학생으로 전환)
  const chipOf = (st) => !sel ? `<button type="button" class="sch-chip" data-sch-sid="${esc(st.id)}">${esc(st.name)}</button>`
    : st.id === sel ? `<button type="button" class="sch-chip on" data-sch-sid="${esc(st.id)}">${esc(st.name)}</button>`
    : `<button type="button" class="sch-chip dim" data-sch-pick="${esc(st.id)}" title="${esc(st.name)} 시간표 보기">${esc(st.name)}</button>`;
  // 이번 주 보강(날짜가 정해진 것) → 시간이 맞는 칸에 표시
  const wkr = periodRange("thisWeek");
  const mkWeek = sel && !state.makeup.missing ? state.makeup.rows.filter((r) => r.student_id === sel && r.status === "예정" && r.planned_date && r.planned_date >= wkr.start && r.planned_date <= wkr.end).sort((a, b) => a.planned_date.localeCompare(b.planned_date) || (a.planned_start || "").localeCompare(b.planned_start || "")) : [];
  const mkIn = (sl) => mkWeek.filter((r) => parseD(r.planned_date).getDay() === sl.weekday && r.planned_start && hhmm(r.planned_start) >= hhmm(sl.start_time) && hhmm(r.planned_start) < hhmm(sl.end_time));
  const mkChips = (sl) => mkIn(sl).map((r) => `<span class="sch-chip mk" title="이번 주 보강">보강 ${shortDate(r.planned_date).replace(/\(.\)/, "")}</span>`).join("");
  const mine = (names) => !!sel && names.some((x) => x.id === sel);
  const rows = days.map((d) => d.slots.map((sl, i) => {
    const names = active.filter((s) => (sl.student_ids || []).includes(s.id));
    const tm = timeText(sl.start_time, sl.end_time);
    return `<tr class="${i === 0 ? "sch-first" : ""} ${d.wd === today ? "sch-today" : ""}">
      ${i === 0 ? `<th class="sch-day ${d.wd === today ? "today" : ""}" rowspan="${d.slots.length}" scope="rowgroup"><b>${DAY_NAME[d.wd]}</b>${d.wd === today ? "<em>오늘</em>" : ""}</th>` : ""}
      <td class="sch-slot"><b>${esc(sl.label || "타임 " + (i + 1))}</b>${tm ? `<span>${tm}</span>` : ""}</td>
      <td class="sch-names ${mine(names) || mkIn(sl).length ? "mine" : ""}"><div class="w">${names.length || mkIn(sl).length ? names.map(chipOf).join("") + mkChips(sl) : `<span class="muted">-</span>`}</div></td>
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
      return `<td class="${cls} ${mine(names) || mkIn(sl).length ? "mine" : ""}"><div class="sg-top"><span>${esc(tm)}</span><span>${names.length}명</span></div><div class="sg-chips">${names.length || mkIn(sl).length ? names.map(chipOf).join("") + mkChips(sl) : `<span class="muted">-</span>`}</div></td>`;
    }).join("");
    return `<tr><th class="sg-rt" scope="row"><b>${esc(first.label || "타임 " + (i + 1))}</b>${rtime ? `<span>${rtime}</span>` : ""}</th>${cells}</tr>`;
  }).join("");
  const gridHead = days.map((d) => `<th scope="col" class="${d.wd === today ? "today" : ""}">${DAY_NAME[d.wd]}${d.wd === today ? "<em>오늘</em>" : ""}</th>`).join("");
  let fbar = "";
  if (sel) {
    const mySlots = days.flatMap((d) => d.slots.filter((sl) => (sl.student_ids || []).includes(sel)).map((sl) => ({ d, sl })));
    const lbl = mySlots.map(({ d, sl }) => `${DAY_NAME[d.wd]} ${timeText(sl.start_time, sl.end_time) || ""}`.trim()).join(" · ");
    const opts = activeAll.slice().sort((a, b) => a.name.localeCompare(b.name, "ko")).map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? "selected" : ""}>${esc(x.name)}${x.grade ? " (" + esc(x.grade) + ")" : ""}</option>`).join("");
    const chips = activeAll.slice().sort((a, b) => a.name.localeCompare(b.name, "ko")).map((x) => `<button type="button" class="sch-fc ${x.id === sel ? "on" : ""}" data-sch-pick="${esc(x.id)}" aria-pressed="${x.id === sel}">${esc(x.name)}</button>`).join("");
    fbar = `<div class="sch-fchips">${chips}</div><select class="sch-fsel" id="sch-fsel" aria-label="학생 선택">${opts}</select>
      <div class="sch-sum"><span class="rc-av" aria-hidden="true">${esc(selSt.name.trim().slice(0, 1))}</span><div class="sch-sum-t"><b>${esc(selSt.name)}</b> <span class="muted">${esc(selSt.grade || "")}${mySlots.length ? ` · 매주 ${mySlots.length}회` : ""}</span><div class="sch-sum-s">${mySlots.length ? esc(lbl) : '<span class="muted">배정된 정규 수업이 없어요</span>'}</div></div>
      ${mkWeek.length ? `<span class="sch-sum-mk">이번 주 보강 ${mkWeek.length}건 · ${mkWeek.map((r) => `${shortDate(r.planned_date)}${r.planned_start ? " " + hhmm(r.planned_start) : ""}`).join(", ")}</span>` : ""}</div>`;
  }
  return `<section class="sch">${head}${fbar}
    <div class="card sch-card sch-wide"><table class="sch-grid"><thead><tr><th></th>${gridHead}</tr></thead><tbody>${grid}</tbody></table></div>
    <div class="card sch-card sch-narrow"><table class="sch-table"><tbody>${rows}</tbody></table></div></section>`;
}
function schedulePrintHtml(orient = "p", zoom = 1, sid = null) {
  const zs = zoom < 1 ? ` style="zoom:${zoom}"` : "";
  let days = groupDays(state.schedule.slots);
  const active = state.students.filter((s) => s.active && (!sid || s.id === sid));
  const who = sid ? (state.students.find((s) => s.id === sid) || {}).name || "" : "";
  const title = who ? `${esc(who)} 수업 시간표` : "수업 시간표";
  // 학생 한 명만 출력할 때: 가로는 격자를 유지하고 이름만 걸러 내고, 세로는 그 학생의 수업이 있는 칸만 남깁니다.
  if (sid && orient !== "l") days = days.map((d) => ({ wd: d.wd, slots: d.slots.filter((sl) => (sl.student_ids || []).includes(sid)) })).filter((d) => d.slots.length);
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
      <div class="tl-hd"><div><div class="pl-br pv-row">${LOGO_SVG}<span>${esc(ACADEMY_NAME).toUpperCase()}</span></div><h1>${title}</h1></div><span>매주 반복</span></div>
      <div class="tl-bd"${zs}><table class="tl-table"><thead><tr><th></th>${days.map((d) => `<th class="tl-d">${DAY_NAME[d.wd]}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>
      ${foot}</div>`;
  }
  const block = (d) => `<div class="tp-day"><div class="tp-d">${DAY_NAME[d.wd]}</div><div class="tp-slots">${d.slots.map((sl, i) => {
    const tm = timeText(sl.start_time, sl.end_time);
    return `<div class="tp-slot"><div class="tp-t"><b>${esc(sl.label || "타임 " + (i + 1))}</b>${tm ? `<span>${tm}</span>` : ""}</div>
      <div class="tp-n">${chips(namesOf(sl))}</div></div>`;
  }).join("")}</div></div>`;
  return `<div class="rp-page tp-page">
    <div class="pl-hd"><div class="pl-br pv-row">${LOGO_SVG}<span>${esc(ACADEMY_NAME).toUpperCase()}</span></div><h1>${title}</h1><div class="pl-who"><span>매주 반복</span></div></div>
    <div class="tp-bd"${zs}>${days.map(block).join("")}</div>
    ${foot}
  </div>`;
}
const SCH_ORIENT_KEY = "rachel_sched_orient";
function schedOrient() {
  try { return localStorage.getItem(SCH_ORIENT_KEY) === "l" ? "l" : "p"; } catch { return "p"; }
}
function openSchedPreview(returnTo, orient = schedOrient(), sid = null) {
  try { localStorage.setItem(SCH_ORIENT_KEY, orient); } catch { /* 저장 실패는 무시 */ }
  openEvalPreview(schedulePrintHtml(orient, 1, sid), () => {
    const area = $("#sched-print-area");
    area.innerHTML = schedulePrintHtml(orient, 1, sid);
    area.classList.toggle("land", orient === "l");
    document.body.classList.add("print-sched");
    try { window.print(); } finally { document.body.classList.remove("print-sched"); area.classList.remove("land"); }
  }, returnTo, "시간표 미리보기", {
    land: orient === "l",
    onRender: orient === "l" ? paginateSchedLand : paginateSchedPortrait,
    orient: { value: orient, options: [["p", "세로"], ["l", "가로"]], onChange: (v) => openSchedPreview(returnTo, v, sid) },
  });
}
function bindSchedule() {
  const nb = $("#sch-new");
  if (nb) nb.onclick = () => startScheduleEdit();
  const pb = $("#sch-print");
  if (pb) {
    pb.onclick = () => openSchedPreview(pb, schedOrient(), state.schedule.fsel);
  }
  const first = () => state.students.filter((x) => x.active).slice().sort((a, b) => a.name.localeCompare(b.name, "ko"))[0];
  $("#main").querySelectorAll("[data-schmode]").forEach((b) => {
    b.onclick = () => {
      const sc = state.schedule;
      if (b.dataset.schmode === "all") sc.fsel = null;
      else if (!sc.fsel) { const f = first(); sc.fsel = f ? f.id : null; }
      render();
    };
  });
  $("#main").querySelectorAll("[data-sch-pick]").forEach((b) => {
    b.onclick = () => { state.schedule.fsel = b.dataset.schPick; render(); };
  });
  const fs = $("#sch-fsel");
  if (fs) fs.onchange = () => { state.schedule.fsel = fs.value; render(); };
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
    // 변화: 최근 30일 평균 - 그 이전(31~90일) 평균. 둘 다 있을 때만 표시
    const cut = daysAgoStr(30);
    const curT = tests.filter((t) => t.test_date >= cut).map((t) => pct(t.score, t.max_score));
    const oldT = tests.filter((t) => t.test_date < cut).map((t) => pct(t.score, t.max_score));
    const delta = curT.length && oldT.length ? Math.round(avg(curT) - avg(oldT)) : null;
    const books = bookProgressFor(s.id);
    return { s, last, lessonCount: lessons.length, attended, avgPct, delta, testCount: tests.length, books, lastCovered, nextPlan };
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
              const w = book.total_units ? Math.max(0, Math.min(100, Math.round((p.current_unit / book.total_units) * 100))) : 0;
              return `<div class="row"><span>${esc(book.title)}</span><span class="muted">${p.current_unit}/${book.total_units}</span><div class="bar${w >= 100 ? " done" : ""}" role="img" aria-label="${w}% 진행"><span style="width:${w}%"></span></div></div>`;
            })
            .join("")}</div>`
        : `<span class="muted">배정된 교재 없음</span>`;
      const dl = r.delta == null || r.delta === 0 ? "" : `<div class="delta ${r.delta > 0 ? "up" : "down"}"><span aria-hidden="true">${r.delta > 0 ? "▲" : "▼"}</span> ${Math.abs(r.delta)}<span class="sr-only">${r.delta > 0 ? " 올랐어요" : " 내렸어요"}</span></div>`;
      return `<tr class="clickable" data-id="${esc(r.s.id)}">
        <td class="c-name"><strong>${esc(r.s.name)}</strong><div class="muted">${esc(r.s.grade || "")}</div></td>
        <td class="c-books">${books}</td>
        <td class="c-last" data-l="최근 수업">${lastCell}</td>
        <td class="c-next" data-l="다음 수업">${r.lastCovered && coverText(r.lastCovered) ? esc(coverText(r.lastCovered)) + `<div class="muted">${fmtDate(r.lastCovered.lesson_date)}</div>` : '<span class="muted">-</span>'}${r.nextPlan ? `<div class="next-plan">다음: ${esc(r.nextPlan)}</div>` : ""}</td>
        <td class="num c-att" data-l="30일 출석">${r.lessonCount ? `${r.attended}/${r.lessonCount}회` : "-"}</td>
        <td class="num c-avg" data-l="시험 평균">${r.avgPct == null ? "-" : `<b>${r.avgPct.toFixed(0)}점</b>`}${dl}<div class="muted">${r.testCount ? r.testCount + "회" : ""}</div></td>
        <td class="go" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg></td>
      </tr>`;
    })
    .join("");

  if (state.schedule.draft) return renderScheduleEdit();
  main.innerHTML = `
    <div class="page-head"><h2>전체 현황</h2><span class="muted">재원생 ${students.length}명</span>
      ${stale ? `<span class="badge warn">30일간 수업 기록이 없는 학생 ${stale}명</span>` : ""}</div>
    ${scheduleHtml()}
    <div class="card table-wrap">
      <table class="ov-table">
        <thead><tr><th>학생</th><th>교재 진도</th><th>최근 수업</th><th>수업 진도 · 다음 예정</th><th class="num">30일 출석</th><th class="num">90일 시험 평균</th><th class="go"></th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <p class="muted" style="margin-top:.8rem;font-size:.85rem">행을 누르면 학생 상세로 이동합니다. 시험 평균은 점수를 100점 만점으로 환산한 값이고, ▲▼는 최근 30일 평균이 그 이전(31~90일)보다 얼마나 올랐는지 내렸는지입니다.</p>
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
      ${[["progress", "교재 진도"], ["lessons", "수업 기록"], ["tests", "시험·단어"], ["writing", "라이팅"], ["recs", "수업 추천"]]
        .map(([k, t]) => `<button class="tab ${state.tab === k ? "active" : ""}" role="tab" data-tab="${k}">${t}</button>`)
        .join("")}
    </div>
    <div id="tab-body"></div>`;
  if (state.tab === "progress") renderProgressTab(s);
  else if (state.tab === "lessons") renderLessonsTab(s);
  else if (state.tab === "report") renderReportTab(s);
  else if (state.tab === "recs") renderRecsTab(s);
  else if (state.tab === "writing") renderWritingTab(s);
  else renderTestsTab(s);
}

function nextLine(p, book) {
  const nb = p.next_textbook_id ? state.textbooks.find((b) => b.id === p.next_textbook_id) : null;
  if (!nb) return "";
  const done = book.total_units > 0 && p.current_unit >= book.total_units;
  return `<div class="next-book${done ? " done" : ""}">${done ? "교재를 끝냈어요 · 다음 교재" : "다음 교재"} <b>${esc(nb.title)}</b></div>`;
}
function renderProgressTab(s) {
  const items = bookProgressFor(s.id);
  const assignedIds = new Set(items.map((x) => x.book.id));
  const available = state.textbooks.filter((b) => !assignedIds.has(b.id));
  const nextLesson = state.detail.lessons.find((l) => l.next_plan);
  const classDays = studentClassDays(s.id);
  const week = state.progView === "week" && items.length > 0;
  const mini = ({ p, book }) => {
    return `<button type="button" class="wk-book" data-act="days" data-pid="${esc(p.id)}" title="누르면 요일을 바꿀 수 있어요"><b>${esc(book.title)}</b><span>${p.current_unit > 0 ? esc(curLabel(book, p.current_unit)) : "시작 전"}</span>${dailyVal(book, p) ? `<em class="wk-dr">하루 ${esc(dailyVal(book, p))}</em>` : `<em class="wk-dr none">추천 범위 없음</em>`}</button>`;
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
        ${dailyRow(book, p)}
        ${recNote(book, p, state.detail.lessons)}
        ${nextLine(p, book)}
        <div class="stat"><strong>${esc(curShort(book, p.current_unit))} <span class="muted" style="font-size:.9rem;font-weight:400">/ ${book.total_units}</span></strong></div>
        ${recent ? `<div style="font-size:.85rem;margin-top:.5rem">최근 수업 <span class="muted">${fmtDate(recent.lesson_date)}</span> ·${esc(rangeText(book, recentEnt) || " 범위 미입력")}</div>` : ""}
        <div class="muted" style="font-size:.8rem;margin-top:.4rem">진도 갱신 ${fmtDate((p.updated_at || "").slice(0, 10))}</div>
        <div class="book-actions">
          <button class="btn small" data-act="days">요일 변경</button>
          <button class="btn small" data-act="range">${p.daily_min ? "하루 추천 진도 범위 변경" : "하루 추천 진도 범위 정하기"}</button>
          <button class="btn small" data-act="next">다음 교재</button>
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
      const row = ws.addRow([utcD(d), b ? `${b.title} | ${rangeText(b, r).trim()} (${fmtN(amountN(r.from_unit, r.to_unit))}단원)` : "", k > 0 ? XL_SAME : "", "", "", "", b ? b.title : ""]);
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

const TEST_KINDS = ["단어시험", "단원평가", "모의고사", "기타"]; // 처음 한 번 test_kinds 에 채워 넣는 시작 종류 (이후에는 모두 수정·삭제 가능)
const KIND_SEED = "__seeded__"; // 시작 종류를 이미 채웠다는 표시 행(목록에는 안 보임)
const KIND_COLORS = ["#1b7f86", "#2c5fd1", "#b45309", "#7c3aed", "#c2410c", "#be185d"];
async function loadKinds() {
  try {
    let rows = await run(db.from("test_kinds").select("*").order("created_at"));
    state.kinds.missing = false;
    if (!rows.some((k) => k.name === KIND_SEED)) {
      // 처음 한 번: 시작 종류를 일반 행으로 만들어 이름·색·단위·삭제를 모두 고칠 수 있게 함 (이미 고친 값은 유지)
      try {
        for (const name of TEST_KINDS) if (!rows.some((k) => k.name === name)) await run(db.from("test_kinds").insert({ name, default_max: 100, unit: "점" }));
        await run(db.from("test_kinds").insert({ name: KIND_SEED, default_max: 1, unit: "점" }));
        rows = await run(db.from("test_kinds").select("*").order("created_at"));
      } catch { /* 실패해도 아래에서 기본 종류로 대체 */ }
    }
    state.kinds.rows = rows.filter((k) => k.name !== KIND_SEED);
    state.kinds.seeded = rows.some((k) => k.name === KIND_SEED);
  } catch {
    state.kinds.rows = [];
    state.kinds.seeded = false;
    state.kinds.missing = true; // 테이블이 아직 없음 → 기본 종류만 사용
  }
}
/* 기본 + 내가 만든 종류 */
function kindList() {
  const mk = (name, builtin, k) => ({ name, builtin, id: k && k.id, max: k ? Number(k.default_max) || 100 : 100, unit: (k && k.unit) || "점", color: k && k.color, memo: k && k.memo, over: !!k });
  if (state.kinds.seeded) return state.kinds.rows.map((k) => mk(k.name, false, k));
  return [
    ...TEST_KINDS.map((name) => mk(name, true, state.kinds.rows.find((k) => k.name === name))),
    ...state.kinds.rows.filter((k) => !TEST_KINDS.includes(k.name)).map((k) => mk(k.name, false, k)),
  ];
}
const kindIndex = (name) => kindList().findIndex((k) => k.name === name);
const kindUnit = (name) => (kindList().find((k) => k.name === name) || {}).unit || "점";
function kStyle(name) {
  const k = kindList().find((x) => x.name === name);
  return k && k.color ? ` style="--c:${esc(k.color)}"` : "";
}
/* 기록이 있는 종류만, 정해진 순서(기본→내 종류→목록에 없는 이름) */
function kindsIn(rows) {
  const names = kindList().map((k) => k.name);
  rows.forEach((t) => { if (t.kind && !names.includes(t.kind)) names.push(t.kind); });
  return names.filter((n) => rows.some((t) => t.kind === n));
}
function kindCard(kind, list, ci) {
  const pts = [...list].sort((a, b) => a.test_date.localeCompare(b.test_date)).slice(-15);
  const vals = pts.map((t) => pct(t.score, t.max_score));
  const last = Math.round(vals[vals.length - 1]);
  if (pts.length < 2) {
    return `<div class="card gc gone k${ci}"${kStyle(kind)}><div class="gk">${esc(kind)}</div><div class="gbig">${last}% <small>· 1회</small></div><div class="muted">다음 시험부터 추이가 표시돼요</div></div>`;
  }
  const W = 300, H = 136, L = 38, R = 12, T = 22, B = 24;
  const x = (i) => L + 14 + (i * (W - L - R - 24)) / (pts.length - 1);
  const y = (v) => T + ((100 - Math.max(0, Math.min(100, v))) * (H - T - B)) / 100;
  const line = vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;
  const grid = [0, 50, 100].map((g) => `<line class="gaxis" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text class="gtick" x="${L - 6}" y="${y(g) + 3.5}" text-anchor="end">${g}%</text>`).join("");
  const showAll = pts.length <= 8;
  const dots = vals.map((v, i) => {
    const isLast = i === vals.length - 1;
    return `<circle class="gdot${isLast ? " last" : ""}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${isLast ? 5 : 3.2}"><title>${fmtDate(pts[i].test_date)} ${pts[i].score}/${pts[i].max_score}${esc(kindUnit(kind))} = ${v.toFixed(0)}%</title></circle>${showAll || isLast ? `<text class="gval${isLast ? " last" : ""}" x="${x(i).toFixed(1)}" y="${(y(v) - 9).toFixed(1)}" text-anchor="middle">${Math.round(v)}</text>` : ""}`;
  }).join("");
  const dl = (i) => { const d = parseD(pts[i].test_date); return `${d.getMonth() + 1}.${d.getDate()}`; };
  const labIdx = pts.length <= 7 ? pts.map((_, i) => i) : [0, pts.length - 1];
  const labels = labIdx.map((i) => `<text class="gtick" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="${pts.length > 7 ? (i ? "end" : "start") : "middle"}">${dl(i)}</text>`).join("");
  const diff = Math.round(vals[vals.length - 1]) - Math.round(vals[vals.length - 2]);
  const chg = `<span class="gchg ${diff > 0 ? "up" : diff < 0 ? "dn" : ""}">${diff > 0 ? "▲" : diff < 0 ? "▼" : "–"} ${Math.abs(diff)}</span>`;
  return `<div class="card gc k${ci}"${kStyle(kind)}><div class="gh"><div><div class="gk">${esc(kind)}</div><div class="gs"><b>${last}</b>% ${chg}</div></div><span class="gm">${list.length}회</span></div>
    <svg class="gsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(kind)} 점수 추이(백분율)">${grid}<path class="garea" d="${area}"/><path class="gline" d="${line}"/>${dots}${labels}</svg>
    <div class="gf"><span>평균 <b>${avg(vals).toFixed(0)}%</b></span><span>최고 <b>${Math.max(...vals).toFixed(0)}%</b></span><span>최저 <b>${Math.min(...vals).toFixed(0)}%</b></span></div></div>`;
}
// 그래프는 기간 필터와 무관하게 최근 4주(오늘 포함 28일) 기준
function trendCards(all) {
  const from = addDays(todayStr(), -27);
  const rows = all.filter((t) => t.test_date >= from && t.test_date <= todayStr());
  const kinds = kindsIn(rows);
  if (!kinds.length) return `<h3 class="gtitle">종류별 점수 추이 <small class="muted">· 최근 4주 · 백분율(%)</small></h3><div class="card empty">최근 4주 안에 시험 기록이 없습니다.</div>`;
  const cards = kinds.map((k) => kindCard(k, rows.filter((t) => t.kind === k), kindIndex(k)));
  return `<h3 class="gtitle">종류별 점수 추이 <small class="muted">· 최근 4주 · 백분율(%)</small></h3><div class="gg ${kinds.length === 1 ? "one" : ""}">${cards.join("")}</div>`;
}

function renderTestsTab(s) {
  const all = state.detail.tests;
  const rows = all.filter((t) => inRange(state.testFilter, t.test_date));
  const pcts = rows.map((t) => pct(t.score, t.max_score));
  const recent = pcts.slice(0, 5);
  const scoped = state.testFilter.range !== "all";
  $("#tab-body").innerHTML = `
    <div class="toolbar"><button class="btn primary" id="btn-add-test">+ 시험 점수</button>
      <span class="xl-sep" aria-hidden="true"></span>
      <button class="btn xl-btn" id="btn-txl-tpl" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>양식 다운로드</button>
      <button class="btn xl-btn" id="btn-txl-up" type="button"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m0 0L6 7m4-4l4 4M4 16h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>엑셀 업로드</button>
      <input type="file" id="txl-file" accept=".xlsx" hidden></div>
    ${all.length ? trendCards(all) : ""}
    ${filterHtml(state.testFilter, "tf", false)}
    ${
      rows.length
        ? `<div class="summary">
            <div class="card"><strong>${avg(pcts).toFixed(0)}%</strong><span>${scoped ? "기간 평균" : "전체 평균"}</span></div>
            <div class="card"><strong>${avg(recent).toFixed(0)}%</strong><span>최근 ${recent.length}회 평균</span></div>
            <div class="card"><strong>${Math.max(...pcts).toFixed(0)}%</strong><span>최고</span></div>
            <div class="card"><strong>${rows.length}회</strong><span>${scoped ? "기간 내 시험" : "누적 시험"}</span></div>
          </div>
          <div class="card table-wrap"><table>
            <thead><tr><th>날짜</th><th>종류</th><th>이름</th><th class="num">점수</th><th class="num">백분율</th></tr></thead>
            <tbody>${rows
              .map(
                (t) => `<tr class="clickable" data-tid="${esc(t.id)}">
                  <td style="white-space:nowrap">${fmtDate(t.test_date)}</td><td>${esc(t.kind)}</td><td>${esc(t.title || "")}</td>
                  <td class="num">${t.score}/${t.max_score}${esc(kindUnit(t.kind))}</td><td class="num">${pct(t.score, t.max_score).toFixed(0)}%</td></tr>`
              )
              .join("")}</tbody></table></div>`
        : `<div class="card empty">${all.length ? "이 기간에는 시험 기록이 없습니다. 위에서 기간을 바꿔 보세요." : "시험 기록이 없습니다."}</div>`
    }`;
  bindFilter(state.testFilter, "tf", () => renderTestsTab(s));
  $("#btn-txl-tpl").onclick = () => downloadTestTemplate(s).catch((e) => fail(e));
  const tfile = $("#txl-file");
  $("#btn-txl-up").onclick = () => tfile.click();
  tfile.onchange = async () => {
    const f = tfile.files && tfile.files[0];
    tfile.value = "";
    if (!f) return;
    try { await uploadTestSheet(s, f); } catch (e) { fail(e); }
  };
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
const LOGO_SVG = `<svg class="pv-logo" viewBox="-3.5 -7 71 71" role="img" aria-label="로고"><rect width="64" height="64" rx="15" fill="#d9eeee"/><path d="M14.65 16.35L14.65 15.43Q15.80 15.48 17.75 15.52Q19.71 15.57 21.64 15.57Q23.85 15.57 25.92 15.52Q27.99 15.48 28.86 15.48Q33.14 15.48 35.97 16.42Q38.80 17.36 40.20 19.16Q41.60 20.95 41.60 23.48Q41.60 25.05 40.96 26.63Q40.32 28.22 38.77 29.58Q37.23 30.93 34.57 31.72Q33.14 32.18 31.35 32.36Q35.49 32.73 37.51 34.15Q39.49 35.58 40.09 38.43L41.14 43.17Q41.56 45.01 42.02 45.75Q42.48 46.48 43.35 46.48Q43.95 46.44 44.34 46.18Q44.73 45.93 45.19 45.42L45.84 45.98Q44.59 47.40 43.17 48.02Q41.74 48.64 39.72 48.64Q37.23 48.64 35.62 47.59Q34.01 46.53 33.51 43.68L32.68 39.08Q32.36 37.14 31.90 35.70Q31.44 34.25 30.63 33.39Q29.83 32.54 28.40 32.54L25.41 32.54L25.41 43.12Q25.41 44.78 25.66 45.61Q25.92 46.44 26.65 46.71Q27.39 46.99 28.86 47.08L28.86 48Q27.62 47.91 25.73 47.88Q23.85 47.86 21.92 47.86Q19.71 47.86 17.75 47.88Q15.80 47.91 14.65 48L14.65 47.08Q16.12 46.99 16.86 46.71Q17.59 46.44 17.84 45.61Q18.10 44.78 18.10 43.12L18.10 20.31Q18.10 18.61 17.84 17.80Q17.59 17 16.83 16.70Q16.07 16.40 14.65 16.35M25.41 20.31L25.41 31.62L27.39 31.62Q30.10 31.62 31.51 30.59Q32.91 29.55 33.44 27.83Q33.97 26.10 33.97 23.99Q33.97 20.35 32.68 18.35Q31.39 16.35 28.26 16.35Q26.47 16.35 25.94 17.13Q25.41 17.92 25.41 20.31" fill="#0f3d44"/><path d="M43 -7h12v26l-6-5-6 5z" fill="#f4a27a"/></svg>`;

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
      r.tests.forEach((t) => out.push(`- ${shortDate(t.test_date)} ${t.kind}${t.title ? ` ${t.title}` : ""} ${t.score}/${t.max_score}${kindUnit(t.kind)}`));
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
const EVAL_STATUS = ["임시저장", "작성중", "AI 초안", "완료"];

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
  if (row.status === "임시저장") return `<span class="badge" title="임시 저장 상태는 다음 예약 작업이 내용을 다시 씁니다. 확정하려면 '작성 중'이나 '완료'로 바꿔 저장하세요">임시 저장</span>`;
  return row.status === "완료" ? `<span class="badge done">완료</span>` : `<span class="badge">작성 중</span>`;
}

function evalActionCell(row, sm) {
  if (!row) return sm.r.lessons.length
    ? `<span class="btn small primary ev-go">작성하기</span>`
    : `<span class="ev-none">수업 기록 없음</span>`;
  if (row.status === "완료") return `<span class="badge done ev-ok"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg> 작성 완료</span>`;
  return evalStatusBadge(row);
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
      <td class="ev-act">${evalActionCell(row, sm)}</td></tr>`;
  });
  main.innerHTML = head + (students.length
    ? `<div class="ev-prog"><div class="ev-prog-t"><span>작성 현황</span><strong>${students.length}명 중 ${done}명 완료</strong></div><div class="bar" role="img" aria-label="${Math.round((done / students.length) * 100)}% 완료"><span style="width:${Math.round((done / students.length) * 100)}%"></span></div></div>
      <div class="card table-wrap"><table>
        <thead><tr><th>학생</th><th class="num">수업</th><th class="num">출석률</th><th class="num">숙제 완료율</th><th class="num">시험 평균</th><th class="num">평가서</th></tr></thead>
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
  const kinds = kindsIn(mine.filter((t) => t.test_date >= d.range.start));
  if (!kinds.length) return "";
  const card = (kind, ci) => {
    const pts = mine.filter((t) => t.kind === kind).sort((a, b) => a.test_date.localeCompare(b.test_date)).slice(-10)
      .map((t) => ({ v: Math.round(pct(t.score, t.max_score)), cur: t.test_date >= d.range.start, d: parseD(t.test_date) }));
    const cur = pts.filter((p) => p.cur);
    const avgCur = Math.round(avg(cur.map((p) => p.v)));
    const head = `<div class="rg-h"><b>${esc(kind)}</b><span>이번 달 평균 <b>${avgCur}</b>%</span></div>`;
    if (pts.length < 2) return `<div class="rg-card">${head}<div class="rg-one">${pts[0].v}% <small>· 1회</small></div></div>`;
    const W = 300, H = 118, L = 34, R = 10, T = 12, B = 22;
    const x = (i) => L + 10 + (i * (W - L - R - 20)) / (pts.length - 1);
    const y = (v) => T + ((100 - Math.max(0, Math.min(100, v))) * (H - T - B)) / 100;
    const ci0 = pts.findIndex((p) => p.cur);
    const shade = ci0 >= 0 ? `<rect x="${(x(ci0) - 9).toFixed(1)}" y="${T - 6}" width="${(x(pts.length - 1) - x(ci0) + 18).toFixed(1)}" height="${H - T - B + 6}" rx="3" class="rg-shade"/><text class="rg-cm" x="${((x(ci0) + x(pts.length - 1)) / 2).toFixed(1)}" y="${T - 1}" text-anchor="middle">이번 달</text>` : "";
    const grid = [0, 50, 100].map((g) => `<line class="rg-ax" x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}"/><text class="rg-tk" x="${L - 5}" y="${y(g) + 3}" text-anchor="end">${g}%</text>`).join("");
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
    const dots = pts.map((p, i) => `<circle class="rg-dot${p.cur ? " cur" : ""}" cx="${x(i).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3.4"/><text class="rg-vl${p.cur ? " cur" : ""}" x="${x(i).toFixed(1)}" y="${(y(p.v) - 7).toFixed(1)}" text-anchor="middle">${p.v}</text><text class="rg-tk" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${p.d.getMonth() + 1}.${p.d.getDate()}</text>`).join("");
    return `<div class="rg-card k${ci}"${kStyle(kind)}>${head}<div class="rg-plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(kind)} 최근 3개월 점수 추이(백분율)">${shade}${grid}<path class="rg-ln" d="${line}"/>${dots}</svg></div></div>`;
  };
  return `<div class="rg-sec"><h3>시험 점수 추이 <small>최근 3개월 · 백분율(%)</small></h3><div class="rg-two">${kinds.map((k) => card(k, kindIndex(k))).join("")}</div></div>`;
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
    <div class="rp-top"><div class="rp-brand pv-row">${LOGO_SVG}<div>${esc(ACADEMY_NAME)}<small>월말평가서</small></div></div><div class="rp-when">${yy}년<b>${mm}월</b></div></div>
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
          <label class="check"><span>상태</span><select name="status">${EVAL_STATUS.map((x) => `<option value="${x}" ${(row ? row.status : "임시저장") === x ? "selected" : ""}>${x === "작성중" ? "작성 중" : x === "임시저장" ? "임시 저장" : x}</option>`).join("")}</select></label>
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
    <div class="pl-hd"><div class="pl-br pv-row">${LOGO_SVG}<span>${esc(ACADEMY_NAME).toUpperCase()}</span></div><h1>${esc(title)}</h1>
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
        if (![from, to].every((v) => Number.isFinite(v) && v * 2 === Math.round(v * 2))) throw new Error(`${b.title}: 단원 번호는 0.5 단위로 입력하세요. 예: 9, 9.5`);
        if (to < from - 0.5) throw new Error(`${b.title}: 종료 단원이 시작 단원보다 앞서요.`);
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
      <div class="re-row"><div class="us-col"><span class="cap">시작 단원</span>${unitStep(b, "from", r.from_unit, `data-re-from="${esc(r.id)}" aria-label="시작 단원"`)}</div>
      <div class="us-col"><span class="cap">종료 단원</span>${unitStep(b, "to", r.to_unit, `data-re-to="${esc(r.id)}" aria-label="종료 단원"`)}</div></div>
      <label>추천 이유<textarea rows="2" maxlength="600" data-re-why="${esc(r.id)}">${esc(r.rationale || "")}</textarea></label></fieldset>`).join("");
}

/* 수업 추천 직접 입력: '제안' 상태로 저장(직접 수정 표시 포함 → 예약 작업이 덮어쓰지 않음) */
function manualRecForm(s) {
  const prog = state.progress.filter((p) => p.student_id === s.id);
  let books = prog.map((p) => state.textbooks.find((b) => b.id === p.textbook_id)).filter(Boolean);
  if (!books.length) books = state.textbooks.slice();
  if (!books.length) { toast("먼저 교재를 등록하세요"); return; }
  const prOf = (bid) => prog.find((p) => p.textbook_id === bid);
  const days = new Set(); prog.forEach((p) => dayList(p).forEach((d) => days.add(d)));
  const upcoming = [];
  for (let i = 0; i < 28 && upcoming.length < 4; i++) { const d = addDays(todayStr(), i); if (days.has(parseD(d).getDay()) && !recLessonOn(s.id, { target_date: d })) upcoming.push(d); }
  const dateOf = (d) => `${Number(d.slice(5, 7))}.${Number(d.slice(8, 10))}(${DAY_NAME[parseD(d).getDay()]})`;
  const defBlock = (date, usedIds) => {
    const wd = date ? parseD(date).getDay() : null;
    const free = books.filter((b) => !usedIds.includes(b.id));
    const pool = free.length ? free : books;
    const b = pool.find((x) => { const dl = dayList(prOf(x.id)); return wd != null && dl.length && dl.includes(wd); }) || pool[0];
    const cur = (prOf(b.id) && prOf(b.id).current_unit) || 0;
    const f = Math.min(b.total_units, cur + 1);
    return { bid: b.id, from: f, to: f };
  };
  let blocks = [];
  let date = upcoming[0] || todayStr();
  blocks.push(defBlock(date, []));
  let why = "";
  openForm({
    title: `수업 추천 직접 입력 · ${s.name}`,
    wide: true,
    fields: [{ name: "mr-slot", type: "slot" }],
    values: {},
    submitLabel: "추천 저장",
    onSubmit: async () => {
      read();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("수업 예정일을 입력하세요.");
      if (recLessonOn(s.id, { target_date: date })) throw new Error("이 날은 이미 수업 기록이 있어 추천을 추가할 수 없어요.");
      const seen = new Set();
      for (const b of blocks) {
        const bk = state.textbooks.find((x) => x.id === b.bid);
        if (seen.has(b.bid)) throw new Error(`${bk.title}: 같은 교재가 두 번 들어 있어요.`);
        seen.add(b.bid);
        if (![b.from, b.to].every((v) => Number.isFinite(v) && v * 2 === Math.round(v * 2))) throw new Error(`${bk.title}: 단원 번호는 0.5 단위로 입력하세요. 예: 9, 9.5`);
        if (b.to < b.from - 0.5) throw new Error(`${bk.title}: 끝 단원이 시작 단원보다 앞서요.`);
        if (b.from < 1 || b.to > bk.total_units) throw new Error(`${bk.title}: 전체 단원 수(${bk.total_units})를 벗어났어요.`);
        const dup = (state.detail.recs || []).find((r) => r.status === "제안" && r.textbook_id === b.bid && r.target_date === date);
        if (dup) throw new Error(`${bk.title}: ${dateOf(date)}에 이미 제안이 있어요. 목록에서 "추천 수정"을 쓰세요.`);
      }
      const when = new Date().toISOString();
      const rows = blocks.map((b) => ({ student_id: s.id, textbook_id: b.bid, target_date: date, from_unit: b.from, to_unit: b.to, rationale: why.trim().slice(0, 600) || null, model: "직접 입력", status: "제안", edited_at: when }));
      try { await run(db.from("recommendations").insert(rows)); }
      catch (e) {
        if (!/edited_at/i.test((e && e.message) || "")) throw e;
        await run(db.from("recommendations").insert(rows.map(({ edited_at, ...r }) => r)));
        toast("저장했어요. 예약 작업 보호는 최신 schema.sql 실행 후 적용됩니다.");
      }
      await refresh();
      toast(`${dateOf(date)} 추천 ${rows.length}개를 저장했습니다`);
    },
  });
  function read() {
    const di = document.querySelector("#mr-date"); if (di) date = di.value;
    const w = document.querySelector("#mr-why"); if (w) why = w.value;
    blocks = blocks.map((b, i) => {
      const bs = document.querySelector(`[data-mr-book="${i}"]`);
      if (!bs) return b;
      return { bid: bs.value, from: Number(document.querySelector(`[data-mr-from="${i}"]`).value), to: Number(document.querySelector(`[data-mr-to="${i}"]`).value) };
    });
  }
  function draw() {
    const warn = date && recLessonOn(s.id, { target_date: date }) ? `<p class="warn-note">이 날은 이미 수업 기록이 있어요. 다른 날짜를 고르세요.</p>` : "";
    $("#mr-slot").innerHTML = `<div class="re-row"><label>수업 예정일<input type="date" id="mr-date" value="${esc(date)}"></label></div>
      ${upcoming.length ? `<div class="chip-row" style="margin:.1rem 0 .6rem">${upcoming.map((d) => `<button type="button" class="chip ${d === date ? "on" : ""}" data-mr-day="${d}">${dateOf(d)}</button>`).join("")}</div>` : ""}
      ${warn}
      ${blocks.map((b, i) => {
        const bk = state.textbooks.find((x) => x.id === b.bid); const pr = prOf(b.bid);
        return `<fieldset class="re-box"><legend>교재 ${i + 1}</legend>
        <label>교재<select data-mr-book="${i}">${books.map((x) => `<option value="${esc(x.id)}" ${x.id === b.bid ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select></label>
        <div class="re-row"><div class="us-col"><span class="cap">시작 단원</span>${unitStep(bk, "from", b.from, `data-mr-from="${i}" aria-label="시작 단원"`)}</div>
        <div class="us-col"><span class="cap">끝 단원</span>${unitStep(bk, "to", b.to, `data-mr-to="${i}" aria-label="끝 단원"`)}</div></div>
        <div class="muted" style="font-size:.8rem">${pr ? `현재 진도 ${esc(curLabel(bk, pr.current_unit))}` : "진도 기록 없음"}${blocks.length > 1 ? ` · <a href="#" data-mr-del="${i}">삭제</a>` : ""}</div></fieldset>`;
      }).join("")}
      ${blocks.length < books.length ? `<button type="button" class="btn small" id="mr-add">＋ 교재 추가</button>` : ""}
      <label style="display:block;margin-top:.6rem">메모 / 근거 (선택)<textarea rows="2" maxlength="600" id="mr-why" placeholder="예: 학교 시험 2주 전이라 문법 위주로">${esc(why)}</textarea></label>
      <p class="muted" style="font-size:.8rem;margin:.4rem 0 0">"제안" 상태로 저장되며 AI 추천처럼 수정·거절·수업 기록 반영을 쓸 수 있어요.</p>`;
    const sl = $("#mr-slot");
    sl.querySelectorAll("[data-mr-day]").forEach((b) => { b.onclick = () => { read(); date = b.dataset.mrDay; draw(); }; });
    $("#mr-date").onchange = () => { read(); draw(); };
    sl.querySelectorAll("[data-mr-book]").forEach((el) => { el.onchange = () => { read(); const i = Number(el.dataset.mrBook); const bk = state.textbooks.find((x) => x.id === blocks[i].bid); const cur = (prOf(bk.id) && prOf(bk.id).current_unit) || 0; const f = Math.min(bk.total_units, cur + 1); blocks[i].from = f; blocks[i].to = f; draw(); }; });
    sl.querySelectorAll("[data-mr-del]").forEach((a) => { a.onclick = (e) => { e.preventDefault(); read(); blocks.splice(Number(a.dataset.mrDel), 1); draw(); }; });
    const add = $("#mr-add"); if (add) add.onclick = () => { read(); blocks.push(defBlock(date, blocks.map((b) => b.bid))); draw(); };
  }
  draw();
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
        <span class="badge ${cls}">${esc(r.status)}</span>${r.model === "직접 입력" ? '<span class="badge done">직접 입력</span>' : r.edited_at ? '<span class="badge done">직접 수정</span>' : ""}
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
  $("#tab-body").innerHTML = `<div class="eval-edit"><div class="toolbar" style="margin:0 0 .7rem"><span class="spacer"></span><button class="btn primary small" type="button" id="rec-manual">＋ 추천 직접 입력</button></div>` + filterHtml(state.recFilter, "rf", "수업 안내 미리보기") + (recs.length
    ? `${pending.length ? groups(pending, false).map((g) => group(g, false)).join("") : `<div class="card empty">확인할 새 추천이 없습니다.</div>`}
       ${done.length ? `<h3 style="margin-top:1.2rem">지난 추천</h3>${groups(done, true).map((g) => group(g, true)).join("")}` : ""}
       <p class="muted" style="font-size:.85rem">날짜별 "수업 기록 반영"을 누르면 수업 기록 창이 그날 추천 교재·단원으로 한 번에 채워집니다. "거절"은 그날 추천 전체에 적용됩니다. 그대로 저장하면 "채택", 고쳐서 저장하면 "수정"으로 기록됩니다. 진도표는 수업 기록을 저장할 때만 바뀝니다.</p>`
    : `<div class="card empty">${allForStudent.length ? "이 기간에는 추천이 없습니다. 위에서 기간을 바꿔 보세요." : "아직 추천이 없습니다. Claude 예약 작업이 실행되면 여기에 표시됩니다."}</div>`) + `</div><div class="eval-print" id="plan-print-area"></div>`;
  bindRecFilter(() => renderRecsTab(s));
  $("#rec-manual").onclick = () => manualRecForm(s);
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

const RECS_MODE_KEY = "rachel_recs_mode";
function recsByStudentHtml(recs) {
  const act = state.students.filter((x) => x.active);
  const rows = act.map((st) => {
    const mine = recs.filter((r) => r.student_id === st.id);
    const open = mine.filter((r) => r.status === "제안");
    const pend = open.filter((r) => !recLessonOn(st.id, r));
    const first = [...open].sort((a, b) => (a.target_date || "9999").localeCompare(b.target_date || "9999"))[0];
    return { st, mine, open, pend, first };
  }).filter((x) => x.mine.length);
  if (!rows.length) return `<div class="card empty">이번 주에 확인할 새 추천이 없습니다. 다른 주의 추천은 학생 화면의 수업 추천 탭에서 기간을 바꿔 볼 수 있습니다.</div>`;
  rows.sort((a, b) => (a.open.length ? 0 : 1) - (b.open.length ? 0 : 1) || ((a.first && a.first.target_date) || "").localeCompare((b.first && b.first.target_date) || "") || a.st.name.localeCompare(b.st.name, "ko"));
  const ui = state.recsUi;
  if (!rows.some((x) => x.st.id === ui.sid)) ui.sid = (rows.find((x) => x.pend.length) || rows[0]).st.id;
  const cur = rows.find((x) => x.st.id === ui.sid);
  const when = (r) => (r && r.target_date ? `${shortDate(r.target_date)}` : "수업일 미정");
  const list = rows.map((x) => `<button type="button" class="rc-li ${x.st.id === ui.sid ? "on" : ""}" data-rcsid="${esc(x.st.id)}" aria-pressed="${x.st.id === ui.sid}">
      <span class="rc-av" aria-hidden="true">${esc(x.st.name.trim().slice(0, 1))}</span>
      <span class="rc-lt"><b>${esc(x.st.name)}</b> <span class="muted">${esc(x.st.grade || "")}</span><span class="muted rc-lw">${x.first ? when(x.first) : "처리 완료"}</span></span>
      ${x.pend.length ? `<span class="nav-badge">${x.pend.length}</span>` : `<span class="rc-ok">완료</span>`}</button>`).join("");

  const st = cur.st;
  const recCard = (r) => {
    const b = state.textbooks.find((x) => x.id === r.textbook_id);
    const pr = b ? state.progress.find((x) => x.student_id === st.id && x.textbook_id === b.id) : null;
    const pct = b && pr && b.total_units ? Math.max(0, Math.min(100, Math.round((pr.current_unit / b.total_units) * 100))) : null;
    const has = r.status === "제안" ? recLessonOn(st.id, r) : null;
    const cls = r.status === "거절" ? "bad" : r.status === "제안" ? "warn" : "";
    return `<div class="rc-rec" data-rid="${esc(r.id)}">
      <div class="rc-rh"><b>${esc(b ? b.title : "(교재 없음)")}</b><span class="rc-range">${esc(b ? rangeText(b, r).trim() : `${r.from_unit}–${r.to_unit}단원`)}</span>
        ${r.status === "제안" ? "" : `<span class="badge ${cls}">${esc(r.status)}</span>`}<span class="spacer"></span>
        ${pr && b ? `<span class="muted rc-cur">현재 ${esc(curLabel(b, pr.current_unit))}${pct != null ? `<span class="rc-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>` : ""}</span>` : ""}</div>
      ${r.rationale ? `<div class="rc-why">${esc(r.rationale)}</div>` : ""}
      ${has ? `<div style="margin-top:.5rem">${lessonChip(has)}</div>` : ""}
      ${r.status === "제안" && !has ? `<div class="rc-ra"><button class="btn small" type="button" data-rec-edit="${esc(r.id)}" data-rec-sid="${esc(st.id)}">범위 수정</button><button class="btn small danger" type="button" data-rec-no="${esc(r.id)}">${cur.open.length > 1 ? "이 교재만 거절" : "거절"}</button></div>` : ""}</div>`;
  };
  const byDate = new Map();
  cur.mine.filter((r) => r.status === "제안").forEach((r) => { const k = r.target_date || ""; if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(r); });
  const dates = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const grp = ([date, items]) => {
    const has = date ? recLessonOn(st.id, { target_date: date }) : null;
    const ids = items.map((r) => esc(r.id)).join(",");
    return `<section class="rc-grp"><div class="rc-gh"><strong>${date ? shortDate(date) : "수업일 미정"}</strong><span class="muted">${has ? "수업 기록 있음" : `추천 ${items.length}개`}</span><span class="spacer"></span>
      ${has ? `<button class="btn small" type="button" disabled>기록 있음</button>` : `<button class="btn small danger" type="button" data-rec-no="${ids}">${items.length > 1 ? "모두 거절" : "거절"}</button><button class="btn small primary" type="button" data-rec-use="${esc(items[0].id)}">${items.length > 1 ? `${items.length}개 모두 반영` : "수업 기록 반영"}</button>`}</div>
      <div class="rc-recs">${items.map(recCard).join("")}</div></section>`;
  };
  const decided = cur.mine.filter((r) => r.status !== "제안");
  const lessons = state.recentLessons.filter((l) => l.student_id === st.id).sort((a, b) => b.lesson_date.localeCompare(a.lesson_date)).slice(0, 3);
  const tests = state.recentTests.filter((t) => t.student_id === st.id);
  const hist = lessons.map((l) => {
    const t = tests.find((x) => x.test_date === l.lesson_date);
    const pct = t && t.max_score ? Math.round((t.score / t.max_score) * 100) : null;
    const bits = [l.attendance === "결석" ? "결석" : l.homework ? `숙제 ${l.homework}` : ""].filter(Boolean);
    return `<div class="rc-hr"><span class="muted">${shortDate(l.lesson_date)}</span><span>${esc(coverText(l) || topicText(l) || (l.attendance === "결석" ? "결석" : "-"))}${bits.length ? ` · ${esc(bits.join(" · "))}` : ""}</span><span class="muted">${t ? esc(`${t.kind || "시험"} ${pct != null ? pct + "%" : t.score}`) : ""}</span></div>`;
  }).join("");
  const nextBadge = cur.first ? `<span class="rc-when">다음 수업 ${when(cur.first)}</span>` : "";
  const idx = rows.findIndex((x) => x.st.id === ui.sid);
  const sheetRows = rows.map((x) => `<button type="button" class="rc-sr ${x.st.id === ui.sid ? "on" : ""}" data-rcsid="${esc(x.st.id)}" data-pend="${x.pend.length ? 1 : 0}" data-name="${esc(x.st.name)}">
      <span class="rc-av" aria-hidden="true">${esc(x.st.name.trim().slice(0, 1))}</span>
      <span class="rc-lt"><b>${esc(x.st.name)}</b> <span class="muted">${esc(x.st.grade || "")}</span><span class="muted rc-lw2">${x.first ? when(x.first) : "처리 완료"}</span></span>
      ${x.pend.length ? `<span class="nav-badge">${x.pend.length}</span>` : `<span class="rc-ok">완료</span>`}</button>`).join("");
  const nPend = rows.filter((x) => x.pend.length).length;
  const mobile = `<div class="rc-sw">
      <div class="rc-sw-bar"><button type="button" class="rc-step" data-rcstep="-1" aria-label="이전 학생">‹</button>
        <div class="rc-sw-mid"><b>${esc(cur.st.name)}</b> <span class="muted">${esc(cur.st.grade || "")}</span><span class="muted rc-sw-sub">${idx + 1} / ${rows.length}명${cur.first ? ` · 다음 수업 ${when(cur.first)}` : ""}</span></div>
        <button type="button" class="rc-step" data-rcstep="1" aria-label="다음 학생">›</button></div>
      <button type="button" class="btn rc-all" id="rc-all-open" aria-haspopup="dialog">전체 학생 ${rows.length}명 보기 ▾</button></div>
    <div class="rc-sheet" id="rc-sheet" role="dialog" aria-modal="true" aria-label="학생 고르기" hidden>
      <div class="rc-back" data-rcclose></div>
      <div class="rc-panel"><span class="rc-grab" aria-hidden="true"></span>
        <div class="rc-sht"><b>학생 고르기</b><button type="button" class="btn small" data-rcclose>닫기</button></div>
        <input type="search" id="rc-q" class="rc-q" placeholder="이름으로 찾기" aria-label="이름으로 찾기" autocomplete="off">
        <div class="rc-fl" role="group" aria-label="필터"><button type="button" class="on" data-rcf="all">전체 <b>${rows.length}</b></button><button type="button" data-rcf="pend">확인 필요 <b>${nPend}</b></button><button type="button" data-rcf="done">완료 <b>${rows.length - nPend}</b></button></div>
        <div class="rc-srs">${sheetRows}<div class="muted rc-none" hidden>찾는 학생이 없어요.</div></div></div></div>`;
  return `<div class="rc-wrap">
    ${mobile}
    <nav class="rc-list" aria-label="학생 선택">${list}<p class="muted rc-hint">숫자는 확인할 추천 수예요. 휴원·퇴원 학생은 보이지 않아요.</p></nav>
    <section class="rc-detail" aria-live="polite">
      <div class="rc-dh"><b class="rc-name">${esc(st.name)}</b><span class="muted">${esc(st.grade || "")}</span>${nextBadge}</div>
      ${dates.length ? dates.map(grp).join("") : `<div class="empty" style="padding:1rem 0">확인할 추천을 모두 처리했어요.</div>`}
      ${decided.length ? `<div class="rc-sub">처리한 추천</div><div class="rc-recs">${decided.map(recCard).join("")}</div>` : ""}
      <div class="rc-sub">최근 수업</div>${hist || `<div class="muted" style="font-size:.88rem">최근 30일 수업 기록이 없어요.</div>`}
      <div class="rc-foot"><button class="btn small rc-next" type="button" data-rcstep="1">다음 학생 ›</button><button class="btn small" type="button" id="rc-open-stu">${esc(st.name)} 학생 화면 열기</button></div>
    </section></div>
    <p class="muted" style="font-size:.85rem;margin-top:.8rem">"반영"을 누르면 수업 기록 창이 추천 교재·단원으로 채워져요. 그대로 저장하면 "채택", 고쳐서 저장하면 "수정"으로 기록돼요. 진도표는 수업 기록을 저장할 때만 바뀝니다.</p>`;
}

function renderAllRecs() {
  const wk = periodRange("thisWeek");
  const activeIds = new Set(state.students.filter((s) => s.active).map((s) => s.id)); // 퇴원/휴원 학생은 제외
  const recs = state.allRecs.filter((r) => activeIds.has(r.student_id) && recDate(r) >= wk.start && recDate(r) <= wk.end);
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
  const ui = state.recsUi;
  try { const m = localStorage.getItem(RECS_MODE_KEY); if (m === "date" || m === "student") ui.mode = m; } catch { /* 저장 실패는 무시 */ }
  const seg = `<div class="rc-seg" role="group" aria-label="보기 방식"><button type="button" data-rcmode="student" class="${ui.mode === "student" ? "on" : ""}" aria-pressed="${ui.mode === "student"}">학생별</button><button type="button" data-rcmode="date" class="${ui.mode === "date" ? "on" : ""}" aria-pressed="${ui.mode === "date"}">날짜별</button></div>`;
  const head = `<div class="page-head"><h2>수업 추천</h2><span class="muted">이번 주 ${shortDate(wk.start)} ~ ${shortDate(wk.end)} · 학생별 다음 수업 진도 추천</span><span class="spacer"></span>${seg}</div>`;
  if (ui.mode === "student") {
    $("#main").innerHTML = head + recsByStudentHtml(recs);
  } else {
    $("#main").innerHTML = `
    ${head}
    ${pending.length ? `${table(pending)}` : `<div class="card empty">이번 주에 확인할 새 추천이 없습니다. 다른 주의 추천은 학생 화면의 수업 추천 탭에서 기간을 바꿔 볼 수 있습니다.</div>`}
    ${done.length ? `<h3 style="margin-top:1.2rem">최근 처리한 추천</h3>${table(done)}` : ""}
    <p class="muted" style="font-size:.85rem;margin-top:.8rem">"반영"을 누르면 그 학생의 수업 기록 창이 추천 교재·단원으로 채워집니다. 그대로 저장하면 "채택", 고쳐서 저장하면 "수정"으로 기록돼요. 진도표는 수업 기록을 저장할 때만 바뀝니다.</p>`;
  }
  $("#main").querySelectorAll("[data-rcmode]").forEach((b) => {
    b.onclick = () => {
      ui.mode = b.dataset.rcmode;
      try { localStorage.setItem(RECS_MODE_KEY, ui.mode); } catch { /* 저장 실패는 무시 */ }
      renderAllRecs();
    };
  });
  const rcRows = [...$("#main").querySelectorAll(".rc-list .rc-li")].map((e) => e.dataset.rcsid);
  $("#main").querySelectorAll("[data-rcstep]").forEach((b) => {
    b.onclick = () => {
      if (!rcRows.length) return;
      const i = rcRows.indexOf(ui.sid);
      ui.sid = rcRows[(i + Number(b.dataset.rcstep) + rcRows.length) % rcRows.length];
      renderAllRecs();
      window.scrollTo({ top: 0 });
    };
  });
  const sheet = $("#rc-sheet");
  if (sheet) {
    const closeSheet = () => { sheet.hidden = true; document.body.classList.remove("rc-lock"); const o = $("#rc-all-open"); if (o) o.focus(); };
    $("#rc-all-open").onclick = () => { sheet.hidden = false; document.body.classList.add("rc-lock"); $("#rc-q").value = ""; applyRcFilter(); $("#rc-q").focus(); };
    sheet.querySelectorAll("[data-rcclose]").forEach((e) => (e.onclick = closeSheet));
    sheet.onkeydown = (e) => { if (e.key === "Escape") closeSheet(); };
    let rcf = "all";
    const applyRcFilter = () => {
      const q = $("#rc-q").value.trim().toLowerCase();
      let n = 0;
      sheet.querySelectorAll(".rc-sr").forEach((r) => {
        const okF = rcf === "all" || (rcf === "pend" ? r.dataset.pend === "1" : r.dataset.pend === "0");
        const okQ = !q || r.dataset.name.toLowerCase().includes(q);
        r.hidden = !(okF && okQ);
        if (!r.hidden) n++;
      });
      sheet.querySelector(".rc-none").hidden = n > 0;
    };
    $("#rc-q").oninput = applyRcFilter;
    sheet.querySelectorAll("[data-rcf]").forEach((b) => (b.onclick = () => {
      rcf = b.dataset.rcf;
      sheet.querySelectorAll("[data-rcf]").forEach((x) => x.classList.toggle("on", x === b));
      applyRcFilter();
    }));
  }
  document.body.classList.remove("rc-lock");
  const ob = $("#rc-open-stu");
  if (ob) ob.onclick = () => selectStudent(state.recsUi.sid);
  $("#main").querySelectorAll("[data-rcsid]").forEach((b) => {
    b.onclick = () => { ui.sid = b.dataset.rcsid; renderAllRecs(); };
  });
  $("#main").querySelectorAll("[data-rec-edit]").forEach((b) => {
    b.onclick = async () => {
      const st = state.students.find((x) => x.id === b.dataset.recSid);
      if (!st) return;
      try { await loadDetail(st.id); } catch (e) { return fail(e); }
      editRecsForm(st, b.dataset.recEdit.split(",").filter(Boolean));
    };
  });

  $("#main").querySelectorAll("[data-rec-use]").forEach((b) => {
    b.onclick = async () => {
      const rec = recs.find((r) => r.id === b.dataset.recUse);
      const s = state.students.find((x) => x.id === rec.student_id);
      if (!s) return toast("학생 정보를 찾을 수 없습니다");
      try { await loadDetail(s.id); } catch (e) { return fail(e); }
      if (await recDateHasLesson(s, rec)) return;
      lessonForm(s, null, state.detail.recs.find((r) => r.id === rec.id) || rec);
    };
  });
  $("#main").querySelectorAll("[data-lesson-chip]").forEach((b) => {
    b.onclick = async () => {
      const rec = recs.find((r) => r.id === b.closest("[data-rid]").dataset.rid);
      const st = rec && state.students.find((x) => x.id === rec.student_id);
      if (!st) return;
      try { await loadDetail(st.id); } catch (e) { return fail(e); }
      const l = state.detail.lessons.find((x) => x.lesson_date === b.dataset.lessonChip);
      if (l) lessonForm(st, l);
    };
  });
  $("#main").querySelectorAll("[data-rec-no]").forEach((b) => {
    b.onclick = async () => {
      const ids = b.dataset.recNo.split(",").filter(Boolean);
      if (!confirm(ids.length > 1 ? `추천 ${ids.length}개를 모두 거절로 기록할까요?` : "이 추천을 거절로 기록할까요?")) return;
      try {
        await run(db.from("recommendations").update({ status: "거절", decided_at: new Date().toISOString() }).in("id", ids));
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
  let q = "";
  const usage = (id) => new Set(state.progress.filter((p) => p.textbook_id === id && (state.students.find((x) => x.id === p.student_id) || {}).active).map((p) => p.student_id)).size;
  const hl = (t) => {
    const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`;
  };
  const listHtml = () => {
    const all = state.textbooks;
    const found = q ? all.filter((b) => b.title.toLowerCase().includes(q.toLowerCase())) : all;
    const cnt = $("#tb-count");
    if (cnt) cnt.textContent = q ? `${found.length}/${all.length}권` : `전체 ${all.length}권`;
    if (!all.length) return `<p class="muted">등록된 교재가 없습니다.</p>`;
    if (!found.length) return `<div class="tb-empty">"${esc(q)}"에 해당하는 교재가 없어요.<br><button type="button" class="linklike" id="tb-add-q">"${esc(q)}" 교재 추가</button></div>`;
    return `<ul style="list-style:none;margin:0;padding:0">${found.map((b) => {
      const u = usage(b.id);
      return `<li style="display:flex;gap:.5rem;align-items:center;padding:.45rem 0;border-bottom:1px solid var(--border)">
        <span style="flex:1"><strong>${hl(b.title)}</strong> <span class="muted">${bookLeaves(b) ? `${b.structure.items.length}개 항목 · ${b.total_units}단원` : `${b.total_units} ${esc(b.unit_label)}`}${u ? ` · ${u}명 사용` : ""}</span></span>
        <button type="button" class="btn small" data-edit="${esc(b.id)}">수정</button></li>`;
    }).join("")}</ul>`;
  };
  const paint = () => {
    $("#dlg-body").innerHTML = `
      <div class="toolbar"><button type="button" class="btn primary small" id="tb-add">+ 교재 추가</button></div>
      ${state.textbooks.length ? `<div class="tb-search"><input type="search" id="tb-q" placeholder="교재 이름 검색" autocomplete="off" aria-label="교재 검색" value="${esc(q)}"><span id="tb-count" class="muted"></span></div>` : ""}
      <div id="tb-list">${listHtml()}</div>`;
    $("#tb-list").innerHTML = listHtml(); // 개수 표시 갱신
    const qi = $("#tb-q");
    if (qi) qi.oninput = () => { q = qi.value.trim(); $("#tb-list").innerHTML = listHtml(); };
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
    if (e.target.id === "tb-add-q") {
      const t = q;
      dlg.close();
      editTextbook(null, t);
    }
    const id = e.target.dataset?.edit;
    if (id) {
      dlg.close();
      editTextbook(state.textbooks.find((b) => b.id === id));
    }
  };
  dlg.showModal();
}

function editTextbook(book, presetTitle) {
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
    values: book ? { ...book, mode: wasTree ? "tree" : "flat", outline: "" } : { title: presetTitle || "", total_units: 20, unit_label: "Unit", mode: "flat", outline: "" },
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
/* ---------- 하루 추천 진도 범위 (교재 배정 · 수업 추천의 기준) ---------- */
const dailyWord = (book, p) => (bookLeaves(book) ? (p && p.daily_unit === "top" ? "대단원" : "소단원") : (book.unit_label || "단원"));
const dailyAmt = (n, word) => `${n}${/[A-Za-z]/.test(word) ? " " : ""}${word}`;
function dailyVal(book, p) {
  if (!p || !p.daily_min) return "";
  return dailyAmt(fmtN(Number(p.daily_max || p.daily_min)), dailyWord(book, p));
}
function dailyRow(book, p) {
  const v = dailyVal(book, p);
  return `<div class="rng ${v ? "" : "none"}"><b>하루 추천 진도 범위</b><span class="v">${v ? esc(v) : "정하지 않음"}</span><span class="why">${v ? "새 교재 추천에 쓰는 값 · 수업 기록이 생기면 최근 평균 우선" : "정하면 새 교재 추천에 써요. 아래 버튼으로 입력하세요."}</span></div>`;
}
function dailyChip(book, p) {
  if (!p || !p.daily_min) return "";
  const lo = Number(p.daily_min), hi = Number(p.daily_max || p.daily_min);
  return `<span class="dchip dr-chip">하루 ${esc(dailyAmt(lo === hi ? fmtN(lo) : fmtN(lo) + "~" + fmtN(hi), dailyWord(book, p)))}</span>`;
}
// 추천 기준 안내: 수업 기록이 있는 진행 중 교재는 최근 수업 평균, 새 교재는 하루 추천 진도 범위
function recNote(book, p, lessons) {
  if (p.current_unit >= book.total_units) return "";
  const ns = [];
  (lessons || []).forEach((l) => {
    if (l.attendance === "결석") return;
    lessonBooks(l).forEach((b) => {
      if (b.textbook_id === book.id && b.from_unit && b.to_unit) ns.push(b.to_unit - b.from_unit + 1);
    });
  });
  if (ns.length) {
    const recent = ns.slice(0, 8);
    const avg = Math.max(1, snapHalf(recent.reduce((a, b) => a + b, 0) / recent.length));
    const t = dailyPlan(book, p.current_unit, avg, "leaf");
    return `<div class="dr-next">진행 중이라 최근 수업 평균(${recent.length}회, 한 수업 약 ${fmtN(avg)}개)으로 추천해요 · <b>${esc(t)}</b></div>`;
  }
  if (p.daily_min) return `<div class="dr-next">이 교재 수업 기록이 아직 없어 하루 추천 진도 범위로 추천해요 · <b>${esc(dailyPlan(book, p.current_unit, Number(p.daily_max || p.daily_min), p.daily_unit))}</b></div>`;
  return "";
}
// 현재 진도(cur) 다음부터 하루 최대(max)만큼의 범위를 글자로
function dailyNext(book, cur, max, unit) {
  const total = book.total_units;
  if (cur >= total) return "";
  const lv = bookLeaves(book);
  const from = cur + 1;
  let to = Math.min(total, cur + max);
  if (lv && unit === "top") {
    const top0 = lv[from - 1].top;
    const lastTop = Math.min(bookTopCount(book) - 1, top0 + max - 1);
    const idx = lv.map((l, n) => (l.top === lastTop ? n + 1 : 0)).filter(Boolean);
    to = idx[idx.length - 1];
  }
  return from === to ? unitName(book, from) : `${unitName(book, from)} ~ ${unitName(book, to)}`;
}
// 다음 수업 추천 범위를 글자로. 분량(max)과 현재 진도(cur)가 0.5 단위여도 됩니다. 예) 현재 7, 분량 1.5 → "Unit 8 ~ Unit 9 중간"
function dailyPlan(book, cur, max, unit) {
  if (cur >= book.total_units) return "";
  const lv = bookLeaves(book);
  if (lv && unit === "top") return dailyNext(book, Math.floor(cur), Math.ceil(max), unit);
  if (!isHalfN(cur) && !isHalfN(max)) return dailyNext(book, cur, max, unit);
  return rangeText(book, { from_unit: cur + 1, to_unit: Math.min(book.total_units, cur + max) }).trim();
}
const bookTopCount = (book) => (book.structure && Array.isArray(book.structure.items) ? book.structure.items.length : 0);
// 배정 창·범위 변경 창에 들어가는 입력 칸. getBook/getCur 는 입력이 바뀔 때마다 다시 읽습니다.
function mountDaily(hostId, form, getBook, getCur, vals = {}) {
  const host = $("#" + hostId);
  const one = vals.daily_max ?? vals.daily_min ?? "";
  const st = { lo: one, hi: one, unit: vals.daily_unit || "leaf" };
  const paint = () => {
    const book = getBook();
    const tree = !!(book && bookLeaves(book));
    const word = book ? dailyWord(book, { daily_unit: st.unit }) : "단원";
    host.innerHTML = `<div class="dr-box">
      <div class="dr-t"><b>하루 추천 진도 범위</b><span class="muted">(선택)</span></div>
      <div class="dr-sub muted">한 번 수업에 나갈 양이에요. ＋/−는 0.5씩, 숫자 칸을 눌러 직접 입력할 수 있어요(0.5 ~ 50). 새로 시작하는 교재의 수업 추천에 쓰고, 수업이 진행되면 최근 수업 평균으로 추천해요.</div>
      <div class="dr-row"><span>한 수업에</span>${stepHtml("daily_max", st.hi)}
        ${tree ? `<select name="daily_unit" aria-label="단위"><option value="leaf" ${st.unit === "leaf" ? "selected" : ""}>소단원</option><option value="top" ${st.unit === "top" ? "selected" : ""}>대단원</option></select>` : `<span class="dr-w">${esc(word)}</span>`}</div>
      <div class="dr-hint" id="${hostId}-hint"></div></div>`;
    hint();
  };
  const stepHtml = (nm, v) => `<span class="dr-st"><button type="button" data-st="${nm}" data-d="-0.5" aria-label="0.5 줄이기">−0.5</button><input type="number" name="${nm}" min="0.5" max="50" step="0.5" inputmode="decimal" value="${esc(v === "" ? "" : fmtN(v))}"><button type="button" data-st="${nm}" data-d="0.5" aria-label="0.5 늘리기">+0.5</button></span>`;
  const hint = () => {
    const el = $("#" + hostId + "-hint");
    const book = getBook();
    if (!el || !book) return;
    const hi = Number(st.hi) || 0, lo = hi;
    if (!hi) { el.textContent = "비워 두면 첫 수업도 평균(없으면 2개)으로 추천해요."; return; }
    if ([lo, hi].some((x) => x < 0.5 || x > 50 || x * 2 !== Math.round(x * 2))) { el.textContent = "0.5 단위로 입력해 주세요. 예: 0.5, 1, 1.5, 2"; el.classList.add("bad"); return; }
    el.classList.remove("bad");
    const cur = Number(getCur()) || 0;
    const t = dailyPlan(book, cur, Math.max(hi, lo), st.unit);
    el.innerHTML = t ? `이렇게 추천해요 · 현재 진도가 <b>${esc(cur > 0 ? unitName(book, cur) : "시작 전")}</b>이면 다음 수업은 <b>${esc(t)}</b> (${esc(dailyAmt(lo === hi ? fmtN(lo) : fmtN(lo) + "~" + fmtN(hi), dailyWord(book, { daily_unit: st.unit })))})` : "이 교재는 모두 끝났어요.";
  };
  host.addEventListener("input", (e) => {
    const el = e.target;
    if (el.name === "daily_max") { st.hi = el.value; st.lo = el.value; }
    else if (el.name === "daily_unit") { st.unit = el.value; paint(); return; }
    hint();
  });
  // 칸에서 벗어나면 0.5 단위로 맞춤(1.3 → 1.5). 최소가 최대보다 크면 같게 맞춤
  host.addEventListener("change", (e) => {
    const el = e.target;
    if (el.name !== "daily_max") return;
    const key = "hi";
    const raw = Number(el.value);
    st[key] = el.value === "" || !isFinite(raw) ? "" : fmtN(Math.max(0.5, Math.min(50, snapHalf(raw))));
    st.lo = st.hi;
    // 다시 그리지 않고 값만 갈아 끼움(바로 이어서 누른 ＋/− 버튼이 사라지지 않게)
    const hiEl = host.querySelector("[name=daily_max]");
    if (hiEl) hiEl.value = st.hi;
    hint();
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-st]");
    if (!b) return;
    const key = "hi";
    const base = Number(st.hi) || 0;
    const d = Number(b.dataset.d);
    st[key] = fmtN(base === 0 && d > 0 ? 1 : Math.max(0.5, Math.min(50, snapHalf(base) + d)));
    st.lo = st.hi;
    paint();
  });
  const bs = form.elements.textbook_id;
  if (bs) bs.addEventListener("change", () => { st.unit = "leaf"; paint(); });
  const cu = form.elements.current_unit;
  if (cu) form.addEventListener("input", (e) => { if (e.target.name === "current_unit") hint(); });
  if (cu) form.addEventListener("change", (e) => { if (e.target.name === "current_unit") hint(); });
  paint();
}
// 입력값 읽기: 둘 다 비면 범위 없음(null), 하나만 있으면 같은 값
function readDaily(form) {
  const num = (nm) => { const el = form.elements[nm]; const v = el && el.value !== "" ? Number(el.value) : null; return v; };
  let lo = num("daily_min"), hi = num("daily_max");
  const un = form.elements.daily_unit ? form.elements.daily_unit.value : "leaf";
  if (lo == null && hi == null) return { daily_min: null, daily_max: null, daily_unit: "leaf" };
  if (lo == null) lo = hi;
  if (hi == null) hi = lo;
  if ([lo, hi].some((x) => !(x >= 0.5 && x <= 50) || x * 2 !== Math.round(x * 2))) throw new Error("하루 추천 진도 범위는 0.5 단위로 0.5 ~ 50 사이로 입력하세요. 예: 0.5, 1, 1.5");
  return { daily_min: lo, daily_max: hi, daily_unit: un === "top" ? "top" : "leaf" };
}
const dailyErr = (e) => (/daily_(min|max|unit)/i.test((e && e.message) || "") ? new Error("하루 추천 진도 범위를 저장하려면 최신 schema.sql 을 Supabase 에서 먼저 실행하세요.") : e);

const nextOptions = () => [["", "(정하지 않음)"], ...state.textbooks.map((b) => [b.id, b.title])];
function assignBook(s) {
  const assigned = new Set(bookProgressFor(s.id).map((x) => x.book.id));
  const options = state.textbooks.filter((b) => !assigned.has(b.id)).map((b) => [b.id, `${b.title} (${bookLeaves(b) ? b.total_units + "단원" : b.total_units + " " + b.unit_label})`]);
  const sel = new Set();
  const classDays = studentClassDays(s.id);
  openForm({
    title: "교재 배정",
    fields: [
      { name: "textbook_id", label: "교재", type: "select", options, required: true },
      { name: "current_unit", label: "현재 진도 (이미 나간 단원 수)", type: "number", min: 0, step: 0.5, default: 0 },
      { name: "next_textbook_id", label: "다음 교재 (선택 · 이 교재를 끝낸 뒤 이어서 할 교재)", type: "select", options: nextOptions() },
      { name: "as-days", type: "slot" },
      { name: "as-rng", type: "slot" },
    ],
    onSubmit: async (d) => {
      const cu = d.current_unit || 0;
      const bk = state.textbooks.find((x) => x.id === d.textbook_id);
      if (cu * 2 !== Math.round(cu * 2) || cu < 0 || (bk && cu > bk.total_units)) throw new Error(`현재 진도는 0.5 단위로 0 ~ ${bk ? bk.total_units : ""} 사이로 입력하세요. 예: 7, 7.5`);
      const row = { student_id: s.id, textbook_id: d.textbook_id, current_unit: cu };
      if (sel.size) row.weekdays = SCH_ORDER.filter((x) => sel.has(x));
      if (d.next_textbook_id) {
        if (d.next_textbook_id === d.textbook_id) throw new Error("다음 교재는 지금 배정하는 교재와 달라야 해요.");
        row.next_textbook_id = d.next_textbook_id;
      }
      const dr = readDaily($("#dlg-form"));
      if (dr.daily_min != null) Object.assign(row, dr);
      let noNext = false;
      try {
        try { await run(db.from("progress").insert(row)); }
        catch (e) {
          if (!row.next_textbook_id || !/next_textbook_id/i.test(e.message || "")) throw e;
          noNext = true; // 아직 DB에 컬럼이 없음
          const { next_textbook_id: _n, ...rest } = row;
          await run(db.from("progress").insert(rest));
        }
      } catch (e) { throw dailyErr(weekdaysErr(e)); }
      await refresh();
      toast(noNext ? "배정했어요. 다음 교재는 DB에 컬럼이 없어 저장되지 않았어요 (schema.sql 실행 필요)" : "교재를 배정했습니다");
    },
  });
  bindUnitCtls($("#dlg-form"), ["current_unit"], { zero: true });
  mountDayPicker("as-days", sel, classDays);
  mountDaily("as-rng", $("#dlg-form"), () => state.textbooks.find((b) => b.id === $("#dlg-form").elements.textbook_id.value), () => $("#dlg-form").elements.current_unit.value, { daily_min: 1, daily_max: 1 });
}

function changeDaily(s, p, book) {
  openForm({
    title: `하루 추천 진도 범위 · ${book.title}`,
    fields: [{ name: "cd-rng", type: "slot" }],
    deleteLabel: "범위 없애기",
    deleteConfirm: "하루 추천 진도 범위를 없앨까요? 이 교재는 최근 수업 평균으로 추천돼요.",
    onDelete: async () => {
      try { await run(db.from("progress").update({ daily_min: null, daily_max: null, daily_unit: "leaf" }).eq("id", p.id)); } catch (e) { throw dailyErr(e); }
      await refresh(); toast("하루 추천 진도 범위를 없앴어요");
    },
    onSubmit: async () => {
      const dr = readDaily($("#dlg-form"));
      try { await run(db.from("progress").update(dr).eq("id", p.id)); } catch (e) { throw dailyErr(e); }
      await refresh();
      toast(dr.daily_min == null ? "하루 추천 진도 범위를 없앴어요" : "하루 추천 진도 범위를 저장했습니다");
    },
  });
  mountDaily("cd-rng", $("#dlg-form"), () => book, () => p.current_unit, p);
}

function changeNext(s, p, book) {
  const opts = [["", "(정하지 않음)"], ...state.textbooks.filter((b) => b.id !== book.id).map((b) => [b.id, b.title])];
  openForm({
    title: `다음 교재 · ${book.title}`,
    fields: [{ name: "next_textbook_id", label: "이 교재를 끝낸 뒤 이어서 할 교재", type: "select", options: opts }],
    values: { next_textbook_id: p.next_textbook_id || "" },
    onSubmit: async (d) => {
      try { await run(db.from("progress").update({ next_textbook_id: d.next_textbook_id || null }).eq("id", p.id)); }
      catch (e) { throw new Error(/next_textbook_id/i.test(e.message || "") ? "DB에 next_textbook_id 컬럼이 없어요. schema.sql을 한 번 실행해 주세요." : e.message); }
      await refresh();
      toast("다음 교재를 저장했습니다");
    },
  });
}

function changeDays(s, p, book) {
  const sel = new Set(dayList(p));
  openForm({
    title: `수업 요일 · ${book.title}`,
    fields: [{ name: "cd-days", type: "slot" }],
    deleteLabel: "배정 해제",
    deleteConfirm: `'${book.title}' 배정을 해제할까요? 진도 기록이 사라집니다.`,
    onDelete: async () => { await run(db.from("progress").delete().eq("id", p.id)); await refresh(); toast("배정을 해제했습니다"); },
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

function lessonForm(s, lesson, rec = null, preset = null) {
  const assigned = bookProgressFor(s.id).map((x) => x.book);
  const bookOf = (id) => state.textbooks.find((b) => b.id === id);
  const progOf = (id) => state.progress.find((x) => x.student_id === s.id && x.textbook_id === id);
  const autoFrom = (id) => {
    const bk = bookOf(id), pr = progOf(id);
    return bk && pr && pr.current_unit < bk.total_units ? pr.current_unit + 1 : null;
  };

  // 날짜의 요일에 배정된 교재만 기록할 수 있습니다 (요일을 지정하지 않은 교재는 모든 요일).
  const wdOf = (ds) => { const d = new Date(`${ds}T00:00:00`); return Number.isNaN(d.getTime()) ? null : d.getDay(); };
  let curAtt = (lesson && lesson.attendance) || (preset && preset.attendance) || "출석";
  const isMk = () => curAtt === "보강"; // 보강 수업은 요일과 상관없이 어떤 교재든 기록할 수 있습니다
  const dayItemsStrict = (wd) => bookProgressFor(s.id).filter((x) => !dayList(x.p).length || (wd != null && dayList(x.p).includes(wd)));
  const dayItems = (wd) => (isMk() ? bookProgressFor(s.id) : dayItemsStrict(wd));
  let pickOpen = false, pickQ = "";
  const defaultBlocks = (wd) => {
    const items = dayItemsStrict(wd);
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
    values = { lesson_date: (preset && preset.date) || (rec && rec.target_date) || todayStr(), attendance: (preset && preset.attendance) || "출석" };
    blocks = (preset && preset.blocks) || defaultBlocks(wdOf(values.lesson_date));
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
      const assignIds = new Set();
      let topicOnly = null;
      blocks.forEach((b, i) => {
        const hasText = b.topic && b.topic.trim();
        if (!b.textbook_id) {
          if (b.from_unit != null || b.to_unit != null) throw new Error(`교재 ${i + 1}: 단원 범위를 입력하려면 교재를 선택하세요.`);
          if (hasText) { if (i > 0 && !isMk()) throw new Error(`교재 ${i + 1}: 교재를 선택하세요.`); topicOnly = topicOnly ? { topic: `${topicOnly.topic.trim()} / ${b.topic.trim()}` } : b; }
          return;
        }
        const book = bookOf(b.textbook_id);
        if (!book) throw new Error(`교재 ${i + 1}: 교재를 찾을 수 없습니다.`);
        if (used.has(b.textbook_id)) throw new Error(`${book.title} 교재가 두 번 들어 있습니다. 한 블록으로 합쳐 주세요.`);
        used.add(b.textbook_id);
        if ([b.from_unit, b.to_unit].some((v) => v != null && v * 2 !== Math.round(v * 2))) throw new Error(`${book.title}: 단원 번호는 0.5 단위로 입력하세요. 예: 9, 9.5`);
        if (b.from_unit != null && b.to_unit != null && b.to_unit < b.from_unit - 0.5) throw new Error(`${book.title}: 종료 단원이 시작 단원보다 앞설 수 없습니다.`);
        if ((b.from_unit || 0) > book.total_units || (b.to_unit || 0) > book.total_units) throw new Error(`${book.title}: 전체 단원 수는 ${book.total_units}입니다.`);
        if (b.assign) assignIds.add(b.textbook_id);
        withBook.push({ textbook_id: b.textbook_id, from_unit: b.from_unit ?? null, to_unit: b.to_unit ?? null, topic: hasText ? b.topic.trim().slice(0, 200) : null });
      });
      if (topicOnly && withBook.length) withBook[0].topic = [withBook[0].topic, topicOnly.topic.trim()].filter(Boolean).join(" / ").slice(0, 200); // 교재 없이 적은 내용은 첫 교재의 학습 내용에 붙여 저장
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
      if (!lesson && newId && data.attendance === "보강") await completeMakeupFor(s.id, newId, data.lesson_date, preset && preset.makeupId);
      if (rec && newId) {
        for (const r of recGroup) {
          const b = withBook.find((x) => x.textbook_id === r.textbook_id);
          if (!b) continue; // 빼 둔 교재의 추천은 '제안' 그대로 둡니다
          const same = b.from_unit === r.from_unit && b.to_unit === r.to_unit;
          await run(db.from("recommendations").update({ status: same ? "채택" : "수정", applied_lesson_id: newId, decided_at: new Date().toISOString() }).eq("id", r.id));
        }
      }

      let synced = false;
      if (!lesson && (sync_progress || assignIds.size) && data.attendance !== "결석") {
        for (const b of withBook) {
          const pr = progOf(b.textbook_id);
          if (!pr) {
            if (!assignIds.has(b.textbook_id)) continue; // 배정 안 된 교재는 '배정' 체크를 했을 때만 진도를 만듭니다
            await run(db.from("progress").insert({ student_id: s.id, textbook_id: b.textbook_id, current_unit: b.to_unit ?? 0 }));
            synced = true;
          } else if (!sync_progress || b.to_unit == null) {
            continue;
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
  const unitField = (b, i, key, label) => {
    const book = bookOf(b.textbook_id);
    const role = key === "from_unit" ? "from" : "to";
    const lv = bookLeaves(book);
    const pick = lv
      ? `<select class="ls-pk1" data-i="${i}" data-k="${key}" data-pick aria-label="${label} 목록에서 고르기"><option value="">목록에서 고르기</option>${lv.map((l, n) => `<option value="${n + 1}">${esc(l.label)}</option>`).join("")}</select>`
      : "";
    return `<div><span class="cap">${label}</span>${unitStep(book, role, b[key], `data-i="${i}" data-k="${key}" aria-label="${label}"`)}${pick}</div>`;
  };
  const hintHtml = (book, b, i) => {
    const pr = progOf(book.id);
    const ok = b.from_unit != null && b.to_unit != null && b.from_unit >= 1 && b.to_unit >= b.from_unit - 0.5;
    return `<div class="ls-hint" data-hint="${i}">${pr ? `현재 진도 ${esc(curLabel(book, pr.current_unit))}` : isMk() ? `이 학생에게 배정되지 않은 교재예요 · 총 ${esc(book.total_units)}${bookLeaves(book) ? " 단원" : " " + esc(book.unit_label)}` : "배정이 해제된 교재예요"}${ok ? ` · 기록 <b>${esc(rangeText(book, { from_unit: b.from_unit, to_unit: b.to_unit }).trim())} (${esc(fmtN(amountN(b.from_unit, b.to_unit)))}단원)</b>` : ""}</div>`;
  };
  const paint = () => {
    const usedIds = new Set(blocks.map((b) => b.textbook_id).filter(Boolean));
    const allowed = dayItems(curWd);
    const skipped = isMk() ? [] : allowed.filter((x) => !usedIds.has(x.book.id));
    const dn = curWd != null ? DAY_NAME[curWd] + "요일 " : "";
    const blockHtml = blocks.map((b, i) => {
      const book = bookOf(b.textbook_id);
      const p = book ? progOf(book.id) : null;
      const pr = p;
      const hint = book ? hintHtml(book, b, i) : "";
      const days = p ? dayList(p) : [];
      return `<div class="ls-block">
        <div class="ls-head"><span class="tb-n">${i + 1}</span>
          <strong class="ls-name">${esc(book ? book.title : isMk() ? "교재 없이 내용만" : "교재 없음")}</strong>${book && !p && isMk() ? `<span class="ls-un">배정 안 된 교재</span>` : ""}
          ${book ? `${p ? `<span class="ls-kind">${days.length ? SCH_ORDER.filter((d) => days.includes(d)).map((d) => DAY_NAME[d]).join(" · ") : "모든 수업"}</span>` : ""}<span class="ls-kind">${bookLeaves(book) && bookLeaves(book).some((l) => l.child >= 0) ? "1레벨 → 2레벨" : "1레벨만"}</span>` : ""}
          <button type="button" class="btn small" data-ls="skip" data-i="${i}">${isMk() ? "빼기" : "오늘은 안 나감"}</button></div>
        ${book ? `<div class="ls-us-row">${unitField(b, i, "from_unit", "시작 단원")}${unitField(b, i, "to_unit", "종료 단원")}</div>${hint}` : ""}
        ${book && !p && isMk() && !lesson ? `<label class="ls-assign"><input type="checkbox" data-i="${i}" data-k="assign" ${b.assign ? "checked" : ""}><span>이 학생에게 이 교재도 배정하고 진도 올리기<small>체크하지 않으면 이 수업 기록에만 남고 교재 진도 탭은 그대로예요.</small></span></label>` : ""}
        <label>학습 내용 (예: 현재완료, 본문 읽기)<input type="text" maxlength="200" data-i="${i}" data-k="topic" value="${esc(b.topic || "")}"></label></div>`;
    }).join("");
    const skippedHtml = skipped.map((x) => `<div class="ls-skip"><strong>${esc(x.book.title)}</strong><span class="muted">오늘은 안 나감</span><button type="button" class="btn small" data-ls="addbook" data-id="${esc(x.book.id)}">+ 넣기</button></div>`).join("");
    const empty = !blocks.length && !skipped.length && !isMk()
      ? `<div class="ls-empty"><strong>${curWd != null ? DAY_NAME[curWd] + "요일에 " : ""}배정된 교재가 없어요</strong><span class="muted">교재 진도 탭에서 교재의 요일을 바꾸면 이 날에도 기록할 수 있어요. 진도 없이 출결·숙제·메모는 그대로 저장돼요.</span>${bookProgressFor(s.id).length ? `<span class="muted">현재 배정: ${bookProgressFor(s.id).map((x) => `${esc(x.book.title)} (${dayList(x.p).length ? SCH_ORDER.filter((d) => dayList(x.p).includes(d)).map((d) => DAY_NAME[d]).join("·") : "모든 수업"})`).join(", ")}</span>` : ""}</div>`
      : "";
    const nb = blocks.filter((b) => b.textbook_id).length;
    const addBar = isMk() ? `<div class="ls-addbar"><button type="button" class="btn ls-add" data-ls="pick">＋ 교재 추가</button>${blocks.some((b) => !b.textbook_id) ? "" : `<button type="button" class="btn ls-add quiet" data-ls="nobook">＋ 교재 없이 내용만</button>`}</div><div id="ls-pickwrap"></div>` : "";
    host.innerHTML = `${isMk() ? `<div class="ls-banner"><b>보강 수업</b>은 요일과 상관없이 어떤 교재든 추가할 수 있어요</div>` : curWd != null ? `<div class="ls-banner"><b>${DAY_NAME[curWd]}요일</b> 수업 교재만 기록할 수 있어요</div>` : ""}
      <div class="ls-title"><strong>${isMk() ? "" : dn}수업 교재 · 진도</strong><span class="muted">${isMk() ? `${nb}개 포함` : allowed.length ? `${allowed.length}개 중 ${nb}개 포함` : "0개"}</span></div>${blockHtml}${skippedHtml}${empty}${addBar}`;
    if (pickOpen) paintPick();
  };
  const hlq = (t, q) => { const i = q ? t.toLowerCase().indexOf(q.toLowerCase()) : -1; return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + q.length))}</mark>${esc(t.slice(i + q.length))}`; };
  const paintPick = () => {
    const wrap = host.querySelector("#ls-pickwrap");
    if (!wrap) return;
    if (!wrap.firstChild) {
      wrap.innerHTML = `<div class="ls-pick"><div class="ls-pk-top"><input type="search" id="ls-pkq" placeholder="교재 이름 검색" autocomplete="off" lang="ko"><button type="button" class="btn small" data-ls="pickclose">닫기</button></div><div id="ls-pklist"></div></div>`;
      const q = wrap.querySelector("#ls-pkq");
      q.value = pickQ;
      q.addEventListener("input", () => { pickQ = q.value.trim(); paintPick(); });
      q.focus();
      wrap.scrollIntoView({ block: "nearest" });
    }
    const used = new Set(blocks.map((b) => b.textbook_id).filter(Boolean));
    const match = (t) => !pickQ || t.toLowerCase().includes(pickQ.toLowerCase());
    const mine = bookProgressFor(s.id).filter((x) => match(x.book.title)).sort((a, b) => a.book.title.localeCompare(b.book.title, "ko"));
    const mineIds = new Set(bookProgressFor(s.id).map((x) => x.book.id));
    const others = state.textbooks.filter((b) => !mineIds.has(b.id) && match(b.title)).sort((a, b) => a.title.localeCompare(b.title, "ko"));
    const row = (b, sub) => `<div class="ls-pk-row ${used.has(b.id) ? "dim" : ""}"><div><b>${hlq(b.title, pickQ)}</b><small>${sub}</small></div>${used.has(b.id) ? `<span class="muted">이미 넣음</span>` : `<button type="button" class="btn small primary" data-ls="pickadd" data-id="${esc(b.id)}">넣기</button>`}</div>`;
    const total = (b) => `총 ${esc(b.total_units)}${bookLeaves(b) ? " 단원" : " " + esc(b.unit_label)}`;
    const dayTxt = (p) => (dayList(p).length ? SCH_ORDER.filter((d) => dayList(p).includes(d)).map((d) => DAY_NAME[d]).join("·") : "모든 수업");
    $("#ls-pklist").innerHTML =
      (mine.length ? `<div class="ls-pk-h">이 학생 교재 (${mine.length})</div>${mine.map((x) => row(x.book, `${dayTxt(x.p)} · 현재 ${esc(curLabel(x.book, x.p.current_unit))}`)).join("")}` : "") +
      (others.length ? `<div class="ls-pk-h">다른 교재 (${others.length}) · 배정 안 된 교재</div>${others.map((b) => row(b, total(b))).join("")}` : "") +
      (!mine.length && !others.length ? `<div class="ls-pk-empty">${pickQ ? `"${esc(pickQ)}"에 맞는 교재가 없어요.` : "등록된 교재가 없어요."}<br><span class="muted">찾는 교재가 없으면 교재 관리에서 먼저 등록하세요.</span></div>` : `<div class="ls-pk-foot muted">찾는 교재가 없나요? 교재 관리에서 먼저 등록하세요.</div>`);
  };
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ls]");
    if (!b) return;
    if (b.dataset.ls === "pick") { pickOpen = !pickOpen; pickQ = ""; paint(); return; }
    if (b.dataset.ls === "pickclose") { pickOpen = false; paint(); return; }
    if (b.dataset.ls === "pickadd") { blocks.push({ textbook_id: b.dataset.id, from_unit: autoFrom(b.dataset.id), to_unit: null, topic: "" }); paint(); return; }
    if (b.dataset.ls === "nobook") { blocks.push({ textbook_id: "", from_unit: null, to_unit: null, topic: "" }); paint(); return; }
    if (b.dataset.ls === "skip") blocks.splice(Number(b.dataset.i), 1);
    else if (b.dataset.ls === "addbook") blocks.push({ textbook_id: b.dataset.id, from_unit: autoFrom(b.dataset.id), to_unit: null, topic: "" });
    paint();
  });
  const attEl = $("#dlg-form [name='attendance']");
  let prevAtt = curAtt;
  attEl.addEventListener("change", () => {
    const next = attEl.value;
    if (next === prevAtt) return;
    if (prevAtt === "보강") {
      const okIds = new Set(dayItemsStrict(curWd).map((x) => x.book.id));
      const off = blocks.filter((b) => b.textbook_id && !okIds.has(b.textbook_id));
      if (off.length && !confirm(`보강이 아니면 ${curWd != null ? DAY_NAME[curWd] + "요일 " : ""}교재만 기록할 수 있어요. 다른 교재 ${off.length}개는 빠져요. 계속할까요?`)) { attEl.value = prevAtt; return; }
      blocks = blocks.filter((b) => !b.textbook_id || okIds.has(b.textbook_id));
      pickOpen = false;
    }
    curAtt = prevAtt = next;
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
    if (el.dataset.pick !== undefined) {
      if (el.value !== "") { b[k] = Number(el.value); paint(); }
      return;
    }
    if (k === "textbook_id") { b.textbook_id = el.value; b.from_unit = el.value ? autoFrom(el.value) : null; b.to_unit = null; paint(); return; }
    if (k === "assign") { b.assign = el.checked; return; }
    if (k === "topic") b.topic = el.value;
    else {
      b[k] = el.value === "" ? null : Number(el.value);
      if (k === "from_unit" || k === "to_unit") {
        const bk = bookOf(b.textbook_id), h = host.querySelector(`[data-hint="${el.dataset.i}"]`);
        if (bk && h) h.outerHTML = hintHtml(bk, b, Number(el.dataset.i)); // 칸을 다시 그리지 않고 안내 줄만 갱신
      }
    }
  };
  host.addEventListener("input", onField);
  host.addEventListener("change", onField);
  paint();
}

/* ---------- 데이터 백업 (엑셀 한 파일, 파일 이름에 받은 시각) ---------- */
const BACKUP_TABLES = [
  ["students", "학생"], ["textbooks", "교재"], ["progress", "교재 진도"], ["lessons", "수업 기록"], ["tests", "시험 점수"],
  ["recommendations", "수업 추천"], ["makeups", "결석·보강"], ["makeup_quota", "보강 기준"], ["monthly_evaluations", "월말 평가서"],
  ["schedule_slots", "시간표"], ["test_kinds", "시험 종류"], ["report_logs", "안내문 발송 기록"], ["writings", "라이팅 첨삭"],
];
async function fetchAllRows(table) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await run(db.from(table).select("*").order("id").range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}
function backupName() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `rachel-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.xlsx`;
}
function renderBackup() {
  const main = $("#main");
  main.innerHTML = `
    <div class="page-head"><h2>데이터 백업</h2><span class="muted">학생·수업·시험 기록 전체를 엑셀 파일 하나로 내려받아 보관해요</span></div>
    <div class="card bk-card"><strong>들어가는 내용</strong> <span class="muted">지금 저장된 전체</span>
      <div class="bk-grid" id="bk-grid">${BACKUP_TABLES.map(([t, n]) => `<div data-bk="${t}"><span>${esc(n)}</span><span class="muted">…</span></div>`).join("")}</div></div>
    <div class="card bk-card" id="bk-act">
      <div class="bk-row"><button class="btn primary" type="button" id="bk-go">지금 백업 받기</button><span class="muted">내 기기의 다운로드 폴더에 저장돼요</span></div></div>
    <p class="muted" style="font-size:.85rem;line-height:1.6;margin:.2rem 0">파일 이름에 받은 날짜와 시각이 들어가서, 언제 받은 백업인지 이름만 보고 알 수 있어요. 학생 정보가 들어 있으니 USB나 구글 드라이브처럼 안전한 곳에 한 부 더 보관하고, 한 달에 한 번쯤 받아 두는 걸 권해요. 이 파일로 앱에 다시 불러오는 기능은 아직 없고, 기록을 확인하거나 문제가 생겼을 때 참고하는 용도예요.</p>`;
  // 건수는 가볍게 따로 세서 보여줌 (실패해도 백업에는 영향 없음)
  BACKUP_TABLES.forEach(async ([t]) => {
    let txt = "—";
    try { txt = `${(await run(db.from(t).select("id"))).length}건`; } catch { /* 표가 없는 DB */ }
    if (state.view !== "backup") return;
    const el = main.querySelector(`[data-bk="${t}"] .muted`);
    if (el) el.textContent = txt;
  });
  $("#bk-go").onclick = runBackup;
}
async function runBackup() {
  const act = $("#bk-act");
  const prog = (n, label) => { act.innerHTML = `<div class="bk-prog"><div class="bk-row"><b>${esc(label)} 내려받는 중…</b><span class="spacer"></span><span class="muted">${n} / ${BACKUP_TABLES.length}</span></div><div class="bk-bar"><i style="width:${Math.round((n / BACKUP_TABLES.length) * 100)}%"></i></div><div class="muted" style="font-size:.85rem">창을 닫지 말고 잠시 기다려 주세요.</div></div>`; };
  try {
    prog(0, "준비");
    const X = await loadXlsx();
    const data = {}, skipped = [];
    for (let i = 0; i < BACKUP_TABLES.length; i++) {
      const [t, label] = BACKUP_TABLES[i];
      prog(i, label);
      try { data[t] = await fetchAllRows(t); } catch { data[t] = null; skipped.push(label); }
    }
    const sName = new Map((data.students || []).map((s) => [s.id, s.name]));
    const bName = new Map((data.textbooks || []).map((b) => [b.id, b.title]));
    const cell = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : v);
    const wb = new X.Workbook();
    const info = wb.addWorksheet("안내");
    const now = new Date();
    info.addRow(["Rachel English 데이터 백업"]).font = { bold: true, size: 14 };
    info.addRow(["받은 시각", `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`]);
    info.addRow(["안내", "표마다 시트가 나뉘어 있어요. 열 이름은 저장소의 이름 그대로이고, 학생·교재 열은 이름을 함께 적었어요."]);
    info.addRow([]);
    BACKUP_TABLES.forEach(([t, label]) => info.addRow([label, data[t] ? `${data[t].length}건` : "받지 못함"]));
    info.getColumn(1).width = 22; info.getColumn(2).width = 90;
    BACKUP_TABLES.forEach(([t, label]) => {
      const rows = data[t];
      if (!rows) return;
      const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== "owner");
      const extra = [];
      if (keys.includes("student_id")) extra.push("학생");
      if (keys.includes("textbook_id")) extra.push("교재");
      const ws = wb.addWorksheet(label.slice(0, 31));
      ws.addRow([...extra, ...keys]).font = { bold: true };
      rows.forEach((r) => ws.addRow([...extra.map((e) => (e === "학생" ? sName.get(r.student_id) || "" : bName.get(r.textbook_id) || "")), ...keys.map((k) => cell(r[k]))]));
      ws.views = [{ state: "frozen", ySplit: 1 }];
      [...extra, ...keys].forEach((_, i) => { ws.getColumn(i + 1).width = 16; });
    });
    prog(BACKUP_TABLES.length, "파일 만드는");
    const buf = await wb.xlsx.writeBuffer();
    const name = backupName();
    saveBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name);
    const n = (t) => (data[t] ? data[t].length : 0);
    act.innerHTML = `<div class="bk-done"><b>${esc(name)}</b> 파일을 저장했어요. 학생 ${n("students")}명 · 수업 기록 ${n("lessons")}건 · 시험 점수 ${n("tests")}건이 들어 있어요. 이 파일은 USB나 구글 드라이브 같은 다른 곳에도 한 부 두세요.${skipped.length ? `<br>받지 못한 항목: ${esc(skipped.join(", "))}` : ""}</div>
      <div class="bk-row" style="margin-top:.7rem"><button class="btn" type="button" id="bk-go">한 번 더 받기</button></div>`;
    $("#bk-go").onclick = runBackup;
  } catch (e) {
    act.innerHTML = `<div class="bk-row"><button class="btn primary" type="button" id="bk-go">지금 백업 받기</button></div>`;
    $("#bk-go").onclick = runBackup;
    fail(e, "백업 실패");
  }
}

/* ---------- 시험 종류 관리 (공통) ---------- */
async function loadKindCounts() {
  const rows = await run(db.from("tests").select("kind").limit(20000));
  const c = {};
  rows.forEach((t) => { c[t.kind] = (c[t.kind] || 0) + 1; });
  state.kinds.counts = c;
}
function renderKinds() {
  const main = $("#main");
  const all = kindList();
  const kq = (state.kinds.q || "").trim().toLowerCase();
  const list = kq ? all.filter((k) => k.name.toLowerCase().includes(kq) || (k.memo || "").toLowerCase().includes(kq)) : all;
  const hlk = (t) => {
    const i = kq ? t.toLowerCase().indexOf(kq) : -1;
    return i < 0 ? esc(t) : `${esc(t.slice(0, i))}<mark>${esc(t.slice(i, i + kq.length))}</mark>${esc(t.slice(i + kq.length))}`;
  };
  const dot = (k) => `<span class="kd-dot${!k.color ? ` k${kindIndex(k.name)}` : ""}"${k.color ? ` style="background:${esc(k.color)}"` : ""}></span>`;
  const rows = list.map((k) => {
    const n = state.kinds.counts[k.name] || 0;
    const key = k.builtin ? `data-kbuiltin="${esc(k.name)}"` : `data-kedit="${esc(k.id)}"`;
    return `<div class="card kd-row${k.builtin ? "" : " mine"}">${dot(k)}<strong class="kd-name">${hlk(k.name)}</strong>
      <span class="muted">기본 만점 ${k.max}${esc(k.unit)} · 기록 ${n}건${k.memo ? ` · ${hlk(k.memo)}` : ""}</span><span class="spacer"></span>
      ${k.builtin ? `<span class="muted kd-tag">기본 종류</span>` : ""}
      <button class="btn small" type="button" ${key} ${state.kinds.missing ? "disabled" : ""}>수정</button>
      ${k.builtin ? (k.over ? `<button class="btn small" type="button" data-kreset="${esc(k.id)}">처음 설정으로</button>` : "")
        : `<button class="btn small danger" type="button" data-kdel="${esc(k.id)}" ${n ? `disabled title="기록이 있어 삭제할 수 없어요"` : all.length < 2 ? `disabled title="종류가 하나는 있어야 해요"` : ""}>삭제</button>`}</div>`;
  }).join("");
  main.innerHTML = `
    <div class="page-head"><h2>시험 종류</h2><span class="muted">[+ 시험 점수]의 '종류'에 나오는 목록입니다. 모든 학생이 함께 씁니다.</span><span class="spacer"></span>
      <button class="btn primary" type="button" id="kd-add" ${state.kinds.missing ? "disabled" : ""}>+ 종류 추가</button></div>
    ${state.kinds.missing ? `<div class="card empty">시험 종류 저장소(test_kinds 테이블)가 아직 없어요. schema.sql의 '시험 종류' 부분을 Supabase에서 한 번 실행해 주세요.</div>` : ""}
    ${all.length ? `<div class="tb-search"><input type="search" id="kd-q" placeholder="종류 이름 검색" autocomplete="off" aria-label="시험 종류 검색" value="${esc(state.kinds.q || "")}"><span class="muted">${kq ? `${list.length}/${all.length}개` : `전체 ${all.length}개`}</span></div>` : ""}
    <div class="kd-list">${rows || (kq ? `<div class="tb-empty">"${esc(state.kinds.q.trim())}"에 해당하는 종류가 없어요.<br><button type="button" class="linklike" id="kd-add-q">"${esc(state.kinds.q.trim())}" 종류 추가</button></div>` : "")}</div>
    <p class="muted" style="font-size:.85rem">단위(점·개 등)는 종류마다 정하고, 그래프는 항상 백분율(%)로 보여줍니다. 이름·색·단위·만점은 모두 고칠 수 있고, 기록이 없는 종류는 삭제할 수 있어요. 이름을 바꾸면 기존 기록의 종류도 함께 바뀝니다.</p>`;
  $("#kd-add").onclick = () => kindForm(null);
  const kqi = $("#kd-q");
  if (kqi) {
    kqi.oninput = () => { state.kinds.q = kqi.value; const pos = kqi.selectionStart; renderKinds(); const n = $("#kd-q"); if (n) { n.focus(); n.setSelectionRange(pos, pos); } };
  }
  const kaq = $("#kd-add-q");
  if (kaq) kaq.onclick = () => { const t = state.kinds.q.trim(); state.kinds.q = ""; kindForm(null, undefined, t); };
  main.querySelectorAll("[data-kedit]").forEach((b) => (b.onclick = () => kindForm(state.kinds.rows.find((k) => k.id === b.dataset.kedit))));
  main.querySelectorAll("[data-kbuiltin]").forEach((b) => (b.onclick = () => {
    const name = b.dataset.kbuiltin;
    kindForm(state.kinds.rows.find((k) => k.name === name) || null, name);
  }));
  main.querySelectorAll("[data-kreset]").forEach((b) => (b.onclick = async () => {
    if (!confirm("이 기본 종류의 단위·만점을 처음 설정(점, 100)으로 되돌릴까요?")) return;
    try {
      await run(db.from("test_kinds").delete().eq("id", b.dataset.kreset));
      await loadKinds();
      renderKinds();
      toast("처음 설정으로 되돌렸습니다");
    } catch (e) { fail(e); }
  }));
  main.querySelectorAll("[data-kdel]").forEach((b) => (b.onclick = async () => {
    const k = state.kinds.rows.find((x) => x.id === b.dataset.kdel);
    if (!k || !confirm(`'${k.name}' 종류를 삭제할까요?`)) return;
    try {
      await loadKindCounts();
      if (state.kinds.counts[k.name]) throw new Error("기록이 있는 종류는 삭제할 수 없어요.");
      await run(db.from("test_kinds").delete().eq("id", k.id));
      await loadKinds();
      renderKinds();
      toast("삭제했습니다");
    } catch (e) { fail(e); }
  }));
}
/* k: 저장된 행(없으면 null), bn: 기본 종류 이름(기본 종류를 처음 수정할 때) */
function kindForm(k, bn, presetName) {
  const builtin = !!bn;
  const cur = (k && k.color) || KIND_COLORS[0];
  const UNITS = ["점", "개", "문항", "%"];
  openForm({
    title: builtin ? `기본 종류 수정 · ${bn}` : k ? "시험 종류 수정" : "시험 종류 추가",
    fields: [
      { name: "name", label: "종류 이름", required: true, maxlength: 30 },
      { name: "default_max", label: "기본 만점", type: "number", min: 1, step: "any", required: true, half: true },
      { name: "unit", label: "단위 (점·개 등 자유롭게)", required: true, maxlength: 8, half: true },
      { name: "kunits", type: "slot" },
      ...(builtin ? [] : [{ name: "kcolor", type: "slot" }]),
      { name: "memo", label: "메모 (선택)", maxlength: 100 },
    ],
    values: { name: bn || (k && k.name) || presetName || "", default_max: k ? k.default_max : 100, unit: (k && k.unit) || "점", memo: k && k.memo },
    onSubmit: async (d) => {
      const name = builtin ? bn : (d.name || "").trim();
      if (!builtin && kindList().some((x) => x.name === name && (!k || x.id !== k.id))) throw new Error("같은 이름의 종류가 이미 있어요.");
      const unit = (d.unit || "").trim() || "점";
      const color = builtin ? (k && k.color) || null : ($("#dlg-form").querySelector('input[name="kc"]:checked') || {}).value || KIND_COLORS[0];
      const row = { name, default_max: d.default_max, unit, color, memo: d.memo };
      const oldName = k && k.name;
      const save = async (r) => (k ? run(db.from("test_kinds").update(r).eq("id", k.id)) : run(db.from("test_kinds").insert(r)));
      try {
        await save(row);
      } catch (e) {
        if (!/unit/i.test(e.message || "")) throw e;
        const { unit: _u, ...rest } = row; // unit 컬럼이 아직 없는 DB
        await save(rest);
        toast("DB에 unit 컬럼이 없어 단위는 저장되지 않았어요 (schema.sql 실행 필요)");
      }
      if (k && !builtin && oldName !== name) await run(db.from("tests").update({ kind: name }).eq("kind", oldName));
      await loadKinds();
      await loadKindCounts();
      if (state.view === "kinds") renderKinds();
      toast("저장했습니다");
    },
  });
  const nm = $("#dlg-form").elements.name;
  if (nm && builtin) nm.readOnly = true;
  const un = $("#dlg-form").elements.unit;
  $("#kunits").innerHTML = `<div class="kd-units"><span class="muted">자주 쓰는 단위</span>${UNITS.map((u) => `<button type="button" class="btn small" data-u="${u}">${u}</button>`).join("")}</div>`;
  $("#kunits").onclick = (e) => { const b = e.target.closest("[data-u]"); if (b) { un.value = b.dataset.u; un.focus(); } };
  const kc = $("#kcolor");
  if (kc) kc.innerHTML = `<div class="kd-colors" role="radiogroup" aria-label="그래프 색"><span class="muted">그래프 색</span>${KIND_COLORS.map((c, i) => `<label class="kd-sw"><input type="radio" name="kc" value="${c}" ${c === cur || (!k && i === 0) ? "checked" : ""} aria-label="색 ${i + 1}"><span style="background:${c}"></span></label>`).join("")}</div>`;
}

function testForm(s, test) {
  const kl = kindList();
  const kindOpts = kl.map((k) => k.name);
  if (test && test.kind && !kindOpts.includes(test.kind)) kindOpts.push(test.kind);
  openForm({
    title: test ? "시험 점수 수정" : "시험 점수",
    fields: [
      { name: "test_date", label: "날짜", type: "date", required: true, half: true },
      { name: "kind", label: "종류", type: "select", options: kindOpts.map((x) => [x, x]), half: true },
      { name: "title", label: "시험 이름 (예: Unit 5 단어)", maxlength: 100 },
      { name: "score", label: "점수", type: "number", min: 0, step: "any", required: true, half: true },
      { name: "max_score", label: "만점", type: "number", min: 1, step: "any", required: true, half: true },
    ],
    values: test || { test_date: todayStr(), kind: kl[0].name, max_score: kl[0].max },
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
  const F = $("#dlg-form").elements, ksel = F.kind, msel = F.max_score, ssel = F.score;
  const setLbl = (el, text) => { const l = el && el.closest("label"); if (l && l.firstChild) l.firstChild.textContent = text; };
  const unitLabels = () => {
    const k = kl.find((x) => x.name === ksel.value);
    const u = (k && k.unit) || kindUnit(ksel.value);
    setLbl(ssel, `점수 (${u})`);
    setLbl(msel, `만점 (${u}) · 기본 ${k ? k.max : 100}`);
  };
  if (ksel && msel) {
    ksel.onchange = () => { if (!test) { const k = kl.find((x) => x.name === ksel.value); if (k) msel.value = k.max; } unitLabels(); };
    unitLabels();
  }
}

/* ---------- 시험·단어 엑셀: 양식 다운로드 / 업로드 ----------
   양식: 날짜 · 종류 · 시험 이름 · 점수 · 만점 (한 줄이 시험 한 건). 종류는 목록에서 고르고, 만점을 비우면 그 종류의 기본 만점. */
const XLT_HEAD = ["날짜", "종류", "시험 이름", "점수", "만점", "구분"];
async function downloadTestTemplate(s) {
  const X = await loadXlsx();
  const kl = kindList();
  const wb = new X.Workbook();
  const ws = wb.addWorksheet("점수입력");
  const info = wb.addWorksheet("안내");
  const lst = wb.addWorksheet("종류목록");
  lst.addRow(["종류", "기본 만점", "단위"]);
  lst.getRow(1).font = { bold: true };
  kl.forEach((k) => lst.addRow([k.name, k.max, k.unit]));
  [16, 12, 8].forEach((w, i) => { lst.getColumn(i + 1).width = w; });
  const kindRef = `종류목록!$A$2:$A$${kl.length + 1}`;

  ws.addRow(XLT_HEAD);
  ws.getRow(1).height = 24;
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2C47" } };
    c.alignment = { horizontal: "center", vertical: "middle" };
  });
  const thin = { style: "thin", color: { argb: "FFD3DBE7" } };
  const grey = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF1F6" } };
  const ex = ws.addRow([utcD(todayStr()), kl[0].name, "Unit 7 단어", 28, 30, "예시"]);
  ex.eachCell({ includeEmpty: true }, (c) => { c.fill = grey; c.font = { italic: true, color: { argb: "FF8B95A5" } }; });
  for (let i = 0; i < 100; i++) ws.addRow([null, null, null, null, null, null]);
  ws.eachRow({ includeEmpty: true }, (row, rn) => {
    if (rn === 1) return;
    row.eachCell({ includeEmpty: true }, (c) => { c.border = { top: thin, left: thin, bottom: thin, right: thin }; });
    row.getCell(1).numFmt = "yyyy-mm-dd";
    row.getCell(2).dataValidation = { type: "list", allowBlank: true, formulae: [kindRef] };
  });
  [14, 14, 28, 10, 10, 8].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  ws.views = [{ state: "frozen", ySplit: 1 }];

  [["시험·단어 업로드 양식", ""], ["", ""], ["학생", `${s.name}${s.grade ? ` (${s.grade})` : ""}`], ["", ""], ["작성 방법", ""],
    ["1", "[점수입력] 시트에 시험 한 건을 한 줄씩 적습니다. 맨 위 회색 줄(구분 칸에 '예시')은 예시라서 업로드할 때 무시됩니다."],
    ["2", "날짜는 2026-10-21 처럼 적습니다. 엑셀 날짜 칸이어도 됩니다."],
    ["3", "종류는 칸의 ▼ 목록에서 고릅니다. 목록에 없는 이름은 오류로 표시됩니다. ([종류목록] 시트 참고, 앱의 '시험 종류'에서 추가할 수 있어요)"],
    ["4", "점수는 숫자만 적습니다. 만점을 비우면 그 종류의 기본 만점이 들어갑니다."],
    ["5", "시험 이름은 비워도 됩니다."],
    ["6", "이미 같은 날짜·종류·이름의 기록이 있으면 업로드할 때 건너뛰거나 덮어쓸지 고를 수 있습니다."]].forEach((r) => info.addRow(r));
  info.getCell("A1").font = { bold: true, size: 16 };
  info.getColumn(1).width = 12; info.getColumn(2).width = 95;
  [3, 5].forEach((n) => { info.getCell(`A${n}`).font = { bold: true }; });

  const buf = await wb.xlsx.writeBuffer();
  saveBlob(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `시험점수_양식_${String(s.name).replace(/[\\/:*?"<>|]/g, "_")}.xlsx`);
  toast("양식을 내려받았습니다");
}
async function readTestSheet(s, file) {
  const X = await loadXlsx();
  const wb = new X.Workbook();
  try { await wb.xlsx.load(await file.arrayBuffer()); } catch { throw new Error("엑셀 파일(.xlsx)을 읽지 못했습니다."); }
  const ws = wb.getWorksheet("점수입력") || wb.worksheets.find((w) => w.name !== "안내" && w.name !== "종류목록");
  if (!ws) throw new Error("[점수입력] 시트를 찾을 수 없습니다. '양식 다운로드'로 받은 파일을 쓰세요.");
  const head = {};
  ws.getRow(1).eachCell((c, i) => { head[xlCellText(c)] = i; });
  if (["날짜", "종류", "점수"].some((k) => !head[k])) throw new Error("양식 열(날짜·종류·점수)을 찾을 수 없습니다. '양식 다운로드'로 받은 파일을 쓰세요.");
  const get = (row, k) => (head[k] ? xlCellText(row.getCell(head[k])) : "");
  const kl = kindList();
  const existing = await run(db.from("tests").select("id, test_date, kind, title").eq("student_id", s.id).limit(5000));
  const keyOf = (d, k, t) => `${d}|${k}|${(t || "").trim()}`;
  const exist = new Map(existing.map((t) => [keyOf(t.test_date, t.kind, t.title), t.id]));
  const seen = new Set();
  const rows = [];
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    if (get(row, "구분") === "예시") return;
    const r = { rn, dateRaw: get(row, "날짜"), kind: get(row, "종류"), title: get(row, "시험 이름"), scoreRaw: get(row, "점수"), maxRaw: get(row, "만점") };
    if (!r.dateRaw && !r.kind && !r.title && !r.scoreRaw && !r.maxRaw) return; // 완전히 빈 줄
    rows.push(r);
  });
  const num = (t) => (t === "" ? NaN : Number(String(t).replace(/,/g, "")));
  rows.forEach((r) => {
    const bad = (msg) => { r.status = "error"; r.msg = msg; };
    r.date = xlDate(r.dateRaw);
    if (!r.date) return bad(`날짜 '${r.dateRaw || "비어 있음"}' 을(를) 읽을 수 없어요`);
    const k = kl.find((x) => x.name === r.kind);
    if (!r.kind) return bad("종류를 골라 주세요");
    if (!k) return bad("종류 목록에 없어요");
    r.score = num(r.scoreRaw);
    if (!Number.isFinite(r.score) || r.score < 0) return bad(r.scoreRaw ? "점수는 0 이상의 숫자여야 해요" : "점수가 비어 있어요");
    r.max = r.maxRaw === "" ? k.max : num(r.maxRaw);
    if (!Number.isFinite(r.max) || r.max <= 0) return bad("만점은 0보다 큰 숫자여야 해요");
    if (r.score > r.max) return bad("점수가 만점보다 커요");
    r.unit = k.unit;
    r.title = r.title.slice(0, 100);
    const key = keyOf(r.date, r.kind, r.title);
    if (seen.has(key)) { r.status = "skip"; r.msg = "위에 같은 줄이 있어요"; return; }
    seen.add(key);
    r.existingId = exist.get(key) || null;
    r.status = "ok";
  });
  const stu = wb.getWorksheet("안내") ? xlCellText(wb.getWorksheet("안내").getCell("B3")) : "";
  return { fileName: file.name, studentName: stu, match: !stu ? null : stu.startsWith(s.name), rows };
}
function xlTestPreviewHtml(res, dupMode) {
  const errN = res.rows.filter((r) => r.status === "error").length;
  const dupN = res.rows.filter((r) => r.status === "ok" && r.existingId).length;
  const skipN = res.rows.filter((r) => r.status === "skip" || (r.status === "ok" && r.existingId && dupMode === "skip")).length;
  const saveN = res.rows.filter((r) => r.status === "ok" && !(r.existingId && dupMode === "skip")).length;
  const body = res.rows.map((r) => {
    const wd = r.date ? DAY_NAME[parseD(r.date).getDay()] : "";
    const dupSkipped = r.status === "skip" || (r.status === "ok" && r.existingId && dupMode === "skip");
    const st = r.status === "error" ? `<span class="badge bad">오류</span><div class="xl-msg">${esc(r.msg)}</div>`
      : dupSkipped ? `<span class="badge">건너뜀</span><div class="xl-msg muted">${esc(r.msg || "이미 같은 기록 있음")}</div>`
      : `<span class="badge done">저장</span>${r.existingId ? `<div class="xl-msg muted">덮어쓰기</div>` : ""}`;
    const sc = r.status === "error" && !Number.isFinite(r.score) ? esc(r.scoreRaw) : `${r.score}/${r.max}${esc(r.unit || "")}`;
    const p = r.status !== "error" && Number.isFinite(r.score) && Number.isFinite(r.max) && r.max > 0 ? `${pct(r.score, r.max).toFixed(0)}%` : "";
    return `<tr class="${r.status === "error" ? "xl-err" : ""}"><td style="white-space:nowrap">${r.date ? `<b>${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}</b> (${wd})` : esc(r.dateRaw)}</td>
      <td>${esc(r.kind)}</td><td>${esc(r.title || "")}</td><td class="num">${sc}</td><td class="num">${p}</td><td>${st}</td></tr>`;
  }).join("");
  return `
    <div class="xl-file"><b>${esc(res.fileName)}</b><span class="muted">${res.studentName ? "양식 학생 " + esc(res.studentName) : "학생 정보 없음"}</span><span class="spacer"></span>
      ${res.match === false ? '<span class="badge bad">학생 다름</span>' : res.match ? '<span class="badge done">학생 일치</span>' : ""}</div>
    ${res.match === false ? '<p class="xl-warn">이 양식은 다른 학생의 것으로 보여요. 맞는지 확인하고 저장하세요.</p>' : ""}
    <div class="xl-sum"><div class="ok"><span>저장</span><b>${saveN}건</b></div><div><span>건너뜀</span><b>${skipN}건</b></div><div class="${errN ? "err" : ""}"><span>확인 필요</span><b>${errN}건</b></div></div>
    ${errN ? '<p class="xl-warn">확인 필요 줄은 저장되지 않아요. 엑셀에서 고쳐 다시 올리거나, 나머지만 저장할 수 있어요.</p>' : ""}
    ${body ? `<div class="card table-wrap xl-tbl"><table><thead><tr><th>날짜</th><th>종류</th><th>이름</th><th class="num">점수</th><th class="num">백분율</th><th>상태</th></tr></thead><tbody>${body}</tbody></table></div>` : '<div class="card empty">입력된 내용이 없습니다.</div>'}
    ${dupN ? `<p class="muted xl-dup">이미 같은 기록이 있는 줄 ${dupN}건이 있어요.</p>` : ""}`;
}
async function uploadTestSheet(s, file) {
  const res = await readTestSheet(s, file);
  let dupMode = "skip";
  const dupN = res.rows.filter((r) => r.status === "ok" && r.existingId).length;
  const count = () => res.rows.filter((r) => r.status === "ok" && !(r.existingId && dupMode === "skip")).length;
  const fields = [{ name: "xlt-prev", type: "slot" }];
  if (dupN) fields.push({ name: "dup", label: "이미 같은 기록이 있는 줄 (날짜·종류·이름이 같은 것)", type: "select", options: [["skip", "건너뛰기 (기존 기록 유지)"], ["overwrite", "덮어쓰기 (엑셀 점수로 바꿈)"]] });
  openForm({
    title: "엑셀 업로드 · 시험·단어",
    wide: true,
    fields,
    values: {},
    submitLabel: `${count()}건 저장`,
    onSubmit: async (d) => {
      const dup = d.dup || "skip";
      const targets = res.rows.filter((r) => r.status === "ok" && !(r.existingId && dup === "skip"));
      if (!targets.length) throw new Error("저장할 내용이 없습니다. 오류 줄을 고치거나 덮어쓰기를 고르세요.");
      const fresh = targets.filter((r) => !r.existingId).map((r) => ({ student_id: s.id, test_date: r.date, kind: r.kind, title: r.title || null, score: r.score, max_score: r.max }));
      if (fresh.length) await run(db.from("tests").insert(fresh));
      for (const r of targets.filter((x) => x.existingId)) await run(db.from("tests").update({ score: r.score, max_score: r.max }).eq("id", r.existingId));
      await refresh();
      toast(`시험 점수 ${targets.length}건을 저장했습니다`);
    },
  });
  $("#xlt-prev").innerHTML = xlTestPreviewHtml(res, dupMode);
  const sel = $("#dlg-form").elements.dup;
  if (sel) sel.onchange = () => { dupMode = sel.value; $("#xlt-prev").innerHTML = xlTestPreviewHtml(res, dupMode); $("#dlg-submit").textContent = `${count()}건 저장`; };
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
/* ---------- 라이팅 첨삭 ---------- */
// 학생이 쓴 영어 글의 사진·문서를 올리면 Worker(/api/correct)가 Claude 로 원문을 읽고 문장별로 첨삭합니다.
// 원본은 비공개 Storage 버킷 'writings', 결과는 writings 테이블에 저장합니다. (schema.sql 마지막 부분)
const WR_TYPES = { grammar: "문법", spelling: "철자", vocabulary: "어휘", punctuation: "문장부호", capitalization: "대소문자", word_order: "어순", expression: "표현" };
const WR_SCORES = [["content", "내용"], ["grammar", "문법"], ["vocabulary", "어휘"], ["organization", "구성"]];
const WR_MAX_SIDE = 2000;           // 사진은 긴 변을 이 크기로 줄여서 보냄
const WR_MAX_FILES = 8;
const WR_MAX_PDF = 8 * 1024 * 1024;

function wrBlobBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("파일을 읽지 못했어요"));
    r.readAsDataURL(blob);
  });
}
async function wrImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`${file.name}: 이 사진 형식은 열 수 없어요. JPG나 PNG로 올려 주세요`);
  }
  const k = Math.min(1, WR_MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return { kind: "image", name: file.name, type: "image/jpeg", blob, data: await wrBlobBase64(blob) };
}
// .docx 는 zip 파일이라 브라우저 기능(DecompressionStream)만으로 본문(word/document.xml)을 꺼내 글자만 뽑는다.
async function wrDocx(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let e = buf.length - 22;
  while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error(`${file.name}: 워드(.docx) 파일이 아니에요`);
  const count = dv.getUint16(e + 10, true);
  let p = dv.getUint32(e + 16, true);
  for (let i = 0; i < count && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nlen));
    if (name === "word/document.xml") {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const data = buf.subarray(start, start + csize);
      let bytes = data;
      if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
      else if (method !== 0) throw new Error(`${file.name}: 열 수 없는 워드 파일이에요`);
      const ent = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      return new TextDecoder().decode(bytes)
        .replace(/<w:tab\/>/g, "\t").replace(/<w:br[^>]*\/>/g, "\n").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")
        .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, g) => (g[0] === "#" ? String.fromCodePoint(g[1].toLowerCase() === "x" ? parseInt(g.slice(2), 16) : Number(g.slice(1))) : ent[g.toLowerCase()]))
        .replace(/\n{3,}/g, "\n\n").trim();
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${file.name}: 워드 파일에서 글을 찾지 못했어요`);
}
async function wrPrepare(file) {
  const name = file.name || "";
  if (file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name)) return wrImage(file);
  if (file.type === "application/pdf" || /\.pdf$/i.test(name)) {
    if (file.size > WR_MAX_PDF) throw new Error(`${name}: PDF가 너무 커요 (8MB까지)`);
    return { kind: "pdf", name, type: "application/pdf", blob: file, data: await wrBlobBase64(file) };
  }
  if (/\.docx$/i.test(name)) {
    const text = await wrDocx(file);
    if (!text) throw new Error(`${name}: 문서에 글이 없어요. 손글씨 사진이라면 사진으로 올려 주세요`);
    return { kind: "text", name, text };
  }
  if (file.type === "text/plain" || /\.txt$/i.test(name)) {
    const text = (await file.text()).trim();
    if (!text) throw new Error(`${name}: 파일이 비어 있어요`);
    return { kind: "text", name, text };
  }
  throw new Error(`${name}: 지원하지 않는 형식이에요 (사진, PDF, 워드, 텍스트)`);
}

async function wrCallCorrect(payload) {
  const { data } = await db.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error("로그인이 필요해요");
  let res;
  try {
    res = await fetch("/api/correct", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    throw new Error(e && e.name === "TimeoutError" ? "시간이 너무 오래 걸려요. 사진을 줄이거나 나눠서 다시 해 주세요" : "첨삭 서버에 연결하지 못했어요");
  }
  const j = await res.json().catch(() => null);
  if (res.status === 404 || !j) throw new Error("첨삭 서버(Worker)가 연결되지 않았어요. 배포된 주소에서 사용해 주세요");
  if (!j.ok) throw new Error(j.error || "첨삭하지 못했어요");
  return j.data;
}

async function loadWritings(s) {
  const w = state.wr;
  try {
    w.rows = await run(db.from("writings").select("*").eq("student_id", s.id).order("written_on", { ascending: false }).order("created_at", { ascending: false }).limit(200));
    w.missing = false;
  } catch {
    w.rows = [];
    w.missing = true;   // schema.sql 업그레이드 전
  }
  w.sid = s.id;
}
function wrAvg(r) {
  const sc = r.result?.scores;
  const v = sc ? WR_SCORES.map(([k]) => sc[k]).filter((n) => Number.isFinite(n)) : [];
  return v.length ? avg(v) : null;
}
function wrFixCount(r) {
  return (r.result?.sentences || []).reduce((n, st) => n + (st.notes?.length || 0), 0);
}
function renderWritingTab(s) {
  const w = state.wr;
  const body = $("#tab-body");
  if (w.sid !== s.id) {
    w.openId = null;
    body.innerHTML = `<div class="card empty">불러오는 중…</div>`;
    loadWritings(s).then(() => {
      if (state.view === "student" && state.studentId === s.id && state.tab === "writing") renderWritingTab(s);
    });
    return;
  }
  if (w.missing) {
    body.innerHTML = `<div class="card empty">라이팅 첨삭 저장소를 찾지 못했어요. Supabase SQL Editor 에서 최신 <code>schema.sql</code> 을 실행했는지 확인해 주세요.</div>`;
    return;
  }
  const open = w.openId && w.rows.find((r) => r.id === w.openId);
  if (open) return renderWritingDetail(s, open);
  w.openId = null;
  const shown = w.rows.filter((r) => inRange(state.wrFilter, r.written_on));
  body.innerHTML = `
    <div class="toolbar"><button class="btn" type="button" id="btn-wr-reload">새로고침</button><span class="muted">Claude Code 에서 첨삭한 글은 새로고침하면 나타나요</span></div>
    ${w.rows.length ? filterHtml(state.wrFilter, "wf", false) : ""}
    ${shown.length
      ? `<div class="wr-list">${shown
          .map((r) => {
            const a = wrAvg(r), n = wrFixCount(r);
            const first = r.title || (r.ocr_text || "").split(/\n/)[0].slice(0, 60) || "(제목 없음)";
            return `<button type="button" class="card wr-row" data-wr-open="${esc(r.id)}">
              <span class="wr-date">${fmtDate(r.written_on)}</span>
              <span class="wr-main"><b>${esc(first)}</b><span class="muted">${esc((r.result?.summary || "").slice(0, 70))}</span></span>
              <span class="wr-meta">${a == null ? "" : `<span class="badge">평균 ${a.toFixed(1)}/5</span>`}${Array.isArray(r.result?.sentences) ? `<span class="badge ${n ? "warn" : "done"}">${n ? `고친 곳 ${n}` : "고칠 곳 없음"}</span>` : `<span class="badge warn">첨삭 대기</span>`}</span></button>`;
          })
          .join("")}</div>`
      : w.rows.length ? `<div class="card empty">이 기간에는 첨삭한 글이 없습니다. 위에서 기간을 바꿔 보세요.</div>`
      : `<div class="card empty">아직 첨삭한 글이 없습니다. Claude Code 에서 '${esc(s.name)} 영어 라이팅 첨삭해줘' 라고 하면 여기에 나타나요.</div>`}`;
  $("#btn-wr-reload").onclick = () => { w.sid = null; renderWritingTab(s); };
  if (w.rows.length) bindFilter(state.wrFilter, "wf", () => renderWritingTab(s));
  body.onclick = (e) => {
    const b = e.target.closest("[data-wr-open]");
    if (b) { w.openId = b.dataset.wrOpen; renderWritingTab(s); }
  };
}

function writingForm(s) {
  const picked = [];
  const urls = [];
  const fields = [
    { name: "written_on", label: "글 쓴 날짜", type: "date", required: true, default: todayStr(), half: true },
    { name: "title", label: "제목·주제 (선택)", maxlength: 100, half: true },
    { name: "wr-slot", type: "slot" },
    { name: "text", label: "또는 글을 직접 붙여넣기", type: "textarea", rows: 5, maxlength: 20000 },
    { name: "note", label: "Claude 에게 전할 말 (선택)", maxlength: 300 },
  ];
  openForm({
    title: `${s.name} 라이팅 첨삭`,
    fields,
    wide: true,
    submitLabel: "첨삭 시작",
    onSubmit: async (v) => {
      const text = [v.text, ...picked.filter((p) => p.kind === "text").map((p) => p.text)].filter(Boolean).join("\n\n");
      const media = picked.filter((p) => p.kind !== "text");
      if (!media.length && !text) throw new Error("사진이나 문서를 올리거나 글을 붙여넣어 주세요");
      const st = $("#wr-status");
      st.textContent = "Claude 가 글을 읽고 첨삭하는 중이에요… (20~60초 걸려요)";
      const out = await wrCallCorrect({ grade: s.grade, topic: v.title, note: v.note, text, files: media.map((p) => ({ type: p.type, data: p.data })) });
      const id = crypto.randomUUID();
      const owner = (await db.auth.getUser()).data.user.id;
      const files = [];
      let upFail = 0;
      for (let i = 0; i < media.length; i++) {
        const m = media[i];
        const path = `${owner}/${s.id}/${id}/${i + 1}.${m.kind === "pdf" ? "pdf" : "jpg"}`;
        const { error } = await db.storage.from("writings").upload(path, m.blob, { contentType: m.type });
        if (error) upFail++;
        else files.push({ path, name: m.name, type: m.type });
      }
      const row = await run(db.from("writings").insert({
        id, student_id: s.id, written_on: v.written_on, title: v.title, files, ocr_text: out.result.transcript || text || null, result: out.result, ai_model: out.model,
      }).select("*").single());
      state.wr.rows.unshift(row);
      state.wr.openId = row.id;
      if (state.view === "student" && state.studentId === s.id && state.tab === "writing") renderWritingTab(s);
      toast(upFail ? "첨삭은 저장했지만 원본 파일 일부를 저장하지 못했어요" : "첨삭이 끝났어요");
    },
  });
  const slot = $("#wr-slot");
  slot.innerHTML = `
    <div class="wr-pick">
      <div class="wr-pick-btns">
        <button type="button" class="btn" id="wr-btn-file">사진·문서 고르기</button>
        <button type="button" class="btn" id="wr-btn-cam">카메라로 찍기</button>
        <input type="file" id="wr-in" accept="image/*,.pdf,.docx,.txt" multiple hidden>
        <input type="file" id="wr-cam" accept="image/*" capture="environment" hidden>
      </div>
      <div class="muted wr-hint">사진(JPG·PNG), PDF, 워드(.docx), 텍스트(.txt) · 최대 ${WR_MAX_FILES}개. 여러 쪽이면 순서대로 올려 주세요.</div>
      <div class="wr-files" id="wr-files"></div>
      <div class="muted" id="wr-status" role="status"></div>
    </div>`;
  const draw = () => {
    $("#wr-files").innerHTML = picked
      .map((p, i) => `<div class="wr-file">${p.kind === "image" ? `<img src="${esc(p.url)}" alt="">` : `<span class="wr-ico">${p.kind === "pdf" ? "PDF" : "TXT"}</span>`}<span class="wr-fn">${esc(p.name)}</span><button type="button" class="btn small" data-wr-rm="${i}" aria-label="${esc(p.name)} 빼기">빼기</button></div>`)
      .join("");
  };
  const add = async (list) => {
    const st = $("#wr-status");
    for (const f of list) {
      if (picked.length >= WR_MAX_FILES) { st.textContent = `파일은 ${WR_MAX_FILES}개까지 올릴 수 있어요`; break; }
      st.textContent = `${f.name} 준비 중…`;
      try {
        const p = await wrPrepare(f);
        if (p.blob && p.kind === "image") { p.url = URL.createObjectURL(p.blob); urls.push(p.url); }
        picked.push(p);
        st.textContent = "";
      } catch (e) {
        st.textContent = e.message || String(e);
      }
    }
    draw();
  };
  $("#wr-btn-file").onclick = () => $("#wr-in").click();
  $("#wr-btn-cam").onclick = () => $("#wr-cam").click();
  for (const id of ["wr-in", "wr-cam"]) {
    $("#" + id).onchange = (e) => { const l = [...e.target.files]; e.target.value = ""; add(l); };
  }
  slot.onclick = (e) => {
    const b = e.target.closest("[data-wr-rm]");
    if (b) { picked.splice(Number(b.dataset.wrRm), 1); draw(); }
  };
  $("#dlg").addEventListener("close", () => urls.forEach((u) => URL.revokeObjectURL(u)), { once: true });
}

// text 안에서 frags 에 해당하는 부분을 <tag> 로 감싸 강조한 HTML (나머지는 이스케이프)
function wrMark(text, frags, tag) {
  const t = String(text ?? "");
  const ranges = [];
  for (const f of frags) {
    if (!f) continue;
    let i = t.indexOf(f);
    while (i >= 0 && ranges.some(([a, b]) => i < b && i + f.length > a)) i = t.indexOf(f, i + 1);
    if (i >= 0) ranges.push([i, i + f.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "", pos = 0;
  for (const [a, b] of ranges) {
    out += esc(t.slice(pos, a)) + `<${tag}>${esc(t.slice(a, b))}</${tag}>`;
    pos = b;
  }
  return out + esc(t.slice(pos));
}
function wrSentenceHtml(st) {
  const notes = st.notes || [];
  if (!notes.length && st.original === st.corrected) return `<div class="wr-s ok"><span class="wr-okmark" aria-label="맞아요">✓</span>${esc(st.original)}</div>`;
  return `<div class="wr-s">
    <div class="wr-orig">${wrMark(st.original, notes.map((n) => n.wrong), "del")}</div>
    <div class="wr-fix">${wrMark(st.corrected, notes.map((n) => n.right), "ins")}</div>
    ${notes.length ? `<ul class="wr-notes">${notes.map((n) => `<li><span class="wr-tag">${esc(WR_TYPES[n.type] || n.type)}</span>${esc(n.explanation)}</li>`).join("")}</ul>` : ""}
  </div>`;
}
function wrScoresHtml(sc) {
  const segs = (v) => Array.from({ length: 5 }, (_, k) => `<i class="${k < (v || 0) ? "on" : ""}"></i>`).join("");
  return WR_SCORES.map(([k, t]) => `<div class="rp-rr"><span class="rp-rn">${t}</span><span class="rp-seg">${segs(sc?.[k])}</span><span class="rp-rl">${sc?.[k] ? sc[k] + "/5" : "-"}</span></div>`).join("");
}
function wrPrintHtml(s, w) {
  const r = w.result || {};
  const [yy, mm, dd] = w.written_on.split("-").map(Number);
  const tx = (h, t) => (t ? `<div class="rp-tx"><h4>${h}</h4><p>${esc(t)}</p></div>` : "");
  const list = (h, arr) => (arr?.length ? `<div class="rp-tx"><h4>${h}</h4><p>${arr.map((x) => "• " + esc(x)).join("\n")}</p></div>` : "");
  const blocks = [
    `<div class="rp-who"><b>${esc(s.name)}</b><span>${s.grade ? esc(s.grade) + " 학생" : "학생"}${w.title ? " · " + esc(w.title) : ""}</span></div>`,
    `<div class="wr-pscores"><h3>영역별 평가</h3>${wrScoresHtml(r.scores)}</div>`,
    tx("총평", r.summary),
    list("잘한 점", r.strengths),
    list("더 노력할 점", r.improvements),
    tx("선생님 한마디", w.teacher_note),
    (r.sentences || []).length ? `<h3 class="wr-ph">문장별 첨삭 <small>밑줄·취소선은 고친 부분이에요</small></h3>` : "",
    ...(r.sentences || []).map(wrSentenceHtml),
  ];
  return `<div class="rp-page">
    <div class="rp-top"><div class="rp-brand pv-row">${LOGO_SVG}<div>${esc(ACADEMY_NAME)}<small>라이팅 첨삭</small></div></div><div class="rp-when">${yy}년<b>${mm}월 ${dd}일</b></div></div>
    <div class="rp-body">${blocks.join("")}</div>
    <div class="rp-foot"><span>${esc(ACADEMY_NAME)} 공부방</span><span>${shortDate(todayStr())} 출력</span></div>
  </div>`;
}

function renderWritingDetail(s, w) {
  const r = w.result || {};
  const pending = !Array.isArray(r.sentences);   // 원문만 저장되고 첨삭은 아직 없는 상태 (Claude 세션이 나중에 채움)
  const files = w.files || [];
  const body = $("#tab-body");
  body.onclick = null;
  body.innerHTML = `
    <div class="toolbar"><button class="btn" type="button" id="wr-back">← 목록</button><strong>${fmtDate(w.written_on)}</strong><span>${esc(w.title || "")}</span><span class="spacer"></span>
      <button class="btn primary" type="button" id="wr-print" ${pending ? "hidden" : ""}>인쇄 / PDF</button>
      <button class="btn danger" type="button" id="wr-del">삭제</button></div>
    ${pending ? `<div class="wr-warn"><strong>첨삭 대기 중</strong> — 원문만 저장돼 있어요. Claude 세션에서 '첨삭해줘' 라고 하면 결과가 여기에 나타나요.</div><div class="card"><h3>저장된 원문</h3><pre class="wr-pre">${esc(w.ocr_text || "")}</pre></div>` : `
    <div class="ai-note"><strong>AI 첨삭</strong> — Claude 가 만든 첨삭이에요${w.ai_model ? ` (${esc(w.ai_model)})` : ""}. 학부모께 보내기 전에 선생님이 한 번 확인해 주세요.</div>
    ${r.unreadable?.length ? `<div class="wr-warn"><strong>잘 안 보여서 짐작해서 읽은 곳</strong><ul>${r.unreadable.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>원문이 다르게 읽혔다면 Claude Code 에서 고쳐서 다시 첨삭해 달라고 하세요.</div>` : ""}
    <div class="grid">
      <div class="card"><h3>영역별 평가</h3>${wrScoresHtml(r.scores)}</div>
      <div class="card"><h3>총평</h3><p class="wr-sum">${esc(r.summary || "")}</p>
        ${r.strengths?.length ? `<h4>잘한 점</h4><ul class="wr-ul">${r.strengths.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${r.improvements?.length ? `<h4>더 노력할 점</h4><ul class="wr-ul">${r.improvements.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>
    </div>
    <div class="card"><h3>문장별 첨삭</h3>${(r.sentences || []).length ? `<div class="wr-sents">${r.sentences.map(wrSentenceHtml).join("")}</div>` : `<p class="muted">읽을 수 있는 영어 문장이 없었어요.</p>`}</div>`}
    <div class="card"><h3>선생님 한마디 <small class="muted">(인쇄에 들어가요)</small></h3>
      <textarea id="wr-note" rows="3" maxlength="3000" style="width:100%">${esc(w.teacher_note || "")}</textarea>
      <div class="toolbar" style="margin:.5rem 0 0"><button class="btn" type="button" id="wr-note-save">저장</button></div></div>
    ${files.length ? `<details class="card" id="wr-orig-box"><summary>올린 원본 보기 (${files.length})</summary><div class="wr-origs" id="wr-origs"><span class="muted">불러오는 중…</span></div></details>` : ""}
    ${w.ocr_text ? `<details class="card"><summary>Claude 가 읽은 원문</summary><pre class="wr-pre">${esc(w.ocr_text)}</pre></details>` : ""}
    <div class="eval-print" id="wr-print-area"></div>`;

  $("#wr-back").onclick = () => { state.wr.openId = null; renderWritingTab(s); };
  const doPrint = () => {
    $("#wr-print-area").innerHTML = wrPrintHtml(s, w);
    document.body.classList.add("print-wr");
    try { window.print(); } finally { document.body.classList.remove("print-wr"); }
  };
  $("#wr-print").onclick = () => openEvalPreview(wrPrintHtml(s, w), doPrint, $("#wr-print"), "첨삭 미리보기", {
    onRender: paginateEvalPreview,
    share: { filename: `라이팅첨삭_${s.name}_${w.written_on}.pdf`, title: `${s.name} 라이팅 첨삭` },
  });
  $("#wr-note-save").onclick = async () => {
    try {
      const note = $("#wr-note").value.trim() || null;
      await run(db.from("writings").update({ teacher_note: note, updated_at: new Date().toISOString() }).eq("id", w.id));
      w.teacher_note = note;
      toast("저장했습니다");
    } catch (e) { fail(e, "저장하지 못했습니다"); }
  };
  $("#wr-del").onclick = async () => {
    if (!confirm("이 첨삭 기록과 올린 파일을 삭제할까요? 되돌릴 수 없습니다.")) return;
    try {
      const paths = files.map((f) => f.path);
      if (paths.length) await db.storage.from("writings").remove(paths);
      await run(db.from("writings").delete().eq("id", w.id));
      state.wr.rows = state.wr.rows.filter((x) => x.id !== w.id);
      state.wr.openId = null;
      renderWritingTab(s);
    } catch (e) { fail(e, "삭제하지 못했습니다"); }
  };
  const box = $("#wr-orig-box");
  if (box) {
    box.addEventListener("toggle", async () => {
      if (!box.open || box.dataset.done) return;
      box.dataset.done = "1";
      const host = $("#wr-origs");
      const { data, error } = await db.storage.from("writings").createSignedUrls(files.map((f) => f.path), 600);
      if (error || !data) { host.textContent = "원본을 불러오지 못했어요"; delete box.dataset.done; return; }
      host.innerHTML = data.map((d, i) => (d.signedUrl
        ? (files[i].type === "application/pdf" ? `<a class="btn" href="${esc(d.signedUrl)}" target="_blank" rel="noopener">PDF 열기 (${esc(files[i].name || "")})</a>` : `<a href="${esc(d.signedUrl)}" target="_blank" rel="noopener"><img src="${esc(d.signedUrl)}" alt="올린 사진 ${i + 1}"></a>`)
        : `<span class="muted">${i + 1}번째 파일을 불러오지 못했어요</span>`)).join("");
    });
  }
}

async function selectStudent(id) {
  state.view = "student";
  state.studentId = id;
  state.wr.openId = null;
  state.wr.sid = null;
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
    document.body.classList.toggle("menu-lock", open);
    $("#btn-menu").setAttribute("aria-expanded", open ? "true" : "false");
  };
  $("#btn-menu").onclick = () => setMenu(!appEl.classList.contains("menu-open"));
  $("#sidebar").addEventListener("click", (e) => {
    if (e.target.closest(".nav-btn, button[data-id], #btn-textbooks, #btn-sched-edit, #btn-kinds, #btn-backup")) setMenu(false);
  });
  document.addEventListener("click", (e) => {
    if (appEl.classList.contains("menu-open") && !e.target.closest("#sidebar, #btn-menu")) setMenu(false);
  });
  $("#nav-overview").onclick = () => {
    state.view = "overview";
    state.studentId = null;
    render();
  };
  $("#nav-makeup").onclick = () => {
    state.view = "makeup";
    state.studentId = null;
    state.makeup.tab = "need";
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
  $("#btn-kinds").onclick = async () => {
    state.view = "kinds";
    state.studentId = null;
    try { await loadKindCounts(); } catch (e) { return fail(e); }
    render();
  };
  if ($("#btn-backup")) $("#btn-backup").onclick = () => {
    state.view = "backup";
    state.studentId = null;
    render();
  };
  const SIDE_KEY = "rachel_side_off";
  const setSide = (off, save = true) => {
    appEl.classList.toggle("side-off", off);
    const b = $("#btn-side");
    b.textContent = off ? "▶ 메뉴 펼치기" : "◀ 메뉴 숨기기";
    b.setAttribute("aria-expanded", off ? "false" : "true");
    if (save) { try { localStorage.setItem(SIDE_KEY, off ? "1" : "0"); } catch { /* 저장 실패는 무시 */ } }
  };
  $("#btn-side").onclick = () => setSide(!appEl.classList.contains("side-off"));
  // 저장된 선택이 없으면, 태블릿 세로처럼 좁은 화면(900px 이하)에서는 메뉴를 접은 채 시작합니다.
  try {
    const sv = localStorage.getItem(SIDE_KEY);
    setSide(sv === null ? window.innerWidth <= 900 : sv === "1", false);
  } catch { setSide(window.innerWidth <= 900, false); }
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
      if (state.tab === "writing") state.wr.sid = null;   // Claude 세션이 저장한 글이 보이도록 탭을 열 때마다 다시 불러옴
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
        if (act.dataset.act === "days") { changeDays(s, p, book); return; }
        else if (act.dataset.act === "range") { changeDaily(s, p, book); return; }
        else if (act.dataset.act === "next") { changeNext(s, p, book); return; }
        else if (act.dataset.act === "unassign") {
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
