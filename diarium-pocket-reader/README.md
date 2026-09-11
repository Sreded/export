# Diarium Pocket Reader

A mobile-first, privacy-focused browser reader for Diarium `.diary` backup files.

## What it does

- Opens Diarium `.diary` backup files directly in the browser.
- Parses the SQLite database locally with WebAssembly (`sql.js`).
- Shows a phone-friendly journal timeline.
- Supports search across headings, entry text, tags, people, and dates.
- Shows entry details, rating, tags, people, and saved-location presence when available.
- Does not upload the diary to a server.
- Sanitizes stored HTML before displaying it.
- Dynamically inspects the SQLite schema and tolerates several likely schema variations.

## Important format note

This project is for the `.diary` file produced by Diarium's **Backup diary** feature. That backup is a SQLite database. It is not the same as Diarium's JSON/HTML/TXT export or its encrypted/compressed cloud-sync payload.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL shown by Vite on your phone or desktop browser.

## Production build

```bash
npm run build
npm run preview
```

The `dist/` directory can be deployed to any static host (Cloudflare Pages, Netlify, Vercel static hosting, GitHub Pages with the usual Vite base-path adjustment, etc.). All diary parsing still happens client-side.

## Testing with a real Diarium file

1. In Diarium, use **Settings → Backup diary**.
2. Save the resulting `.diary` file to your device.
3. Open this app and choose the file.
4. Confirm entry dates and content.
5. If your Diarium version uses schema fields not covered by the parser, inspect the browser console/database schema and add aliases in `candidate()` / `normalizeEntries()`.

## Privacy model

The web app has no API calls and no backend. The selected file is read through the browser `File` API into memory and parsed locally. The project intentionally does not persist the diary file to localStorage or IndexedDB.

## Known limitations

- Diarium's internal SQLite schema is not a public stable API, so future app versions could change table or column names.
- Attachment extraction is not implemented in this first version. Some Diarium media may be stored as database blobs or referenced through other tables depending on the version.
- A cloud-sync payload is not interchangeable with a `Backup diary` `.diary` file.

