
"use strict";

/* =========================================================
   交通問題マップ - script.js
   機能:
   ・Leaflet地図 / OpenStreetMap
   ・交通問題の投稿、編集用データ表示、詳細表示
   ・カテゴリ・キーワード・状態による絞り込み
   ・投稿への投票
   ・SupabaseまたはlocalStorageへの保存
   ・住所検索 / 現在地取得
   ・地図クリックで投稿位置を指定
   ・地図と一覧の連動
   ========================================================= */

const CONFIG = {
  initialCenter: [35.6753, 139.7449],
  initialZoom: 16,
  storageKey: "traffic-issues-map-v1",
  tileUrl: window.MAP_TILE_CONFIG?.url,
  attribution: window.MAP_TILE_CONFIG?.attribution,
  maxTitleLength: 80,
  maxDescriptionLength: 1000,
  reportsPageSize: 1000
};

const mapSearchCache = new Map();
let lastMapSearchAt = 0;

const supabaseSettings = window.SUPABASE_CONFIG || {};
const hasSupabaseSettings = Boolean(supabaseSettings.url || supabaseSettings.anonKey);
const isSupabaseConfigured =
  typeof supabaseSettings.url === "string" &&
  /^https:\/\/.+\.supabase\.co$/.test(supabaseSettings.url) &&
  typeof supabaseSettings.anonKey === "string" &&
  supabaseSettings.anonKey.length > 0;
const supabaseClient =
  isSupabaseConfigured && window.supabase?.createClient
    ? window.supabase.createClient(supabaseSettings.url, supabaseSettings.anonKey)
    : null;

const CATEGORIES = {
  danger: { label: "危険な場所", color: "#e5484d", icon: "⚠️" },
  tobidashi: { label: "飛び出し注意", color: "#f97316", icon: "🚸" },
  signal: { label: "信号・交差点", color: "#e59b18", icon: "🚦" },
  road: { label: "道路・路面", color: "#64748b", icon: "🛣️" },
  sidewalk: { label: "歩道・自転車", color: "#0e9f6e", icon: "🚲" },
  congestion: { label: "渋滞", color: "#8b5cf6", icon: "🚗" },
  other: { label: "その他", color: "#3984e8", icon: "📍" }
};

const STATUS_LABELS = {
  pending: "未対応",
  investigating: "確認中",
  resolved: "解決済み"
};

const $ = (selector) => document.querySelector(selector);

const $$ = (selector) => [...document.querySelectorAll(selector)];

