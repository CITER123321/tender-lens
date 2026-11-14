# Demo video script: Tender Lens (target 2:50, hard limit 3:00)

Format: screen recording 1920×1080, Chrome with the side panel open, browser zoom 110–125% so the panel text is readable on YouTube. English voice-over (own voice or TTS) and English subtitles (`subtitles-en.srt` in this folder, upload it in YouTube Studio → Subtitles).

Record in a separate Chrome profile with no personal tabs, bookmarks or e-mail visible. Prepare before recording:

- Gemini Nano downloaded (`chrome://on-device-internals` shows the model as ready), the extension built with your Firebase config, Settings set to **Auto**.
- Tab 1: a current BZP notice for IT services (search https://ezamowienia.gov.pl/mo-client-board/bzp/list for "usługi informatyczne").
- Tab 2: a Baza Konkurencyjności notice with a PDF attachment, e.g. https://bazakonkurencyjnosci.funduszeeuropejskie.gov.pl/ogloszenia/297362 (deadline 7 Dec 2026).
- A long SWZ PDF (80+ pages) and a medium one (10–25 pages) saved on the desktop, from current tenders.
- Google Calendar open in tab 3 (empty test calendar, nothing private).

If Gemini Nano is not ready on the recording computer, record scene 3 anyway: the pill will say **Cloud** and the route note will say Nano is not available. That is the fallback working; say so in the voice-over (alternative line given below).

---

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:14 | Tab 1, scroll quickly through the whole BZP notice. | This is a Polish public tender notice. Somewhere in here are the deadline, the bid security and the list of documents. Miss one line and your offer is rejected. |
| 0:14–0:32 | Click the Tender Lens icon. The side panel opens with the instant preview (deadline, countdown, bid security, criteria). Point at "Instant preview from the local parser, no AI yet". | Tender Lens opens next to the notice. Before any AI runs, a local parser already found the deadline, the bid security and the award criteria. |
| 0:32–1:02 | Click **Analyze notice**. Show the green pill **On device · Gemini Nano**, the time, and the route note ("Fits the on-device window…"). Scroll: summary, Watch out, criteria bars, conditions. | Now the AI part. The GDPR clauses and platform manuals were removed locally, the rest fits Gemini Nano's window, so Firebase AI Logic runs it right here in Chrome, on my computer. I get a summary in English, the conditions, the criteria and the things a small company could miss, like references with a minimum value. |
| *(alt. 0:32–1:02 if Nano is not ready)* | Same, pill shows **Cloud**. | Gemini Nano isn't available on this machine yet, so the same request falls back to Gemini in the cloud. Same code, same schema, and the panel tells you which one answered. |
| 1:02–1:20 | Settings tab → select **Cloud only** → back → **Analyze** again. Blue pill **Cloud · Gemini via Firebase AI Logic**. Switch back to **Auto**. | Same request in the cloud: same JSON schema, different engine. Each answer is labelled, so you always know where your data went. |
| 1:20–1:50 | Tab 2 (Baza Konkurencyjności). Panel shows the notice and the attachment list. Then drag the long SWZ PDF into the drop zone. Status: "Reading PDF page 12 of 96 locally…", then route note "Long document (96-page PDF…) …cloud model reads the original PDF". Show the result. | Requests for quotation from EU projects work too. For the long specification, text is extracted on my computer first. Ninety-six pages is too much for the on-device model, so the original PDF goes to Gemini in the cloud. |
| 1:50–2:12 | Settings → **On-device only**. Drop a medium PDF (10–25 pages, e.g. "Zapytanie ofertowe" from tab 2, saved to disk). Status shows "On-device pass 1 of 3…", "pass 2 of 3". Route note: "…split into 3 local passes. Nothing leaves this computer." | If I don't want anything to leave my computer, on-device only mode splits a longer document into several Gemini Nano passes and merges the results. |
| 2:12–2:35 | Tick two checklist items. Click **Watch**, open the **Watchlist** tab (sorted by deadline, "Synced with Cloud Firestore"). Click **Add to calendar**, open the .ics, show the event in Google Calendar. | The checklist is what I actually work from. Watched tenders sync through Cloud Firestore with an anonymous account, and the deadline goes to my calendar with reminders three days and one day before. |
| 2:35–2:50 | Static slide: the routing diagram from the README plus the list: AI Logic hybrid (PREFER_ON_DEVICE, ONLY_ON_DEVICE, ONLY_IN_CLOUD), App Check, Authentication, Firestore, Remote Config. End card: "Tender Lens · open source · Apache-2.0". | Under the hood: Firebase AI Logic hybrid inference, App Check, Authentication, Firestore and Remote Config. Tender Lens. Read the notice, not the boilerplate. |

If you use the alternative line for 0:32–1:02, replace subtitles 5–7 in `subtitles-en.srt` with it.

Word count of the voice-over: about 330 words, which fits 2:50 at a calm pace. If it runs long, cut scene 1:02–1:20 first.

## Thumbnail (optional)

Screenshot of the side panel next to a BZP notice, green pill "On device · Gemini Nano" visible, title text "Polish tenders → bid checklist".
