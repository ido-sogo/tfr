"use strict";

const HOME_STORAGE_KEY = "traffic-issues-map-v1";
const HOME_PAGE_SIZE = 1000;

function updateHomeStatistics(reports) {
  const total = document.getElementById("total-report-count");
  const investigating = document.getElementById("pending-report-count");
  const resolved = document.getElementById("resolved-report-count");

  if (total) total.textContent = String(reports.length);
  if (investigating) {
    investigating.textContent = String(
      reports.filter((report) => report.status === "investigating").length
    );
  }
  if (resolved) {
    resolved.textContent = String(
      reports.filter((report) => report.status === "resolved").length
    );
  }
}

function updateHomeMessage(message, isError = false) {
  const element = document.getElementById("home-data-message");
  if (!element) return;

  element.replaceChildren();
  const icon = document.createElement("i");
  icon.className = isError
    ? "fa-solid fa-triangle-exclamation"
    : "fa-solid fa-circle-info";
  icon.setAttribute("aria-hidden", "true");
  element.append(icon, document.createTextNode(` ${message}`));
  element.classList.toggle("home-data-error", isError);
}

function loadLocalHomeReports() {
  const saved = localStorage.getItem(HOME_STORAGE_KEY);
  if (saved === null) {
    return [
      { status: "pending" },
      { status: "investigating" },
      { status: "pending" }
    ];
  }

  const parsed = JSON.parse(saved);
  if (!Array.isArray(parsed)) {
    throw new TypeError("保存された投稿データが配列ではありません。");
  }

  return parsed.filter((report) => report && typeof report === "object");
}

async function loadSupabaseHomeReports() {
  const settings = window.SUPABASE_CONFIG || {};
  const isConfigured =
    typeof settings.url === "string" &&
    /^https:\/\/.+\.supabase\.co$/.test(settings.url) &&
    typeof settings.anonKey === "string" &&
    settings.anonKey.length > 0;

  if (!isConfigured || !window.supabase?.createClient) return null;

  const client = window.supabase.createClient(settings.url, settings.anonKey);
  let pageStart = 0;
  const reports = [];

  while (true) {
    const { data, error } = await client
      .from("traffic_reports")
      .select("id, status")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(pageStart, pageStart + HOME_PAGE_SIZE - 1);

    if (error) throw error;
    reports.push(...data);
    if (data.length < HOME_PAGE_SIZE) return reports;
    pageStart += HOME_PAGE_SIZE;
  }
}

async function initializeHome() {
  try {
    const remoteReports = await loadSupabaseHomeReports();
    if (remoteReports) {
      updateHomeStatistics(remoteReports);
      return;
    }

    updateHomeStatistics(loadLocalHomeReports());
    if (window.SUPABASE_CONFIG?.url || window.SUPABASE_CONFIG?.anonKey) {
      updateHomeMessage(
        "投稿状況を取得できないため、この端末に保存された情報を表示しています。",
        true
      );
    }
  } catch (error) {
    console.error("ホームの投稿状況を読み込めませんでした:", error);
    updateHomeMessage(
      "投稿状況を読み込めませんでした。時間をおいて再読み込みしてください。",
      true
    );
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeHome, { once: true });
} else {
  void initializeHome();
}
