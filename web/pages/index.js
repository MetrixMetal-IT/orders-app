import React, { useEffect, useMemo, useRef, useState } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Zamienia "1,5" → "1.5", "1.500,99" → "1500.99" itp. i zwraca Number lub null */
function parseDecimalInput(raw) {
  if (raw === "" || raw === null || raw === undefined) return null;
  const s = String(raw).trim();

  // Wykryj format europejski: cyfry, kropki-jako-separator-tysięcy, przecinek-jako-dziesiętny
  // np. "1.500,99" lub "1,5" lub "1500,99"
  const euPattern = /^-?\d{1,3}(\.\d{3})*(,\d+)?$/;
  const euSimple  = /^-?\d+(,\d+)$/;   // "1,5"  "1500,9"

  let normalized = s;
  if (euPattern.test(s) || euSimple.test(s)) {
    // usuń kropki-separatory tysięcy, zamień przecinek na kropkę
    normalized = s.replace(/\./g, "").replace(",", ".");
  } else {
    // format US / neutralny: "1,500.99" – usuń przecinki-separatory
    normalized = s.replace(/,/g, "");
  }

  const n = parseFloat(normalized);
  return isNaN(n) ? null : Math.round(n * 100) / 100; // DECIMAL(10,2)
}

/** Formatuje datę do "YYYY-MM-DD" (potrzebne do value w <input type="date">) */
function toDateValue(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (isNaN(dt)) return "";
  return dt.toISOString().slice(0, 10);
}

