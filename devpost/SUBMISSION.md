# Devpost submission: Tender Lens

Copy each section into the matching field on Devpost. Platform to select: **Web (Chrome)**.

---

## Project name

Tender Lens

## Elevator pitch (max 200 characters)

A Chrome side panel that reads Polish and EU tender notices and gives you the deadline, bid security, conditions and a document checklist. Gemini Nano on-device first, cloud for long PDFs.

---

## Inspiration

I prepare bids for public tenders and requests for quotation in Poland. Each notice is long, written in legal Polish, and the information that decides whether you can bid at all is spread across numbered sections: the deadline in 8.1, the bid security in 6.4, the reference requirements in 5.4, the documents somewhere in 5.6 and 5.7, plus a 100-page specification PDF. Missing one line costs the whole offer. Before Tender Lens I copied these fields into a notes file by hand for every notice.

Notices are public, but my own notes on which tenders I'm watching and what I still have to prepare are not something I want to send to a server every time. That made it a good fit for hybrid AI: short notices can be read on my own computer, long specifications need a bigger model.

## What it does

Tender Lens is a Chrome extension with a side panel. Open a notice on e-Zamówienia (BZP), Baza Konkurencyjności or TED and the panel shows:

- an **instant preview** from a local parser (no AI): deadline with a countdown, bid security, award criteria;
- after **Analyze**, an AI summary in English: what is being bought, participation conditions, criteria with weights, required documents, and "watch out" items such as references with minimum contract values or named key staff;
- a **bid checklist** you tick off while preparing the offer;
- **Watch** (saved to Cloud Firestore, sorted by deadline) and **Add to calendar** (`.ics` with reminders 3 days and 1 day before).

For the specification (SWZ / zapytanie ofertowe) you drop the PDF into the panel or click one of the attachment links it found on the page. Any other site works through the context menu: select the notice text, right-click, *Analyze selected text with Tender Lens*.

Every result says which engine produced it (**On device · Gemini Nano** or **Cloud · Gemini via Firebase AI Logic**), how long it took and why it was routed there.

## How we built it

- **Firebase AI Logic hybrid inference** (Web SDK, Gemini Developer API). One `GenerativeModel` per inference mode: `PREFER_ON_DEVICE` for notices that fit Gemini Nano's window, `ONLY_IN_CLOUD` for long PDFs (sent as the original file) and scans, `ONLY_ON_DEVICE` for the "on-device only" setting and for offline use. The same `Schema` is passed as `responseSchema` to the cloud model and as `responseConstraint` to Gemini Nano, so both return the same JSON. `response.inferenceSource` drives the engine label in the UI, and `initializeDeviceModel()` starts the Nano download from a click with a progress bar.
- **A router in plain TypeScript** decides the mode from the text size after local cleanup, the PDF page count, whether the PDF has a text layer, the user's setting, Nano's availability and the network state. Polish notices are full of boilerplate (GDPR clauses, platform manuals, sanctions law), so we strip it locally first; that alone moves most BZP notices from "needs the cloud" to "fits on the device". Notices that are only slightly too long get their least relevant lines trimmed. In on-device-only mode, long documents are split into several Nano passes and the partial results are merged.
- **Parser + model together.** A deterministic parser reads the fixed-format fields of BZP, TED and Baza Konkurencyjności (its public JSON API), Polish dates and amounts. Its results are passed to the model as hints and used to check the model: dates and money from the parser win, and any disagreement is shown to the user.
- **Fallback in both directions.** If Gemini Nano is missing or still downloading, the SDK falls back to the cloud. If Nano answers with unusable JSON, the request is retried once in the cloud and the route note says so.
- **App Check** with the debug provider (Chrome extensions can't use reCAPTCHA), **anonymous Authentication**, **Cloud Firestore** with security rules and persistent local cache for the watchlist, and **Remote Config** to tune the on-device token budget and the cloud model without a new build.
- Chrome Manifest V3, TypeScript, Vite, PDF.js for local text extraction, Vitest. The code was written with AI coding agents (Claude Code and Codex).

## Challenges we ran into

- **Gemini Nano does not accept Polish as a declared input language** in Chrome 157 (only en, de, es, fr, ja), and declaring it aborts the call. We declare English and rely on a glossary in the prompt (wadium = bid security, SWZ = tender specification and so on) plus the parser hints.
- **The on-device context window is small** compared with a typical notice. Cleaning boilerplate locally and trimming by relevance was more effective than any prompt change.
- **App Check in an extension.** reCAPTCHA needs a web origin, which `chrome-extension://` pages don't have. We use the debug provider and kept a `CustomProvider` slot for a production attestation backend.
- **Single-page government sites.** BZP and Baza Konkurencyjności render after load, so the capture retries, and for Baza Konkurencyjności we read the public JSON API directly.

## Accomplishments that we're proud of

- On the real notices in our test set the local parser finds every deadline, bid security and weighted criterion, so the model is never the only source for a date or an amount.
- The same request works on a laptop with Gemini Nano, a laptop without it, and offline (on-device only), and the user can always see which path was taken.
- Long specification PDFs work: text is extracted locally, and only when the document is too long for the device does the original PDF go to the cloud model.

## What we learned

- Hybrid is mostly a routing problem. Deciding *what* to send where, and cleaning the input locally first, matters more than the model call itself.
- A small model with a strict JSON schema and good hints is good enough for extraction; free-form summarising of a 100-page document is where the cloud model earns its place.

## What's next for Tender Lens

- Reminder notifications from the watchlist, and a shared watchlist for a small team.
- More platforms (platformazakupowa.pl, e-propublico, SmartPZP) and the ESPD/JEDZ form.
- A production App Check provider and a Chrome Web Store release.
- Declare Polish input as soon as Gemini Nano supports it.

## Built with

firebase-ai-logic, gemini-nano, gemini, firebase-app-check, firebase-authentication, cloud-firestore, firebase-remote-config, chrome-extension, manifest-v3, prompt-api, typescript, vite, pdf.js, vitest, claude-code, codex

---

## How Firebase AI Logic is used (for the "description" requirement)

Code: `src/ai/hybrid.ts` (model creation, schema, `generateContent`, `initializeDeviceModel`, `inferenceSource`), called from the pipeline in `src/core/analyze.ts` through the side panel (`src/sidepanel/main.ts`). Modes used at runtime: `PREFER_ON_DEVICE`, `ONLY_ON_DEVICE`, `ONLY_IN_CLOUD`.

## Value proposition

Small bidders lose tenders on formalities: a missed bid security, a reference below the minimum value, a missing declaration. Tender Lens puts those items on one screen with a checklist and a calendar reminder, keeps short notices on the user's computer, and still handles the long specification PDFs that need a bigger model.

## Testing instructions (paste into the Devpost "testing instructions" field)

1. Clone the repository and run `npm install`.
2. Without any keys: `npm run build:mock`, then `chrome://extensions` → Developer mode → Load unpacked → `dist`. Open a notice, for example any notice on https://ezamowienia.gov.pl/mo-client-board/bzp/list or https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia , and click the extension icon. Mock mode shows the parser results and the routing decision, without calling a model.
3. With AI: create a free Firebase project and follow "Full setup" in the README (about 10 minutes: AI Logic with Gemini Developer API, anonymous Auth, Firestore, an App Check debug token). `npm run build` and load `dist` again.
4. `npm test` runs the unit tests on saved real notices.

The demo video shows the extension running with the author's Firebase project.

## Built during the submission period

The whole project (code, tests, fixtures, documentation) was created after 11 November 2026 for this hackathon. No pre-existing code. Libraries from npm: Firebase JS SDK, PDF.js.