function getElement(id) {
  return document.getElementById(id);
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `issue-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日時不明";

  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

/* =========================
   保存データ
   ========================= */

const DEMO_REPORTS = [
  {
    id: "demo-1",
    title: "交差点の見通しが悪い",
    category: "signal",
    description: "国会議事堂周辺の交差点を想定した画面確認用の架空サンプルです。実際の道路状況を示すものではありません。",
    location: "国会議事堂周辺（サンプル）",
    lat: 35.676,
    lng: 139.7442,
    status: "pending",
    votes: 4,
    createdAt: "2026-09-10T08:00:00.000Z",
    demo: true
  },
  {
    id: "demo-2",
    title: "歩道が狭く感じる",
    category: "sidewalk",
    description: "歩行者と自転車が通るときに注意が必要そうな場所を想定した架空サンプルです。",
    location: "永田町周辺（サンプル）",
    lat: 35.6745,
    lng: 139.7462,
    status: "investigating",
    votes: 2,
    createdAt: "2026-09-12T08:00:00.000Z",
    demo: true
  },
  {
    id: "demo-3",
    title: "道路の路面が気になる",
    category: "road",
    description: "路面の状態を確認してほしいという想定の架空サンプルです。実際の道路状況を示すものではありません。",
    location: "霞ヶ関周辺（サンプル）",
    lat: 35.6739,
    lng: 139.7437,
    status: "pending",
    votes: 1,
    createdAt: "2026-09-14T08:00:00.000Z",
    demo: true
  }
];

function cloneDemoReports() {
  return DEMO_REPORTS.map((report) => ({ ...report }));
}

function normalizeReport(report, index) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;

  const title = typeof report.title === "string" ? report.title.trim() : "";
  const hasLatitude =
    typeof report.lat === "number" ||
    (typeof report.lat === "string" && report.lat.trim() !== "");
  const hasLongitude =
    typeof report.lng === "number" ||
    (typeof report.lng === "string" && report.lng.trim() !== "");
  const lat = Number(report.lat);
  const lng = Number(report.lng);

  if (
    !title ||
    title.length > CONFIG.maxTitleLength ||
    !hasLatitude ||
    !hasLongitude ||
    !isValidCoordinate(lat, lng)
  ) {
    return null;
  }

  const hasCategory =
    typeof report.category === "string" &&
    Object.prototype.hasOwnProperty.call(CATEGORIES, report.category);
  const hasStatus =
    typeof report.status === "string" &&
    Object.prototype.hasOwnProperty.call(STATUS_LABELS, report.status);
  const createdAt =
    typeof report.createdAt === "string" &&
    !Number.isNaN(new Date(report.createdAt).getTime())
      ? report.createdAt
      : new Date(0).toISOString();
  const votes = Number(report.votes);

  return {
    id: typeof report.id === "string" && report.id.trim()
      ? report.id
      : `imported-${index}-${createId()}`,
    title,
    category: hasCategory ? report.category : "other",
    description: typeof report.description === "string"
      ? report.description.slice(0, CONFIG.maxDescriptionLength)
      : "",
    location: typeof report.location === "string" ? report.location : "",
    lat,
    lng,
    status: hasStatus ? report.status : "pending",
    votes: Number.isSafeInteger(votes) && votes > 0 ? votes : 0,
    createdAt,
    createdBy: typeof report.createdBy === "string" ? report.createdBy : null,
    demo: report.demo === true
  };
}

function loadReports() {
  try {
    const saved = localStorage.getItem(CONFIG.storageKey);
    if (saved === null) return cloneDemoReports();

    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) {
      throw new TypeError("保存された投稿データが配列ではありません。");
    }

    const normalized = parsed
      .map((report, index) => normalizeReport(report, index))
      .filter(Boolean);

    if (normalized.length !== parsed.length) {
      console.warn("形式が不正な投稿データを読み込み対象から除外しました。");
    }

    return normalized;
  } catch (error) {
    console.error("投稿データを読み込めませんでした:", error);
    return cloneDemoReports();
  }
}

let reports = hasSupabaseSettings ? [] : loadReports();
let map;
let markerLayer;
let markersById = new Map();
let selectedReportId = null;
let activeCategory = "all";
let mapReady = false;
let reportsLoading = isSupabaseConfigured;
let appMode = "view";
let currentUser = null;
let isCurrentUserAdmin = false;
let accountMode = "login";
let pendingVerificationEmail = "";
let activeInviteToken = null;

function saveReports() {
  try {
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(reports));
    return true;
  } catch (error) {
    console.error("投稿データを保存できませんでした:", error);
    showToast("保存できませんでした。ブラウザの保存容量を確認してください。", "error");
    return false;
  }
}

function mapSupabaseReport(row, index) {
  return normalizeReport({
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    location: row.location,
    lat: row.latitude,
    lng: row.longitude,
    status: row.status,
    votes: row.votes,
    createdAt: row.created_at,
    createdBy: row.created_by || null
  }, index);
}

async function loadSupabaseReports() {
  const rows = [];
  let pageStart = 0;

  while (true) {
    const { data, error } = await supabaseClient
      .from("traffic_reports")
      .select("*")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(pageStart, pageStart + CONFIG.reportsPageSize - 1);

    if (error) throw error;
    rows.push(...data);
    if (data.length < CONFIG.reportsPageSize) break;
    pageStart += CONFIG.reportsPageSize;
  }

  const normalizedReports = rows
    .map((row, index) => mapSupabaseReport(row, index))
    .filter(Boolean);
  if (normalizedReports.length !== rows.length) {
    console.warn("形式が不正なSupabase投稿データを読み込み対象から除外しました。");
  }
  reports = normalizedReports;
  renderMarkers();
  renderReportList();
}

/* =========================
   通知
   ========================= */

function showToast(message, type = "success") {
  const container = getElement("toast-container");

  if (!container) {
    console.log(message);
    return;
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toast.setAttribute("role", "status");

  container.appendChild(toast);

  window.setTimeout(() => {
    toast.remove();
  }, 3500);
}

function updateAuthControls() {
  const accountButton = getElement("account-button");
  const adminLogButton = getElement("admin-log-button");
  const adminInviteButton = getElement("admin-invite-button");

  accountButton?.classList.toggle("is-hidden", !supabaseClient);
  if (accountButton) {
    const label = currentUser ? "アカウント" : "ログイン";
    accountButton.setAttribute("aria-label", label);
    accountButton.title = label;
  }
  adminLogButton?.classList.toggle("is-hidden", !isCurrentUserAdmin);
  adminInviteButton?.classList.toggle("is-hidden", !isCurrentUserAdmin);
}

function openAccountDialog() {
  if (!supabaseClient) {
    showToast("ログイン機能を利用できません。Supabaseの設定を確認してください。", "error");
    return;
  }
  if (!currentUser) setAccountMode("login");
  else accountMode = "login";
  updateAccountDialog();
  const dialog = getElement("account-dialog");
  if (dialog?.showModal && !dialog.open) dialog.showModal();
  else dialog?.setAttribute("open", "");
}

function canCreateReport() {
  return Boolean(currentUser || activeInviteToken);
}

function requirePostAccess() {
  if (canCreateReport()) return true;
  if (!supabaseClient) {
    showToast("投稿にはログインが必要です。Supabaseの接続設定を確認してください。", "error");
    return false;
  }
  showToast("投稿するにはログインするか、管理者から受け取った招待リンクを開いてください。", "error");
  openAccountDialog();
  return false;
}

async function initializeInviteAccess() {
  const currentUrl = new URL(window.location.href);
  const token = currentUrl.searchParams.get("invite");
  if (!token) return;

  currentUrl.searchParams.delete("invite");
  window.history.replaceState(null, "", currentUrl.pathname + currentUrl.search + currentUrl.hash);

  if (!supabaseClient || !/^[a-f0-9]{64}$/.test(token)) {
    showToast("招待リンクが無効か、投稿機能の接続設定がありません。", "error");
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc("validate_traffic_report_invite", {
      p_token: token
    });
    if (error) throw error;
    if (data !== true) {
      showToast("この招待リンクは無効化されているか、正しくありません。", "error");
      return;
    }

    activeInviteToken = token;
    showToast("招待リンクを確認しました。アカウントなしで投稿できます。");
    updateMapStatus("招待リンクで投稿できます。地図をタップして投稿場所を選んでください。");
  } catch (error) {
    console.error("招待リンクを確認できませんでした:", error);
    showToast("招待リンクを確認できません。データベース設定を確認してください。", "error");
  }
}

function updateAccountDialog() {
  const signedIn = Boolean(currentUser);
  const currentUserLabel = getElement("account-current-user");
  const emailGroup = getElement("account-email-group");
  const passwordGroup = getElement("account-password-group");
  const passwordConfirmGroup = getElement("account-password-confirm-group");
  const modeTabs = getElement("account-mode-tabs");
  const password = getElement("account-password");
  const passwordConfirm = getElement("account-password-confirm");
  const emailInput = getElement("account-email");
  const resetPasswordButton = getElement("reset-password-button");
  const message = getElement("account-message");
  const recovering = accountMode === "recovery";
  const registering = accountMode === "signup";

  currentUserLabel?.classList.toggle("is-hidden", !signedIn);
  if (currentUserLabel) {
    currentUserLabel.textContent = currentUser
      ? `${isCurrentUserAdmin ? "管理者としてログイン中" : "ログイン中"}: ${currentUser.email || currentUser.id}`
      : "";
  }
  emailGroup?.classList.toggle("is-hidden", signedIn);
  passwordGroup?.classList.toggle("is-hidden", signedIn && !recovering);
  getElement("claim-admin-section")?.classList.toggle(
    "is-hidden",
    !signedIn || isCurrentUserAdmin
  );
  passwordConfirmGroup?.classList.toggle(
    "is-hidden",
    (signedIn && !recovering) || (!registering && !recovering)
  );
  modeTabs?.classList.toggle("is-hidden", signedIn);
  resetPasswordButton?.classList.toggle("is-hidden", signedIn || registering || recovering);
  getElement("account-login-tab")?.classList.toggle("is-active", !registering && !recovering);
  getElement("account-login-tab")?.setAttribute("aria-selected", String(!registering && !recovering));
  getElement("account-signup-tab")?.classList.toggle("is-active", registering);
  getElement("account-signup-tab")?.setAttribute("aria-selected", String(registering));
  getElement("sign-in-button")?.classList.toggle("is-hidden", signedIn);
  getElement("sign-out-button")?.classList.toggle("is-hidden", !signedIn || recovering);
  getElement("resend-confirmation-button")?.classList.toggle(
    "is-hidden",
    !pendingVerificationEmail || signedIn
  );
  const passwordMinimum = registering || recovering ? 8 : 6;
  if (password) {
    password.minLength = passwordMinimum;
    password.autocomplete = registering || recovering ? "new-password" : "current-password";
  }
  if (passwordConfirm) {
    passwordConfirm.required = registering || recovering;
    passwordConfirm.minLength = passwordMinimum;
  }
  if (emailInput) emailInput.required = !signedIn;
  const submitButton = getElement("sign-in-button");
  if (submitButton) {
    submitButton.textContent = signedIn
      ? recovering ? "パスワードを更新" : ""
      : recovering
        ? "パスワードを更新"
        : registering
          ? "アカウントを作成"
          : "ログイン";
    submitButton.classList.toggle("is-hidden", signedIn && !recovering);
  }
  const requirement = getElement("password-requirement");
  requirement?.classList.toggle(
    "is-hidden",
    (signedIn && !recovering) || (!registering && !recovering)
  );
  if (message) {
    message.textContent = signedIn
      ? "ログイン中は自分の投稿を削除できます。管理者には管理ログの閲覧と全投稿の削除が許可されます。"
      : recovering
        ? "新しいパスワードを入力してください。8文字以上で設定できます。"
        : registering
          ? "8文字以上のパスワードを設定してください。確認メールが届く場合があります。"
          : "ログインすると自分の投稿を削除できます。";
  }
}

function setAccountFeedback(message, type = "info") {
  const feedback = getElement("account-feedback");
  if (!feedback) return;
  feedback.textContent = message;
  feedback.classList.toggle("is-hidden", !message);
  feedback.classList.toggle("is-error", type === "error");
  feedback.classList.toggle("is-success", type === "success");
}

function getAuthErrorMessage(error, action) {
  const code = error?.code || "";
  const message = error?.message || "";
  if (code === "invalid_credentials" || code === "invalid_grant") {
    return "メールアドレスまたはパスワードを確認してください。";
  }
  if (code === "email_not_confirmed") {
    return "メールアドレスの確認が完了していません。確認メールをご確認ください。";
  }
  if (code === "user_already_exists" || code === "email_exists") {
    return "このメールアドレスは登録済みです。ログインしてください。";
  }
  if (code === "weak_password" || /password.*(weak|short|characters)/i.test(message)) {
    return "パスワードの条件を満たしていません。8文字以上で設定してください。";
  }
  if (code === "over_email_send_rate_limit" || code === "too_many_requests") {
    return "メール送信の回数が上限に達しました。時間をおいて再度お試しください。";
  }
  if (code === "email_address_invalid" || code === "validation_failed") {
    return "メールアドレスの形式を確認してください。";
  }
  if (code === "signup_disabled" || code === "is_signup_disabled") {
    return "現在、新規登録が無効になっています。管理者にSupabaseの設定を確認してもらってください。";
  }
  if (action === "signup" && /email.*(rate|limit|send)/i.test(message)) {
    return "確認メールを送信できませんでした。送信上限に達していないか、SupabaseのSMTP設定を確認してください。";
  }
  if (action === "reset" && code === "user_not_found") {
    return "このメールアドレスのアカウントを確認できませんでした。";
  }
  if (message) return `処理に失敗しました: ${message}`;
  return "処理に失敗しました。入力内容と通信状況を確認して、もう一度お試しください。";
}

async function syncAuthenticatedUser(user, event = "") {
  currentUser = user;
  isCurrentUserAdmin = false;

  if (supabaseClient && currentUser) {
    try {
      const { data, error } = await supabaseClient
        .from("traffic_report_admins")
        .select("user_id")
        .eq("user_id", currentUser.id)
        .maybeSingle();

      if (error) throw error;
      isCurrentUserAdmin = Boolean(data);
    } catch (error) {
      console.error("管理者権限を確認できませんでした:", error);
      showToast("管理者権限を確認できません。Supabaseの設定と管理者テーブルを確認してください。", "error");
    }
  }

  updateAuthControls();
  if (event === "PASSWORD_RECOVERY") {
    accountMode = "recovery";
    pendingVerificationEmail = "";
    updateAccountDialog();
    const dialog = getElement("account-dialog");
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else dialog?.setAttribute("open", "");
    setAccountFeedback("新しいパスワードを設定してください。");
  }
  updateAccountDialog();
  renderMarkers();
  renderReportList();
}

async function initializeSupabaseAuth() {
  supabaseClient.auth.onAuthStateChange((event, session) => {
    window.setTimeout(() => {
      void syncAuthenticatedUser(session?.user || null, event);
    }, 0);
  });

  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw error;
  await syncAuthenticatedUser(data.session?.user || null);
}

async function handleAccountSubmit(event) {
  event.preventDefault();
  if (!supabaseClient) {
    setAccountFeedback("ログイン機能を利用できません。Supabaseの設定を確認してください。", "error");
    return;
  }

  const form = getElement("account-form");
  if (!form?.reportValidity()) return;

  const email = getElement("account-email")?.value.trim() || "";
  const password = getElement("account-password")?.value || "";
  const passwordConfirm = getElement("account-password-confirm")?.value || "";
  const button = getElement("sign-in-button");
  if (button) button.disabled = true;
  setAccountFeedback("");

  try {
    if (accountMode === "signup" || accountMode === "recovery") {
      if (password.length < 8) {
        setAccountFeedback("パスワードは8文字以上にしてください。", "error");
        return;
      }
      if (password !== passwordConfirm) {
        setAccountFeedback("確認用パスワードが一致しません。", "error");
        return;
      }
    }

    if (accountMode === "login") {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      closeDialog("account-dialog");
      showToast("ログインしました。");
      return;
    }

    if (accountMode === "signup") {
      const { data, error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: new URL("map.html", window.location.href).href }
      });
      if (error) throw error;
      if (data.user && data.user.identities?.length === 0) {
        setAccountFeedback("このメールアドレスは既に登録されています。ログインしてください。", "error");
        return;
      }
      if (data.session) {
        closeDialog("account-dialog");
        showToast("アカウントを作成し、ログインしました。");
      } else {
        pendingVerificationEmail = email;
        updateAccountDialog();
        setAccountFeedback("確認メールを送信しました。メール内のリンクから登録を完了してください。", "success");
      }
      return;
    }

    if (accountMode === "recovery") {
      const { error } = await supabaseClient.auth.updateUser({ password });
      if (error) throw error;
      accountMode = "login";
      closeDialog("account-dialog");
      showToast("パスワードを更新しました。");
    }
  } catch (error) {
    console.error("アカウント処理に失敗しました:", error);
    if (error?.code === "email_not_confirmed") {
      pendingVerificationEmail = email;
      updateAccountDialog();
    }
    setAccountFeedback(getAuthErrorMessage(error, accountMode), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function claimAdminAccess() {
  const passwordInput = getElement("claim-admin-password");
  const password = passwordInput?.value || "";
  const button = getElement("claim-admin-button");
  if (!supabaseClient || !currentUser || !password) {
    setAccountFeedback("ログイン後、管理者認証パスワードを入力してください。", "error");
    return;
  }

  if (button) button.disabled = true;
  setAccountFeedback("");
  try {
    const { error } = await supabaseClient.functions.invoke("claim-admin", {
      body: { password }
    });
    if (error) throw error;
    if (passwordInput) passwordInput.value = "";
    await syncAuthenticatedUser(currentUser);
    if (!isCurrentUserAdmin) {
      throw new Error("管理者権限の反映を確認できませんでした。時間をおいて再度お試しください。");
    }
    setAccountFeedback("管理者権限を確認しました。管理機能が有効になりました。", "success");
  } catch (error) {
    console.error("管理者認証に失敗しました:", error);
    const status = error?.context?.status;
    if (status === 403) {
      setAccountFeedback("管理者認証パスワードが正しくありません。", "error");
    } else if (status === 429) {
      setAccountFeedback("認証の試行回数が上限に達しました。1時間後に再度お試しください。", "error");
    } else {
      setAccountFeedback(
        error?.message || "管理者認証に失敗しました。Supabaseの関数設定を確認してください。",
        "error"
      );
    }
  } finally {
    if (button) button.disabled = false;
  }
}

async function requestPasswordReset() {
  if (!supabaseClient) {
    setAccountFeedback("パスワード再設定を利用できません。Supabaseの設定を確認してください。", "error");
    return;
  }
  const emailInput = getElement("account-email");
  const email = emailInput?.value.trim() || "";
  if (!email) {
    emailInput?.focus();
    setAccountFeedback("先にメールアドレスを入力してください。", "error");
    return;
  }
  if (!emailInput?.reportValidity()) return;

  const button = getElement("reset-password-button");
  if (button) button.disabled = true;
  setAccountFeedback("");
  try {
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: new URL("map.html", window.location.href).href
    });
    if (error) throw error;
    setAccountFeedback("パスワード再設定の案内をメールで送信しました。メールをご確認ください。", "success");
  } catch (error) {
    console.error("パスワード再設定メールを送信できませんでした:", error);
    setAccountFeedback(getAuthErrorMessage(error, "reset"), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function resendConfirmationEmail() {
  if (!supabaseClient || !pendingVerificationEmail) return;
  const button = getElement("resend-confirmation-button");
  if (button) button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.resend({
      type: "signup",
      email: pendingVerificationEmail,
      options: { emailRedirectTo: new URL("map.html", window.location.href).href }
    });
    if (error) throw error;
    setAccountFeedback("確認メールを再送しました。受信トレイをご確認ください。", "success");
  } catch (error) {
    console.error("確認メールを再送できませんでした:", error);
    setAccountFeedback(getAuthErrorMessage(error, "resend"), "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function setAccountMode(mode) {
  accountMode = mode === "signup" ? "signup" : "login";
  pendingVerificationEmail = "";
  const password = getElement("account-password");
  const passwordConfirm = getElement("account-password-confirm");
  if (password) password.value = "";
  if (passwordConfirm) passwordConfirm.value = "";
  resetPasswordVisibility();
  setAccountFeedback("");
  updateAccountDialog();
}

function resetPasswordVisibility() {
  [
    ["account-password", "toggle-password-visibility"],
    ["account-password-confirm", "toggle-confirm-password-visibility"]
  ].forEach(([inputId, buttonId]) => {
    const input = getElement(inputId);
    const button = getElement(buttonId);
    const icon = button?.querySelector("i");
    if (input) input.type = "password";
    if (button) button.setAttribute("aria-label", "パスワードを表示");
    icon?.classList.add("fa-eye");
    icon?.classList.remove("fa-eye-slash");
  });
}

async function handleSignOut() {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    accountMode = "login";
    pendingVerificationEmail = "";
    getElement("account-form")?.reset();
    closeDialog("account-dialog");
    showToast("ログアウトしました。");
  } catch (error) {
    console.error("ログアウトに失敗しました:", error);
    showToast(`ログアウトできませんでした: ${error.message}`, "error");
  }
}

async function showAdminLogs() {
  if (!isCurrentUserAdmin) {
    showToast("管理ログを閲覧する権限がありません。", "error");
    return;
  }

  const dialog = getElement("admin-log-dialog");
  const list = getElement("admin-log-list");
  if (!dialog || !list) return;
  list.replaceChildren();

  const loading = document.createElement("p");
  loading.className = "field-help";
  loading.textContent = "ログを読み込んでいます。";
  list.appendChild(loading);
  if (dialog.showModal && !dialog.open) dialog.showModal();
  else dialog.setAttribute("open", "");

  try {
    const { data, error } = await supabaseClient
      .from("traffic_report_deletion_logs")
      .select("id, report_id, deleted_by_email, deleted_by, report_snapshot, deleted_at")
      .order("deleted_at", { ascending: false })
      .limit(100);

    if (error) throw error;
    list.replaceChildren();

    if (data.length === 0) {
      const empty = document.createElement("p");
      empty.className = "field-help";
      empty.textContent = "削除ログはまだありません。";
      list.appendChild(empty);
      return;
    }

    data.forEach((entry) => {
      const snapshot = entry.report_snapshot || {};
      const item = document.createElement("article");
      item.className = "admin-log-entry";

      const title = document.createElement("h3");
      title.textContent = typeof snapshot.title === "string" ? snapshot.title : "タイトル不明";

      const actor = document.createElement("p");
      actor.textContent = `削除者: ${entry.deleted_by_email || entry.deleted_by || "不明"}`;

      const date = document.createElement("p");
      date.textContent = `削除日時: ${formatDate(entry.deleted_at)}`;

      const location = document.createElement("p");
      location.textContent = `場所: ${typeof snapshot.location === "string" && snapshot.location
        ? snapshot.location
        : "場所の説明なし"}`;

      const category = document.createElement("p");
      const reportCategory = CATEGORIES[snapshot.category];
      category.textContent = `カテゴリ: ${reportCategory
        ? `${reportCategory.icon} ${reportCategory.label}`
        : "不明"}`;

      const status = document.createElement("p");
      status.textContent = `削除時の状態: ${STATUS_LABELS[snapshot.status] || "不明"}`;

      const description = document.createElement("p");
      description.textContent = `説明: ${typeof snapshot.description === "string" && snapshot.description
        ? snapshot.description
        : "説明はありません。"}`;

      const coordinates = document.createElement("p");
      coordinates.textContent = Number.isFinite(Number(snapshot.latitude)) &&
        Number.isFinite(Number(snapshot.longitude))
        ? `座標: ${Number(snapshot.latitude).toFixed(6)}, ${Number(snapshot.longitude).toFixed(6)}`
        : "座標: 不明";

      const reportId = document.createElement("p");
      reportId.textContent = `投稿ID: ${entry.report_id}`;

      item.append(title, actor, date, category, status, location, description, coordinates, reportId);
      list.appendChild(item);
    });
  } catch (error) {
    console.error("管理ログを読み込めませんでした:", error);
    list.replaceChildren();
    const failure = document.createElement("p");
    failure.className = "field-help";
    failure.textContent = "管理ログを読み込めませんでした。データベース設定を確認してください。";
    list.appendChild(failure);
    showToast("管理ログを読み込めませんでした。", "error");
  }
}

async function openInviteManagement() {
  if (!isCurrentUserAdmin) {
    showToast("招待リンクを管理する権限がありません。", "error");
    return;
  }

  const dialog = getElement("invite-management-dialog");
  if (dialog?.showModal && !dialog.open) dialog.showModal();
  else dialog?.setAttribute("open", "");
  await loadInviteList();
}

async function loadInviteList() {
  const list = getElement("invite-list");
  if (!list || !isCurrentUserAdmin) return;
  list.replaceChildren();

  const loading = document.createElement("p");
  loading.className = "field-help";
  loading.textContent = "招待リンクを読み込んでいます。";
  list.appendChild(loading);

  try {
    const { data, error } = await supabaseClient
      .from("traffic_report_invites")
      .select("id, label, created_at, revoked_at, created_by")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    list.replaceChildren();
    if (data.length === 0) {
      const empty = document.createElement("p");
      empty.className = "field-help";
      empty.textContent = "発行済みリンクはありません。";
      list.appendChild(empty);
      return;
    }

    data.forEach((invite) => {
      const item = document.createElement("article");
      item.className = "invite-list-item";

      const title = document.createElement("h4");
      title.textContent = invite.label || "名前なしの招待リンク";

      const created = document.createElement("p");
      created.textContent = `発行日時: ${formatDate(invite.created_at)}`;

      const status = document.createElement("p");
      const isRevoked = Boolean(invite.revoked_at);
      status.className = isRevoked ? "invite-status is-revoked" : "invite-status";
      status.textContent = isRevoked
        ? `無効化済み: ${formatDate(invite.revoked_at)}`
        : "有効・無期限・複数回利用";

      item.append(title, created, status);
      if (!isRevoked) {
        const revokeButton = document.createElement("button");
        revokeButton.type = "button";
        revokeButton.className = "secondary-button invite-revoke-button";
        revokeButton.textContent = "無効化";
        revokeButton.addEventListener("click", () => {
          void revokeInvite(invite.id, invite.label);
        });
        item.appendChild(revokeButton);
      }
      list.appendChild(item);
    });
  } catch (error) {
    console.error("招待リンク一覧を読み込めませんでした:", error);
    list.replaceChildren();
    const failure = document.createElement("p");
    failure.className = "account-feedback is-error";
    failure.textContent = "招待リンク一覧を読み込めません。データベース設定を確認してください。";
    list.appendChild(failure);
  }
}

async function createInvite(event) {
  event.preventDefault();
  if (!isCurrentUserAdmin) {
    showToast("招待リンクを発行する権限がありません。", "error");
    return;
  }
  if (window.location.protocol !== "https:") {
    showToast("招待リンクの発行には、HTTPSで公開したサイトが必要です。", "error");
    return;
  }

  const label = getElement("invite-label")?.value.trim() || "";
  const button = getElement("create-invite-button");
  const generated = getElement("generated-invite");
  if (button) button.disabled = true;
  generated?.classList.add("is-hidden");

  try {
    const { data, error } = await supabaseClient.rpc("create_traffic_report_invite", {
      p_label: label
    });
    if (error) throw error;
    const invite = Array.isArray(data) ? data[0] : data;
    if (!invite || typeof invite.invite_token !== "string") {
      throw new Error("招待リンクが正しく発行されませんでした。");
    }

    const link = new URL("map.html", window.location.href);
    link.searchParams.set("invite", invite.invite_token);
    const linkInput = getElement("generated-invite-url");
    if (linkInput) linkInput.value = link.href;
    generated?.classList.remove("is-hidden");
    getElement("invite-create-form")?.reset();
    await loadInviteList();
  } catch (error) {
    console.error("招待リンクを発行できませんでした:", error);
    showToast("招待リンクを発行できません。管理者権限とデータベース設定を確認してください。", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

async function revokeInvite(id, label) {
  if (!isCurrentUserAdmin) {
    showToast("招待リンクを無効化する権限がありません。", "error");
    return;
  }
  if (!window.confirm(`「${label || "名前なしの招待リンク"}」を無効化しますか？このリンクから新しい投稿はできなくなります。`)) return;

  try {
    const { data, error } = await supabaseClient.rpc("revoke_traffic_report_invite", {
      p_invite_id: id
    });
    if (error) throw error;
    if (data !== true) throw new Error("招待リンクはすでに無効化されています。");
    getElement("generated-invite")?.classList.add("is-hidden");
    showToast("招待リンクを無効化しました。");
    await loadInviteList();
  } catch (error) {
    console.error("招待リンクを無効化できませんでした:", error);
    showToast("招待リンクを無効化できませんでした。", "error");
  }
}

async function copyGeneratedInvite() {
  const input = getElement("generated-invite-url");
  if (!input?.value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(input.value);
    } else {
      input.focus();
      input.select();
      if (!document.execCommand("copy")) throw new Error("クリップボードへのコピーに失敗しました。");
    }
    showToast("招待リンクをコピーしました。");
  } catch (error) {
    console.error("招待リンクをコピーできませんでした:", error);
    showToast("コピーできませんでした。リンク欄を選択して手動でコピーしてください。", "error");
  }
}

/* =========================
   地図の初期化
   ========================= */

function initializeMap() {
  const mapElement = getElement("map");

  if (!mapElement) {
    console.error('HTMLに id="map" がありません。');
    return;
  }

  if (typeof L === "undefined") {
    showToast("地図ライブラリを読み込めませんでした。", "error");
    console.error("Leafletが読み込まれていません。");
    return;
  }

  map = L.map(mapElement, {
    zoomControl: false,
    preferCanvas: true,
    maxBounds: [[-85.05112878, -180], [85.05112878, 180]],
    maxBoundsViscosity: 1
  }).setView(CONFIG.initialCenter, CONFIG.initialZoom);

  L.tileLayer(CONFIG.tileUrl, {
    attribution: CONFIG.attribution,
    maxZoom: 19,
    noWrap: true
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);

  map.on("click", (event) => {
    if (appMode !== "propose") {
      updateMapStatus("見るモードです。投稿するには「提案する」に切り替えてください。");
      return;
    }
    if (!requirePostAccess()) return;

    const coordinates = {
      lat: event.latlng.lat,
      lng: event.latlng.lng
    };

    updateMapStatus("地点を選択しました。投稿内容を入力してください。");
    openCreateDialog(coordinates);
  });

  mapReady = true;
  renderMarkers();
  window.setTimeout(() => map.invalidateSize(), 100);
}

/* =========================
   地図マーカー
   ========================= */

function createMarkerIcon(report, selected = false) {
  const category = CATEGORIES[report.category] || CATEGORIES.other;

  return L.divIcon({
    className: "traffic-marker-wrapper",
    html: `
      <div class="traffic-marker ${selected ? "is-selected" : ""}"
           style="--marker-color:${category.color}">
        <div class="traffic-marker-inner">${category.icon}</div>
      </div>
    `,
    iconSize: [42, 48],
    iconAnchor: [21, 43],
    popupAnchor: [0, -40]
  });
}

function renderMarkers() {
  if (!mapReady || !markerLayer) return;

  markerLayer.clearLayers();
  markersById.clear();

  getFilteredReports().forEach((report) => {
    if (!isValidCoordinate(report.lat, report.lng)) return;

    const marker = L.marker([report.lat, report.lng], {
      icon: createMarkerIcon(report, report.id === selectedReportId),
      keyboard: true,
      title: report.title
    });

    marker.bindPopup(createPopupContent(report), {
      maxWidth: 270
    });
    marker.bindTooltip(report.title, {
      direction: "top",
      offset: [0, -36],
      opacity: 0.96
    });

    marker.on("click", () => {
      const previousId = selectedReportId;
      selectedReportId = report.id;
      [previousId, report.id].forEach((id) => {
        const selectedMarker = markersById.get(id);
        const selectedReport = reports.find((item) => item.id === id);
        if (selectedMarker && selectedReport) {
          selectedMarker.setIcon(createMarkerIcon(selectedReport, id === selectedReportId));
        }
      });
      renderReportList();
    });

    marker.addTo(markerLayer);
    markersById.set(report.id, marker);
  });
}

function createPopupContent(report) {
  const category = CATEGORIES[report.category] || CATEGORIES.other;

  const wrapper = document.createElement("div");
  wrapper.className = "map-popup";

  const title = document.createElement("strong");
  title.textContent = report.title;

  const categoryText = document.createElement("p");
  categoryText.textContent = `${category.icon} ${category.label}`;

  const location = document.createElement("p");
  location.textContent = report.location || "場所の説明なし";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "popup-detail-button";
  button.textContent = "詳細を見る";
  button.addEventListener("click", () => openReportDetail(report.id));

  wrapper.append(title, categoryText, location, button);
  return wrapper;
}

function isValidCoordinate(lat, lng) {
  return Number.isFinite(Number(lat)) &&
    Number.isFinite(Number(lng)) &&
    Number(lat) >= -90 &&
    Number(lat) <= 90 &&
    Number(lng) >= -180 &&
    Number(lng) <= 180;
}

/* =========================
   投稿の絞り込み
   ========================= */

function getFilteredReports() {
  const searchInput = getElement("map-search-input");
  const sortSelect = getElement("report-sort-select");

  const query = (searchInput?.value || "").trim().toLowerCase();
  const sort = sortSelect?.value || "newest";

  let filtered = reports.filter((report) => {
    const categoryMatch =
      activeCategory === "all" || report.category === activeCategory;

    const searchable = [
      report.title,
      report.description,
      report.location,
      CATEGORIES[report.category]?.label
    ].join(" ").toLowerCase();

    const queryMatch = !query || searchable.includes(query);

    return categoryMatch && queryMatch;
  });

  if (sort === "votes") {
    filtered.sort((a, b) => (b.votes || 0) - (a.votes || 0));
  } else if (sort === "oldest") {
    filtered.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else {
    filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  return filtered;
}

/* =========================
   投稿一覧
   ========================= */

function renderReportList() {
  const list = getElement("report-list");
  if (!list) return;

  const filtered = getFilteredReports();

  const count = getElement("report-result-count");
  if (count) count.textContent = `${filtered.length}件`;

  list.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "report-empty";
    empty.textContent = "投稿が見つかりません。検索条件を変更してください。";
    list.appendChild(empty);
  } else {
    filtered.forEach((report) => {
      list.appendChild(createReportCard(report));
    });
  }

  updateStatistics();
}

function createReportCard(report) {
  const category = CATEGORIES[report.category] || CATEGORIES.other;

  const card = document.createElement("article");
  card.className = `report-card ${report.id === selectedReportId ? "is-selected" : ""}`;
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `投稿の詳細: ${report.title}`);

  const top = document.createElement("div");
  top.className = "report-card-top";

  const categoryBadge = document.createElement("span");
  categoryBadge.className = "report-category";
  categoryBadge.style.setProperty("--category-color", category.color);
  categoryBadge.textContent = `${category.icon} ${category.label}`;

  const status = document.createElement("span");
  status.className = `report-status status-${report.status}`;
  status.textContent = STATUS_LABELS[report.status] || "未対応";

  top.append(categoryBadge, status);
  if (canDeleteReport(report)) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "report-delete-button";
    deleteButton.setAttribute("aria-label", `投稿「${report.title}」を削除`);
    deleteButton.title = "投稿を削除";
    deleteButton.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteReport(report.id);
    });
    deleteButton.addEventListener("keydown", (event) => event.stopPropagation());
    top.appendChild(deleteButton);
  }

  const title = document.createElement("h3");
  title.className = "report-card-title";
  title.textContent = report.title;

  const description = document.createElement("p");
  description.className = "report-card-description";
  description.textContent = report.description || "説明はありません。";

  const location = document.createElement("p");
  location.className = "report-card-location";
  location.textContent = `📍 ${report.location || "場所の説明なし"}`;

  const footer = document.createElement("div");
  footer.className = "report-card-footer";

  const date = document.createElement("span");
  date.textContent = formatDate(report.createdAt);

  const votes = document.createElement("span");
  votes.textContent = `👍 ${report.votes || 0}`;

  footer.append(date, votes);
  card.append(top, title, description, location, footer);

  card.addEventListener("click", () => selectReport(report.id));
  card.addEventListener("keydown", (event) => {
    if (event.target !== card) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectReport(report.id);
    }
  });

  return card;
}

function canDeleteReport(report) {
  if (!supabaseClient) return true;
  return Boolean(
    currentUser &&
    (isCurrentUserAdmin || report.createdBy === currentUser.id)
  );
}

async function deleteReport(id) {
  const report = reports.find((item) => item.id === id);
  if (!report || !canDeleteReport(report)) {
    showToast("この投稿を削除する権限がありません。", "error");
    return;
  }
  if (!window.confirm(`「${report.title}」を削除します。この操作は取り消せません。`)) return;

  if (supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from("traffic_reports")
        .delete()
        .eq("id", id)
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("投稿が削除されなかったか、削除権限がありません。");
      }
    } catch (error) {
      console.error("投稿を削除できませんでした:", error);
      showToast(`投稿を削除できませんでした: ${error.message}`, "error");
      return;
    }
  } else {
    const previousReports = reports;
    reports = reports.filter((item) => item.id !== id);
    if (!saveReports()) {
      reports = previousReports;
      return;
    }
  }

  if (supabaseClient) reports = reports.filter((item) => item.id !== id);
  if (selectedReportId === id) selectedReportId = null;
  if (getElement("report-detail-dialog")?.open) {
    closeDialog("report-detail-dialog");
  }
  renderMarkers();
  renderReportList();
  showToast("投稿を削除しました。");
}

function selectReport(id) {
  const report = reports.find((item) => item.id === id);
  if (!report) return;

  selectedReportId = id;
  renderMarkers();

  if (mapReady && isValidCoordinate(report.lat, report.lng)) {
    map.flyTo([report.lat, report.lng], Math.max(map.getZoom(), 16), {
      duration: 0.6
    });

    const marker = markersById.get(id);
    if (marker) {
      window.setTimeout(() => marker.openPopup(), 350);
    }
  }

  renderReportList();
}

/* =========================
   統計
   ========================= */

function updateStatistics() {
  const total = getElement("total-report-count");
  const pending = getElement("pending-report-count");
  const resolved = getElement("resolved-report-count");

  if (total) total.textContent = reports.length;
  if (pending) {
    pending.textContent = reports.filter(
      (report) => report.status === "investigating"
    ).length;
  }
  if (resolved) {
    resolved.textContent = reports.filter(
      (report) => report.status === "resolved"
    ).length;
  }
}

/* =========================
   投稿フォーム
   ========================= */

function openCreateDialog(coordinates = null) {
  if (!requirePostAccess()) return;

  const dialog = getElement("create-report-dialog");
  const form = getElement("create-report-form");

  if (!dialog || !form) {
    showToast("投稿フォームがHTMLに見つかりません。", "error");
    return;
  }

  const reportCoordinates = coordinates || (mapReady ? map.getCenter() : null);
  if (!reportCoordinates) {
    showToast("地図を読み込めないため投稿場所を指定できません。", "error");
    return;
  }

  form.reset();

  const latInput = getElement("report-latitude");
  const lngInput = getElement("report-longitude");

  if (latInput) latInput.value = reportCoordinates.lat.toFixed(6);
  if (lngInput) lngInput.value = reportCoordinates.lng.toFixed(6);

  const locationInput = getElement("report-location");
  if (locationInput) {
    locationInput.value =
      `${reportCoordinates.lat.toFixed(5)}, ${reportCoordinates.lng.toFixed(5)}`;
  }

  updateCharacterCount();

  if (typeof dialog.showModal === "function") {
    if (!dialog.open) dialog.showModal();
  } else {
    dialog.setAttribute("open", "");
  }
}

function closeDialog(id) {
  const dialog = getElement(id);
  if (!dialog) return;

  if (typeof dialog.close === "function" && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
}

async function handleCreateReport(event) {
  event.preventDefault();
  if (!requirePostAccess()) return;
  if (reportsLoading) {
    showToast("投稿を読み込み中です。少し待ってからお試しください。", "error");
    return;
  }
  if (!supabaseClient) {
    showToast("Supabaseの設定を確認してください。", "error");
    return;
  }

  const title = getElement("report-title")?.value.trim() || "";
  const category = getElement("report-category")?.value || "other";
  const description = getElement("report-description")?.value.trim() || "";
  const location = getElement("report-location")?.value.trim() || "";
  const status = getElement("report-status")?.value || "pending";

  const latValue = getElement("report-latitude")?.value;
  const lngValue = getElement("report-longitude")?.value;

  const lat = latValue?.trim() ? Number(latValue) : Number.NaN;
  const lng = lngValue?.trim() ? Number(lngValue) : Number.NaN;

  if (!title) {
    showToast("タイトルを入力してください。", "error");
    return;
  }

  if (title.length > CONFIG.maxTitleLength) {
    showToast(`タイトルは${CONFIG.maxTitleLength}文字以内にしてください。`, "error");
    return;
  }

  if (description.length > CONFIG.maxDescriptionLength) {
    showToast(`説明は${CONFIG.maxDescriptionLength}文字以内にしてください。`, "error");
    return;
  }

  if (!Object.prototype.hasOwnProperty.call(CATEGORIES, category)) {
    showToast("カテゴリを選び直してください。", "error");
    return;
  }

  if (!isValidCoordinate(lat, lng)) {
    showToast("「提案する」モードで地図をタップして投稿場所を選んでください。", "error");
    return;
  }

  const report = {
    id: createId(),
    title,
    category,
    description,
    location: location || `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    lat,
    lng,
    status: Object.prototype.hasOwnProperty.call(STATUS_LABELS, status)
      ? status
      : "pending",
    votes: 0,
    createdAt: new Date().toISOString(),
    createdBy: currentUser?.id || null,
    demo: false
  };

  const submitButton = getElement("submit-report-button");
  if (submitButton) submitButton.disabled = true;

  try {
    if (!currentUser && activeInviteToken) {
      const { data: reportId, error } = await supabaseClient.rpc("create_report_with_invite", {
        p_token: activeInviteToken,
        p_title: report.title,
        p_category: report.category,
        p_description: report.description,
        p_location: report.location,
        p_latitude: report.lat,
        p_longitude: report.lng
      });

      if (error) throw error;
      if (typeof reportId !== "string" || !reportId) {
        throw new Error("投稿の保存結果を確認できませんでした。");
      }

      const { data, error: loadError } = await supabaseClient
        .from("traffic_reports")
        .select("*")
        .eq("id", reportId)
        .single();
      if (loadError) throw loadError;
      const savedReport = mapSupabaseReport(data, reports.length);
      if (!savedReport) throw new Error("Supabaseから返された投稿データが不正です。");
      Object.assign(report, savedReport);
    } else {
      const { data, error } = await supabaseClient
        .from("traffic_reports")
        .insert({
          title: report.title,
          category: report.category,
          description: report.description,
          location: report.location,
          latitude: report.lat,
          longitude: report.lng,
          created_by: currentUser.id
        })
        .select()
        .single();

      if (error) throw error;
      const savedReport = mapSupabaseReport(data, reports.length);
      if (!savedReport) throw new Error("Supabaseから返された投稿データが不正です。");
      Object.assign(report, savedReport);
    }
  } catch (error) {
    console.error("投稿の保存に失敗しました:", error);
    showToast("投稿を保存できませんでした。招待リンクまたはログイン状態を確認してください。", "error");
    return;
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
  reports.unshift(report);

  selectedReportId = report.id;
  activeCategory = "all";

  const searchInput = getElement("map-search-input");
  if (searchInput) searchInput.value = "";

  $$("#category-filters [data-category]").forEach((button) => {
    button.classList.toggle(
      "is-active",
      button.dataset.category === "all"
    );
  });

  closeDialog("create-report-dialog");
  renderMarkers();
  renderReportList();

  if (mapReady) {
    map.flyTo([lat, lng], 16, { duration: 0.7 });
    window.setTimeout(() => {
      markersById.get(report.id)?.openPopup();
    }, 750);
  }

  showToast("交通問題を投稿しました。");
}