/** Zwraca datę sprzed N godzin jako "YYYY-MM-DD" */
function hoursAgo(h) {
  const d = new Date(Date.now() - h * 3600_000);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────────────

export default function Home() {
  const [meta, setMeta] = useState(null);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);

  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);

  const [statusFilter, setStatusFilter] = useState("");
  const [klientFilter, setKlientFilter] = useState("");

  // ── 1. Filtr DataAutomatu ────────────────────────────────────────────────
  const [dateFrom, setDateFrom] = useState(() => hoursAgo(24));
  const [dateTo,   setDateTo]   = useState("");   // pusty = bez górnej granicy
  // ────────────────────────────────────────────────────────────────────────

  const [selected, setSelected] = useState(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingPdf, setLoadingPdf] = useState(false);

  const [pdfDoc, setPdfDoc] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const lastPdfNameRef = useRef(null);

  // ── 2. Dwa poziomy rozwijania: klient + pdfName ──────────────────────────
  const [openKlients, setOpenKlients]  = useState({});   // { klientName: bool }
  const [openGroups,  setOpenGroups]   = useState({});   // { pdfName: bool }
  // ────────────────────────────────────────────────────────────────────────

  const [pdfMessage, setPdfMessage] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");
  const [editForm, setEditForm] = useState({
    Klient: "",
    FinalIndeks: "",
    NazwaKlienta: "",
    IloscKlienta: "",
    CenaOfertowa: "",
  });

  // ── 3. Walidacja pól numerycznych w czasie wpisywania ────────────────────
  const [editNumericErrors, setEditNumericErrors] = useState({
    IloscKlienta: "",
    CenaOfertowa: "",
  });
  // ────────────────────────────────────────────────────────────────────────

  const canvasRef = useRef(null);
  const pdfjsRef = useRef(null);

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
      if (statusFilter) params.set("status", statusFilter);
      if (klientFilter) params.set("klient", klientFilter);
      // ── 1. przekazujemy zakres dat ──
      if (dateFrom) params.set("date_from", dateFrom);
      if (dateTo)   params.set("date_to",   dateTo);
      // ────────────────────────────────
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

  async function updateStatus(id, status) {
    const r = await fetch(`${API}/orders/${id}/status?status=${encodeURIComponent(status)}`, {
      method: "POST",
    });
    if (!r.ok) { alert("Nie udało się zmienić statusu"); return; }
    await loadList();
    if (selected && selected[pk] === id) setSelected({ ...selected, Status: status });
  }

  async function saveEdits() {
    if (!selected) return;

    // ── 3. walidacja przed zapisem ──
    const iloscParsed = parseDecimalInput(editForm.IloscKlienta);
    const cenaParsed  = parseDecimalInput(editForm.CenaOfertowa);

    const numErrors = {
      IloscKlienta: editForm.IloscKlienta !== "" && iloscParsed === null ? "Nieprawidłowa liczba" : "",
      CenaOfertowa: editForm.CenaOfertowa  !== "" && cenaParsed  === null ? "Nieprawidłowa liczba" : "",
    };
    setEditNumericErrors(numErrors);
    if (numErrors.IloscKlienta || numErrors.CenaOfertowa) return;
    // ────────────────────────────────

    setEditSaving(true);
    setEditError("");
    try {
      const payload = {
        Klient:       editForm.Klient,
        FinalIndeks:  editForm.FinalIndeks,
        NazwaKlienta: editForm.NazwaKlienta,
        IloscKlienta: iloscParsed,
        CenaOfertowa: cenaParsed,
      };
      Object.keys(payload).forEach((k) => payload[k] === null && delete payload[k]);

      const id = selected[pk];
      const r = await fetch(`${API}/orders/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        throw new Error(`PATCH failed: ${r.status} ${t}`);
      }
      const updated = await r.json();
      setSelected(updated);
      setItems((prev) => prev.map((x) => (x[pk] === id ? updated : x)));
      setEditOpen(false);
    } catch (e) {
      console.error(e);
      setEditError(e?.message || String(e));
    } finally {
      setEditSaving(false);
    }
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

  function getPdfName(row) {
    return row.pdfFileName ?? row.PdfFileName ?? row.pdf_filename ?? row.pdf ?? "(brak pdfFileName)";
  }

  async function onSelect(row) {
    setSelected(row);
    setPdfMessage("");
    const currentPdfName = getPdfName(row);
    const prevPdfName = lastPdfNameRef.current;
    if (currentPdfName !== prevPdfName) setPageNumber(1);
    lastPdfNameRef.current = currentPdfName;
    setEditOpen(false);
    setEditError("");
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
      return;
    }

    const oneDriveId = pickField(row, ["onedriveId", "onedrive_id", "OneDriveId"]);
    const pdfUrl     = pickField(row, ["pdfWebUrl", "pdf_web_url", "pdfUrl", "PDF_URL"]);
    let proxied = null;
    if (oneDriveId)   proxied = `${API}/pdf?id=${encodeURIComponent(oneDriveId)}`;
    else if (pdfUrl)  proxied = `${API}/pdf?url=${encodeURIComponent(pdfUrl)}`;
    else { setPdfMessage("Brak onedriveId i brak URL do PDF w rekordzie."); return; }

    setLoadingPdf(true);
    try {
      const doc = await pdfjsLib.getDocument({ url: proxied, disableRange: false, disableStream: false }).promise;
      pdfCacheRef.current.set(cacheKey, { doc, lastUsed: Date.now() });
      prunePdfCache();
      setPdfDoc(doc);
      setPdfMessage("PDF załadowany.");
    } catch (e) {
      console.error(e);
      setPdfMessage("Nie udało się załadować PDF. Sprawdź konsolę.");
    } finally {
      setLoadingPdf(false);
    }
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

  useEffect(() => {
    renderPage().catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageNumber]);

  const selectedId = selected ? selected[pk] : null;

  // duplikaty pozycji (bez zmian)
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

  // ── 2. Grupowanie: klient → pdf → rows ──────────────────────────────────
  const groupedByKlient = useMemo(() => {
    // Map<klientName, Map<pdfName, rows[]>>
    const outer = new Map();

    for (const r of items) {
      const klient  = r.Klient ?? r.klient ?? "(brak klienta)";
      const pdfName = getPdfName(r);

      if (!outer.has(klient)) outer.set(klient, new Map());
      const inner = outer.get(klient);

      if (!inner.has(pdfName)) inner.set(pdfName, []);
      inner.get(pdfName).push(r);
    }

    // sortuj pozycje w obrębie każdego pdf
    for (const pdfMap of outer.values()) {
      for (const [pdfName, arr] of pdfMap.entries()) {
        arr.sort((a, b) => Number(a.Pozycja ?? a.pozycja ?? 0) - Number(b.Pozycja ?? b.pozycja ?? 0));
        pdfMap.set(pdfName, arr);
      }
    }

    return Array.from(outer.entries()); // [ [klientName, Map<pdfName, rows[]>], ... ]
  }, [items]);
  // ────────────────────────────────────────────────────────────────────────

  // ── 3. Handler zmiany pól numerycznych z live-walidacją ─────────────────
  function handleNumericChange(field, raw) {
    setEditForm((p) => ({ ...p, [field]: raw }));
    const parsed = parseDecimalInput(raw);
    const isError = raw !== "" && parsed === null;
    setEditNumericErrors((p) => ({ ...p, [field]: isError ? "Nieprawidłowa liczba (użyj . lub ,)" : "" }));
  }
  // ────────────────────────────────────────────────────────────────────────

  // style pomocnicze
  const thStyle = { textAlign: "left", borderBottom: "1px solid #eee", padding: 6 };
  const tdStyle = { borderBottom: "1px solid #f3f3f3", padding: 6 };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "sans-serif" }}>
      {/* ══════════ LEFT: lista ══════════ */}
      <div style={{ width: "45%", borderRight: "1px solid #ddd", padding: 12, overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>Orders MVP</h2>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          API: <b>{API}</b>
        </div>

        {/* filtry */}
        <div style={{ display: "flex", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <select
            value={statusFilter}
            onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }}
          >
            <option value="">status: (all)</option>
            <option value="new">new</option>
            <option value="confirmed">confirmed</option>
            <option value="rejected">rejected</option>
          </select>

          <input
            placeholder="Klient contains..."
            value={klientFilter}
            onChange={(e) => { setPage(1); setKlientFilter(e.target.value); }}
            style={{ flex: 1, minWidth: 120 }}
          />

          <button onClick={() => loadList()} disabled={loadingList}>
            {loadingList ? "Ładowanie..." : "Odśwież"}
          </button>
        </div>

        {/* ── 1. filtr DataAutomatu ── */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
          <span style={{ color: "#555", whiteSpace: "nowrap" }}>DataAutomatu od:</span>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setPage(1); setDateFrom(e.target.value); }}
            style={{ fontSize: 12 }}
          />
          <span style={{ color: "#555" }}>do:</span>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => { setPage(1); setDateTo(e.target.value); }}
            style={{ fontSize: 12 }}
          />
          <button
            style={{ fontSize: 11 }}
            onClick={() => { setPage(1); setDateFrom(hoursAgo(24)); setDateTo(""); }}
          >
            Ostatnie 24h
          </button>
          <button
            style={{ fontSize: 11 }}
            onClick={() => { setPage(1); setDateFrom(""); setDateTo(""); }}
          >
            Wszystkie daty
          </button>
        </div>
        {/* ─────────────────────────── */}

        <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
          Razem: {total} | Strona: {page}
          <span style={{ marginLeft: 10 }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>◀</button>
            <button onClick={() => setPage((p) => p + 1)} style={{ marginLeft: 6 }}>▶</button>
          </span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={thStyle}>Pozycja</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Klient</th>
              <th style={thStyle}>NaszIndeks</th>
              <th style={thStyle}>NazwaKlienta</th>
              <th style={thStyle}>IloscKlienta</th>
              <th style={thStyle}>CenaOfertowa</th>
            </tr>
          </thead>

          <tbody>
            {/* ── 2. Dwa poziomy: klient → pdf → pozycje ── */}
            {groupedByKlient.map(([klientName, pdfMap]) => {
              const isKlientOpen = openKlients[klientName] ?? false;
              const totalRowsForKlient = Array.from(pdfMap.values()).reduce((s, a) => s + a.length, 0);

              return (
                <React.Fragment key={klientName}>
                  {/* ── nagłówek klienta ── */}
                  <tr
                    onClick={() => setOpenKlients((p) => ({ ...p, [klientName]: !isKlientOpen }))}
                    style={{ cursor: "pointer", background: "#e8edf5", borderTop: "2px solid #c5cfe0" }}
                  >
                    <td colSpan={7} style={{ padding: "7px 6px", fontWeight: "bold", fontSize: 12 }}>
                      <span style={{ display: "inline-block", width: 18 }}>
                        {isKlientOpen ? "▾" : "▸"}
                      </span>
                      🏢 {klientName}
                      <span style={{ marginLeft: 10, color: "#555", fontWeight: "normal" }}>
                        ({pdfMap.size} {pdfMap.size === 1 ? "zamówienie" : "zamówień"},{" "}
                        {totalRowsForKlient} {totalRowsForKlient === 1 ? "pozycja" : "pozycji"})
                      </span>
                    </td>
                  </tr>

                  {/* ── zamówienia (pdf) tego klienta ── */}
                  {isKlientOpen && Array.from(pdfMap.entries()).map(([pdfName, rows]) => {
                    const isPdfOpen = openGroups[pdfName] ?? false;

                    return (
                      <React.Fragment key={pdfName}>
                        {/* nagłówek pdf */}
                        <tr
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenGroups((p) => ({ ...p, [pdfName]: !isPdfOpen }));
                          }}
                          style={{ cursor: "pointer", background: "#f7f7f7", borderTop: "1px solid #eee" }}
                        >
                          <td colSpan={7} style={{ padding: "5px 6px 5px 28px", fontSize: 12 }}>
                            <span style={{ display: "inline-block", width: 18 }}>
                              {isPdfOpen ? "▾" : "▸"}
                            </span>
                            📄 {pdfName}
                            <span style={{ marginLeft: 8, color: "#888", fontSize: 11 }}>
                              ({rows.length} pozycji)
                            </span>
                          </td>
                        </tr>

                        {/* pozycje */}
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

                          const isSel = selectedId === id;
                          const st    = (status ?? "").toString().toLowerCase();
                          const statusBg = st === "rejected" ? "#f1f1f1" : st === "confirmed" ? "#e9f7ee" : "transparent";

                          const posKey = String(pozycja ?? "").trim();
                          const isDup  = st !== "rejected" && posKey && (dupPosMap.get(pdfName)?.get(posKey) ?? 0) > 1;

                          return (
                            <tr
                              key={id}
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenGroups((p) => ({ ...p, [pdfName]: true }));
                                setOpenKlients((p) => ({ ...p, [klientName]: true }));
                                onSelect(row);
                              }}
                              style={{
                                cursor: "pointer",
                                background: isSel ? "#f3f6ff" : isDup ? "#ffe5e5" : statusBg,
                                color: st === "rejected" ? "#666" : "inherit",
                                borderLeft: isDup ? "4px solid crimson" : "4px solid transparent",
                              }}
                            >
                              <td style={{ ...tdStyle, paddingLeft: 40 }}>{pozycja}</td>
                              <td style={tdStyle}>{status}</td>
                              <td style={tdStyle}>{klient}</td>
                              <td style={tdStyle}>{naszIndeks}</td>
                              <td style={{ ...tdStyle, maxWidth: 220 }}>
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

      {/* ══════════ RIGHT: szczegóły + PDF ══════════ */}
      <div style={{ flex: 1, padding: 12, overflow: "auto" }}>
        <h3 style={{ marginTop: 0 }}>Szczegóły</h3>

        {!selected && <div>Kliknij rekord po lewej.</div>}

        {selected && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 10, alignItems: "center" }}>
              <b>ID:</b> {selectedId}
              <button onClick={() => updateStatus(selectedId, "new")}>new</button>
              <button onClick={() => updateStatus(selectedId, "confirmed")}>confirmed</button>
              <button onClick={() => updateStatus(selectedId, "rejected")}>rejected</button>
              {loadingPdf && <span style={{ marginLeft: 8, fontSize: 12 }}>Ładowanie PDF...</span>}
            </div>

            <div style={{ fontSize: 12, color: "#444", marginBottom: 10 }}>{pdfMessage}</div>

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
                  <input
                    value={editForm.Klient}
                    onChange={(e) => setEditForm((p) => ({ ...p, Klient: e.target.value }))}
                  />

                  <div>NaszIndeks</div>
                  <input
                    value={editForm.FinalIndeks}
                    onChange={(e) => setEditForm((p) => ({ ...p, FinalIndeks: e.target.value }))}
                  />

                  <div>NazwaKlienta</div>
                  <input
                    value={editForm.NazwaKlienta}
                    onChange={(e) => setEditForm((p) => ({ ...p, NazwaKlienta: e.target.value }))}
                  />

                  {/* ── 3. IloscKlienta z live-walidacją ── */}
                  <div>IloscKlienta</div>
                  <div>
                    <input
                      value={editForm.IloscKlienta}
                      onChange={(e) => handleNumericChange("IloscKlienta", e.target.value)}
                      style={{ borderColor: editNumericErrors.IloscKlienta ? "crimson" : undefined, width: "100%" }}
                    />
                    {editNumericErrors.IloscKlienta && (
                      <div style={{ fontSize: 11, color: "crimson", marginTop: 2 }}>
                        {editNumericErrors.IloscKlienta}
                      </div>
                    )}
                    {editForm.IloscKlienta !== "" && !editNumericErrors.IloscKlienta && (
                      <div style={{ fontSize: 11, color: "#558b2f", marginTop: 2 }}>
                        → {parseDecimalInput(editForm.IloscKlienta)}
                      </div>
                    )}
                  </div>

                  {/* ── 3. CenaOfertowa z live-walidacją ── */}
                  <div>CenaOfertowa</div>
                  <div>
                    <input
                      value={editForm.CenaOfertowa}
                      onChange={(e) => handleNumericChange("CenaOfertowa", e.target.value)}
                      style={{ borderColor: editNumericErrors.CenaOfertowa ? "crimson" : undefined, width: "100%" }}
                    />
                    {editNumericErrors.CenaOfertowa && (
                      <div style={{ fontSize: 11, color: "crimson", marginTop: 2 }}>
                        {editNumericErrors.CenaOfertowa}
                      </div>
                    )}
                    {editForm.CenaOfertowa !== "" && !editNumericErrors.CenaOfertowa && (
                      <div style={{ fontSize: 11, color: "#558b2f", marginTop: 2 }}>
                        → {parseDecimalInput(editForm.CenaOfertowa)}
                      </div>
                    )}
                  </div>
                  {/* ─────────────────────────────────────── */}

                  <div />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={saveEdits} disabled={editSaving}>Zapisz</button>
                    <button
                      onClick={() => {
                        setEditError("");
                        setEditNumericErrors({ IloscKlienta: "", CenaOfertowa: "" });
                        setEditForm({
                          Klient:       selected?.Klient       ?? "",
                          FinalIndeks:  selected?.FinalIndeks  ?? "",
                          NazwaKlienta: selected?.NazwaKlienta ?? "",
                          IloscKlienta: selected?.IloscKlienta ?? "",
                          CenaOfertowa: selected?.CenaOfertowa ?? "",
                        });
                        setEditOpen(false);
                      }}
                      disabled={editSaving}
                    >
                      Anuluj
                    </button>
                  </div>
                </div>
              )}
            </div>

            <details style={{ marginBottom: 10 }}>
              <summary>Szczegóły pozycji</summary>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 10 }}>
                <tbody>
                  {[
                    ["Klient",              selected?.Klient        ?? selected?.klient        ?? ""],
                    ["NaszIndeks",          selected?.FinalIndeks   ?? selected?.finalIndeks   ?? ""],
                    ["NazwaKlienta",        selected?.NazwaKlienta  ?? selected?.nazwaKlienta  ?? ""],
                    ["NumerRysunku",        selected?.nrRys         ?? ""],
                    ["Oferta",              selected?.oferta        ?? ""],
                    ["DataUtworzeniaOferty",selected?.DataUtworzenia ?? ""],
                    ["DataWaznosciOferty",  selected?.DataWaznosci  ?? ""],
                    ["IloscZOferty",        selected?.IloscZOferty  ?? ""],
                    ["IloscKlienta",        selected?.IloscKlienta  ?? selected?.iloscKlienta  ?? ""],
                    ["CenaOfertowa",        selected?.CenaOfertowa  ?? selected?.cenaOfertowa  ?? ""],
                    ["DataAutomatu",        selected?.DataAutomatu  ?? selected?.dataAutomatu  ?? ""],
                    ["pdfFileName",         selected?.pdfFileName   ?? selected?.PdfFileName   ?? ""],
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
              <button onClick={() => setPageNumber((p) => Math.max(1, p - 1))}>Poprzednia strona</button>
              <button
                onClick={() => setPageNumber((p) => p + 1)}
                disabled={!pdfDoc || pageNumber >= (pdfDoc?.numPages || 1)}
              >
                Następna strona
              </button>
              <div style={{ fontSize: 12, color: "#666" }}>
                Strona: {pageNumber}/{pdfDoc?.numPages || "-"}
              </div>
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
