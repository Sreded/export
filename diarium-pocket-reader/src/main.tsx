import React, { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import {
  BookOpen, CalendarDays, ChevronLeft, FileUp, MapPin, Search,
  ShieldCheck, Star, Tag, UserRound, X, CloudOff, Database
} from 'lucide-react';
import './styles.css';

type SqlDatabase = any;
type RawRow = Record<string, unknown>;

type DiaryEntry = {
  id: string;
  date: Date | null;
  heading: string;
  html: string;
  plainText: string;
  rating: number | null;
  latitude: number | null;
  longitude: number | null;
  tags: string[];
  people: string[];
  raw: RawRow;
};

const candidate = (row: RawRow, names: string[]) => {
  const keys = Object.keys(row);
  for (const name of names) {
    const key = keys.find(k => k.toLowerCase() === name.toLowerCase());
    if (key) return row[key];
  }
  return undefined;
};

const stringify = (v: unknown) => v == null ? '' : String(v);

function parseDiariumDate(value: unknown): Date | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;

  if (typeof value === 'number') {
    // Common representations: Unix seconds/ms, .NET ticks, and date-like YYYYMMDD integers.
    if (value > 621355968000000000) {
      const ms = (value - 621355968000000000) / 10000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (value > 1e12 && value < 1e15) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (value > 1e9 && value < 1e11) {
      const d = new Date(value * 1000);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (value >= 19000101 && value <= 22001231) {
      const s = String(value);
      const d = new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T12:00:00`);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const s = String(value).trim();
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct;

  const digits = Number(s);
  if (Number.isFinite(digits)) return parseDiariumDate(digits);
  return null;
}

function htmlToText(html: string) {
  const el = document.createElement('div');
  el.innerHTML = html;
  return (el.textContent || el.innerText || '').trim();
}

function looksLikeHtml(text: string) {
  return /<([a-z][^>]*)>/i.test(text);
}

function safeHtml(value: string) {
  // The diary is user-owned local data, but strip active content before rendering.
  const doc = new DOMParser().parseFromString(value, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, form, input, button, link, meta').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || (['href','src','xlink:href'].includes(name) && val.startsWith('javascript:'))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return doc.body.innerHTML;
}

function queryRows(db: SqlDatabase, sql: string, params: unknown[] = []): RawRow[] {
  const stmt = db.prepare(sql);
  try {
    if (params.length) stmt.bind(params);
    const out: RawRow[] = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    return out;
  } finally {
    stmt.free();
  }
}

function quoteIdent(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

function discoverSchema(db: SqlDatabase) {
  const tables = queryRows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(r => String(r.name));
  const columns = new Map<string, string[]>();
  for (const table of tables) {
    const cols = queryRows(db, `PRAGMA table_info(${quoteIdent(table)})`).map(r => String(r.name));
    columns.set(table, cols);
  }
  return { tables, columns };
}

function findEntryTable(schema: ReturnType<typeof discoverSchema>) {
  const scored = schema.tables.map(table => {
    const cols = (schema.columns.get(table) || []).map(c => c.toLowerCase());
    let score = 0;
    if (table.toLowerCase() === 'entries') score += 20;
    if (table.toLowerCase().includes('entry')) score += 5;
    if (cols.some(c => ['text','html','content','body'].includes(c))) score += 6;
    if (cols.some(c => ['heading','title'].includes(c))) score += 3;
    if (cols.some(c => ['date','datetime','timestamp','diaryentryid'].includes(c))) score += 4;
    return { table, score };
  }).sort((a,b) => b.score - a.score);
  return scored[0]?.score ? scored[0].table : null;
}

function readLookupValues(db: SqlDatabase, entryId: unknown, schema: ReturnType<typeof discoverSchema>, kind: 'tag'|'people') {
  if (entryId == null) return [];
  const tableNames = schema.tables;
  const joinCandidates = kind === 'tag'
    ? tableNames.filter(t => /entrytags?/i.test(t))
    : tableNames.filter(t => /entrypeople|entrypersons?|peopleentries/i.test(t));
  const valueCandidates = kind === 'tag'
    ? tableNames.filter(t => /^diarytags?$|^tags?$/i.test(t))
    : tableNames.filter(t => /^people$|^persons?$|^diarypeople$/i.test(t));

  for (const joinTable of joinCandidates) {
    const jcols = schema.columns.get(joinTable) || [];
    const entryCol = jcols.find(c => /diaryentryid|entryid/i.test(c));
    const foreignCol = jcols.find(c => kind === 'tag' ? /diarytagid|tagid/i.test(c) : /personid|peopleid|diarypeopleid/i.test(c));
    if (!entryCol || !foreignCol) continue;

    for (const valueTable of valueCandidates) {
      const vcols = schema.columns.get(valueTable) || [];
      const idCol = vcols.find(c => c.toLowerCase() === foreignCol.toLowerCase()) ||
        vcols.find(c => kind === 'tag' ? /diarytagid|tagid|^id$/i.test(c) : /personid|peopleid|^id$/i.test(c));
      const textCol = vcols.find(c => /^(name|title|tag|text)$/i.test(c));
      if (!idCol || !textCol) continue;
      try {
        const sql = `SELECT v.${quoteIdent(textCol)} AS value FROM ${quoteIdent(joinTable)} j JOIN ${quoteIdent(valueTable)} v ON j.${quoteIdent(foreignCol)} = v.${quoteIdent(idCol)} WHERE j.${quoteIdent(entryCol)} = ?`;
        return queryRows(db, sql, [entryId]).map(r => stringify(r.value)).filter(Boolean);
      } catch { /* try next schema variant */ }
    }
  }
  return [];
}

function normalizeEntries(db: SqlDatabase): DiaryEntry[] {
  const schema = discoverSchema(db);
  const table = findEntryTable(schema);
  if (!table) throw new Error('Could not find a diary-entry table in this SQLite file.');

  const rows = queryRows(db, `SELECT * FROM ${quoteIdent(table)}`);
  return rows.map((row, index) => {
    const idVal = candidate(row, ['DiaryEntryId','EntryId','Id','id']) ?? index;
    const heading = stringify(candidate(row, ['Heading','Title','heading','title'])) || 'Untitled entry';
    const content = stringify(candidate(row, ['Text','Html','HTML','Content','Body','Description','text','html']));
    const html = looksLikeHtml(content) ? safeHtml(content) : safeHtml(content.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('\n','<br>'));
    const plainText = htmlToText(html);
    const ratingNum = Number(candidate(row, ['Rating','rating','Mood','Score']));
    const latNum = Number(candidate(row, ['Latitude','Lat','latitude']));
    const lonNum = Number(candidate(row, ['Longitude','Lon','Lng','longitude']));
    const dateRaw = candidate(row, ['Date','Datetime','DateTime','Timestamp','Created','CreatedAt','DiaryEntryId']);

    return {
      id: String(idVal),
      date: parseDiariumDate(dateRaw),
      heading,
      html,
      plainText,
      rating: Number.isFinite(ratingNum) ? ratingNum : null,
      latitude: Number.isFinite(latNum) && latNum !== 0 ? latNum : null,
      longitude: Number.isFinite(lonNum) && lonNum !== 0 ? lonNum : null,
      tags: readLookupValues(db, idVal, schema, 'tag'),
      people: readLookupValues(db, idVal, schema, 'people'),
      raw: row
    };
  }).sort((a,b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
}

function formatDate(date: Date | null, long = false) {
  if (!date) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, long
    ? { weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' }
    : { month:'short', day:'numeric', year:'numeric' }).format(date);
}

function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [fileName, setFileName] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<DiaryEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(e => [e.heading, e.plainText, ...e.tags, ...e.people, formatDate(e.date)]
      .join(' ').toLowerCase().includes(q));
  }, [entries, query]);

  const years = useMemo(() => new Set(entries.map(e => e.date?.getFullYear()).filter(Boolean)).size, [entries]);

  async function openFile(file: File) {
    setBusy(true); setError(''); setSelected(null);
    try {
      const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const signature = new TextDecoder().decode(header);
      if (!signature.startsWith('SQLite format 3')) {
        throw new Error('This file does not look like a standard Diarium backup SQLite database. Choose the .diary file created by “Backup diary”, not a cloud-sync file or another export format.');
      }
      const SQL = await initSqlJs({ locateFile: () => wasmUrl });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const db = new SQL.Database(bytes);
      try {
        const parsed = normalizeEntries(db);
        if (!parsed.length) throw new Error('The database opened, but no diary entries were found.');
        setEntries(parsed);
        setFileName(file.name);
      } finally { db.close(); }
    } catch (e) {
      setEntries([]); setFileName('');
      setError(e instanceof Error ? e.message : 'Could not read this diary file.');
    } finally { setBusy(false); }
  }

  if (selected) {
    return <main className="app detail-page">
      <header className="detail-header">
        <button className="icon-button" onClick={() => setSelected(null)} aria-label="Back"><ChevronLeft /></button>
        <div className="detail-header-title">Entry</div>
        <div className="icon-spacer" />
      </header>
      <article className="entry-detail">
        <div className="entry-date-large">{formatDate(selected.date, true)}</div>
        <h1>{selected.heading}</h1>
        <div className="chips">
          {selected.rating !== null && <span className="chip"><Star size={14}/> {selected.rating}</span>}
          {selected.tags.map(t => <span className="chip" key={`t-${t}`}><Tag size={14}/> {t}</span>)}
          {selected.people.map(p => <span className="chip" key={`p-${p}`}><UserRound size={14}/> {p}</span>)}
          {selected.latitude !== null && selected.longitude !== null && <span className="chip"><MapPin size={14}/> Location saved</span>}
        </div>
        <div className="prose" dangerouslySetInnerHTML={{ __html: selected.html }} />
      </article>
    </main>
  }

  return <main className="app">
    <section className="hero">
      <div className="brand-mark"><BookOpen size={24}/></div>
      <div>
        <div className="eyebrow">PRIVATE · ON YOUR DEVICE</div>
        <h1>Diarium Pocket Reader</h1>
        <p>Open a Diarium <code>.diary</code> backup directly on your phone or computer. Your journal stays in your browser.</p>
      </div>
    </section>

    {!entries.length && <section className="upload-card">
      <div className="upload-icon"><FileUp size={28}/></div>
      <h2>Open your diary</h2>
      <p>Select the <code>.diary</code> file created by Diarium’s <strong>Backup diary</strong> feature.</p>
      <input ref={inputRef} type="file" accept=".diary,application/octet-stream,application/x-sqlite3" hidden
        onChange={e => e.target.files?.[0] && openFile(e.target.files[0])} />
      <button className="primary" onClick={() => inputRef.current?.click()} disabled={busy}>
        <Database size={18}/>{busy ? 'Reading…' : 'Choose .diary file'}
      </button>
      <div className="privacy-note"><ShieldCheck size={16}/> Processed locally. Nothing is sent to a server.</div>
      {error && <div className="error">{error}</div>}
    </section>}

    {!!entries.length && <>
      <section className="library-head">
        <div>
          <div className="eyebrow">YOUR JOURNAL</div>
          <h2>{fileName}</h2>
        </div>
        <button className="text-button" onClick={() => { setEntries([]); setFileName(''); setQuery(''); }}>Close</button>
      </section>
      <section className="stats">
        <div><strong>{entries.length.toLocaleString()}</strong><span>Entries</span></div>
        <div><strong>{years}</strong><span>Years</span></div>
        <div><strong>{entries.filter(e => e.tags.length).length}</strong><span>Tagged</span></div>
      </section>
      <div className="search-wrap"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search entries, tags, people…" />{query && <button onClick={()=>setQuery('')} aria-label="Clear search"><X size={17}/></button>}</div>
      <section className="timeline">
        {filtered.map(entry => <button className="entry-card" key={entry.id} onClick={() => setSelected(entry)}>
          <div className="date-box"><span>{entry.date ? entry.date.toLocaleString(undefined,{month:'short'}) : '—'}</span><strong>{entry.date ? entry.date.getDate() : '?'}</strong></div>
          <div className="entry-copy">
            <div className="entry-topline"><span>{formatDate(entry.date)}</span>{entry.rating !== null && <span className="rating"><Star size={13}/> {entry.rating}</span>}</div>
            <h3>{entry.heading}</h3>
            <p>{entry.plainText || 'No text in this entry.'}</p>
            {!!entry.tags.length && <div className="mini-tags">{entry.tags.slice(0,3).map(t=><span key={t}>#{t}</span>)}</div>}
          </div>
        </button>)}
        {!filtered.length && <div className="empty-search"><Search size={24}/><h3>No entries found</h3><p>Try another word, tag, person, or date.</p></div>}
      </section>
    </>}

    <footer><CloudOff size={15}/> Offline-friendly after the app loads.</footer>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />);