/* =========================
   詳細ダイアログ
   ========================= */

function openReportDetail(id) {
  const report = reports.find((item) => item.id === id);
  if (!report) return;

  selectedReportId = id;

  const dialog = getElement("report-detail-dialog");
  const title = getElement("report-detail-title");
  const content = getElement("report-detail-content");

  if (title) title.textContent = report.title;

  if (content) {
    const category = CATEGORIES[report.category] || CATEGORIES.other;

    content.replaceChildren();

    const addLine = (label, value, className = "") => {
      const paragraph = document.createElement("p");
      if (className) paragraph.className = className;

      const strong = document.createElement("strong");
      strong.textContent = `${label}: `;

      paragraph.append(strong, document.createTextNode(value));
      content.appendChild(paragraph);
    };

    addLine("カテゴリ", `${category.icon} ${category.label}`);
    addLine("状態", STATUS_LABELS[report.status] || "未対応");
    addLine("場所", report.location || "場所の説明なし");
    addLine("投稿日時", formatDate(report.createdAt));
    addLine("賛同数", String(report.votes || 0));
    addLine("説明", report.description || "説明はありません。");

    if (report.demo) {
      addLine("注意", "これは画面確認用の架空サンプルです。");
    }

    const coordinates = document.createElement("p");
    coordinates.textContent =
      `座標: ${Number(report.lat).toFixed(6)}, ${Number(report.lng).toFixed(6)}`;
    content.appendChild(coordinates);
  }

  const voteButton = getElement("detail-vote-button");
  if (voteButton) {
    voteButton.onclick = () => voteForReport(report.id);
  }

  if (dialog?.showModal && !dialog.open) {
    dialog.showModal();
  } else if (dialog) {
    dialog.setAttribute("open", "");
  }

  renderMarkers();
  renderReportList();
}

