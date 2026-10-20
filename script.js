
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
  tileUrl: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  maxTitleLength: 80,
  maxDescriptionLength: 1000
};

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
    createdAt: row.created_at
  }, index);
}

async function loadSupabaseReports() {
  const { data, error } = await supabaseClient
    .from("traffic_reports")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;

  const normalizedReports = data
    .map((row, index) => mapSupabaseReport(row, index))
    .filter(Boolean);
  if (normalizedReports.length !== data.length) {
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
    preferCanvas: true
  }).setView(CONFIG.initialCenter, CONFIG.initialZoom);

  L.tileLayer(CONFIG.tileUrl, {
    attribution: CONFIG.attribution,
    maxZoom: 19
  }).addTo(map);

  L.control.zoom({ position: "bottomright" }).addTo(map);

  markerLayer = L.layerGroup().addTo(map);

  map.on("click", (event) => {
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
  categoryText.textContent = `${category.icon} ${category.label} · ${STATUS_LABELS[report.status] || "未対応"}`;

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
  const searchInput = getElement("report-search-input");
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
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectReport(report.id);
    }
  });

  return card;
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
      (report) => report.status !== "resolved"
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
  if (reportsLoading) {
    showToast("投稿を読み込み中です。少し待ってからお試しください。", "error");
    return;
  }
  if (hasSupabaseSettings && !supabaseClient) {
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
    showToast("地図をクリックして投稿場所を選んでください。", "error");
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
    demo: false
  };

  if (supabaseClient) {
    const submitButton = getElement("submit-report-button");
    if (submitButton) submitButton.disabled = true;

    try {
      const { data, error } = await supabaseClient
        .from("traffic_reports")
        .insert({
          title: report.title,
          category: report.category,
          description: report.description,
          location: report.location,
          latitude: report.lat,
          longitude: report.lng
        })
        .select()
        .single();

      if (error) throw error;
      const savedReport = mapSupabaseReport(data, reports.length);
      if (!savedReport) throw new Error("Supabaseから返された投稿データが不正です。");
      Object.assign(report, savedReport);
    } catch (error) {
      console.error("Supabaseへの投稿に失敗しました:", error);
      showToast("投稿を保存できませんでした。接続設定とテーブル権限を確認してください。", "error");
      return;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  } else {
    reports.unshift(report);
    if (!saveReports()) {
      reports.shift();
      return;
    }
  }
  if (supabaseClient) reports.unshift(report);

  selectedReportId = report.id;
  activeCategory = "all";

  const searchInput = getElement("report-search-input");
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
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("accept-language", "ja");

    const response = await fetch(url);

    if (!response.ok) throw new Error("検索リクエストに失敗しました。");

    const results = await response.json();

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
    showToast("通信エラーです。時間をおいて試してください。", "error");
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

function setViewMode(mode) {
  const mapSection = getElement("map-section");
  const sidebar = getElement("sidebar");
  const mapButton = getElement("map-mode-button");
  const listButton = getElement("list-mode-button");

  const listMode = mode === "list";

  document.body.classList.toggle("list-mode", listMode);
  document.body.classList.toggle("map-mode", !listMode);

  if (mapSection) mapSection.classList.toggle("is-hidden", listMode);
  if (sidebar) sidebar.classList.toggle("is-list-mode", listMode);

  if (mapButton) {
    mapButton.classList.toggle("is-active", !listMode);
    mapButton.setAttribute("aria-pressed", String(!listMode));
  }

  if (listButton) {
    listButton.classList.toggle("is-active", listMode);
    listButton.setAttribute("aria-pressed", String(listMode));
  }

  if (mapReady) {
    window.setTimeout(() => map.invalidateSize(), 150);
  }
}

/* =========================
   ボタン連携
   ========================= */

function onClick(id, callback) {
  const element = getElement(id);
  if (element) element.addEventListener("click", callback);
}

function setupEventListeners() {
  onClick("header-create-button", () => openCreateDialog());
  onClick("empty-create-button", () => openCreateDialog());
  onClick("close-create-dialog-button", () => closeDialog("create-report-dialog"));
  onClick("cancel-create-report-button", () => closeDialog("create-report-dialog"));

  onClick("close-detail-dialog-button", () => closeDialog("report-detail-dialog"));
  onClick("detail-back-button", () => closeDialog("report-detail-dialog"));

  onClick("help-button", () => {
    const dialog = getElement("help-dialog");
    if (dialog?.showModal && !dialog.open) dialog.showModal();
    else dialog?.setAttribute("open", "");
  });

  onClick("close-help-dialog-button", () => closeDialog("help-dialog"));
  onClick("close-help-footer-button", () => closeDialog("help-dialog"));

  onClick("sidebar-close-button", () => {
    getElement("sidebar")?.classList.toggle("is-collapsed");
    window.setTimeout(() => mapReady && map.invalidateSize(), 200);
  });

  onClick("locate-me-button", locateUser);

  onClick("reset-map-button", () => {
    if (mapReady) map.flyTo(CONFIG.initialCenter, CONFIG.initialZoom);
    selectedReportId = null;
    renderMarkers();
    renderReportList();
    updateMapStatus("初期表示に戻しました。");
  });

  onClick("map-mode-button", () => setViewMode("map"));
  onClick("list-mode-button", () => setViewMode("list"));

  const searchForm = getElement("map-search-form");
  if (searchForm) {
    searchForm.addEventListener("submit", searchMapLocation);
  }

  const createForm = getElement("create-report-form");
  if (createForm) {
    createForm.addEventListener("submit", handleCreateReport);
  }

  const reportSearch = getElement("report-search-input");
  if (reportSearch) {
    reportSearch.addEventListener("input", () => {
      renderMarkers();
      renderReportList();
    });
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
  ["create-report-dialog", "report-detail-dialog", "help-dialog"].forEach((id) => {
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
    mapReady
      ? "地図をクリックすると投稿場所を選択できます。"
      : "地図を読み込めませんでした。ページを再読み込みしてください。"
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp, { once: true });
} else {
  initializeApp();
}
