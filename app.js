(function () {
  "use strict";

  const SQL_JS_SOURCES = [
    {
      script: "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.js",
      wasm: "https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/"
    },
    {
      script: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.min.js",
      wasm: "https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/"
    }
  ];

  const FIELD_HINTS = {
    date: ["date", "datetime", "timestamp", "created", "modified", "time", "entrydate", "day"],
    title: ["title", "heading", "subject", "name"],
    text: ["text", "content", "body", "notes", "note", "description", "entry"],
    rating: ["rating", "mood", "score", "emotion"],
    tags: ["tags", "tag", "labels", "categories"],
    people: ["people", "persons", "contacts"],
    location: ["location", "place", "address"]
  };

  const state = {
    db: null,
    entries: [],
    schema: [],
    detected: null,
    file: null,
    lastFocused: null
  };

  let els;

  document.addEventListener("DOMContentLoaded", start);

  function start() {
    els = {
      welcomePanel: byId("welcomePanel"), loadingPanel: byId("loadingPanel"), readerPanel: byId("readerPanel"),
      errorPanel: byId("errorPanel"), errorMessage: byId("errorMessage"), loadingMessage: byId("loadingMessage"),
      fileInput: byId("fileInput"), openFileButton: byId("openFileButton"), changeFileButton: byId("changeFileButton"),
      tryAgainButton: byId("tryAgainButton"), dropZone: byId("dropZone"), searchInput: byId("searchInput"),
      sortSelect: byId("sortSelect"), entryCount: byId("entryCount"), fileLabel: byId("fileLabel"),
      entriesList: byId("entriesList"), emptyState: byId("emptyState"), emptyTitle: byId("emptyTitle"),
      emptyMessage: byId("emptyMessage"), databaseDetailsContent: byId("databaseDetailsContent"),
      detailOverlay: byId("detailOverlay"), detailDate: byId("detailDate"), detailTitle: byId("detailTitle"),
      detailMetadata: byId("detailMetadata"), detailBody: byId("detailBody"), closeDetailButton: byId("closeDetailButton"),
      plainTextButton: byId("plainTextButton"), textOutputOverlay: byId("textOutputOverlay"),
      closeTextOutputButton: byId("closeTextOutputButton"), copyTextButton: byId("copyTextButton"),
      copyStatus: byId("copyStatus"), textOutput: byId("textOutput")
    };

    els.openFileButton.addEventListener("click", chooseFile);
    els.changeFileButton.addEventListener("click", chooseFile);
    els.tryAgainButton.addEventListener("click", chooseFile);
    els.fileInput.addEventListener("change", function () { if (this.files[0]) openDiaryFile(this.files[0]); });
    els.searchInput.addEventListener("input", renderEntries);
    els.sortSelect.addEventListener("change", renderEntries);
    els.closeDetailButton.addEventListener("click", closeDetail);
    els.plainTextButton.addEventListener("click", openTextOutput);
    els.closeTextOutputButton.addEventListener("click", closeTextOutput);
    els.copyTextButton.addEventListener("click", copyPlainText);
    els.detailOverlay.addEventListener("click", function (event) { if (event.target.hasAttribute("data-close-detail")) closeDetail(); });
    els.textOutputOverlay.addEventListener("click", function (event) { if (event.target.hasAttribute("data-close-output")) closeTextOutput(); });
    document.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!els.textOutputOverlay.hidden) closeTextOutput();
      else if (!els.detailOverlay.hidden) closeDetail();
    });
    setupDragAndDrop();
  }

  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error("Missing required page element: " + id);
    return element;
  }

  function chooseFile() {
    els.fileInput.value = "";
    els.fileInput.click();
  }

  function setupDragAndDrop() {
    ["dragenter", "dragover"].forEach(function (type) {
      els.dropZone.addEventListener(type, function (event) { event.preventDefault(); els.dropZone.classList.add("is-dragging"); });
    });
    ["dragleave", "drop"].forEach(function (type) {
      els.dropZone.addEventListener(type, function (event) { event.preventDefault(); els.dropZone.classList.remove("is-dragging"); });
    });
    els.dropZone.addEventListener("drop", function (event) { if (event.dataTransfer.files[0]) openDiaryFile(event.dataTransfer.files[0]); });
    els.dropZone.addEventListener("click", chooseFile);
    els.dropZone.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chooseFile(); } });
  }

  async function loadSqlJs() {
    if (typeof window.initSqlJs === "function") {
      return window.initSqlJs({ locateFile: function (file) { return SQL_JS_SOURCES[0].wasm + file; } });
    }
    const failures = [];
    for (const source of SQL_JS_SOURCES) {
      try {
        await loadScript(source.script);
        if (typeof window.initSqlJs !== "function") throw new Error("The downloaded script did not expose initSqlJs.");
        return await window.initSqlJs({ locateFile: function (file) { return source.wasm + file; } });
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        delete window.initSqlJs;
      }
    }
    throw new Error("The SQLite reader could not be loaded from either CDN. Check your internet connection, content blocker, or network policy. Details: " + failures.join(" | "));
  }

  function loadScript(url) {
    return new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.src = url;
      script.async = true;
      script.onload = resolve;
      script.onerror = function () { script.remove(); reject(new Error("Failed to load " + url)); };
      document.head.appendChild(script);
    });
  }

  async function openDiaryFile(file) {
    setLoading(true, "Reading “" + file.name + "” locally…");
    try {
      const buffer = await file.arrayBuffer();
      if (!hasSQLiteHeader(buffer)) throw new Error("This file does not have the expected “SQLite format 3” header. It may not be a supported Diarium SQLite backup, or it may be compressed or damaged.");
      els.loadingMessage.textContent = "Inspecting database tables and fields…";
      const SQL = await loadSqlJs();
      closeDatabase();
      state.db = new SQL.Database(new Uint8Array(buffer));
      state.file = file;
      state.schema = inspectDatabase(state.db);
      state.detected = detectEntryTable(state.schema);
      if (!state.detected) {
        renderDatabaseDetails();
        throw new Error("No likely journal-entry table was recognized. Open Database details below after dismissing this message, or inspect the console for the discovered schema.");
      }
      state.entries = loadEntries(state.db, state.detected);
      state.entries.forEach(function (entry, index) { entry._index = index; });
      console.info("Diarium Reader schema:", state.schema, "Selected:", state.detected);
      showReader();
    } catch (error) {
      console.error("Diarium Reader failed:", error, state.schema);
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  function hasSQLiteHeader(buffer) {
    if (buffer.byteLength < 16) return false;
    const bytes = new Uint8Array(buffer, 0, 16);
    const expected = "SQLite format 3\u0000";
    return bytes.every(function (value, index) { return value === expected.charCodeAt(index); });
  }

  function inspectDatabase(db) {
    return getTables(db).map(function (tableName) { return { name: tableName, columns: getColumns(db, tableName) }; });
  }

  function getTables(db) {
    const statement = db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name");
    const tables = [];
    try {
      statement.bind(["table", "sqlite_%"]);
      while (statement.step()) tables.push(String(statement.getAsObject().name));
    } finally { statement.free(); }
    return tables;
  }

  function getColumns(db, tableName) {
    const result = db.exec("PRAGMA table_info(" + quoteIdentifier(tableName) + ")");
    if (!result.length) return [];
    return result[0].values.map(function (row) {
      return { cid: row[0], name: String(row[1]), type: String(row[2] || ""), notnull: Boolean(row[3]), primaryKey: Boolean(row[5]) };
    });
  }

  function quoteIdentifier(value) { return '"' + String(value).replace(/"/g, '""') + '"'; }
  function normalizedName(value) { return String(value).toLowerCase().replace(/[^a-z0-9]/g, ""); }

  function detectEntryTable(schema) {
    let best = null;
    schema.forEach(function (table) {
      const names = table.columns.map(function (column) { return normalizedName(column.name); });
      const matches = {};
      Object.keys(FIELD_HINTS).forEach(function (group) {
        matches[group] = findMatchingColumn(table.columns, FIELD_HINTS[group]);
      });
      let score = 0;
      if (matches.text) score += 9;
      if (matches.date) score += 7;
      if (matches.title) score += 3;
      if (matches.rating) score += 1;
      if (matches.tags) score += 1;
      if (/entr|diar|journal|event|day|record/i.test(table.name)) score += 4;
      if (names.some(function (name) { return name === "id" || name.endsWith("id"); })) score += 1;
      if (!matches.text && !matches.title) score -= 6;
      const candidate = { table: table.name, columns: table.columns, fields: matches, score: score };
      if (!best || candidate.score > best.score) best = candidate;
    });
    return best && best.score >= 7 ? best : null;
  }

  function findMatchingColumn(columns, hints) {
    let best = null;
    let bestScore = 0;
    columns.forEach(function (column) {
      const name = normalizedName(column.name);
      hints.forEach(function (hint, index) {
        const exact = name === hint;
        const contains = name.includes(hint);
        const score = exact ? 100 - index : contains ? 50 - index : 0;
        if (score > bestScore) { best = column.name; bestScore = score; }
      });
    });
    return best;
  }

  function loadEntries(db, detectedSchema) {
    const result = db.exec("SELECT * FROM " + quoteIdentifier(detectedSchema.table));
    if (!result.length) return [];
    const columns = result[0].columns;
    return result[0].values.map(function (values) {
      const row = {};
      columns.forEach(function (column, index) { row[column] = values[index]; });
      return normalizeEntry(row, detectedSchema.fields);
    });
  }

  function normalizeEntry(row, fields) {
    const used = new Set(Object.values(fields).filter(Boolean));
    const dateInfo = parseFlexibleDate(fields.date ? row[fields.date] : null);
    const text = toPlainText(cleanValue(fields.text ? row[fields.text] : ""));
    const title = toPlainText(cleanValue(fields.title ? row[fields.title] : ""));
    const metadata = {};
    Object.keys(row).forEach(function (key) {
      const value = cleanValue(row[key]);
      if (value && !used.has(key) && !looksBinary(row[key])) metadata[key] = value;
    });
    return {
      title: title, text: text, date: dateInfo.date, rawDate: dateInfo.raw,
      rating: cleanValue(fields.rating ? row[fields.rating] : ""),
      tags: cleanValue(fields.tags ? row[fields.tags] : ""),
      people: cleanValue(fields.people ? row[fields.people] : ""),
      location: cleanValue(fields.location ? row[fields.location] : ""), metadata: metadata
    };
  }

  function cleanValue(value) {
    if (value === null || value === undefined) return "";
    if (value instanceof Uint8Array || Array.isArray(value)) return "[binary data]";
    return String(value).trim();
  }
  function looksBinary(value) { return value instanceof Uint8Array || Array.isArray(value); }

  function toPlainText(value) {
    if (!value || !/<\/?[a-z][\s\S]*?>/i.test(value)) return value;
    try {
      const parsed = new DOMParser().parseFromString(value, "text/html");
      parsed.querySelectorAll("br").forEach(function (element) { element.replaceWith("\n"); });
      parsed.querySelectorAll("p, div, section, article, header, footer, blockquote, pre, li, h1, h2, h3, h4, h5, h6").forEach(function (element) {
        element.appendChild(parsed.createTextNode("\n"));
      });
      return (parsed.body.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    } catch (error) {
      console.warn("Could not convert entry markup to plain text:", error);
      return value;
    }
  }

  function parseFlexibleDate(value) {
    if (value === null || value === undefined || value === "") return { date: null, raw: "" };
    const raw = String(value).trim();
    let date = null;
    const dotNetMatch = raw.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
    if (dotNetMatch) {
      const possible = new Date(Number(dotNetMatch[1]));
      if (isPlausibleDate(possible)) date = possible;
    } else if (/^\d{8}(?:\d{6})?$/.test(raw)) {
      const year = Number(raw.slice(0, 4));
      const month = Number(raw.slice(4, 6)) - 1;
      const day = Number(raw.slice(6, 8));
      const hour = raw.length > 8 ? Number(raw.slice(8, 10)) : 0;
      const minute = raw.length > 8 ? Number(raw.slice(10, 12)) : 0;
      const second = raw.length > 8 ? Number(raw.slice(12, 14)) : 0;
      const possible = new Date(year, month, day, hour, minute, second);
      if (isPlausibleDate(possible) && possible.getFullYear() === year && possible.getMonth() === month && possible.getDate() === day) date = possible;
    } else if (typeof value === "number" || /^-?\d+(?:\.\d+)?$/.test(raw)) {
      const number = Number(value);
      const candidates = [];
      if (Number.isFinite(number)) {
        if (number >= 1e17) {
          candidates.push((number - 621355968000000000) / 10000);
          candidates.push((number - 116444736000000000) / 10000);
          candidates.push(number / 1000000);
        } else if (number >= 1e14) {
          candidates.push(number / 1000);
        } else if (number >= 1e11) {
          candidates.push(number);
        } else if (number >= 1e8) {
          candidates.push(number * 1000);
          candidates.push(Date.UTC(2001, 0, 1) + number * 1000);
        } else if (number >= 2400000 && number <= 2600000) {
          candidates.push((number - 2440587.5) * 86400000);
        } else if (number >= 20000 && number <= 100000) {
          candidates.push((number - 25569) * 86400000);
        }
      }
      for (const candidate of candidates) {
        const possible = new Date(candidate);
        if (isPlausibleDate(possible)) { date = possible; break; }
      }
    } else {
      const normalized = raw.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
      const possible = new Date(normalized);
      if (isPlausibleDate(possible)) date = possible;
    }
    return { date: date, raw: raw };
  }

  function isPlausibleDate(date) {
    return !Number.isNaN(date.getTime()) && date.getUTCFullYear() >= 1800 && date.getUTCFullYear() <= 2300;
  }

  function setLoading(isLoading, message) {
    els.loadingPanel.hidden = !isLoading;
    if (message) els.loadingMessage.textContent = message;
    if (isLoading) { els.welcomePanel.hidden = true; els.readerPanel.hidden = true; els.errorPanel.hidden = true; }
  }

  function showError(message) {
    els.welcomePanel.hidden = true;
    els.readerPanel.hidden = state.schema.length === 0;
    els.errorPanel.hidden = false;
    els.errorMessage.textContent = message;
    els.changeFileButton.hidden = true;
    if (state.schema.length) { renderDatabaseDetails(); els.readerPanel.hidden = false; }
  }

  function showReader() {
    els.welcomePanel.hidden = true;
    els.errorPanel.hidden = true;
    els.readerPanel.hidden = false;
    els.changeFileButton.hidden = false;
    els.searchInput.value = "";
    els.fileLabel.textContent = state.file.name;
    renderDatabaseDetails();
    renderEntries();
  }

  function renderEntries() {
    const query = els.searchInput.value.trim().toLocaleLowerCase();
    const filtered = state.entries.filter(function (entry) {
      return !query || (entry.title + "\n" + entry.text).toLocaleLowerCase().includes(query);
    }).slice();
    filtered.sort(function (a, b) {
      const aTime = a.date ? a.date.getTime() : 0;
      const bTime = b.date ? b.date.getTime() : 0;
      return els.sortSelect.value === "oldest" ? aTime - bTime : bTime - aTime;
    });
    els.entriesList.replaceChildren();
    filtered.forEach(function (entry) { els.entriesList.appendChild(createEntryCard(entry)); });
    els.entryCount.textContent = query ? filtered.length + " of " + state.entries.length + " entries" : state.entries.length + (state.entries.length === 1 ? " entry" : " entries");
    els.emptyState.hidden = filtered.length !== 0;
    if (filtered.length === 0) {
      els.emptyTitle.textContent = query ? "No matching entries" : "No journal entries found";
      els.emptyMessage.textContent = query ? "Try a different word or phrase." : "This backup did not contain recognizable journal entries.";
    }
  }

  function getVisibleEntries() {
    const query = els.searchInput.value.trim().toLocaleLowerCase();
    const entries = state.entries.filter(function (entry) {
      return !query || (entry.title + "\n" + entry.text).toLocaleLowerCase().includes(query);
    }).slice();
    entries.sort(function (a, b) {
      const aTime = a.date ? a.date.getTime() : 0;
      const bTime = b.date ? b.date.getTime() : 0;
      return els.sortSelect.value === "oldest" ? aTime - bTime : bTime - aTime;
    });
    return entries;
  }

  function buildPlainText(entries) {
    return entries.map(function (entry) {
      const lines = [formatDate(entry)];
      if (entry.title) lines.push(entry.title);
      if (entry.rating) lines.push("Mood / rating: " + entry.rating);
      if (entry.tags) lines.push("Tags: " + entry.tags);
      if (entry.people) lines.push("People: " + entry.people);
      if (entry.location) lines.push("Location: " + entry.location);
      lines.push("", entry.text || "[No text content]");
      return lines.join("\n").trim();
    }).join("\n\n----------------------------------------\n\n");
  }

  function openTextOutput() {
    state.lastFocused = els.plainTextButton;
    const entries = getVisibleEntries();
    els.textOutput.value = buildPlainText(entries);
    els.copyStatus.textContent = entries.length + (entries.length === 1 ? " entry ready to copy." : " entries ready to copy.");
    els.textOutputOverlay.hidden = false;
    document.body.classList.add("detail-open");
    els.copyTextButton.focus();
  }

  function closeTextOutput() {
    els.textOutputOverlay.hidden = true;
    document.body.classList.remove("detail-open");
    if (state.lastFocused) state.lastFocused.focus();
  }

  async function copyPlainText() {
    const text = els.textOutput.value;
    if (!text) { els.copyStatus.textContent = "There is no entry text to copy."; return; }
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        els.textOutput.focus();
        els.textOutput.select();
        if (!document.execCommand("copy")) throw new Error("The browser declined the copy command.");
      }
      els.copyStatus.textContent = "Copied to clipboard.";
      els.copyTextButton.textContent = "Copied!";
      window.setTimeout(function () { els.copyTextButton.textContent = "Copy all text"; }, 1600);
    } catch (error) {
      console.error("Copy failed:", error);
      els.copyStatus.textContent = "Copy was blocked. Select the text below and use your device’s Copy command.";
      els.textOutput.focus();
      els.textOutput.select();
    }
  }

  function createEntryCard(entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "entry-card";
    button.addEventListener("click", function () { openEntry(entry, button); });
    appendTextElement(button, "p", "entry-date", formatDate(entry));
    if (entry.title) appendTextElement(button, "h3", "entry-title", entry.title);
    appendTextElement(button, "p", "entry-preview", entry.text || "No text content");
    const chips = makeChips(entry);
    if (chips.childNodes.length) button.appendChild(chips);
    return button;
  }

  function appendTextElement(parent, tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
  }

  function makeChips(entry) {
    const container = document.createElement("div");
    container.className = "chips";
    [[entry.rating, "Mood / rating: "], [entry.tags, "Tags: "]].forEach(function (item) {
      if (item[0]) appendTextElement(container, "span", "chip", item[1] + item[0]);
    });
    return container;
  }

  function formatDate(entry) {
    if (entry.date) return new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: hasMeaningfulTime(entry.date) ? "short" : undefined }).format(entry.date);
    return entry.rawDate || "Date unavailable";
  }
  function hasMeaningfulTime(date) { return date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0; }

  function openEntry(entry, trigger) {
    state.lastFocused = trigger;
    els.detailDate.textContent = formatDate(entry);
    els.detailTitle.textContent = entry.title || "Journal entry";
    els.detailBody.textContent = entry.text || "No text content was found for this entry.";
    els.detailMetadata.replaceChildren();
    addMetadata("Mood / rating", entry.rating);
    addMetadata("Tags", entry.tags);
    addMetadata("People", entry.people);
    addMetadata("Location", entry.location);
    Object.keys(entry.metadata).forEach(function (key) { addMetadata(humanize(key), entry.metadata[key]); });
    els.detailOverlay.hidden = false;
    document.body.classList.add("detail-open");
    els.closeDetailButton.focus();
  }

  function addMetadata(label, value) {
    if (!value) return;
    const row = document.createElement("div");
    row.className = "metadata-row";
    appendTextElement(row, "span", "metadata-label", label);
    appendTextElement(row, "span", "metadata-value", value);
    els.detailMetadata.appendChild(row);
  }

  function humanize(value) { return String(value).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, function (c) { return c.toUpperCase(); }); }

  function closeDetail() {
    els.detailOverlay.hidden = true;
    document.body.classList.remove("detail-open");
    if (state.lastFocused) state.lastFocused.focus();
  }

  function renderDatabaseDetails() {
    const content = els.databaseDetailsContent;
    content.replaceChildren();
    const list = document.createElement("dl");
    addDefinition(list, "Filename", state.file ? state.file.name : "Unavailable");
    addDefinition(list, "Database size", state.file ? formatBytes(state.file.size) : "Unavailable");
    addDefinition(list, "Selected entry table", state.detected ? state.detected.table + " (confidence score " + state.detected.score + ")" : "None recognized");
    content.appendChild(list);
    state.schema.forEach(function (table) {
      const section = document.createElement("div");
      section.className = "schema-table";
      appendTextElement(section, "strong", "", table.name);
      appendTextElement(section, "div", "", table.columns.map(function (column) { return column.name + (column.type ? " (" + column.type + ")" : ""); }).join(", ") || "No columns");
      content.appendChild(section);
    });
  }

  function addDefinition(list, term, description) {
    appendTextElement(list, "dt", "", term);
    appendTextElement(list, "dd", "", description);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
    if (bytes < 1024) return bytes + " bytes";
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = units[0];
    for (let i = 1; i < units.length && value >= 1024; i += 1) { value /= 1024; unit = units[i]; }
    return value.toFixed(value >= 10 ? 1 : 2) + " " + unit;
  }

  function closeDatabase() {
    if (state.db) {
      try { state.db.close(); } catch (error) { console.warn("Could not close the previous database:", error); }
    }
    state.db = null;
    state.entries = [];
    state.schema = [];
    state.detected = null;
  }
})();