async function voteForReport(id) {
  const report = reports.find((item) => item.id === id);
  if (!report) return;
  if (reportsLoading) {
    showToast("投稿を読み込み中です。少し待ってからお試しください。", "error");
    return;
  }

  const previousVotes = report.votes;
  if (previousVotes >= Number.MAX_SAFE_INTEGER) {
    showToast("これ以上賛同数を増やせません。", "error");
    return;
  }
  if (supabaseClient) {
    const voteButton = getElement("detail-vote-button");
    if (voteButton) voteButton.disabled = true;
    try {
      const { data, error } = await supabaseClient.rpc("increment_report_votes", {
        target_report_id: id
      });
      if (error) throw error;
      if (!Number.isSafeInteger(data) || data <= previousVotes) {
        throw new Error("賛同数を更新できませんでした。");
      }
      report.votes = data;
    } catch (error) {
      console.error("Supabaseで賛同を記録できませんでした:", error);
      showToast("賛同を記録できませんでした。接続設定とデータベース関数を確認してください。", "error");
      return;
    } finally {
      if (voteButton) voteButton.disabled = false;
    }
  } else {
    report.votes = previousVotes + 1;
    if (!saveReports()) {
      report.votes = previousVotes;
      return;
    }
  }
  renderMarkers();
  renderReportList();
  openReportDetail(id);

  showToast("賛同を記録しました。");
}

