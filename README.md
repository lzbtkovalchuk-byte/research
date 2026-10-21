# Competitor Funnel Watch

Biweekly report for Skillsta on competitors' Meta ads and web funnels — one HTML report per topic (vocal, drawing), posted to Slack.

## How it runs
1. **Collect** (`.github/workflows/collect.yml`, every other Saturday, no AI):
   - `src/collect_ads.js` — active ads per app from the public Meta Ad Library in the app's geo (set per app in the config); groups ads by funnel link and screenshots one ad per link.
   - `src/walk_funnels.js` — walks each funnel on a 390×844 phone screen with fixed neutral answers, stopping at account creation or the paywall. Full-page screenshots (inner scroll containers are expanded). Popups are captured, closed and the screen behind them captured too. Each funnel gets its own plus-address per run (`name+fw<YYMMDD><app><n>@…`); if a funnel rejects the email or loops back to its start, the reason is recorded.
   - `src/diff.js` — compares with the previous run: ad counts, new/changed/removed funnel links, new/changed/removed screens, and highlight boxes for changed screens (pixel diff). Writes `diff.json` and one `summary.md` for both topics.
2. **Analyse** (Claude scheduled task on Sundays, see `ANALYSIS.md`): reads `summary.md` + only the changed screens, pulls Skillsta funnel conversion from Amplitude, writes `analysis.json` (what changed per app, notes per changed screen, Amplitude, ideas) and pushes. Off-weeks stop early.
3. **Publish** (`.github/workflows/publish.yml`, triggered by that push): builds one `report.html` (vocal + drawing, only what changed, previous and current screens side by side) and posts it to Slack with the "What changed" lines.

## Edit the competitor list
`config/competitors.yaml` — add an app with its Meta page id or link domain, geo and topics.

## Secrets (repo Settings → Secrets and variables → Actions)
| Secret | What |
|---|---|
| `TEST_EMAIL` | Test Gmail address for funnel email gates (plus-addresses are built from it) |
| `GMAIL_APP_PASSWORD` | App password of that Gmail (needs 2-Step Verification); used to read email verification codes over IMAP |
| `TEST_ACCOUNT_PASSWORD` | Password for test accounts on apps marked `allow_signup: true` (Imprint) |
| `PROXY_UK`, `PROXY_US` | Proxy URLs like `http://user:pass@host:port` (US optional: GitHub runners are in the US) |
| `SLACK_BOT_TOKEN` | Slack app token with `files:write`, `chat:write` |
| `SLACK_CHANNEL_ID` | Channel for the report (falls back to `settings.slack_channel` in the config: #skillsta-product-marketing) |

## Manual runs
Actions → *Collect ads & funnels* → Run workflow (optionally `only: smartyme,breeze` to test a few apps).

## Testing the walker locally
`test/site/index.html` is a mock funnel. Serve it with `python3 -m http.server 8765` from `test/site`, then run
`CONFIG=test/config.yaml RUNS_DIR=/tmp/runs node src/walk_funnels.js`. Set `CODE_OVERRIDE=123456` and `TEST_ACCOUNT_PASSWORD=…` to test the code and sign-up steps. Query flags: `code=1` (verification code screen), `signup=1` (create-account screen), `v=2` (a changed question),
`popup=1` (gift popup over the paywall), `tall=1` (paywall scrolling inside a container), `strict=1` / `strict=loop`
(an email without `+` is rejected as already registered; `loop` also sends you back to the start).
