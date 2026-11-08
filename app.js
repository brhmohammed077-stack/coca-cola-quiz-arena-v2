/* Coca-Cola Quiz Arena — secure multi-device client.
   All scoring, timing, buzzer order and answer validation happen on Supabase.
*/
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SESSION_KEY = "coca-cola-quiz-arena-session-v2";
  const config = window.ARENA_CONFIG || {};
  const supabaseLib = window.supabase;
  let client = null;
  let session = null;
  let live = null;
  let pollHandle = null;
  let isPolling = false;
  let actionBusy = false;
  let toastHandle = null;
  const TEAM_NAMES = Array.from({ length: 10 }, (_, i) => `الفوج ${String(i + 1).padStart(2, "0")}`);

  function toast(message) {
    const el = $("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastHandle);
    toastHandle = setTimeout(() => el.classList.remove("show"), 3000);
  }
  function showScreen(id) {
    document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
    const screen = $(id);
    if (screen) screen.classList.add("active");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function setConnection(text, connected = false) {
    const label = $("connection-label");
    if (label) label.textContent = text;
    const dot = document.querySelector(".top-status .live-dot");
    if (dot) dot.style.background = connected ? "#41d18a" : "#ff394b";
  }
  function getClient() {
    if (client) return client;
    if (!supabaseLib?.createClient || !config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error("إعداد اتصال Supabase غير مكتمل في config.js.");
    }
    client = supabaseLib.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return client;
  }
  async function api(action, payload = {}) {
    const sb = getClient();
    const headers = session?.token ? { "x-arena-token": session.token } : {};
    const { data, error } = await sb.functions.invoke("arena", {
      body: { action, ...payload },
      headers
    });
    if (error) {
      let message = error.message || "تعذّر الاتصال بالخادم.";
      try {
        const details = await error.context?.json?.();
        if (details?.error) message = details.error;
      } catch (_) { /* Keep the original network error. */ }
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data;
  }
  function saveSession(value) {
    session = value;
    localStorage.setItem(SESSION_KEY, JSON.stringify(value));
  }
  function clearSession() {
    session = null;
    live = null;
    localStorage.removeItem(SESSION_KEY);
    stopPolling();
    setConnection("غير متصل");
  }
  function selectedTeamNumber() {
    return Number(document.querySelector(".team-seat.selected")?.dataset.team || 0);
  }
  function buildTeamSeats() {
    const grid = $("team-grid");
    if (!grid) return;
    grid.innerHTML = TEAM_NAMES.map((name, i) =>
      `<button class="team-seat" type="button" data-team="${i + 1}">${String(i + 1).padStart(2, "0")}<br><small>الفوج</small></button>`
    ).join("");
    grid.querySelectorAll("[data-team]").forEach((button) => button.addEventListener("click", () => {
      grid.querySelectorAll(".team-seat").forEach((item) => item.classList.remove("selected"));
      button.classList.add("selected");
      if ($("selected-team-label")) $("selected-team-label").textContent = TEAM_NAMES[Number(button.dataset.team) - 1];
    }));
  }
  function setFill(value) {
    const fill = Math.max(0, Math.min(100, Number(value) || 0));
    ["arena-liquid", "landing-liquid"].forEach((id) => { if ($(id)) $(id).style.height = `${fill}%`; });
    if ($("fill-percent")) $("fill-percent").textContent = `${Math.round(fill)}%`;
    if ($("landing-fill")) $("landing-fill").textContent = `${Math.round(fill)}%`;
    if ($("host-fill")) $("host-fill").textContent = `${Math.round(fill)}%`;
    if ($("host-progress")) $("host-progress").style.width = `${fill}%`;
  }
  function formatTeam(teamId) {
    const team = live?.teams?.find((item) => item.id === teamId);
    return team?.display_name || "الفوج";
  }
  function statusLabel(match) {
    if (!match) return "بانتظار تهيئة المسابقة";
    const labels = {
      lobby: "بانتظار السؤال من المنظّم",
      countdown: "استعدوا — العدّ التنازلي بدأ",
      buzz: "اضغطوا على القارورة الآن",
      answer: "دور الإجابة جارٍ",
      question_done: "انتهت فرص الإجابة في هذا السؤال",
      finished: "انتهت المسابقة"
    };
    return labels[match.status] || "متصل";
  }
  function renderScores() {
    if (!live) return;
    const ordered = [...(live.teams || [])].sort((a, b) => b.score - a.score || a.team_number - b.team_number);
    const html = ordered.map((team, index) =>
      `<div class="score-item"><span class="score-rank">${String(index + 1).padStart(2, "0")}</span><span>${team.display_name}</span><b class="score-value">${team.score} نقطة</b></div>`
    ).join("");
    if ($("score-list")) $("score-list").innerHTML = html;
    if ($("host-score-list")) $("host-score-list").innerHTML = ordered.map((team, index) =>
      `<div class="host-score-row"><span>${index + 1}. ${team.display_name}</span><b>${team.score}</b></div>`
    ).join("");
    if ($("correct-count")) $("correct-count").textContent = ordered.reduce((sum, team) => sum + Number(team.score || 0), 0) / 10;
  }
  function renderQueue() {
    if (!live || !$("queue-list")) return;
    const queue = live.queue || [];
    $("queue-list").innerHTML = queue.length ? queue.map((entry, index) => {
      const active = String(entry.id) === String(live.match.active_queue_id);
      const stateText = active ? "دوره الآن" : entry.result === "correct" ? "إجابة صحيحة" : entry.result === "wrong" ? "إجابة خاطئة" : entry.result === "timeout" ? "انتهى الوقت" : "في الانتظار";
      return `<div class="queue-item ${active ? "active" : ""}"><span class="queue-number">${String(index + 1).padStart(2, "0")}</span><span class="queue-team">${entry.display_name || `الفوج ${entry.team_number || ""}`}</span><span class="queue-status">${stateText}</span></div>`;
    }).join("") : `<div class="empty-state">بانتظار ضغط الأفواج على القارورة</div>`;
    if ($("buzz-count")) $("buzz-count").textContent = queue.length;
  }
  function remainingSeconds(deadline) {
    if (!deadline) return null;
    return Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000));
  }
  function renderQuestion() {
    if (!live) return;
    const match = live.match;
    const question = live.question;
    const status = match.status;
    const text = question?.prompt || "بانتظار السؤال من المنظّم";
    if ($("question-text")) $("question-text").textContent = text;
    if ($("round-number")) $("round-number").textContent = String(match.round_number).padStart(2, "0");
    if ($("host-round")) $("host-round").textContent = String(match.round_number).padStart(2, "0");
    if ($("question-subtitle")) $("question-subtitle").textContent = status === "buzz" || status === "answer"
      ? "ترتيب الضغط محفوظ على الخادم، ويمكن للأفواج الضغط خلال نافذة التسجيل."
      : statusLabel(match);

    let phaseText = statusLabel(match);
    if (status === "countdown") phaseText = `يبدأ بعد ${remainingSeconds(match.countdown_ends_at) ?? 0}`;
    if (status === "answer") phaseText = `دور ${formatTeam(live.active_team_id)} — ${remainingSeconds(match.answer_deadline) ?? 0} ث`;
    if ($("phase-timer")) $("phase-timer").textContent = phaseText;
    if ($("answer-state")) $("answer-state").textContent = phaseText;
    if ($("bottle-hint")) {
      const canBuzz = ["buzz", "answer"].includes(status) && remainingSeconds(match.buzz_open_until) > 0;
      $("bottle-hint").textContent = canBuzz ? "القارورة مفتوحة — اضغط لتسجيل دورك" : status === "answer" ? `الفوج ${formatTeam(live.active_team_id)} يجيب الآن` : statusLabel(match);
    }
    const alreadyBuzzed = (live.queue || []).some((entry) => entry.team_id === live.own_team_id);
    const open = ["buzz", "answer"].includes(status) && remainingSeconds(match.buzz_open_until) > 0;
    if ($("buzz-bottle")) $("buzz-bottle").disabled = session?.role !== "team" || !open || alreadyBuzzed;
    renderOptions();
  }
  function renderOptions() {
    const grid = $("options-grid");
    if (!grid || !live) return;
    const active = session?.role === "team" && live.match.status === "answer" && live.active_team_id === live.own_team_id && remainingSeconds(live.match.answer_deadline) > 0;
    const options = Array.isArray(live.question?.options) ? live.question.options : [];
    grid.innerHTML = active ? options.map((option, index) =>
      `<button class="option-btn" type="button" data-option="${index}"><span>${"ABCDEF"[index]}</span>${escapeHtml(String(option))}</button>`
    ).join("") : "";
    grid.querySelectorAll("[data-option]").forEach((button) => button.addEventListener("click", () => submitAnswer(Number(button.dataset.option))));
  }
  function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }
  function renderLive() {
    if (!live) return;
    setConnection(session?.role === "host" ? "المنظّم متصل" : formatTeam(live.own_team_id), true);
    setFill(live.match.fill_percent);
    renderQuestion();
    renderQueue();
    renderScores();
    if (session?.role === "host" && $("host-note") && $("access-codes")?.hidden !== false) {
      const active = live.active_team_id ? ` — الدور الآن لـ ${formatTeam(live.active_team_id)}` : "";
      $("host-note").textContent = `${statusLabel(live.match)}${active}`;
    }
    if (live.match.status === "finished") showResults();
  }
  async function pollState() {
    if (!session || isPolling) return;
    isPolling = true;
    try {
      live = await api("state");
      renderLive();
    } catch (error) {
      setConnection("انقطع الاتصال — إعادة المحاولة", false);
      if (/انتهت الجلسة|جلسة غير صالحة/.test(error.message)) {
        clearSession();
        showScreen("landing-screen");
        toast(error.message);
      }
    } finally { isPolling = false; }
  }
  function startPolling() {
    stopPolling();
    pollState();
    pollHandle = setInterval(pollState, 850);
  }
  function stopPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
  }
  async function runAction(action, payload, successMessage) {
    if (actionBusy) return;
    actionBusy = true;
    try {
      await api(action, payload);
      if (successMessage) toast(successMessage);
      await pollState();
    } catch (error) { toast(error.message); }
    finally { actionBusy = false; }
  }
  async function loginTeam() {
    const number = selectedTeamNumber();
    const code = $("team-code").value.trim().toUpperCase();
    if (!number) return toast("اختر رقم الفوج أولًا.");
    if (!code) return toast("أدخل رمز الفوج.");
    try {
      const result = await api("login_team", { team_number: number, code });
      saveSession({ token: result.token, role: "team", team_id: null, team_number: number });
      await pollState();
      showScreen("arena-screen");
      startPolling();
      toast(`تم تسجيل دخول ${TEAM_NAMES[number - 1]}`);
    } catch (error) { toast(error.message); }
  }
  async function loginHost() {
    const code = $("host-code").value.trim().toUpperCase();
    if (!code) return toast("أدخل رمز المنظّم.");
    try {
      const result = await api("login_host", { code });
      saveSession({ token: result.token, role: "host" });
      await pollState();
      showScreen("host-screen");
      startPolling();
      toast("تم فتح لوحة المنظّم.");
    } catch (error) { toast(error.message); }
  }
  async function bootstrapArena() {
    const setupKey = $("setup-key")?.value.trim();
    if (!setupKey) return toast("أدخل رمز التهيئة الذي أضفته في أسرار Supabase.");
    try {
      const result = await api("bootstrap", { setup_key: setupKey });
      saveSession({ token: result.token, role: "host" });
      const lines = [
        "احتفظ بهذه الرموز الآن — لن تظهر مرة أخرى:",
        `المنظّم: ${result.host_code}`,
        ...result.team_codes.map((code, i) => `الفوج ${String(i + 1).padStart(2, "0")}: ${code}`)
      ];
      if ($("access-codes")) {
        $("access-codes").hidden = false;
        $("access-codes").textContent = lines.join("\n");
      }
      await pollState();
      showScreen("host-screen");
      startPolling();
      toast("تم إنشاء المسابقة. انسخ الرموز واحتفظ بها بأمان.");
    } catch (error) { toast(error.message); }
  }
  async function submitAnswer(option) {
    if (actionBusy) return;
    actionBusy = true;
    try {
      const result = await api("answer", { option });
      toast(result.result === "correct" ? "إجابة صحيحة! أضيفت 10 نقاط وارتفع مستوى القارورة." : "إجابة غير صحيحة. ينتقل الدور إلى الفريق التالي.");
      await pollState();
    } catch (error) { toast(error.message); }
    finally { actionBusy = false; }
  }
  function readHostQuestion() {
    const inputs = [...document.querySelectorAll("[data-host-option]")].sort((a, b) => Number(a.dataset.hostOption) - Number(b.dataset.hostOption));
    const options = inputs.map((input) => input.value.trim());
    const correct = Number(document.querySelector('input[name="correct"]:checked')?.value ?? 0);
    const prompt = $("host-question")?.value.trim() || "";
    if (!prompt || options.length !== 6 || options.some((value) => !value)) throw new Error("أكمل نص السؤال والاختيارات الستة أولًا.");
    return { prompt, options, correct_option: correct };
  }
  function initHostOptions() {
    const defaults = ["جون بيمبرتون", "آسا كاندلر", "روبرت وودروف", "فرانك روبنسون", "هنري فورد", "جيمس كوينسي"];
    const hostOptions = $("host-options");
    if (!hostOptions || hostOptions.children.length) return;
    hostOptions.innerHTML = defaults.map((option, index) =>
      `<label class="host-option"><input type="radio" name="correct" value="${index}" ${index === 0 ? "checked" : ""}><input type="text" data-host-option="${index}" value="${escapeHtml(option)}" aria-label="الخيار ${index + 1}"></label>`
    ).join("");
  }
  function showResults() {
    if (!live || !$("winner-card")) return;
    const ranking = [...(live.teams || [])].sort((a, b) => b.score - a.score || a.team_number - b.team_number);
    const winner = ranking[0];
    $("winner-card").innerHTML = `الفائز بالتحدّي<strong>${escapeHtml(winner?.display_name || "—")}</strong><span>${winner?.score || 0} نقطة</span>`;
    $("final-ranking").innerHTML = ranking.map((team, i) =>
      `<div>${i + 1}. ${escapeHtml(team.display_name)} <b style="color:#e9bb68">${team.score} نقطة</b></div>`
    ).join("");
    showScreen("result-screen");
  }
  function bindEvents() {
    $("team-entry")?.addEventListener("click", () => showScreen("team-login-screen"));
    $("host-entry")?.addEventListener("click", () => showScreen("host-login-screen"));
    $("home-btn")?.addEventListener("click", () => showScreen("landing-screen"));
    document.querySelectorAll("[data-back]").forEach((button) => button.addEventListener("click", () => showScreen("landing-screen")));
    $("join-team")?.addEventListener("click", loginTeam);
    $("join-host")?.addEventListener("click", loginHost);
    $("initialize-arena")?.addEventListener("click", bootstrapArena);
    $("copy-access-codes")?.addEventListener("click", async () => {
      const text = $("access-codes")?.textContent || "";
      try { await navigator.clipboard.writeText(text); toast("تم نسخ رموز الدخول."); }
      catch (_) { toast("حدّد الرموز وانسخها يدويًا من المربع."); }
    });
    $("buzz-bottle")?.addEventListener("click", () => runAction("buzz", {}, "تم تسجيل ضغط فريقك في ترتيب الانتظار."));
    $("start-question")?.addEventListener("click", async () => {
      try { const question = readHostQuestion(); await runAction("start_question", question, "تم إطلاق السؤال والعدّ التنازلي."); }
      catch (error) { toast(error.message); }
    });
    $("next-question")?.addEventListener("click", () => runAction("next_question", {}, "أصبحت الجولة التالية جاهزة. أعد إدخال السؤال ثم أطلقه."));
    $("finish-match")?.addEventListener("click", () => { if (confirm("إنهاء المسابقة وعرض الترتيب النهائي؟")) runAction("finish", {}, "انتهت المسابقة."); });
    $("reset-match")?.addEventListener("click", () => {
      if (confirm("هل تريد إعادة ضبط النقاط والقارورة وترتيب المسابقة؟")) runAction("reset", {}, "تمت إعادة ضبط المسابقة.");
    });
    $("back-to-host")?.addEventListener("click", () => showScreen("host-screen"));
  }
  async function restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return;
      session = JSON.parse(raw);
      await pollState();
      showScreen(session.role === "host" ? "host-screen" : "arena-screen");
      startPolling();
    } catch (_) {
      clearSession();
      showScreen("landing-screen");
    }
  }

  buildTeamSeats();
  initHostOptions();
  bindEvents();
  setFill(0);
  setConnection("اتصال المسابقة غير مهيأ");
  restoreSession();
})();