/* =========================
   地図検索
   ========================= */

async function searchMapLocation(event) {
  event?.preventDefault();

  const input = getElement("map-search-input");
  const query = input?.value.trim();

  if (!query) {
    showToast("地名や住所を入力してください。", "error");
    return;
  }

  if (!mapReady) {
    showToast("地図を利用できません。ページを再読み込みしてください。", "error");
    return;
  }

  updateMapStatus("場所を検索しています…");

  try {
    const cacheKey = query.replace(/\s+/g, " ").toLocaleLowerCase("ja-JP");
    let results = mapSearchCache.get(cacheKey);

    if (!results) {
      if (!supabaseClient) {
        throw new Error("住所検索にはSupabaseの設定が必要です。");
      }

      const delay = 1000 - (Date.now() - lastMapSearchAt);
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      lastMapSearchAt = Date.now();
      const { data, error } = await supabaseClient.functions.invoke(
        "nominatim-search",
        { body: { query } }
      );

      if (error) {
        if (error.context?.status === 429) {
          throw new Error("検索が集中しています。1秒ほど待って再度お試しください。");
        }
        throw error;
      }

      results = data?.results;
      if (!Array.isArray(results)) {
        throw new Error("住所検索サービスから不正な応答がありました。");
      }
      mapSearchCache.set(cacheKey, results);
    }

    if (!Array.isArray(results) || results.length === 0) {
      updateMapStatus("場所が見つかりませんでした。");
      showToast("別の地名や住所を試してください。", "error");
      return;
    }

    const result = results[0];
    const lat = Number(result.lat);
    const lng = Number(result.lon);

    if (!isValidCoordinate(lat, lng)) {
      throw new Error("検索結果の座標が不正です。");
    }

    map.flyTo([lat, lng], 16, { duration: 0.8 });
    updateMapStatus(`検索結果: ${result.display_name}`);
  } catch (error) {
    console.error(error);
    updateMapStatus("検索できませんでした。");
    showToast(
      error.message || "通信エラーです。時間をおいて試してください。",
      "error"
    );
  }
}

