# AI analysis step (run by a Claude scheduled task)

The collection workflow does all browsing and screenshots without AI. This step only reads the
compact summaries and writes two small JSON files, so it stays cheap. Do not browse funnels here.

## Steps

1. Find the latest folder in `data/runs/`. If it already has both `analysis-vocal.json` and
   `analysis-drawing.json`, stop: nothing to do.
2. For each topic (`vocal`, `drawing`) read `data/runs/<date>/summary-<topic>.md`.
   It lists ad counts, funnel link changes, every funnel's structure (screens, email gate, paywall,
   prices, discount, timer, trial, money-back) and which screens are `[CHANGED]` / `[NEW]`.
   Open screenshots (`funnels/<app>/<hash>/NN.webp`) **only** for screens marked CHANGED or NEW,
   and for the Skillsta paywall, if you need to see them. Never open the whole folder.
3. Pull Skillsta's own funnel conversion from Amplitude for the last 14 days (the funnels named in
   `config/competitors.yaml` under `skillsta`). Use the step events of the web quiz: start → key
   question steps → email submitted → paywall viewed → purchase. If the events can't be found,
   leave `amplitude` out and say so in `findings`.
4. Write `data/runs/<date>/analysis-<topic>.json` (schema below), then
   `git add data/runs/<date>/analysis-*.json && git commit -m "Analysis <date>" && git push`.
   The push triggers the Slack publish workflow.

## Schema

```json
{
  "findings": ["3–5 one-sentence findings, most important first: what changed in ads/funnels and why it matters for Skillsta"],
  "comparison_notes": ["2–5 sentences on how Skillsta's funnel structure differs from competitors"],
  "amplitude": {
    "funnel": "Skillsta · Drawing funnel",
    "period": "Sep 29 – Oct 12, 2026",
    "steps": [{ "label": "Quiz start", "pct": 1.0 }, { "label": "Email submitted", "pct": 0.34 }]
  },
  "hypotheses": [
    {
      "priority": 1,
      "stage": "Loader → Email",
      "title": "Short imperative title",
      "seen_in": "Competitor(s) and screen where the pattern appears",
      "change": "What to change in the Skillsta funnel",
      "metric": "The Amplitude step conversion that should move",
      "impact": "Expected direction and rough size, stated as an estimate"
    }
  ]
}
```

Rules: 3–6 hypotheses per topic, ranked by the biggest Skillsta drop-off they address; every
hypothesis must cite a competitor screen seen in this run; no invented numbers — impacts are
labelled as estimates.
