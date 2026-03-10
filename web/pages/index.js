import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

// ── 1. source_quote: znajdź stronę z cytatem ────────────────────────────────
async function findQuotePageInDoc(doc, quote) {
  if (!doc || !quote || quote.trim().length < 4) return null;
  const needle = quote.trim().toLowerCase().replace(/\s+/g, " ");
  for (let i = 1; i <= doc.numPages; i++) {
    try {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => it.str).join(" ").toLowerCase().replace(/\s+/g, " ");
      if (text.includes(needle)) return i;
    } catch (_) { /* ignoruj błędy pojedynczej strony */ }
  }
  return null;
}

// ── 1. source_quote: narysuj żółte podświetlenie na canvas overlay ──────────
async function highlightQuoteOnPage(doc, pageNum, quote, overlayCanvas, scale, outputScale) {
  if (!doc || !quote || !overlayCanvas) return;
  const needle = quote.trim().toLowerCase().replace(/\s+/g, " ");
  try {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale });
    const content = await page.getTextContent();

    overlayCanvas.width  = Math.floor(viewport.width  * outputScale);
    overlayCanvas.height = Math.floor(viewport.height * outputScale);
    overlayCanvas.style.width  = `${viewport.width}px`;
    overlayCanvas.style.height = `${viewport.height}px`;

    const ctx = overlayCanvas.getContext("2d");
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    ctx.setTransform(outputScale, 0, 0, outputScale, 0, 0);

    // Zbierz tokeny i zbuduj pełny tekst z mapą pozycji
    const tokens = content.items.map((item) => ({
      str: item.str, tx: item.transform, w: item.width, h: item.height,
    }));

    let fullText = "";
    const charMap = [];
    tokens.forEach((tok, ti) => {
      for (let ci = 0; ci < tok.str.length; ci++) {
        charMap.push({ ti, ci });
        fullText += tok.str[ci];
      }
      fullText += " ";
      charMap.push({ ti, ci: -1 });
    });

    const normFull = fullText.toLowerCase().replace(/\s+/g, " ");
    let searchFrom = 0;
    let found = false;

    while (true) {
      const idx = normFull.indexOf(needle, searchFrom);
      if (idx === -1) break;
      found = true;

      const coveredTokens = new Set();
      for (let ci = idx; ci < idx + needle.length; ci++) {
        if (charMap[ci]) coveredTokens.add(charMap[ci].ti);
      }

      coveredTokens.forEach((ti) => {
        const tok = tokens[ti];
        if (!tok) return;
        const [, , , , e, f] = tok.tx;
        const pt    = viewport.convertToViewportPoint(e, f);
        const ptEnd = viewport.convertToViewportPoint(e + tok.w, f + tok.h);
        const rx = Math.min(pt[0], ptEnd[0]) - 1;
        const ry = Math.min(pt[1], ptEnd[1]) - tok.h * scale - 2;
        const rw = Math.abs(ptEnd[0] - pt[0]) + 2;
        const rh = tok.h * scale + 4;
        ctx.save();
        ctx.globalAlpha = 0.38;
        ctx.fillStyle = "#FFD600";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.restore();
      });

      searchFrom = idx + needle.length;
    }

    if (!found) {
      // Baner informacyjny u góry gdy nie znaleziono
      ctx.save();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = "#FFD600";
      ctx.fillRect(0, 0, viewport.width, 28);
      ctx.restore();
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.fillStyle = "#7a6000";
      ctx.font = "11px sans-serif";
      ctx.fillText("⚠ Nie znaleziono fragmentu source_quote na tej stronie", 6, 18);
      ctx.restore();
    }
  } catch (e) {
    console.warn("highlightQuoteOnPage error", e);
  }
}
// ────────────────────────────────────────────────────────────────────────────

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
  const overlayRef = useRef(null); // ── 1. overlay dla highlight
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
        params.set("exclude_status", "rejected");
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

  async function updateStatus(id, status) {
    const r = await fetch(`${API}/orders/${id}/status?status=${encodeURIComponent(status)}`, { method: "POST" });
    if (!r.ok) { alert("Nie udało się zmienić statusu"); return; }
    await loadList();
    if (selected && selected[pk] === id) setSelected((s) => ({ ...s, Status: status }));
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

    const quote = row.sourceQuote ?? row.source_quote ?? "";

    const cached = pdfCacheRef.current.get(cacheKey);
    if (cached?.doc) {
      cached.lastUsed = Date.now();
      setPdfDoc(cached.doc);
      // ── 1. znajdź stronę z quote ──
      if (quote) {
        const qPage = await findQuotePageInDoc(cached.doc, quote);
        if (qPage) setPageNumber(qPage);
      }
      setPdfMessage("PDF z cache.");
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
      // ── 1. znajdź stronę z quote po załadowaniu ──
      if (quote) {
        const qPage = await findQuotePageInDoc(doc, quote);
        if (qPage && qPage !== pageNumber) setPageNumber(qPage);
      }
      setPdfMessage("PDF załadowany.");
    } catch (e) {
      console.error(e);
      setPdfMessage("Nie udało się załadować PDF. Sprawdź konsolę.");
    } finally { setLoadingPdf(false); }
  }

  // ── 1. renderPage z overlayem highlight ─────────────────────────────────
  const renderPage = useCallback(async () => {
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

      // highlight overlay
      const quote = selected?.sourceQuote ?? selected?.source_quote ?? "";
      if (quote && overlayRef.current) {
        await highlightQuoteOnPage(pdfDoc, pageNumber, quote, overlayRef.current, scale, outputScale);
      } else if (overlayRef.current) {
        const oc = overlayRef.current;
        oc.width = canvas.width; oc.height = canvas.height;
        oc.style.width = canvas.style.width; oc.style.height = canvas.style.height;
        oc.getContext("2d").clearRect(0, 0, oc.width, oc.height);
      }
    } catch (e) {
      console.error("renderPage failed", e);
      setPdfMessage("renderPage failed: " + (e?.message || String(e)));
    }
  }, [pdfDoc, pageNumber, selected]);

  useEffect(() => { renderPage().catch(console.error); }, [renderPage]);
  // ────────────────────────────────────────────────────────────────────────

  const selectedId = selected ? selected[pk] : null;

  // ── 3. licznik nowych pozycji ────────────────────────────────────────────
  const newCountMap = useMemo(() => {
    const m = new Map();
    for (const r of items) {
      const st = (r.Status ?? r.status ?? "").toString().toLowerCase();
      if (st !== "new") continue;
      const klient  = r.Klient ?? r.klient ?? "(brak klienta)";
      const pdfName = getPdfName(r);
      if (!m.has(klient)) m.set(klient, { total: 0, pdfs: new Map() });
      const entry = m.get(klient);
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
      if (status === "rejected") continue;
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
      const klient  = r.Klient ?? r.klient ?? "(brak klienta)";
      const pdfName = getPdfName(r);
      if (!outer.has(klient)) outer.set(klient, new Map());
      const inner = outer.get(klient);
      if (!inner.has(pdfName)) inner.set(pdfName, []);
      inner.get(pdfName).push(r);
    }
    for (const pdfMap of outer.values()) {
      for (const [pdfName, arr] of pdfMap.entries()) {
        arr.sort((a, b) => Number(a.Pozycja ?? a.pozycja ?? 0) - Number(b.Pozycja ?? b.pozycja ?? 0));
        pdfMap.set(pdfName, arr);
      }
    }
    return Array.from(outer.entries());
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
            <option value="new">new</option>
            <option value="confirmed">confirmed</option>
            <option value="rejected">rejected</option>
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
            <button onClick={() => bulkUpdateStatus("new")}       disabled={bulkSaving}>new</button>
            <button onClick={() => bulkUpdateStatus("confirmed")} disabled={bulkSaving}>confirmed</button>
            <button onClick={() => bulkUpdateStatus("rejected")}  disabled={bulkSaving}>rejected</button>
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
            </tr>
          </thead>

          <tbody>
            {groupedByKlient.map(([klientName, pdfMap]) => {
              const isKlientOpen = openKlients[klientName] ?? false;
              const totalRowsForKlient = Array.from(pdfMap.values()).reduce((s, a) => s + a.length, 0);
              const newCount = newCountMap.get(klientName)?.total ?? 0; // ── 3.

              return (
                <React.Fragment key={klientName}>
                  {/* nagłówek klienta */}
                  <tr
                    onClick={() => setOpenKlients((p) => ({ ...p, [klientName]: !isKlientOpen }))}
                    style={{ cursor: "pointer", background: "#e8edf5", borderTop: "2px solid #c5cfe0" }}
                  >
                    <td colSpan={8} style={{ padding: "7px 6px", fontWeight: "bold", fontSize: 12 }}>
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
                    const isPdfOpen    = openGroups[pdfName] ?? false;
                    const pdfNewCount  = newCountMap.get(klientName)?.pdfs.get(pdfName) ?? 0; // ── 3.
                    const pdfRowIds    = rows.map((r) => r[pk]).filter(Boolean);
                    const pdfAllChecked = pdfRowIds.length > 0 && pdfRowIds.every((id) => checkedIds.has(id));

                    return (
                      <React.Fragment key={pdfName}>
                        {/* nagłówek pdf */}
                        <tr
                          onClick={(e) => { e.stopPropagation(); setOpenGroups((p) => ({ ...p, [pdfName]: !isPdfOpen })); }}
                          style={{ cursor: "pointer", background: "#fef9c3", borderTop: "2px solid #fde047" }}
                        >
                          {/* ── 2. checkbox dla całego pdf ── */}
                          <td style={{ padding: "5px 6px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={pdfAllChecked}
                              onChange={() => toggleCheckAll(pdfRowIds)} />
                          </td>
                          <td colSpan={7} style={{ padding: "5px 6px 5px 8px", fontSize: 12 }}>
                            <span style={{ display: "inline-block", width: 18 }}>{isPdfOpen ? "▾" : "▸"}</span>
                            📄 {pdfName}
                            <span style={{ marginLeft: 8, color: "#888", fontSize: 11 }}>({rows.length} pozycji)</span>
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

                        {isPdfOpen && rows.map((row) => {
                          const id           = row[pk];
                          const pozycja      = row.Pozycja      ?? row.pozycja      ?? "";
                          const status       = row.Status       ?? row.status       ?? "";
                          const klient       = row.Klient       ?? row.klient       ?? "";
                          const naszIndeks   = row.FinalIndeks  ?? row.finalIndeks  ?? "";
                          const nazwaKlienta = row.NazwaKlienta ?? row.nazwaKlienta ?? "";
                          const iloscKlienta = row.IloscKlienta ?? row.iloscKlienta ?? "";
                          const waluta       = row.OfertaWaluta ?? row.ofertaWaluta ?? "";
                          const cenaOfertowa = [row.CenaOfertowa ?? row.cenaOfertowa ?? "", waluta].filter(Boolean).join(" ");
                          const isSel       = selectedId === id;
                          const st          = (status ?? "").toString().toLowerCase();
                          const statusBg    = st === "rejected" ? "#f1f1f1" : st === "confirmed" ? "#e9f7ee" : "transparent";
                          const posKey      = String(pozycja ?? "").trim();
                          const isDup       = st !== "rejected" && posKey && (dupPosMap.get(pdfName)?.get(posKey) ?? 0) > 1;
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
                                color: st === "rejected" ? "#999" : "inherit",
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
              <button onClick={() => updateStatus(selectedId, "new")}>new</button>
              <button onClick={() => updateStatus(selectedId, "confirmed")}>confirmed</button>
              <button onClick={() => updateStatus(selectedId, "rejected")}>rejected</button>
              {loadingPdf && <span style={{ marginLeft: 8, fontSize: 12, color: "#888" }}>Ładowanie PDF...</span>}
            </div>

            {pdfMessage && <div style={{ fontSize: 12, color: "#444", marginBottom: 8 }}>{pdfMessage}</div>}

            {/* ── 1. baner source_quote ── */}
            {(selected?.sourceQuote ?? selected?.source_quote) && (
              <div style={{
                fontSize: 12, marginBottom: 10, padding: "5px 10px",
                background: "#fffde7", border: "1px solid #ffe082", borderRadius: 4,
              }}>
                🔍 <b>Cytat źródłowy:</b> <i style={{ color: "#555" }}>„{selected?.sourceQuote ?? selected?.source_quote}"</i>
                <span style={{ marginLeft: 8, color: "#aaa", fontSize: 11 }}>(podświetlono na PDF poniżej)</span>
              </div>
            )}

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

            {/* ── 1. canvas + overlay pozycjonowany absolutnie nad nim ── */}
            <div style={{ border: "1px solid #ddd", display: "inline-block", position: "relative" }}>
              <canvas ref={canvasRef} />
              <canvas ref={overlayRef} style={{ position: "absolute", top: 0, left: 0, pointerEvents: "none" }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