/* =========================
   現在地
   ========================= */

function locateUser() {
  if (!mapReady) {
    showToast("地図を利用できません。ページを再読み込みしてください。", "error");
    return;
  }

  if (!navigator.geolocation) {
    showToast("このブラウザでは現在地を取得できません。", "error");
    return;
  }

  updateMapStatus("現在地を取得しています…");

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;

      if (!isValidCoordinate(lat, lng)) {
        updateMapStatus("現在地を取得できませんでした。");
        showToast("現在地の座標を取得できませんでした。", "error");
        return;
      }

      map.flyTo([lat, lng], 16, { duration: 0.8 });
      updateMapStatus("現在地を表示しました。");
    },
    (error) => {
      console.error(error);
      updateMapStatus("現在地を取得できませんでした。");
      showToast(
        "位置情報を許可するか、ブラウザの設定を確認してください。",
        "error"
      );
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000
    }
  );
}

function updateMapStatus(message) {
  const status = getElement("map-status");
  if (status) status.textContent = message;
}

/* =========================
   フィルター操作
   ========================= */

function setupCategoryFilters() {
  const container = getElement("category-filters");
  if (!container) return;

  container.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest("[data-category]");
    if (!button) return;

    activeCategory = button.dataset.category || "all";

    container.querySelectorAll("[data-category]").forEach((item) => {
      const active = item === button;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });

    renderMarkers();
    renderReportList();
  });
}

