# AI analysis step (run by a Claude scheduled task)

The collection workflow does all browsing, screenshots and change detection without AI (including the
yellow highlight boxes, which come from a pixel diff). This step only reads one compact summary, looks at
the changed screens, and writes one small JSON file, so it stays cheap. Do not browse funnels here.

## Steps

1. Find the latest folder in `data/runs/`. If it already has `analysis.json`, stop: nothing to do.
2. Read `data/runs/<date>/summary.md`. It covers both topics: ad counts, funnel link changes, and per
   funnel the stop reason plus every screen marked `[CHANGED]`, `[NEW]` or `[REMOVED]`, with the
   screenshot paths (previous → current). Open **only** those screenshots. Never open a whole folder.
   If the summary says the previous run is `none`, this is a baseline: write only `headline`,
   `what_changed` (all "First capture.") and `amplitude`.
3. Pull Skillsta's funnel conversion from Amplitude (project 593634) for the last 14 days and the 14 days
   before, one segment per `gp:funnel` value (`new_vocal`, `voice_assessment`, `drawing`).
   Steps: quiz_start → quiz_loading_start → email_submit → payment_view → payment_success, conversion
   window 1 day. If the events can't be found, leave `amplitude` out.
4. Write `data/runs/<date>/analysis.json` (schema below), then
   `git add data/runs/<date>/analysis.json && git commit -m "Analysis <date>" && git push`.
   The push triggers the publish workflow, which builds the report and posts it to Slack.

## Schema

```json
{
  "headline": "One sentence: the most important thing that moved since the last run.",
  "what_changed": {
    "breeze": "Paywall rebuilt: pay-what-you-want trial removed, per-day prices added.",
    "chillio": "No changes."
  },
  "screens": [
    {
      "app": "breeze",
      "funnel": "try-breeze.com/funnel/childhood",
      "n": 40,
      "title": "Pay-what-you-want trial replaced by a plan picker",
      "notes": ["1–3 short sentences, each naming exactly what is different (copy, price, layout, offer)."]
    },
    { "app": "simply-piano", "funnel": "join-piano.hellosimply.com/start", "n": 31, "removed": true, "title": "…", "notes": ["…"] },
    { "app": "copymind", "funnel": "app.copymind.me/welcome-quiz/gender", "n": 36, "prev_n": 38, "title": "…", "notes": ["…"] },
    { "app": "learna", "funnel": "onboarding.ailearna.com/onboarding", "n": 6, "hide": true, "title": "answer options shuffled", "notes": [] }
  ],
  "hide_funnels": [
    { "app": "simply-piano", "funnel": "join-piano.hellosimply.com/start", "reason": "The walk took a different answer branch than last run." }
  ],
  "amplitude": [
    {
      "funnel": "Vocal 2.0", "topic": "vocal", "period": "13–26 Oct", "prev_period": "29 Sep – 12 Oct",
      "steps": [
        { "label": "Quiz start", "n": 24310, "prev_n": 25942 },
        { "label": "Loader", "n": 4280, "prev_n": 4679 },
        { "label": "Email", "n": 488, "prev_n": 522 },
        { "label": "Paywall", "n": 113, "prev_n": 125 },
        { "label": "Purchase", "n": 28, "prev_n": 29 }
      ]
    }
  ],
  "ideas": [
    { "title": "Short imperative title.", "detail": "What to test in the Skillsta funnel and which step it should move.", "seen_in": "Breeze paywall" }
  ]
}
```

Rules:
- `what_changed`: one line for **every** app in the summary (competitors and Skillsta funnels), keyed by app id.
  If nothing changed, write exactly "No changes." Mention a stop reason only if it is new since last run.
- `screens`: one entry per changed, new or popup screen (use the current screen number), and per removed screen
  (previous number, `"removed": true`). For a screen that replaced another, describe it on the new one.
  Notes describe only what is visible on the screenshots. No guesses about intent.
- Hide capture noise instead of describing it: `"hide": true` on a screen entry drops that card (images that had not
  loaded last run, shuffled answer options, screens not reached because the walk stopped earlier). If the walk took a
  different answer branch, hide the whole funnel with `hide_funnels`. Only hide what you checked on the screenshots.
- `prev_n` on a new screen pairs it with that removed previous screen (e.g. a paywall that moved from step 38 to 36).
- `ideas`: at most 3, each tied to a change seen in this run. Skip the section (empty list) if nothing is worth testing.
- No invented numbers.
