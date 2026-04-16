import React, { useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

// ─── helpers ────────────────────────────────────────────────────────────────

function parseDecimalInput(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  const euPattern = /^-?\d{1,3}(\.\d{3})*(,\d+)?$/;
  const euSimple  = /^-?\d+(,\d+)$/;
  let normalized = s;
  if (euPattern.test(s) || euSimple.test(s)) {
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = s.replace(/,/g, "");
  }
  const n = parseFloat(normalized);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function hoursAgo(h) {
  const d = new Date(Date.now() - h * 3600_000);
  return d.toISOString().slice(0, 10);
}

function getPdfName(row) {
  return row?.pdfFileName ?? row?.PdfFileName ?? row?.pdf_filename ?? row?.pdf ?? "(brak pdfFileName)";
}

function getRowCreatedAtMs(row) {
  const raw =
    row?.DataAutomatu ??
    row?.dataAutomatu ??
    row?.createdAt ??
    row?.CreatedAt ??
    null;

  if (!raw) return Number.NEGATIVE_INFINITY;

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

// Nazwy klientów które muszą pozostać w pełnej formie (whitelist).
// Domyślnie grupujemy po pierwszym członie (np. "TRUMPF POLSKA" → "TRUMPF").
// Wyjątki: SCANFIL (wiele oddziałów — każdy oddział to osobna grupa),
//          BIO TECTOR (samo "BIO" jest bez sensu jako nazwa grupy).
const KLIENT_FULL_NAME_WHITELIST = ["SCANFIL", "BIO TECTOR"];

function normalizeKlientGroup(name) {
  if (name === null || name === undefined || name === "") return "(brak klienta)";
  const safeName = String(name).trim();
  if (!safeName || safeName === "(brak klienta)") return "(brak klienta)";
  const upper = safeName.toUpperCase();
  // Sprawdź czy nazwa zaczyna się od któregoś z wyjątków — wtedy zostawiamy pełną nazwę
  for (const prefix of KLIENT_FULL_NAME_WHITELIST) {
    if (upper === prefix || upper.startsWith(prefix + " ") || upper.startsWith(prefix + "-")) {
      return safeName;
    }
  }
  // Domyślnie: bierz tylko pierwszy człon (do pierwszej spacji)
  const firstWord = safeName.split(/\s+/)[0];
  return firstWord || safeName;
}



export default function Home() {
  const [meta, setMeta] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);

  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);

  // ── 5. domyślny filtr: ukryj rejected ───────────────────────────────────
  const [statusFilter, setStatusFilter] = useState("non-rejected");
  // ────────────────────────────────────────────────────────────────────────

  const [klientFilter, setKlientFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(() => hoursAgo(24));
  const [dateTo,   setDateTo]   = useState("");

  const [selected,    setSelected]    = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPdf,  setLoadingPdf]  = useState(false);

  const [pdfDoc,     setPdfDoc]     = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const lastPdfNameRef = useRef(null);

  const [openKlients, setOpenKlients] = useState({});
  const [openGroups,  setOpenGroups]  = useState({});

  const [pdfMessage, setPdfMessage] = useState("");

  // ── 2. bulk checkboxy ───────────────────────────────────────────────────
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  // ────────────────────────────────────────────────────────────────────────

  const [editOpen,   setEditOpen]   = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError,  setEditError]  = useState("");
  const [editForm, setEditForm] = useState({
    Klient: "", FinalIndeks: "", NazwaKlienta: "", IloscKlienta: "", CenaOfertowa: "",
  });
  const [editNumericErrors, setEditNumericErrors] = useState({ IloscKlienta: "", CenaOfertowa: "" });

  const canvasRef  = useRef(null);
  const pdfjsRef   = useRef(null);
  const pdfCacheRef = useRef(new Map());
  const MAX_PDF_CACHE = 5;

  function prunePdfCache() {
    const cache = pdfCacheRef.current;
    if (cache.size <= MAX_PDF_CACHE) return;
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of cache.entries()) {
      const t = v?.lastUsed ?? 0;
      if (t < oldest) { oldest = t; oldestKey = k; }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined") return;
      const mod = await import("pdfjs-dist/legacy/build/pdf");
      if (cancelled) return;
      mod.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
      pdfjsRef.current = mod;
    })().catch((e) => {
      console.error("Failed to load pdfjs", e);
      setPdfMessage("Nie udało się załadować pdf.js.");
    });
    return () => { cancelled = true; };
  }, []);

  const pk = useMemo(() => meta?.pk || "Id", [meta]);

  async function loadMeta() {
    const r = await fetch(`${API}/meta`);
    if (!r.ok) throw new Error("meta failed");
    setMeta(await r.json());
  }

  async function loadList() {
    setLoadingList(true);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("page_size", String(pageSize));
      // ── 5. obsługa non-rejected ──
      if (statusFilter === "non-rejected") {
        params.set("exclude_status", "odrzucone");
      } else if (statusFilter) {
        params.set("status", statusFilter);
      }
      if (klientFilter) params.set("klient", klientFilter);
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo)   params.set("date_to",   dateTo);
      const r = await fetch(`${API}/orders?${params.toString()}`);
      const j = await r.json();
      setItems(j.items || []);
      setTotal(j.total || 0);
    } finally {
      setLoadingList(false);
    }
  }

  useEffect(() => { loadMeta().catch(console.error); }, []);
  useEffect(() => {
    loadList().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter, klientFilter, dateFrom, dateTo]);

  // ── 4. auto-otwieranie gdy 1 klient lub 1 pdf ───────────────────────────
  useEffect(() => {
    if (items.length === 0) return;
    const klients = [...new Set(items.map((r) => r.Klient ?? r.klient ?? "(brak klienta)"))];
    if (klients.length === 1) {
      setOpenKlients((p) => ({ ...p, [klients[0]]: true }));
      const pdfs = [...new Set(items.map(getPdfName))];
      if (pdfs.length === 1) {
        setOpenGroups((p) => ({ ...p, [pdfs[0]]: true }));
      }
    }
  }, [items]);
  // ────────────────────────────────────────────────────────────────────────

  // ── auto-wyświetlone: zmień status z 'nowe' na 'wyświetlone' po kliknięciu ──
  async function markAsViewed(row) {
    const id = row[pk];
    const st = (row.Status ?? row.status ?? "").toString().toLowerCase();
    if (st !== "nowe") return; // tylko jeśli aktualnie 'nowe'
    try {
      const r = await fetch(`${API}/orders/${id}/status?status=${encodeURIComponent("wyświetlone")}`, { method: "POST" });
      if (!r.ok) return;
      // aktualizuj lokalnie bez przeładowania całej listy
      setItems((prev) => prev.map((x) => x[pk] === id ? { ...x, Status: "wyświetlone" } : x));
      setSelected((s) => s && s[pk] === id ? { ...s, Status: "wyświetlone" } : s);
    } catch (_) { /* cicho ignoruj — nie blokuj UX */ }
  }

  // ── 2. bulk ──────────────────────────────────────────────────────────────
  async function bulkUpdateStatus(status) {
    if (checkedIds.size === 0) return;
    setBulkSaving(true);
    try {
      await Promise.all(
        [...checkedIds].map((id) =>
          fetch(`${API}/orders/${id}/status?status=${encodeURIComponent(status)}`, { method: "POST" })
        )
      );
      setCheckedIds(new Set());
      await loadList();
    } finally {
      setBulkSaving(false); }
  }

  function toggleCheck(id, e) {
    e.stopPropagation();
    setCheckedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleCheckAll(rowIds) {
    const allChecked = rowIds.every((id) => checkedIds.has(id));
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (allChecked) rowIds.forEach((id) => next.delete(id));
      else            rowIds.forEach((id) => next.add(id));
      return next;
    });
  }
  // ────────────────────────────────────────────────────────────────────────

  async function saveEdits() {
    if (!selected) return;
    const iloscParsed = parseDecimalInput(editForm.IloscKlienta);
    const cenaParsed  = parseDecimalInput(editForm.CenaOfertowa);
    const numErrors = {
      IloscKlienta: editForm.IloscKlienta !== "" && iloscParsed === null ? "Nieprawidłowa liczba" : "",
      CenaOfertowa: editForm.CenaOfertowa  !== "" && cenaParsed  === null ? "Nieprawidłowa liczba" : "",
    };
    setEditNumericErrors(numErrors);
    if (numErrors.IloscKlienta || numErrors.CenaOfertowa) return;
    setEditSaving(true); setEditError("");
    try {
      const payload = {
        Klient: editForm.Klient, FinalIndeks: editForm.FinalIndeks,
        NazwaKlienta: editForm.NazwaKlienta,
        IloscKlienta: iloscParsed, CenaOfertowa: cenaParsed,
      };
      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);
      const id = selected[pk];
      const r = await fetch(`${API}/orders/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`PATCH failed: ${r.status} ${t}`); }
      const updated = await r.json();
      setSelected(updated);
      setItems((prev) => prev.map((x) => (x[pk] === id ? updated : x)));
      setEditOpen(false);
    } catch (e) {
      console.error(e); setEditError(e?.message || String(e));
    } finally { setEditSaving(false); }
  }

  function pickField(row, candidates) {
    for (const k of candidates) {
      if (row && row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
    }
    return null;
  }

  function getPdfCacheKey(row) {
    const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
    const pdfUrl     = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);
    return oneDriveId ? `id:${oneDriveId}` : pdfUrl ? `url:${pdfUrl}` : null;
  }

  async function onSelect(row) {
    setSelected(row);
    setPdfMessage("");
    const currentPdfName = getPdfName(row);
    const prevPdfName = lastPdfNameRef.current;
    if (currentPdfName !== prevPdfName) setPageNumber(1);
    lastPdfNameRef.current = currentPdfName;
    setEditOpen(false); setEditError("");
    setEditNumericErrors({ IloscKlienta: "", CenaOfertowa: "" });
    setEditForm({
      Klient:       row.Klient       ?? row.klient       ?? "",
      FinalIndeks:  row.FinalIndeks  ?? row.finalIndeks  ?? "",
      NazwaKlienta: row.NazwaKlienta ?? row.nazwaKlienta ?? "",
      IloscKlienta: row.IloscKlienta ?? row.iloscKlienta ?? "",
      CenaOfertowa: row.CenaOfertowa ?? row.cenaOfertowa ?? "",
    });

    const pdfjsLib = pdfjsRef.current;
    if (!pdfjsLib) { setPdfMessage("PDF.js jeszcze się ładuje — spróbuj za sekundę."); return; }

    const cacheKey = getPdfCacheKey(row);
    if (!cacheKey) { setPdfMessage("Brak onedriveId i brak URL do PDF w rekordzie."); return; }

    const cached = pdfCacheRef.current.get(cacheKey);
    if (cached?.doc) {
      cached.lastUsed = Date.now();
      setPdfDoc(cached.doc);
      setPdfMessage("PDF z cache.");
      markAsViewed(row); // PDF dostępny z cache — też liczy jako wyświetlony
      return;
    }

    const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
    const pdfUrl     = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);
    let proxied = null;
    if (oneDriveId)  proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}`;
    else if (pdfUrl) proxied = `${API}/pdf?url=${encodeURIComponent(pdfUrl)}`;
    else { setPdfMessage("Brak onedriveId i brak URL do PDF w rekordzie."); return; }

    setLoadingPdf(true);
    try {
      const doc = await pdfjsLib.getDocument({ url: proxied, disableRange: false, disableStream: false }).promise;
      pdfCacheRef.current.set(cacheKey, { doc, lastUsed: Date.now() });
      prunePdfCache();
      setPdfDoc(doc);
      setPdfMessage("PDF załadowany.");
      markAsViewed(row); // zmień 'nowe' → 'wyświetlone' dopiero po sukcesie załadowania PDF
    } catch (e) {
      console.error(e);
      setPdfMessage("Nie udało się załadować PDF. Sprawdź konsolę.");
    } finally { setLoadingPdf(false); }
  }

  async function renderPage() {
    try {
      if (!pdfDoc) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pg = await pdfDoc.getPage(pageNumber);
      const scale = 1.35;
      const viewport = pg.getViewport({ scale });
      const outputScale = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
      const ctx = canvas.getContext("2d");
      canvas.width  = Math.floor(viewport.width  * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width  = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);
      await pg.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      console.error("renderPage failed", e);
      setPdfMessage("renderPage failed: " + (e?.message || String(e)));
    }
  }

  useEffect(() => { renderPage().catch(console.error); }, [pdfDoc, pageNumber]);

  const selectedId = selected ? selected[pk] : null;

  // ── 3. licznik nowych pozycji ────────────────────────────────────────────
  const newCountMap = useMemo(() => {
    const m = new Map();
    for (const r of items) {
      const st = (r.Status ?? r.status ?? "").toString().toLowerCase();
      if (st !== "nowe") continue;
      const groupKey = normalizeKlientGroup(r.Klient ?? r.klient ?? "(brak klienta)");
      const pdfName  = getPdfName(r);
      if (!m.has(groupKey)) m.set(groupKey, { total: 0, pdfs: new Map() });
      const entry = m.get(groupKey);
      entry.total++;
      entry.pdfs.set(pdfName, (entry.pdfs.get(pdfName) ?? 0) + 1);
    }
    return m;
  }, [items]);
  // ────────────────────────────────────────────────────────────────────────

  const dupPosMap = useMemo(() => {
    const m = new Map();
    for (const r of items) {
      const pdfName = getPdfName(r);
      const status = (r.Status ?? r.status ?? "").toString().toLowerCase();
      if (status === "odrzucone") continue;
      const pos = r.Pozycja ?? r.pozycja ?? "";
      const keyPos = String(pos).trim();
      if (!keyPos) continue;
      if (!m.has(pdfName)) m.set(pdfName, new Map());
      const inner = m.get(pdfName);
      inner.set(keyPos, (inner.get(keyPos) ?? 0) + 1);
    }
    return m;
  }, [items]);

  const groupedByKlient = useMemo(() => {
    const outer = new Map();

    for (const r of items) {
      const rawKlient = r.Klient ?? r.klient ?? "(brak klienta)";
      const groupKey = normalizeKlientGroup(rawKlient);
      const pdfName = getPdfName(r);
      const rowCreatedAtMs = getRowCreatedAtMs(r);

      if (!outer.has(groupKey)) {
        outer.set(groupKey, {
          pdfMap: new Map(),
          originalNames: new Set(),
          latestCreatedAtMs: rowCreatedAtMs,
        });
      }

      const entry = outer.get(groupKey);
      entry.originalNames.add(rawKlient);
      entry.latestCreatedAtMs = Math.max(entry.latestCreatedAtMs ?? Number.NEGATIVE_INFINITY, rowCreatedAtMs);

      if (!entry.pdfMap.has(pdfName)) entry.pdfMap.set(pdfName, []);
      entry.pdfMap.get(pdfName).push(r);
    }

    const groupedEntries = Array.from(outer.entries()).map(([groupKey, entry]) => {
      const sortedPdfEntries = Array.from(entry.pdfMap.entries())
        .map(([pdfName, arr]) => {
          arr.sort((a, b) => Number(a.Pozycja ?? a.pozycja ?? 0) - Number(b.Pozycja ?? b.pozycja ?? 0));
          const latestCreatedAtMs = arr.reduce(
            (maxTs, row) => Math.max(maxTs, getRowCreatedAtMs(row)),
            Number.NEGATIVE_INFINITY
          );

          return [pdfName, arr, latestCreatedAtMs];
        })
        .sort((a, b) => {
          if (b[2] !== a[2]) return b[2] - a[2];
          return String(a[0]).localeCompare(String(b[0]), "pl");
        });

      const pdfMap = new Map();
      for (const [pdfName, arr] of sortedPdfEntries) {
        pdfMap.set(pdfName, arr);
      }

      return [
        groupKey,
        {
          pdfMap,
          originalNames: entry.originalNames,
          latestCreatedAtMs: entry.latestCreatedAtMs,
        },
      ];
    });

    groupedEntries.sort((a, b) => {
      const latestA = a[1].latestCreatedAtMs ?? Number.NEGATIVE_INFINITY;
      const latestB = b[1].latestCreatedAtMs ?? Number.NEGATIVE_INFINITY;

      if (latestB !== latestA) return latestB - latestA;
      return String(a[0]).localeCompare(String(b[0]), "pl");
    });

    return groupedEntries;
  }, [items]);

  function handleNumericChange(field, raw) {
    setEditForm((p) => ({ ...p, [field]: raw }));
    const parsed = parseDecimalInput(raw);
    const isError = raw !== "" && parsed === null;
    setEditNumericErrors((p) => ({ ...p, [field]: isError ? "Nieprawidłowa liczba (użyj . lub ,)" : "" }));
  }

  const thStyle = { textAlign: "left", borderBottom: "1px solid #eee", padding: 6 };
  const tdStyle = { borderBottom: "1px solid #f3f3f3", padding: 6 };

  const allVisibleIds = useMemo(() => items.map((r) => r[pk]).filter(Boolean), [items, pk]);
  const allChecked = allVisibleIds.length > 0 && allVisibleIds.every((id) => checkedIds.has(id));

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif" }}>
      {/* ══════════ LEFT ══════════ */}
      <div style={{ width: "45%", borderRight: "1px solid #ddd", padding: 12, overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>Orders MVP</h2>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>API: <b>{API}</b></div>

        {/* filtry */}
        <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <select value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}>
            <option value="non-rejected">status: (bez odrzuconych)</option>
            <option value="">status: (wszystkie)</option>
            <option value="nowe">nowe</option>
            <option value="wyświetlone">wyświetlone</option>
            <option value="zaakceptowane">zaakceptowane</option>
            <option value="odrzucone">odrzucone</option>
          </select>
          {/* ── 5. zmieniony placeholder ── */}
          <input
            placeholder="Klient zawiera..."
            value={klientFilter}
            onChange={(e) => { setPage(1); setKlientFilter(e.target.value); }}
            style={{ flex: 1, minWidth: 120 }}
          />
          <button onClick={() => loadList()} disabled={loadingList}>
            {loadingList ? "Ładowanie..." : "Odśwież"}
          </button>
        </div>

        {/* ── 5. zmieniona etykieta ── */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
          <span style={{ color: "#555", whiteSpace: "nowrap" }}>Data odczytania przez automat od:</span>
          <input type="date" value={dateFrom}
            onChange={(e) => { setPage(1); setDateFrom(e.target.value); }} style={{ fontSize: 12 }} />
          <span style={{ color: "#555" }}>do:</span>
          <input type="date" value={dateTo}
            onChange={(e) => { setPage(1); setDateTo(e.target.value); }} style={{ fontSize: 12 }} />
          <button style={{ fontSize: 11 }} onClick={() => { setPage(1); setDateFrom(hoursAgo(24)); setDateTo(""); }}>
            Ostatnie 24h
          </button>
          <button style={{ fontSize: 11 }} onClick={() => { setPage(1); setDateFrom(""); setDateTo(""); }}>
            Wszystkie daty
          </button>
        </div>

        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          Razem: {total} | Strona: {page}
          <span style={{ marginLeft: 10 }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>◀</button>
            <button onClick={() => setPage((p) => p + 1)} style={{ marginLeft: 6 }}>▶</button>
          </span>
        </div>

        {/* ── 2. pasek bulk actions ── */}
        {checkedIds.size > 0 && (
          <div style={{
            display: "flex", gap: 8, marginBottom: 8, padding: "6px 10px",
            background: "#eef2ff", border: "1px solid #c5cfe0", borderRadius: 4,
            alignItems: "center", fontSize: 12, flexWrap: "wrap",
          }}>
            <b>Zaznaczono: {checkedIds.size}</b>
            <span style={{ color: "#888" }}>→ zmień status na:</span>
            <button onClick={() => bulkUpdateStatus("wyświetlone")}    disabled={bulkSaving}>wyświetlone</button>
            <button onClick={() => bulkUpdateStatus("zaakceptowane")} disabled={bulkSaving}>zaakceptowane</button>
            <button onClick={() => bulkUpdateStatus("odrzucone")}     disabled={bulkSaving}>odrzucone</button>
            <button onClick={() => setCheckedIds(new Set())}
              style={{ marginLeft: "auto", color: "#888", fontSize: 11 }}>
              ✕ Odznacz wszystkie
            </button>
            {bulkSaving && <span>Zapisywanie...</span>}
          </div>
        )}

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={{ ...thStyle, width: 28 }}>
                <input type="checkbox" checked={allChecked}
                  onChange={() => toggleCheckAll(allVisibleIds)} title="Zaznacz wszystkie" />
              </th>
              <th style={thStyle}>Poz.</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Klient</th>
              <th style={thStyle}>NaszIndeks</th>
              <th style={thStyle}>NazwaKlienta</th>
              <th style={thStyle}>Ilość</th>
              <th style={thStyle}>Cena</th>
              <th style={thStyle}>Oferta</th>
              <th style={thStyle}>Data oferty</th>
            </tr>
          </thead>

          <tbody>
            {(Array.isArray(groupedByKlient) ? groupedByKlient : []).map(([klientName, groupEntry]) => {
              const pdfMap = groupEntry?.pdfMap instanceof Map ? groupEntry.pdfMap : new Map();
              const originalNames = groupEntry?.originalNames ?? new Set();
              const isKlientOpen = openKlients[klientName] ?? false;
              const totalRowsForKlient = Array.from(pdfMap.values()).reduce(
                (s, a) => s + (Array.isArray(a) ? a.length : 0),
                0
              );
              const newCount = newCountMap.get(klientName)?.total ?? 0;


              return (
                <React.Fragment key={klientName}>
                  {/* nagłówek klienta */}
                  <tr
                    onClick={() => setOpenKlients((p) => ({ ...p, [klientName]: !isKlientOpen }))}
                    style={{ cursor: "pointer", background: "#e8edf5", borderTop: "2px solid #c5cfe0" }}
                  >
                    <td colSpan={10} style={{ padding: "7px 6px", fontWeight: "bold", fontSize: 12 }}>
                      <span style={{ display: "inline-block", width: 18 }}>{isKlientOpen ? "▾" : "▸"}</span>
                      🏢 {klientName}
                      <span style={{ marginLeft: 10, color: "#555", fontWeight: "normal" }}>
                        ({pdfMap.size} {pdfMap.size === 1 ? "zamówienie" : "zamówień"},{" "}
                        {totalRowsForKlient} {totalRowsForKlient === 1 ? "pozycja" : "pozycji"})
                      </span>

                      {/* ── 3. badge nowych ── */}
                      {newCount > 0 && (
                        <span style={{
                          marginLeft: 10, background: "#e53935", color: "#fff",
                          borderRadius: 10, padding: "1px 7px", fontSize: 11, fontWeight: "bold",
                        }}>
                          🔴 {newCount} nowych
                        </span>
                      )}
                    </td>
                  </tr>

                  {isKlientOpen && Array.from(pdfMap.entries()).map(([pdfName, rows]) => {
                    const safeRows = Array.isArray(rows) ? rows : [];
                    const isPdfOpen    = openGroups[pdfName] ?? false;
                    const pdfNewCount  = newCountMap.get(klientName)?.pdfs.get(pdfName) ?? 0;
                    const pdfRowIds    = safeRows.map((r) => r?.[pk]).filter(Boolean);
                    const pdfAllChecked = pdfRowIds.length > 0 && pdfRowIds.every((id) => checkedIds.has(id));

                    return (
                      <React.Fragment key={pdfName}>
                        {/* nagłówek pdf */}
                        <tr
                          onClick={(e) => { e.stopPropagation(); setOpenGroups((p) => ({ ...p, [pdfName]: !isPdfOpen })); }}
                          style={{ cursor: "pointer", background: "#fef9c3", borderTop: "1px solid #eee" }}
                        >
                          {/* ── 2. checkbox dla całego pdf ── */}
                          <td style={{ padding: "5px 6px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={pdfAllChecked}
                              onChange={() => toggleCheckAll(pdfRowIds)} />
                          </td>
                          <td colSpan={9} style={{ padding: "5px 6px 5px 8px", fontSize: 12 }}>
                            <span style={{ display: "inline-block", width: 18 }}>{isPdfOpen ? "▾" : "▸"}</span>
                            📄 {pdfName}
                            <span style={{ marginLeft: 8, color: "#888", fontSize: 11 }}>({safeRows.length} pozycji)</span>
                            {/* ── 3. badge nowych dla pdf ── */}
                            {pdfNewCount > 0 && (
                              <span style={{
                                marginLeft: 8, background: "#ff7043", color: "#fff",
                                borderRadius: 10, padding: "1px 6px", fontSize: 10, fontWeight: "bold",
                              }}>
                                {pdfNewCount} nowych
                              </span>
                            )}
                          </td>
                        </tr>

                        {isPdfOpen && safeRows.map((row) => {
                          const id           = row[pk];
                          const pozycja      = row.Pozycja      ?? row.pozycja      ?? "";
                          const status       = row.Status       ?? row.status       ?? "";
                          const klient       = row.Klient       ?? row.klient       ?? "";
                          const naszIndeks   = row.FinalIndeks  ?? row.finalIndeks  ?? "";
                          const nazwaKlienta = row.NazwaKlienta ?? row.nazwaKlienta ?? "";
                          const iloscKlienta = row.IloscKlienta ?? row.iloscKlienta ?? "";
                          const waluta       = row.OfertaWaluta ?? row.ofertaWaluta ?? "";
                          const cenaOfertowa = [row.CenaOfertowa ?? row.cenaOfertowa ?? "", waluta].filter(Boolean).join(" ");
                          const oferta       = row.Oferta       ?? row.oferta       ?? "";
                          const dataOferty   = row.DataUtworzenia ?? row.dataUtworzenia ?? "";
                          const isSel       = selectedId === id;
                          const st          = (status ?? "").toString().toLowerCase();
                          const statusBg    = st === "odrzucone" ? "#f1f1f1" : st === "zaakceptowane" ? "#e9f7ee" : st === "wyświetlone" ? "#f0f4ff" : "transparent";
                          const posKey      = String(pozycja ?? "").trim();
                          const isDup       = st !== "odrzucone" && posKey && (dupPosMap.get(pdfName)?.get(posKey) ?? 0) > 1;
                          const isChecked   = checkedIds.has(id);

                          return (
                            <tr key={id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenGroups((p) => ({ ...p, [pdfName]: true }));
                                setOpenKlients((p) => ({ ...p, [klientName]: true }));
                                onSelect(row);
                              }}
                              style={{
                                cursor: "pointer",
                                background: isSel ? "#f3f6ff" : isChecked ? "#fffde7" : isDup ? "#ffe5e5" : statusBg,
                                color: st === "odrzucone" ? "#999" : "inherit",
                                borderLeft: isDup ? "4px solid crimson" : "4px solid transparent",
                              }}
                            >
                              {/* ── 2. checkbox pozycji ── */}
                              <td style={{ ...tdStyle, textAlign: "center" }} onClick={(e) => toggleCheck(id, e)}>
                                <input type="checkbox" checked={isChecked}
                                  onChange={(e) => toggleCheck(id, e)} onClick={(e) => e.stopPropagation()} />
                              </td>
                              <td style={{ ...tdStyle, paddingLeft: 40 }}>{pozycja}</td>
                              <td style={tdStyle}>{status}</td>
                              <td style={tdStyle}>{klient}</td>
                              <td style={tdStyle}>{naszIndeks}</td>
                              <td style={{ ...tdStyle, maxWidth: 200 }}>
                                <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                  {nazwaKlienta}
                                </div>
                              </td>
                              <td style={tdStyle}>{iloscKlienta}</td>
                              <td style={tdStyle}>{cenaOfertowa}</td>
                              <td style={tdStyle}>{oferta}</td>
                              <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>{dataOferty ? String(dataOferty).slice(0, 10) : ""}</td>
                            </tr>
                          );
                        })}
                      </React.Fragment>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ══════════ RIGHT ══════════ */}
      <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Szczegóły</h3>
        {!selected && <div style={{ color: "#888" }}>Kliknij rekord po lewej.</div>}

        {selected && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
              <b>ID:</b> {selectedId}
              {loadingPdf && <span style={{ fontSize: 12, color: "#888" }}>Ładowanie PDF...</span>}
            </div>

            {pdfMessage && <div style={{ fontSize: 12, color: "#444", marginBottom: 8 }}>{pdfMessage}</div>}

            {/* edycja */}
            <div style={{ marginBottom: 10, padding: 10, border: "1px solid #eee", background: "#fafafa" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <button onClick={() => setEditOpen((v) => !v)}>
                  {editOpen ? "Zamknij edycję" : "Edytuj"}
                </button>
                {editSaving && <span style={{ fontSize: 12 }}>Zapisywanie...</span>}
                {editError  && <span style={{ fontSize: 12, color: "crimson" }}>{editError}</span>}
              </div>
              {editOpen && (
                <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "160px 1fr", gap: 8 }}>
                  <div>Klient</div>
                  <input value={editForm.Klient} onChange={(e) => setEditForm((p) => ({ ...p, Klient: e.target.value }))} />
                  <div>NaszIndeks</div>
                  <input value={editForm.FinalIndeks} onChange={(e) => setEditForm((p) => ({ ...p, FinalIndeks: e.target.value }))} />
                  <div>NazwaKlienta</div>
                  <input value={editForm.NazwaKlienta} onChange={(e) => setEditForm((p) => ({ ...p, NazwaKlienta: e.target.value }))} />
                  <div>IloscKlienta</div>
                  <div>
                    <input value={editForm.IloscKlienta} onChange={(e) => handleNumericChange("IloscKlienta", e.target.value)}
                      style={{ borderColor: editNumericErrors.IloscKlienta ? "crimson" : undefined, width: "100%" }} />
                    {editNumericErrors.IloscKlienta && <div style={{ fontSize: 11, color: "crimson", marginTop: 2 }}>{editNumericErrors.IloscKlienta}</div>}
                    {editForm.IloscKlienta !== "" && !editNumericErrors.IloscKlienta && (
                      <div style={{ fontSize: 11, color: "#558b2f", marginTop: 2 }}>→ {parseDecimalInput(editForm.IloscKlienta)}</div>
                    )}
                  </div>
                  <div>CenaOfertowa</div>
                  <div>
                    <input value={editForm.CenaOfertowa} onChange={(e) => handleNumericChange("CenaOfertowa", e.target.value)}
                      style={{ borderColor: editNumericErrors.CenaOfertowa ? "crimson" : undefined, width: "100%" }} />
                    {editNumericErrors.CenaOfertowa && <div style={{ fontSize: 11, color: "crimson", marginTop: 2 }}>{editNumericErrors.CenaOfertowa}</div>}
                    {editForm.CenaOfertowa !== "" && !editNumericErrors.CenaOfertowa && (
                      <div style={{ fontSize: 11, color: "#558b2f", marginTop: 2 }}>→ {parseDecimalInput(editForm.CenaOfertowa)}</div>
                    )}
                  </div>
                  <div />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={saveEdits} disabled={editSaving}>Zapisz</button>
                    <button onClick={() => {
                      setEditError(""); setEditNumericErrors({ IloscKlienta: "", CenaOfertowa: "" });
                      setEditForm({ Klient: selected?.Klient ?? "", FinalIndeks: selected?.FinalIndeks ?? "",
                        NazwaKlienta: selected?.NazwaKlienta ?? "", IloscKlienta: selected?.IloscKlienta ?? "",
                        CenaOfertowa: selected?.CenaOfertowa ?? "" });
                      setEditOpen(false);
                    }} disabled={editSaving}>Anuluj</button>
                  </div>
                </div>
              )}
            </div>

            <details style={{ marginBottom: 10 }}>
              <summary>Szczegóły pozycji</summary>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 10 }}>
                <tbody>
                  {[
                    ["Klient",               selected?.Klient        ?? selected?.klient        ?? ""],
                    ["NaszIndeks",           selected?.FinalIndeks   ?? selected?.finalIndeks   ?? ""],
                    ["NazwaKlienta",         selected?.NazwaKlienta  ?? selected?.nazwaKlienta  ?? ""],
                    ["NumerRysunku",         selected?.nrRys         ?? ""],
                    ["Oferta",               selected?.oferta        ?? ""],
                    ["DataUtworzeniaOferty", selected?.DataUtworzenia ?? ""],
                    ["DataWaznosciOferty",   selected?.DataWaznosci  ?? ""],
                    ["IloscZOferty",         selected?.IloscZOferty  ?? ""],
                    ["IloscKlienta",         selected?.IloscKlienta  ?? selected?.iloscKlienta  ?? ""],
                    ["CenaOfertowa",         selected?.CenaOfertowa  ?? selected?.cenaOfertowa  ?? ""],
                    ["Data odczytania",      selected?.DataAutomatu  ?? selected?.dataAutomatu  ?? ""],
                    ["Cytat źródłowy",       selected?.sourceQuote   ?? selected?.source_quote  ?? ""],
                    ["pdfFileName",          selected?.pdfFileName   ?? selected?.PdfFileName   ?? ""],
                  ].map(([label, value]) => (
                    <tr key={label}>
                      <td style={{ width: 180, padding: 6, borderBottom: "1px solid #eee", color: "#666" }}>{label}</td>
                      <td style={{ padding: 6, borderBottom: "1px solid #eee" }}>
                        {value === null || value === undefined || value === ""
                          ? <span style={{ color: "#999" }}>—</span>
                          : String(value)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>

            <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <button onClick={() => setPageNumber((p) => Math.max(1, p - 1))}>◀ Poprzednia</button>
              <button onClick={() => setPageNumber((p) => p + 1)}
                disabled={!pdfDoc || pageNumber >= (pdfDoc?.numPages || 1)}>Następna ▶</button>
              <div style={{ fontSize: 12, color: "#666" }}>Strona: {pageNumber} / {pdfDoc?.numPages || "—"}</div>
            </div>

            <div style={{ border: "1px solid #ddd", display: "inline-block" }}>
              <canvas ref={canvasRef} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