/* =========================
   文字数カウント
   ========================= */

function updateCharacterCount() {
  const textarea = getElement("report-description");
  const counter = getElement("description-character-count");

  if (!textarea || !counter) return;

  counter.textContent =
    `${textarea.value.length} / ${CONFIG.maxDescriptionLength}`;

  counter.classList.toggle(
    "is-limit",
    textarea.value.length > CONFIG.maxDescriptionLength
  );
}

/* =========================
   地図 / 一覧モード
   ========================= */

function setAppMode(mode) {
  if (mode === "propose" && !requirePostAccess()) return false;
  appMode = mode === "propose" ? "propose" : "view";
  const viewButton = getElement("view-mode-button");
  const proposeButton = getElement("propose-mode-button");
  const proposing = appMode === "propose";

  document.body.classList.toggle("proposal-mode", proposing);
  if (viewButton) {
    viewButton.classList.toggle("is-active", !proposing);
    viewButton.setAttribute("aria-pressed", String(!proposing));
  }
  if (proposeButton) {
    proposeButton.classList.toggle("is-active", proposing);
    proposeButton.setAttribute("aria-pressed", String(proposing));
  }

  updateMapStatus(
    proposing
      ? "提案モードです。地図をタップして投稿地点を選んでください。"
      : "見るモードです。マーカーや投稿一覧から地域の気づきを確認できます。"
  );
  return true;
}

