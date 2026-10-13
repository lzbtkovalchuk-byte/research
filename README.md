# Competitor Funnel Watch

Biweekly report for Skillsta on competitors' Meta ads and web funnels — one HTML report per topic (vocal, drawing), posted to Slack.

## How it runs
1. **Collect** (`.github/workflows/collect.yml`, every other Monday 06:00 Kyiv, no AI):
   - `src/collect_ads.js` — active ads per app from the public Meta Ad Library, UK geo for Genesis products (Breeze, Learna), US for others; groups ads by funnel link and screenshots one ad per link.
   - `src/walk_funnels.js` — walks each funnel on a 390×844 phone screen with fixed neutral answers and the test email, through a UK/US proxy, stopping at account creation or the paywall.
   - `src/diff.js` — compares with the previous run: ad counts, new/changed/removed funnel links, new/changed/removed screens. Writes `summary-<topic>.md`.
2. **Analyse** (Claude scheduled task, see `ANALYSIS.md`): reads only the summaries + changed screens, pulls Skillsta funnel conversion from Amplitude, writes `analysis-<topic>.json` (findings, comparison, hypotheses) and pushes.
3. **Publish** (`.github/workflows/publish.yml`, triggered by that push): builds `report-vocal.html` and `report-drawing.html` and posts each to Slack.

## Edit the competitor list
`config/competitors.yaml` — add an app with its Meta page id or link domain, geo and topics.

## Secrets (repo Settings → Secrets and variables → Actions)
| Secret | What |
|---|---|
| `TEST_EMAIL` | Email typed into funnel email gates |
| `PROXY_UK`, `PROXY_US` | Proxy URLs like `http://user:pass@host:port` (US optional: GitHub runners are in the US) |
| `SLACK_BOT_TOKEN` | Slack app token with `files:write`, `chat:write` |
| `SLACK_CHANNEL_ID` | Channel for both reports (or `SLACK_CHANNEL_VOCAL` / `SLACK_CHANNEL_DRAWING`) |

## Manual runs
Actions → *Collect ads & funnels* → Run workflow (optionally `only: smartyme,breeze` to test a few apps).