/* =========================
   ボタン連携
   ========================= */

function onClick(id, callback) {
  const element = getElement(id);
  if (element) element.addEventListener("click", callback);
}

function setMobileReportsOpen(open) {
  document.body.classList.toggle("reports-open", open);
  const toggleButton = getElement("mobile-reports-button");
  toggleButton?.setAttribute("aria-expanded", String(open));

  if (open) getElement("mobile-sidebar-close-button")?.focus();
  else toggleButton?.focus();
}

function setupEventListeners() {
  onClick("header-create-button", () => {
    if (!setAppMode("propose")) return;
    openCreateDialog();
  });
  onClick("empty-create-button", () => {
    if (!setAppMode("propose")) return;
    openCreateDialog();
  });
  onClick("close-create-dialog-button", () => closeDialog("create-report-dialog"));
  onClick("cancel-create-report-button", () => closeDialog("create-report-dialog"));

  onClick("close-detail-dialog-button", () => closeDialog("report-detail-dialog"));
  onClick("detail-back-button", () => closeDialog("report-detail-dialog"));
  onClick("account-button", () => {
    if (!currentUser) setAccountMode("login");
    else accountMode = "login";
    updateAccountDialog();
    const dialog = getElement("account-dialog");
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else dialog?.setAttribute("open", "");
  });
  onClick("close-account-dialog-button", () => closeDialog("account-dialog"));
  onClick("account-login-tab", () => setAccountMode("login"));
  onClick("account-signup-tab", () => setAccountMode("signup"));
  onClick("reset-password-button", requestPasswordReset);
  onClick("claim-admin-button", claimAdminAccess);
  onClick("resend-confirmation-button", resendConfirmationEmail);
  onClick("sign-out-button", handleSignOut);
  onClick("admin-log-button", showAdminLogs);
  onClick("close-admin-log-button", () => closeDialog("admin-log-dialog"));
  onClick("admin-invite-button", openInviteManagement);
  onClick("close-invite-management-button", () => closeDialog("invite-management-dialog"));
  onClick("refresh-invites-button", loadInviteList);
  onClick("copy-invite-link-button", copyGeneratedInvite);

  onClick("help-button", () => {
    const dialog = getElement("help-dialog");
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else dialog?.setAttribute("open", "");
  });

  onClick("close-help-dialog-button", () => closeDialog("help-dialog"));
  onClick("close-help-footer-button", () => closeDialog("help-dialog"));

  onClick("locate-me-button", locateUser);

  onClick("reset-map-button", () => {
    if (mapReady) map.flyTo(CONFIG.initialCenter, CONFIG.initialZoom);
    selectedReportId = null;
    renderMarkers();
    renderReportList();
    updateMapStatus("初期表示に戻しました。");
  });

  onClick("view-mode-button", () => setAppMode("view"));
  onClick("propose-mode-button", () => setAppMode("propose"));
  onClick("mobile-reports-button", () => setMobileReportsOpen(true));
  onClick("mobile-sidebar-close-button", () => setMobileReportsOpen(false));

  const searchForm = getElement("map-search-form");
  if (searchForm) {
    searchForm.addEventListener("submit", searchMapLocation);
  }

  const createForm = getElement("create-report-form");
  if (createForm) {
    createForm.addEventListener("submit", handleCreateReport);
  }

  const accountForm = getElement("account-form");
  if (accountForm) {
    accountForm.addEventListener("submit", handleAccountSubmit);
  }

  const inviteCreateForm = getElement("invite-create-form");
  if (inviteCreateForm) {
    inviteCreateForm.addEventListener("submit", createInvite);
  }

  onClick("toggle-password-visibility", () => togglePasswordVisibility("account-password", "toggle-password-visibility"));
  onClick("toggle-confirm-password-visibility", () => togglePasswordVisibility("account-password-confirm", "toggle-confirm-password-visibility"));

  const unifiedSearch = getElement("map-search-input");
  if (unifiedSearch) {
    unifiedSearch.addEventListener("input", () => {
      renderMarkers();
      renderReportList();
    });
  }

  function togglePasswordVisibility(inputId, buttonId) {
    const input = getElement(inputId);
    const button = getElement(buttonId);
    if (!input || !button) return;

    const isVisible = input.type === "text";
    input.type = isVisible ? "password" : "text";
    button.setAttribute("aria-label", isVisible ? "パスワードを表示" : "パスワードを隠す");
    const icon = button.querySelector("i");
    if (icon) {
      icon.classList.toggle("fa-eye", isVisible);
      icon.classList.toggle("fa-eye-slash", !isVisible);
    }
  }

  const sortSelect = getElement("report-sort-select");
  if (sortSelect) {
    sortSelect.addEventListener("change", renderReportList);
  }

  const description = getElement("report-description");
  if (description) {
    description.maxLength = CONFIG.maxDescriptionLength;
    description.addEventListener("input", updateCharacterCount);
  }

  setupCategoryFilters();

  // ダイアログの外側をクリックしたときに閉じる
  [
    "create-report-dialog",
    "report-detail-dialog",
    "help-dialog",
    "account-dialog",
    "admin-log-dialog",
    "invite-management-dialog"
  ].forEach((id) => {
    const dialog = getElement(id);
    if (!dialog) return;

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(id);
    });
  });

  // Escapeキーは標準のdialog動作に任せる
}

/* =========================
   起動
   ========================= */

async function initializeApp() {
  setupEventListeners();
  updateAuthControls();
  updateAccountDialog();
  initializeMap();
  renderReportList();
  updateCharacterCount();

  if (isSupabaseConfigured && !supabaseClient) {
    console.error("Supabase SDKを読み込めないか、接続設定が利用できません。");
    showToast("Supabase SDKまたは接続設定を読み込めませんでした。", "error");
  } else if (hasSupabaseSettings && !isSupabaseConfigured) {
    console.error("Supabase URLまたはanon keyの設定が不完全です。");
    showToast("supabase-config.js のProject URLとanon keyを確認してください。", "error");
  } else if (supabaseClient) {
    try {
      await initializeSupabaseAuth();
      await initializeInviteAccess();
      await loadSupabaseReports();
    } catch (error) {
      console.error("Supabaseから投稿を読み込めませんでした:", error);
      showToast("Supabaseから投稿を読み込めません。接続設定とテーブル権限を確認してください。", "error");
    } finally {
      reportsLoading = false;
    }
  } else {
    showToast("Supabase未設定のため、この端末内に投稿を保存しています。", "error");
  }

  updateMapStatus(
    !mapReady
      ? "地図を読み込めませんでした。ページを再読み込みしてください。"
      : activeInviteToken
        ? "招待リンクで投稿できます。地図をタップして投稿場所を選んでください。"
        : "見るモードです。マーカーや投稿一覧から地域の気づきを確認できます。"
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp, { once: true });
} else {
  initializeApp();
}
