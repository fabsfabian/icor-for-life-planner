/* ICOR for Life - Planner - the myPKA Cockpit weekly planner, replicated inside Obsidian.
 *
 * Hand-written CommonJS, no build step. Architecture mirrors the
 * cockpit expansion (REFINE/Expansions/mypka-cockpit) with one structural
 * difference: plan state lives in MARKDOWN FRONTMATTER inside the vault
 * ("02 Planner/"), not in a SQLite sidecar. Every synced task is a note, so
 * the AI team can read and move items by editing frontmatter, and the board
 * re-renders live off metadataCache events.
 *
 * Connector posture (inherited from the cockpit contract, connectors/types.js):
 *   - each connector resolves its own secret from plugin settings and emits a
 *     flat, normalized, SECRET-FREE shape; the board never special-cases a source
 *   - connectors NEVER throw upward: every failure degrades to a calm
 *     { ok:false, reason } and the UI renders a quiet notice, never a crash
 *   - calendar is ALWAYS read-only; task sources are read-only in v1
 *     (completing a card is a local strike-through, never a source write)
 *   - calendar events never become per-event notes, but since 0.5.0 the
 *     parsed defs mirror into ONE cache file ("02 Planner/Calendar Events.md")
 *     so the board renders instantly on relaunch (pale + pulsing until the
 *     fresh fetch lands) and the AI team can read the schedule from the vault.
 *     The cache is SECRET-FREE by contract: event data only, never the ICS
 *     feed URL or its private key.
 *   - reconcile semantics: a task absent from a source's FULL open set on a
 *     healthy fetch is genuinely done -> status: done. On a failed fetch the
 *     files stay untouched (never prune on a blip), and since 0.13.0 a
 *     healthy fetch that read only PART of the open set (a page walk stopped
 *     at its cap, a mailbox with more stars than the read takes, a filter
 *     narrowed since the last sync) carries complete:false and reconciles
 *     nothing either: the upserts still run, so the board stays live, but
 *     absence from a window is never read as a completion.
 */
'use strict';

const {
  Plugin, ItemView, PluginSettingTab, Setting, Notice,
  TFile, TFolder, requestUrl, setIcon, normalizePath, Menu, Modal, Platform, moment,
} = require('obsidian');

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const BOARD_VIEW_TYPE = 'icor-for-life-planner-board';
const TRAY_VIEW_TYPE = 'icor-for-life-planner-tray';
// The week note's own tab (0.14.0): the weekly priorities and the daily
// highlights of one ISO week.
const WEEK_VIEW_TYPE = 'icor-for-life-planner-week';
// The version lives in manifest.json only (this.manifest.version at runtime).
// A second copy here drifted one release behind and nothing read it. The
// plugin's own folder likewise comes off the manifest (gitignoreLineFor).

// Connector registry. One object per source, and EVERYTHING the rest of the
// plugin knows about a source is derived from it: the presentation (label,
// folder, svg), whether a credential is present (`configured`), how its open
// set is fetched (`fetchOpen`), whether a completion can cross to it
// (`setClosed`), whether note edits can flow back (`pushFields`), and which
// platforms it runs on. Adding a source is adding one entry here plus a
// settings section; no list elsewhere needs to learn about it.
//
// `kind`: 'local' (nothing to fetch, nothing to write), 'task' (fetched into
// per-item notes, reconciled, writable), 'calendar' (fetched into the one
// cache note, always read-only).
//
// The svg paths are the verified single-path monochrome marks from the cockpit
// (SourceMark.tsx, fetched from simple-icons 2026-06-02).
const trimmed = (v) => String(v == null ? '' : v).trim();
const CONNECTORS = {
  // 2026-08-30: manual items. No connector, no credential, no write-back target.
  // It is a first-class source so the board, the tray, the drag logic and the
  // card menu treat a hand-written task exactly like a synced one; everything
  // that would reach outward is gated on SYNCED_SOURCES, never on a negation
  // of 'manual', so a future local source inherits the same protection.
  manual: {
    id: 'manual', label: 'Manual', folder: 'Manual', kind: 'local',
    // A pencil, not a brand mark: the meta row's job is to say where this came
    // from, and "you wrote it" is the answer.
    svg: 'M2 22l1.5-5.5L14.9 5.1l4 4L7.5 20.5 2 22zM16.3 3.7l1.4-1.4a1.9 1.9 0 0 1 2.7 0l1.3 1.3a1.9 1.9 0 0 1 0 2.7l-1.4 1.4-4-4z',
    // Always configured: there is nothing to configure.
    configured: () => true,
    fetchOpen: null, setClosed: null, pushFields: null, probeGone: null,
    platforms: ['desktop', 'mobile'],
  },
  todoist: {
    id: 'todoist', label: 'Todoist', folder: 'Todoist', kind: 'task',
    configured: (s) => !!trimmed(s.todoistToken),
    fetchOpen: (s, deps) => todoistFetchOpen(s, deps),
    setClosed: (s, item, closed) => todoistSetClosed(trimmed(s.todoistToken), item.id, closed),
    pushFields: (s, item, pushes) => todoistPushFields(trimmed(s.todoistToken), item.id, pushes),
    probeGone: (s, item, deps) => todoistProbeGone(trimmed(s.todoistToken), item.id, deps),
    doneNotice: (closed) => (closed ? 'Planner: closed in Todoist.' : 'Planner: reopened in Todoist.'),
    platforms: ['desktop', 'mobile'],
    svg: 'M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z',
  },
  clickup: {
    id: 'clickup', label: 'ClickUp', folder: 'ClickUp', kind: 'task',
    configured: (s) => !!trimmed(s.clickupToken),
    fetchOpen: (s, deps) => clickupFetchOpen(s, deps),
    setClosed: (s, item, closed) => clickupSetClosed(trimmed(s.clickupToken), item.id, item.listId, closed),
    pushFields: (s, item, pushes) => clickupPushFields(trimmed(s.clickupToken), item.id, pushes),
    probeGone: (s, item, deps) => clickupProbeGone(trimmed(s.clickupToken), item.id, deps),
    doneNotice: (closed) => (closed ? 'Planner: closed in ClickUp.' : 'Planner: reopened in ClickUp.'),
    platforms: ['desktop', 'mobile'],
    svg: 'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z',
  },
  email: {
    id: 'email', label: 'Email', folder: 'Email', kind: 'task',
    configured: (s) => !!(trimmed(s.imapHost) && trimmed(s.imapUser) && trimmed(s.imapPassword)),
    fetchOpen: (s, deps) => emailFetchStarred(s, deps),
    // The star flag is the one write the mailbox ever sees; closing = unstar.
    setClosed: async (s, item, closed, deps) => {
      try {
        await imapSetStarredRaw(imapTransportOptions(s), trimmed(s.imapUser), trimmed(s.imapPassword), item.id, !closed, deps);
      } catch (e) {
        if (/tls unavailable/i.test((e && e.message) || '')) {
          throw new Error('the email star can only be written from the desktop app');
        }
        throw e;
      }
    },
    // Email takes the star flag only, never field writes.
    pushFields: null,
    probeGone: (s, item, deps) => emailProbeGone(s, item, deps),
    doneNotice: (closed) => (closed ? 'Planner: unstarred the email.' : 'Planner: starred the email again.'),
    // IMAP needs a raw TLS socket, which the mobile app does not have.
    platforms: ['desktop'],
    // Lucide-style mail outline drawn as a filled-stroke substitute is wrong for a
    // fill-rendered mark, so email uses a simple filled envelope path instead.
    svg: 'M1.5 4.5h21a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 0 18V6a1.5 1.5 0 0 1 1.5-1.5zm10.5 8.25L2.25 6.375v11.25h19.5V6.375L12 12.75zM3.375 6l8.625 5.625L20.625 6H3.375z',
  },
  // Outlook (2026-09-06): flagged mail through Microsoft Graph, signed in
  // with the member's OWN Entra app registration (the client id is theirs,
  // the tokens are theirs, nothing passes through myICOR). The one write is
  // the flag status of a message, behind Complete on source, and it needs
  // the Mail.ReadWrite permission the sign-in asks for only once that
  // toggle is on. Runs on desktop and mobile: every call is requestUrl and
  // the redirect is the obsidian:// protocol handler, one path for both.
  outlook: {
    id: 'outlook', label: 'Outlook', folder: 'Outlook', kind: 'task',
    configured: (s) => outlookSignedIn(s),
    fetchOpen: (s, deps) => outlookFetchOpen(s, deps),
    setClosed: (s, item, closed, deps) => outlookSetClosed(s, item, closed, deps),
    // The flag is the one thing the mailbox takes; never field writes.
    pushFields: null,
    probeGone: (s, item, deps) => outlookProbeGone(s, item, deps),
    doneNotice: (closed) => (closed ? 'Planner: marked the email complete in Outlook.' : 'Planner: flagged the email again in Outlook.'),
    platforms: ['desktop', 'mobile'],
    // A flag, not a brand mark: a card from here IS a flagged email, and the
    // Microsoft marks are not in the icon set this file draws from.
    svg: 'M4 2h2v20H4V2zm3 1h12.5l-3.4 4.75L19.5 12.5H7V3z',
  },
  calendar: {
    id: 'calendar', label: 'Calendar', folder: null, kind: 'calendar', // no per-event notes; one cache file
    // A calendar connector carries FEEDS, not one credential: feeds(settings)
    // lists the feeds of its kind in settings order, ready(feed, settings)
    // says whether one of them can be fetched (an address here, a sign-in
    // for the Graph one), and fetchFeed(feed, settings, deps) fetches it.
    // calendarFetchAll walks every connector of kind 'calendar'; the feed's
    // `kind` names which connector owns it (calendarFeedConnector).
    feedKind: 'ics',
    feeds: (s) => calendarFeeds(s).filter((f) => f.kind === 'ics'),
    ready: (feed) => !!feedUrl(feed),
    configured: (s) => calendarFeedConfigured(s),
    fetchFeed: (feed) => calendarFetchFeed(feed),
    fetchOpen: null, setClosed: null, pushFields: null,
    platforms: ['desktop', 'mobile'],
    svg: 'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
  },
  // The Outlook calendar (2026-09-06): one feed of kind 'graph', created on
  // sign-in, fetched through calendarView, which already returns one row per
  // occurrence, so its defs are marked expanded and never enter the
  // recurrence expansion. Read-only like every calendar.
  'outlook-calendar': {
    id: 'outlook-calendar', label: 'Outlook calendar', folder: null, kind: 'calendar',
    feedKind: 'graph',
    feeds: (s) => calendarFeeds(s).filter((f) => f.kind === 'graph'),
    ready: (feed, s) => outlookSignedIn(s || {}),
    configured: (s) => enabledCalendarFeeds(s).some((f) => f.kind === 'graph'),
    fetchFeed: (feed, s, deps) => outlookCalendarFetchFeed(feed, s, deps),
    fetchOpen: null, setClosed: null, pushFields: null,
    platforms: ['desktop', 'mobile'],
    svg: 'M4 2h2v20H4V2zm3 1h12.5l-3.4 4.75L19.5 12.5H7V3z',
  },
};

// The presentation view of the registry (id, label, folder, svg): what the
// board, the tray and the card menu read. Derived, never hand-kept.
const SOURCES = Object.fromEntries(Object.values(CONNECTORS).map((c) => [
  c.id, { id: c.id, label: c.label, folder: c.folder, svg: c.svg },
]));

// The task sources that have a connector: they own a credential, they are
// fetched, they reconcile, and they can be written back to. MANUAL is
// absent by construction (kind 'local'), and every outward-facing decision
// in the plugin asks this list rather than testing for 'manual' by hand.
const SYNCED_SOURCES = Object.values(CONNECTORS).filter((c) => c.kind === 'task' && c.fetchOpen).map((c) => c.id);
const MANUAL_SOURCE = 'manual';
// Everything that is fetched at all, the calendar included: what the sync
// scheduler asks before it starts a run.
const FETCHED_SOURCES = Object.values(CONNECTORS).filter((c) => c.kind !== 'local').map((c) => c.id);
// The calendar connectors: each carries feeds, and a sync fetches every
// enabled feed of every one of them (calendarFetchAll).
const CALENDAR_SOURCES = Object.values(CONNECTORS).filter((c) => c.kind === 'calendar').map((c) => c.id);
// Tray render order. Manual leads: it is the one section that works on a vault
// with no keys at all, and the add control lives in it.
const TASK_SOURCES = [MANUAL_SOURCE, ...SYNCED_SOURCES];

function isSyncedSource(source) { return SYNCED_SOURCES.includes(source); }
// Can an edit in the note be pushed outward? Exactly the sources whose
// connector accepts field writes; email takes the star flag only; manual has
// nowhere to go.
function canPushToSource(source) { return !!(CONNECTORS[source] && CONNECTORS[source].pushFields); }
// Can checking the card close something at the source? Exactly the sources
// whose connector can close.
function canCompleteOnSource(source) { return !!(CONNECTORS[source] && CONNECTORS[source].setClosed); }

// Is this source's credential actually present? The ONE authority on the
// question, so the tray, the board notice and the sync scheduler can never
// disagree about whether a source exists. Manual is always configured: there
// is nothing to configure.
//
// Each connector's `configured` mirrors, field for field, the no-token guard
// at the top of its fetch (todoistFetchOpen, clickupFetchOpen,
// emailFetchStarred, calendarFetchDefs). The fetch guard decides whether a
// FETCH runs; this decides what the UI is allowed to claim before any fetch
// has run. They must agree, and the test suite asserts they do.
function sourceConfigured(settings, source) {
  const c = CONNECTORS[source];
  return c ? !!c.configured(settings || {}) : false;
}

// The env file the secrets can live in instead of Obsidian's keychain
// (0.12.0): vault-relative, the AI team's own key file by default.
const DEFAULT_ENV_FILE_PATH = '06 AI Team/AI Team Knowledge/.env';

const DEFAULT_SETTINGS = {
  // Where the planner lives in the vault: the room folder. Every path the
  // plugin reads or writes derives from this one value (plannerPaths); a
  // renamed room is found on boot (detectPlannerFolder) instead of being
  // recreated empty beside the renamed one.
  plannerFolder: '02 Planner',
  todoistToken: '',
  clickupToken: '',
  clickupTeamId: '',
  imapHost: 'imap.gmail.com',
  imapUser: '',
  imapPassword: '',
  // Transport (Proton Bridge and other local or unusual hosts). The defaults
  // are exactly what every earlier release did: 993, implicit TLS, the
  // certificate verified. The self-signed allowance is honoured for a
  // loopback host only, and that rule is enforced in the transport code,
  // not just in the settings tab.
  imapPort: 993,
  imapSecurity: 'tls',
  imapAllowSelfSigned: false,
  // Outlook through the member's own Microsoft app registration
  // (2026-09-06). The client id is a public-client GUID, not a secret; the
  // tenant is the login segment (common, organizations, consumers); the
  // four token fields are secret-typed and live in the store on Obsidian
  // 1.11.4 or newer (SECRET_FIELDS); outlookScopes records what the last
  // sign-in granted, so the plugin knows whether a flag may be written
  // without asking Microsoft first.
  outlookClientId: '',
  outlookTenant: 'common',
  outlookRefreshToken: '',
  outlookAccessToken: '',
  outlookExpiresAt: '',
  outlookAccount: '',
  outlookScopes: '',
  // The calendars (v0.8.0): one entry per feed,
  //   { id, name, url, color: 1..4, enabled, kind: 'ics' }.
  // The single icsUrl of earlier releases becomes the first entry on load
  // (migrateCalendarSettings) and is read nowhere else after that. The
  // colour is an index into the four lenses styles.css declares; the user
  // picks a swatch, never a hex, so no colour value lives in data.json.
  calendars: [],
  // Set the first time a secret is written to Obsidian's secret storage
  // (0.9.0). Never a secret itself; it lets an older Obsidian opening this
  // vault say why its fields are empty (secretsNoteText).
  secretsInStore: false,
  // Where the secrets live (0.12.0): 'secret-storage' (Obsidian's keychain,
  // the default wherever Obsidian offers it) or 'env-file' (KEY=value lines
  // in the file at envFilePath, inside the vault). The selected backend is
  // the only one read at runtime; choosing the other moves nothing by
  // itself, the settings tab has a Move button per key. On an Obsidian
  // without the store, 'secret-storage' still means data.json, as in every
  // release since 0.9.0, until the env file is chosen.
  secretsBackend: 'secret-storage',
  envFilePath: DEFAULT_ENV_FILE_PATH,
  syncMinutes: 10,
  showWeekend: false,
  // How dates and times are shown (2026-09-07): moment tokens, blank by
  // default. Blank follows Obsidian's Templates setting; when that is blank
  // too the board draws the compact shapes of every earlier release. See
  // displayFormats. Never applied to an input or to anything stored.
  dateFormat: '',
  timeFormat: '',
  splitTime: '13:00',
  lunchEnabled: false,
  lunchStart: '12:30',
  lunchEnd: '13:30',
  dayStart: '08:00',
  dayEnd: '18:00',
  // two-way sync (v0.2.0). completeOnSource is the user's explicit arm switch:
  // checking a card also closes the task at the source / unstars the mail.
  completeOnSource: false,
  // pushEdits: due / priority / description edits in the note flow back to
  // Todoist and ClickUp. Baseline-guarded: only fields the USER changed since
  // the last sync are pushed, so a fresh install never mass-writes.
  pushEdits: true,
  // The next-event strip above the sidebar logo (0.5.0 put it in the
  // ribbon; 0.9.1 moved it out, see setupNextBadge). Desktop and mobile.
  showNextBadge: true,
  // Where a recurring task's card lands when its due date moves on to the
  // next occurrence: 'move' puts it on the new due day (keeping its half),
  // 'drop' sends it back to the tray. See syncCompletionPlan.
  recurringAdvance: 'move',
  // Routines (2026-09-04): blocks of steps at a time of day, one note each
  // under <planner folder>/Routines/. The defaults are what a NEW routine
  // starts with; each routine keeps its own times and weekdays in its note.
  routinesEnabled: true,
  routineDefaults: {
    morning: { start: '06:30', end: '07:30' },
    afternoon: { start: '13:00', end: '13:30' },
    evening: { start: '21:00', end: '21:45' },
  },
  routineWeekdaysDefault: ['mon', 'tue', 'wed', 'thu', 'fri'],
  // Subtasks (2026-09-04). ClickUp returns subtasks only when asked, and an
  // existing board must not flood on upgrade, so the ask is off by default.
  // subtaskChecklist draws the "n of m subtasks" row on a parent card.
  clickupIncludeSubtasks: false,
  subtaskChecklist: true,
  // Habits (2026-09-04; planner-owned since 0.10.0): one note per habit
  // under <planner folder>/Habits/, read for the all-day block under each
  // day and written for the check-in row and the schedule. The My Life
  // Habits room is read only to import from and to link to; up to 0.9.2
  // the setting was called habitsFolder and named the room the planner
  // read, and it is carried over on load (migrateHabitSettings).
  habitsEnabled: true,
  habitsImportFolder: '04 Inner World/My Life/Habits',
  habitStreaks: true,
};

/* ========================================================================== *
 * Secret vault (0.9.0) - where the credentials live.
 *
 * API facts, verified against obsidian.d.ts (obsidian-api, master, fetched
 * 2026-09-06), not recalled from memory:
 *   - `app.secretStorage: SecretStorage`, tagged @since 1.11.4. The class
 *     extends Events and declares exactly three methods, all SYNCHRONOUS:
 *       setSecret(id: string, secret: string): void   (throws on a bad id)
 *       getSecret(id: string): string | null
 *       listSecrets(): string[]
 *     There is NO delete method in the typings. An entry is cleared by
 *     writing the empty string; this layer treats '' and null alike.
 *   - The id rule, from the setSecret doc: "Lowercase alphanumeric ID with
 *     optional dashes". A colon is not allowed, so keys are prefixed with
 *     `icor-for-life-planner-` (dash), never `icor-for-life-planner:`.
 *   - The namespace is GLOBAL, not per plugin: listSecrets() returns every
 *     id in the store, and the SettingSecretControl added in 1.13.2 persists
 *     a key reference any plugin could name. Hence the prefix on every key,
 *     and `secretKey` sanitising whatever it is handed into that alphabet.
 *   - Where the data goes, per Obsidian's docs: "stored in local storage,
 *     keyed to the specific vault". Outside the vault folder and outside
 *     data.json, desktop and mobile alike, so it is never synced or
 *     committed with the notes. It is not a system keyring and the plugin
 *     never calls it one. Nor does it depend on the backing: it feature-detects
 *     the two methods it uses and falls back to data.json, so minAppVersion
 *     stays where it was.
 *   - `SecretComponent` (a masked input bound to the store) is 1.11.1+ and
 *     is not used here: the settings tab keeps its own password inputs so
 *     the same rows work in both modes.
 *
 * The shape. `SecretVault` wraps the store (mode 'store') or nothing
 * (mode 'data-json'). The settings object on disk carries a secret ONLY in
 * data-json mode. In store mode `migrateSecrets` moves each one out on
 * load, blanks its field, and every consumer that needs a credential
 * receives `withSecrets(settings)`: a shallow copy with the fields and the
 * feed addresses filled back in. The connectors, the fetchers and
 * `sourceConfigured` stay pure and keep reading plain fields; they are
 * simply never handed the raw settings any more (gated by the test suite).
 * ========================================================================== */

const SECRET_KEY_PREFIX = 'icor-for-life-planner-';
// Settings field -> key suffix. The four Outlook fields are one sign-in: the
// refresh token (the credential), the access token with its expiry (a
// short-lived cache, refreshed from the first), and the account name shown
// in settings. Signing out clears all four.
const SECRET_FIELDS = {
  todoistToken: 'todoist-token',
  clickupToken: 'clickup-token',
  imapPassword: 'imap-password',
  outlookRefreshToken: 'outlook-refresh-token',
  outlookAccessToken: 'outlook-access-token',
  outlookExpiresAt: 'outlook-expires-at',
  outlookAccount: 'outlook-account',
};
const SECRET_FIELD_NAMES = Object.keys(SECRET_FIELDS);

// A store id in the alphabet the API accepts: lowercase, digits, dashes.
function secretKey(suffix) {
  const slug = String(suffix == null ? '' : suffix).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return SECRET_KEY_PREFIX + (slug || 'unnamed');
}
function fieldSecretKey(field) {
  if (!SECRET_FIELDS[field]) throw new Error(`not a secret field: ${field}`);
  return secretKey(SECRET_FIELDS[field]);
}
function calendarSecretKey(feedId) { return secretKey(`calendar-${feedId}`); }

// Feature detection: the two methods this layer calls, and nothing else.
function secretStorageUsable(storage) {
  return !!(storage && typeof storage.getSecret === 'function' && typeof storage.setSecret === 'function');
}

class SecretVault {
  // `storage` is Obsidian's store (feature-detected). `env` is an
  // EnvFileStore (0.12.0); when it is given it IS the backend and the store
  // is ignored, because the selected backend is the only one read. There is
  // no fallback from one to the other: a fallback hides a misconfiguration.
  constructor(storage, env) {
    this.env = secretStorageUsable(env) ? env : null;
    this.storage = !this.env && secretStorageUsable(storage) ? storage : null;
  }
  get mode() { return this.env ? 'env-file' : (this.storage ? 'store' : 'data-json'); }
  // The settings value this vault answers to, or 'data-json' when neither
  // backend is there (an older Obsidian with the default setting).
  get backend() { return this.env ? 'env-file' : (this.storage ? 'secret-storage' : 'data-json'); }
  available() { return !!(this.env || this.storage); }
  target() { return this.env || this.storage; }
  // true when a write is on disk by the time set() returns (the store, or
  // nothing). The env file writes through a queue, so there it is false and
  // only put() can say that the value is held.
  get immediate() { return !this.env; }
  // '' when absent, unreadable, or cleared; never null, never a throw.
  get(key) {
    const t = this.target();
    if (!t) return '';
    try { return trimmed(t.getSecret(key)); } catch { return ''; }
  }
  // true when the backend holds the value now, on disk. false means the
  // caller must keep the value where it was: a blank is written to
  // data.json only after the backend accepted the secret. The env file
  // cannot answer that synchronously, so for a value it returns false and
  // writes nothing (the caller keeps it; put() moves it once the write has
  // landed). A clear still queues there: no caller blanks anything on its
  // answer, and a clear that fails leaves an old line, never a lost key.
  set(key, value) {
    const t = this.target();
    if (!t) return false;
    const v = trimmed(value);
    if (!v) return this.delete(key);
    if (!this.immediate) return false;
    try { t.setSecret(key, v); return true; } catch { return false; }
  }
  // The same, awaited: resolves true only once the backend holds the value
  // (for the env file, once its own write reached disk without an error).
  // Never rejects.
  async put(key, value) {
    const t = this.target();
    if (!t) return false;
    const v = trimmed(value);
    if (!v) return this.delete(key);
    if (this.immediate) return this.set(key, v);
    try { return (await t.setSecret(key, v)) === true; } catch { return false; }
  }
  delete(key) {
    const t = this.target();
    if (!t) return false;
    if (this.get(key) === '') return true;
    try { t.setSecret(key, ''); return true; } catch { return false; }
  }
  // Resolves once every write the env file has queued is on disk. A store
  // write is synchronous, so there the promise is already settled.
  settle() { return this.env && typeof this.env.settle === 'function' ? this.env.settle() : Promise.resolve(); }
}

// The address of one feed: the entry's own url when it has one (data-json
// mode, or a feed already resolved by withSecrets), else the store's.
// Every reader of a feed address goes through here.
function feedUrl(feed, vault) {
  const v = trimmed(feed && feed.url);
  if (v || !vault || !vault.available() || !feed || !feed.id) return v;
  return vault.get(calendarSecretKey(feed.id));
}
function setFeedUrl(feed, value, vault) {
  const v = trimmed(value);
  if (feed && feed.id && vault && vault.available() && vault.set(calendarSecretKey(feed.id), v)) {
    feed.url = '';
    return true;
  }
  feed.url = v;
  return false;
}
function forgetFeedSecret(feed, vault) {
  if (feed && feed.id && vault) vault.delete(calendarSecretKey(feed.id));
}

// One secret-typed settings field, read and written through the layer.
function readSecret(settings, vault, field) {
  const v = trimmed(settings && settings[field]);
  if (v || !vault || !vault.available()) return v;
  return vault.get(fieldSecretKey(field));
}
// Returns true when the value lives in the store now (the field is blank).
// In env-file mode a value stays in the field (set() answers false there)
// until persistSettings moves it through migrateSecretsSettled; the caller
// that needs the move now asks for a save.
function writeSecret(settings, vault, field, value) {
  const v = trimmed(value);
  if (vault && vault.available() && vault.set(fieldSecretKey(field), v)) {
    settings[field] = '';
    if (v) settings.secretsInStore = true;
    return true;
  }
  settings[field] = v;
  return false;
}

// Move every secret the settings object still carries into the store, IN
// PLACE (the settings tab holds references into `calendars`, so entries are
// blanked, never replaced). The stale `icsUrl` of releases before 0.8.0 is
// dropped in both modes: the calendar migration has already turned it into
// the first feed, and a second copy of a credential is one more to leak.
// Returns { changed, moved }. Idempotent: a second call moves nothing.
function migrateSecrets(settings, vault) {
  const s = settings || {};
  const moved = [];
  let changed = false;
  if (Object.prototype.hasOwnProperty.call(s, 'icsUrl')) { delete s.icsUrl; changed = true; }
  if (!vault || !vault.available()) return { changed, moved };
  for (const field of SECRET_FIELD_NAMES) {
    const v = trimmed(s[field]);
    if (!v) continue;
    if (!vault.set(fieldSecretKey(field), v)) continue;
    s[field] = '';
    moved.push(field);
    changed = true;
  }
  if (Array.isArray(s.calendars)) {
    s.calendars.forEach((f, i) => {
      if (!f || typeof f !== 'object') return;
      const v = trimmed(f.url);
      if (!v) return;
      if (!f.id) f.id = normalizeCalendarFeed(f, i).id; // the key needs a stable id
      if (!vault.set(calendarSecretKey(f.id), v)) return;
      f.url = '';
      moved.push(`calendar:${f.id}`);
      changed = true;
    });
  }
  if (moved.length && s.secretsInStore !== true) { s.secretsInStore = true; changed = true; }
  return { changed, moved };
}

// Whether the settings object still carries a secret in any field or feed.
function settingsHoldSecrets(settings) {
  const s = settings || {};
  if (SECRET_FIELD_NAMES.some((field) => trimmed(s[field]))) return true;
  // Through the accessor: with no vault given it answers the entry's own address.
  return Array.isArray(s.calendars) && s.calendars.some((f) => f && typeof f === 'object' && !!feedUrl(f));
}

// migrateSecrets, then for a backend that cannot confirm a write
// synchronously (the env file) every value still in the settings goes
// through put(), and its field is blanked only once that write is on disk.
// A value whose write failed stays where it was, so a save that follows
// writes it back to data.json rather than nowhere. Same result shape.
async function migrateSecretsSettled(settings, vault) {
  const r = migrateSecrets(settings, vault);
  if (!vault || !vault.available() || vault.immediate) return r;
  const s = settings || {};
  const slots = [];
  for (const field of SECRET_FIELD_NAMES) {
    const v = trimmed(s[field]);
    if (v) slots.push({ obj: s, prop: field, name: field, key: fieldSecretKey(field), value: v });
  }
  if (Array.isArray(s.calendars)) {
    s.calendars.forEach((f, i) => {
      if (!f || typeof f !== 'object') return;
      const v = trimmed(f.url);
      if (!v) return;
      if (!f.id) f.id = normalizeCalendarFeed(f, i).id;
      slots.push({ obj: f, prop: 'url', name: `calendar:${f.id}`, key: calendarSecretKey(f.id), value: v });
    });
  }
  // Every write queued first, then each awaited in order: the queue lands
  // them in that order, and each slot answers for its own write only.
  const writes = slots.map((slot) => vault.put(slot.key, slot.value));
  for (let i = 0; i < slots.length; i++) {
    if (!(await writes[i])) continue;
    slots[i].obj[slots[i].prop] = '';
    r.moved.push(slots[i].name);
    r.changed = true;
  }
  if (r.moved.length && s.secretsInStore !== true) { s.secretsInStore = true; r.changed = true; }
  return r;
}

// The settings with every secret filled back in: a shallow copy, so the
// `_shadow` map inside is the live one. In data-json mode the copy is the
// settings as they are. Only ever handed to readers; never saved.
function withSecrets(settings, vault) {
  const s = Object.assign({}, settings || {});
  // Hidden links back to what the copy was made from, for the one writer
  // that runs inside a connector (a rotated Outlook refresh token,
  // saveOutlookTokens): a write must land in the store, or in the settings
  // that will be saved, never on this throwaway copy. Non-enumerable, so
  // neither JSON nor a further copy carries them.
  Object.defineProperty(s, '_live', { value: settings || null, enumerable: false });
  Object.defineProperty(s, '_vault', { value: vault || null, enumerable: false });
  if (!vault || !vault.available()) return s;
  for (const field of SECRET_FIELD_NAMES) {
    if (trimmed(s[field])) continue;
    const v = vault.get(fieldSecretKey(field));
    if (v) s[field] = v;
  }
  s.calendars = calendarFeeds(s).map((f) => Object.assign({}, f, { url: feedUrl(f, vault) }));
  return s;
}

// What the plugin does with the bytes loadData returned, in order: the
// calendar migration (icsUrl -> calendars[0]) on the raw object BEFORE the
// defaults are laid under it, so the default `calendars: []` never masks
// the old single-URL shape; then the secret migration; then the defaults.
// `changed` says whether data.json must be written back once.
// 0.10.0: the habits moved into the planner folder and the old setting,
// the My Life room the planner used to read, became the import folder.
// The value is carried over once and the old key dropped; a data.json that
// already has the new key keeps it. Same object back when there is nothing
// to do, so `changed` stays honest.
function migrateHabitSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  if (!Object.prototype.hasOwnProperty.call(s, 'habitsFolder')) return s;
  const out = Object.assign({}, s);
  if (out.habitsImportFolder == null && typeof out.habitsFolder === 'string') out.habitsImportFolder = out.habitsFolder;
  delete out.habitsFolder;
  return out;
}

function adoptSettings(loaded, vault) {
  const raw = loaded && typeof loaded === 'object' ? loaded : {};
  const migrated = migrateHabitSettings(migrateCalendarSettings(raw));
  const secrets = migrateSecrets(migrated, vault);
  // A backend that takes a value only through put() (the env file) leaves
  // it in place here; the write-back that follows moves it settled.
  const pending = !!(vault && vault.available() && !vault.immediate && settingsHoldSecrets(migrated));
  const settings = Object.assign({}, DEFAULT_SETTINGS, migrated);
  return { settings, changed: migrated !== raw || secrets.changed || pending, moved: secrets.moved, pending };
}

// The settings tab's one line on where the secrets are. The store is named
// the way Obsidian names it, "Obsidian's keychain", and the member is
// pointed at the section by its path (Settings, General, Keychain). It is
// never called the operating system's own store, because it is not one: an
// encrypted blob per vault on desktop, a per-device native store on mobile,
// in both cases outside the vault and outside data.json.
function secretsNoteText(mode, secretsInStore, envPath) {
  if (mode === 'env-file') return `Secrets are stored in the env file at ${trimmed(envPath) || DEFAULT_ENV_FILE_PATH} (inside the vault, one KEY=value line each). Only that file is read while it is selected; Obsidian's keychain is not consulted.`;
  if (mode === 'store') return 'Secrets are stored in Obsidian\'s keychain (Settings, General, Keychain): outside the vault and outside data.json, so they are never synced or committed with your notes.';
  const base = 'Secrets are stored in this plugin\'s data.json (Obsidian 1.11.4 or newer keeps them in Obsidian\'s keychain, outside the vault; on this Obsidian, choose the env file above to move them out of data.json).';
  if (secretsInStore) {
    return `${base} A newer Obsidian moved this vault's secrets into its keychain; this version cannot read them, so paste them again here or update Obsidian.`;
  }
  return base;
}

/* ---- the env file backend (0.12.0) ---------------------------------------
 * KEY=value lines in one file inside the vault, read and written through
 * the vault adapter (desktop and mobile alike; a dotfile is fine, the
 * adapter does not care what the file explorer hides). The parser: blank
 * lines and `#` comments skipped, an `export ` prefix tolerated, the key
 * [A-Za-z_][A-Za-z0-9_]*, the value everything after the first `=` with
 * the surrounding whitespace and one pair of matching quotes dropped, no
 * interpolation, and the FIRST occurrence of a key wins (which is also the
 * line the writer edits, so reader and writer agree). The writer changes
 * exactly one line, or appends one; every other byte of the file comes back
 * as it went in, CRLF included. A value is never logged, never put in a
 * Notice, never part of an error sentence.
 */
const SECRETS_BACKENDS = ['secret-storage', 'env-file'];
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_LINE_RE = /^(\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const BACKEND_LABELS = { 'secret-storage': 'Obsidian\'s keychain', 'env-file': 'the env file', 'data-json': 'this plugin\'s data.json' };

function normalizeSecretsBackend(v) { return v === 'env-file' ? 'env-file' : 'secret-storage'; }
function secretsBackendLabel(backend) { return BACKEND_LABELS[backend] || BACKEND_LABELS['data-json']; }

// A vault-relative file path: forward slashes, no leading slash, no `..`.
function normalizeEnvFilePath(v) {
  const raw = trimmed(v).replace(/\\/g, '/');
  if (!raw) return { ok: false, path: '', error: `Enter a path inside the vault, for example ${DEFAULT_ENV_FILE_PATH}.` };
  if (/^([a-zA-Z]:)?\//.test(raw) || raw.startsWith('~')) return { ok: false, path: '', error: 'The path is relative to the vault root, not an absolute path.' };
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return { ok: false, path: '', error: 'The path must stay inside the vault (no "..").' };
  if (!parts.length) return { ok: false, path: '', error: 'Enter a file name, not a folder.' };
  return { ok: true, path: parts.join('/'), error: '' };
}

// The env key for a store id: the suffix after the plugin prefix in upper
// snake case (todoist-token becomes TODOIST_TOKEN). A calendar feed's
// address keeps a PLANNER_ prefix, because the feed id is the member's own.
function envKeyFor(secretId) {
  const id = String(secretId == null ? '' : secretId);
  const suffix = id.startsWith(SECRET_KEY_PREFIX) ? id.slice(SECRET_KEY_PREFIX.length) : id;
  const snake = suffix.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const key = suffix.startsWith('calendar-') ? `PLANNER_${snake}` : snake;
  if (!ENV_KEY_RE.test(key)) throw new Error('not an env key');
  return key;
}

function parseEnvText(text) {
  const out = {};
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = ENV_LINE_RE.exec(line);
    if (!m) continue;
    const key = m[2];
    if (Object.prototype.hasOwnProperty.call(out, key)) continue;
    let v = m[3].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === '\'') && v[v.length - 1] === v[0]) v = v.slice(1, -1);
    out[key] = v;
  }
  return out;
}

// The line the plugin writes: bare, unquoted; a value cannot carry a line break.
function envLineFor(key, value) {
  if (!ENV_KEY_RE.test(String(key))) throw new Error('not an env key');
  return `${key}=${String(value == null ? '' : value).replace(/[\r\n]+/g, '')}`;
}

// The file with `key` set to `value`: the first matching line rewritten
// (its own line ending kept), else one line appended, after a separator
// when the file does not end in one. Every byte before the change is the
// byte that came in. The same text back when nothing has to change: the
// line already reads so, or the key is absent and the value is empty (an
// empty value is never appended; clearing a present key leaves `KEY=`).
function upsertEnvLine(text, key, value) {
  const src = String(text == null ? '' : text);
  const line = envLineFor(key, value);
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cr = lines[i].endsWith('\r');
    const bare = cr ? lines[i].slice(0, -1) : lines[i];
    const m = ENV_LINE_RE.exec(bare);
    if (!m || m[2] !== key) continue;
    if (bare === line) return src;
    lines[i] = line + (cr ? '\r' : '');
    return lines.join('\n');
  }
  if (String(value == null ? '' : value) === '') return src;
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  return src + (src === '' || src.endsWith('\n') ? '' : nl) + line + nl;
}

// A failure sentence that cannot carry a value: the error's message only.
function envErrorText(e) { return trimmed(e && e.message ? e.message : e) || 'unknown error'; }

// The env file seen through the store interface (getSecret, setSecret,
// listSecrets), so SecretVault wraps it exactly like Obsidian's store. Reads
// are from memory (load once, reload before a sync and before the settings
// tab draws); a write lands in memory at once and on disk through one
// queue, each write reading the file again first so lines another tool
// wrote meanwhile survive. setSecret returns that write's own promise
// (true landed, false failed, never a throw), and a failed write takes the
// value back out of memory, so the store never claims what the disk
// refused. `error` is the last read or write failure.
class EnvFileStore {
  constructor(adapter, path) {
    this.adapter = adapter || null;
    this.path = trimmed(path) || DEFAULT_ENV_FILE_PATH;
    this.values = {};
    this.loaded = false;
    this.exists = false;
    this.error = '';
    this._chain = Promise.resolve();
    this._latest = {}; // key -> the most recent write of it, for the revert
  }
  async _present() {
    if (!this.adapter) return false;
    if (typeof this.adapter.exists !== 'function') return true;
    try { return !!(await this.adapter.exists(this.path)); } catch { return true; }
  }
  // Read the file into memory, after any queued write has landed. A missing
  // file is an empty store, not an error; an unreadable one is an error and
  // an empty store (never a stale one).
  async load() {
    await this.settle();
    let text = '';
    this.exists = false;
    this.error = '';
    try {
      if (await this._present()) { text = await this.adapter.read(this.path); this.exists = true; }
    } catch (e) { this.error = envErrorText(e); text = ''; }
    this.values = parseEnvText(text);
    this.loaded = true;
    return this;
  }
  getSecret(id) {
    const k = envKeyFor(id);
    return Object.prototype.hasOwnProperty.call(this.values, k) ? this.values[k] : null;
  }
  listSecrets() { return Object.keys(this.values); }
  setSecret(id, value) {
    const k = envKeyFor(id);
    const v = String(value == null ? '' : value).replace(/[\r\n]+/g, '');
    const w = { key: k, value: v };
    this.values[k] = v;
    this._latest[k] = w;
    const write = this._chain.then(() => this._flush(w)).then(() => true, (e) => { this.error = envErrorText(e); return false; });
    this._chain = write.then(() => undefined);
    return write;
  }
  async _flush(w) {
    this.error = '';
    let cur = null;
    try {
      if (!this.adapter) throw new Error('no vault adapter');
      cur = (await this._present()) ? await this.adapter.read(this.path) : '';
      const next = upsertEnvLine(cur, w.key, w.value);
      if (next === cur) { this.exists = this.exists || cur !== ''; return; }
      await this.adapter.write(this.path, next);
      this.exists = true;
    } catch (e) {
      this._revert(w, cur);
      throw e;
    }
  }
  // After a failed write, memory goes back to what the disk holds for that
  // key: the bytes read just before the write, or nothing when even the
  // read failed (load() would answer the same). A later write of the same
  // key that is still queued answers for itself, so it is left alone.
  _revert(w, cur) {
    if (this._latest[w.key] !== w) return;
    const disk = cur == null ? {} : parseEnvText(cur);
    if (Object.prototype.hasOwnProperty.call(disk, w.key)) this.values[w.key] = disk[w.key];
    else delete this.values[w.key];
  }
  settle() { return this._chain; }
}

// The settings object seen through the same interface, so a value still in
// data.json can be moved like any other. An id resolves to its field or to
// the calendar entry it names; anything else is unknown (null, no write).
function dataJsonStore(settings) {
  const s = settings || {};
  const slot = (id) => {
    for (const field of SECRET_FIELD_NAMES) if (fieldSecretKey(field) === id) return { obj: s, prop: field };
    for (const f of (Array.isArray(s.calendars) ? s.calendars : [])) {
      if (f && typeof f === 'object' && f.id && calendarSecretKey(f.id) === id) return { obj: f, prop: 'url' };
    }
    return null;
  };
  return {
    getSecret(id) { const t = slot(id); return t ? trimmed(t.obj[t.prop]) : null; },
    setSecret(id, value) { const t = slot(id); if (!t) throw new Error('unknown secret'); t.obj[t.prop] = trimmed(value); },
    listSecrets() { return []; },
  };
}

// Which backends hold a value for one id. `holders` maps a backend name to
// a store-like object, or null when that backend is not there.
function secretPresence(id, holders) {
  const out = [];
  for (const name of Object.keys(holders || {})) {
    const h = holders[name];
    if (!h) continue;
    let v = null;
    try { v = h.getSecret(id); } catch { v = null; }
    if (trimmed(v)) out.push(name);
  }
  return out;
}

// Copy one secret from one backend into another, then blank the source. The
// source is blanked only after the target holds the value: for the env file
// that means after its write reached disk without an error. false when the
// source has nothing or the target refused; the source is then untouched.
async function moveSecret(id, from, to) {
  if (!from || !to || from === to) return false;
  let v = '';
  try { v = trimmed(from.getSecret(id)); } catch { v = ''; }
  if (!v) return false;
  try { to.setSecret(id, v); } catch { return false; }
  if (typeof to.settle === 'function') {
    await to.settle();
    if (to.error) return false;
  }
  try { from.setSecret(id, ''); } catch { /* the target holds it; the status row shows both until the source is cleared */ }
  if (typeof from.settle === 'function') await from.settle();
  return true;
}

// The rows of the settings tab's key list: the five credentials by name,
// then every pasted calendar address. The Outlook expiry and the account
// name travel with the access token (one sign-in, four keys).
const SECRET_SLOT_LABELS = {
  todoistToken: 'Todoist API token',
  clickupToken: 'ClickUp API token',
  imapPassword: 'Mailbox app password',
  outlookRefreshToken: 'Outlook refresh token',
  outlookAccessToken: 'Outlook access token',
};
const SECRET_SLOT_COMPANIONS = { outlookAccessToken: ['outlookExpiresAt', 'outlookAccount'] };
function secretSlots(settings) {
  const slots = Object.keys(SECRET_SLOT_LABELS).map((field) => {
    const id = fieldSecretKey(field);
    return { id, label: SECRET_SLOT_LABELS[field], envKey: envKeyFor(id), ids: [field].concat(SECRET_SLOT_COMPANIONS[field] || []).map(fieldSecretKey) };
  });
  for (const f of calendarFeeds(settings)) {
    if (!f || !f.id || f.kind === 'graph') continue;
    const id = calendarSecretKey(f.id);
    slots.push({ id, label: `Calendar address: ${f.name || f.id}`, envKey: envKeyFor(id), ids: [id] });
  }
  return slots;
}

// One key's status line: where a value exists, and whether the copy in the
// selected backend is the one in use.
function secretStatusText(present, selected) {
  const names = present.map(secretsBackendLabel);
  if (!names.length) return 'Not set.';
  const where = names.length === 1 ? `Stored in ${names[0]}.` : `Stored in ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}.`;
  if (present.includes(selected)) return names.length > 1 ? `${where} The copy in ${secretsBackendLabel(selected)} is the one in use.` : where;
  return `${where} Not in ${secretsBackendLabel(selected)}, the backend in use, so it is not read until it is moved.`;
}

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/* ========================================================================== *
 * Where the planner lives
 *
 * The room name used to be a module constant. Renaming the room made
 * collectItems return nothing, the file-tree click hook stop firing, and the
 * next sync recreate an empty default folder beside the renamed one, all of
 * it silently. Now the folder is a setting, every path derives from it, and
 * boot adopts a renamed room when it is the only candidate.
 * ========================================================================== */

// Validates a typed folder. Pure. Trims, strips surrounding slashes,
// collapses repeated ones; refuses empty, anything under .obsidian, and any
// '.' or '..' segment. Returns { ok, folder, error }. `what` names the
// folder in the sentence (the planner room, the habits room).
function normalizeVaultFolder(raw, what) {
  const label = what || 'planner';
  let f = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
  f = f.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  f = normalizePath(f);
  if (!f) return { ok: false, folder: null, error: `The ${label} folder cannot be empty.` };
  if (/^\.obsidian(\/|$)/i.test(f)) return { ok: false, folder: null, error: `The ${label} folder cannot live inside .obsidian.` };
  if (f.split('/').some((seg) => seg === '.' || seg === '..')) return { ok: false, folder: null, error: `The ${label} folder cannot contain "." or ".." segments.` };
  return { ok: true, folder: f, error: null };
}
function normalizePlannerFolder(raw) { return normalizeVaultFolder(raw, 'planner'); }
function normalizeHabitsFolder(raw) { return normalizeVaultFolder(raw, 'My Life Habits'); }
// The My Life Habits room, off the setting: read for the import and the
// link picker only, never for the board. An invalid or missing value is
// the default.
function habitsImportFolderOf(settings) {
  const n = normalizeHabitsFolder(settings && settings.habitsImportFolder);
  return n.ok ? n.folder : DEFAULT_SETTINGS.habitsImportFolder;
}
// The import's one write outside the planner folder is confined to that
// room: a folder boundary, not a prefix, same as plannerPaths().isInside.
function importPathInside(settings, path) {
  return typeof path === 'string' && path.startsWith(`${habitsImportFolderOf(settings)}/`);
}
// A planner habit note: under <planner folder>/Habits/, a boundary not a prefix.
function habitPathInside(settings, path) { return plannerPaths(settings).isHabit(path); }

// Every path the plugin reads or writes, derived from the one setting. Pure.
// An invalid or missing setting falls back to the default, so an older
// data.json without the key behaves exactly as before.
function plannerPaths(settings) {
  const n = normalizePlannerFolder(settings && settings.plannerFolder);
  const root = n.ok ? n.folder : DEFAULT_SETTINGS.plannerFolder;
  return {
    root,
    // One cache file for ALL calendar events (never per-event notes).
    cache: `${root}/Calendar Events.md`,
    sourceFolder: (sourceId) => {
      const src = SOURCES[sourceId];
      return src && src.folder ? `${root}/${src.folder}` : null;
    },
    // A folder boundary, not a prefix: '02 Planner2/x.md' is outside '02 Planner'.
    isInside: (path) => typeof path === 'string' && path.startsWith(`${root}/`),
    // Routine notes (2026-09-04): one per routine, under the room.
    routines: `${root}/Routines`,
    isRoutine: (path) => typeof path === 'string' && path.startsWith(`${root}/Routines/`),
    // Habit notes (0.10.0): one per habit, under the room.
    habits: `${root}/Habits`,
    isHabit: (path) => typeof path === 'string' && path.startsWith(`${root}/Habits/`),
    // Week notes (0.14.0): one per ISO week, named by the week itself.
    weeks: `${root}/Weeks`,
    isWeek: (path) => typeof path === 'string' && path.startsWith(`${root}/Weeks/`),
    weekNote: (iso) => `${root}/Weeks/${iso}.md`,
  };
}

// Boot-time detection. Pure. The configured folder existing wins. Otherwise
// exactly one top-level folder whose name ends in "planner" (any prefix,
// any case) is adopted; several ask; none keeps the setting (ensureFolders
// creates it). Returns { action: 'keep' | 'adopt' | 'ask', folder, candidates }.
function detectPlannerFolder(topLevelFolderNames, configured) {
  const names = Array.isArray(topLevelFolderNames) ? topLevelFolderNames : [];
  if (names.includes(configured)) return { action: 'keep', folder: configured, candidates: [] };
  const candidates = names.filter((n) => /(^|\s)planner$/i.test(String(n)));
  if (candidates.length === 1) return { action: 'adopt', folder: candidates[0], candidates };
  if (candidates.length > 1) return { action: 'ask', folder: configured, candidates };
  return { action: 'keep', folder: configured, candidates: [] };
}

// The settings tab's decision for a folder change. Pure. 'move' renames the
// current folder (link-safe, through fileManager.renameFile); 'switch' just
// points the setting; both existing is refused rather than guessed.
function plannerFolderChangePlan({ current, next, currentExists, nextExists }) {
  if (next === current) return { action: 'noop', reason: 'This is the current folder.' };
  if (currentExists && nextExists) return { action: 'refuse', reason: `Both "${current}" and "${next}" exist. Merge them by hand first, then apply.` };
  if (currentExists && !nextExists) return { action: 'move', reason: `Moves "${current}" and every note in it to "${next}", keeping links intact.` };
  return { action: 'switch', reason: nextExists ? `Uses the existing "${next}".` : `Creates "${next}".` };
}

// The .gitignore line for this plugin's own folder, off the manifest
// (Obsidian sets manifest.dir to the plugin folder; the id is the fallback).
function gitignoreLineFor(manifest) {
  const m = manifest || {};
  const dir = String(m.dir || (m.id ? `.obsidian/plugins/${m.id}` : '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return dir ? `${dir}/` : null;
}

/* ========================================================================== *
 * Date helpers (all in the system-local timezone: the planner runs where the
 * user sits; the cockpit's fixed Berlin zone becomes "wherever this Mac is")
 * ========================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }

function localDayStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayStr() { return localDayStr(new Date()); }

// Monday of the week containing dayStr (ISO week anchor, matches the cockpit).
function mondayOf(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const shift = (dt.getDay() + 6) % 7; // Mon=0 .. Sun=6
  dt.setDate(dt.getDate() - shift);
  return localDayStr(dt);
}

function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localDayStr(dt);
}

function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// Lexical compare is correct for YYYY-MM-DD.
function dayInWeek(day, weekStart) {
  return !!day && day >= weekStart && day < addDays(weekStart, 7);
}

function dueBucketOf(day, today) {
  if (!day) return 'none';
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'upcoming';
}

function fmtWeekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const [sy, sm, sd] = weekStart.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (sm === em) return `${sd} - ${ed} ${months[sm - 1]} ${sy}`;
  if (sy === ey) return `${sd} ${months[sm - 1]} - ${ed} ${months[em - 1]} ${sy}`;
  return `${sd} ${months[sm - 1]} ${sy} - ${ed} ${months[em - 1]} ${ey}`;
}

/* ---- display formats (2026-09-07) ---------------------------------------
 * The board's dates and times follow the person's own format: the planner
 * settings "Date format" and "Time format" when filled, else Obsidian's
 * Templates plugin settings (the same moment tokens), else the compact
 * shapes every earlier release drew (7.09., MON 7.09.2026, 18:15). One
 * resolver decides; fmtDayNum, fmtDayLabel and fmtTimeHM consume it and
 * no call site builds a date or time string by hand (a gate asserts so).
 * The formats are read at render time through a source the plugin sets on
 * load, never cached: a change in either settings tab shows on the next
 * paint. Inputs (routine times, the HH:MM fields) and everything stored
 * in frontmatter or ISO strings stay as they are; only what is shown moves.
 */
let displayFormatSource = null;
function setDisplayFormatSource(fn) { displayFormatSource = typeof fn === 'function' ? fn : null; }
function displayFormats() {
  let f = null;
  try { f = displayFormatSource ? displayFormatSource() : null; } catch (e) { f = null; }
  return {
    date: String((f && f.date) || '').trim(),
    time: String((f && f.time) || '').trim(),
  };
}
// The core Templates plugin's options: dateFormat and timeFormat are ''
// until the person types one. Read defensively. Obsidian keeps the
// options after the plugin is switched off, so a disabled Templates
// plugin counts as blank formats: what the person turned off must not
// keep shaping the board.
function templatesFormats(app) {
  const plugins = app && app.internalPlugins && app.internalPlugins.plugins;
  const tpl = plugins && plugins.templates;
  if (!tpl || tpl.enabled === false) return { date: '', time: '' };
  const inst = tpl.instance;
  const opts = (inst && inst.options) || {};
  return {
    date: typeof opts.dateFormat === 'string' ? opts.dateFormat : '',
    time: typeof opts.timeFormat === 'string' ? opts.timeFormat : '',
  };
}
// The planner's own setting wins when filled; blank follows Templates.
function resolveDisplayFormats(settings, app) {
  const s = settings || {};
  const t = templatesFormats(app);
  const own = (v) => String(v == null ? '' : v).trim();
  return { date: own(s.dateFormat) || t.date, time: own(s.timeFormat) || t.time };
}
// moment never throws on a format, but it can answer with nothing (a
// bracket-only format) or with "Invalid date"; both fall back to compact.
function fmtWithMoment(m, fmt, compact) {
  if (!fmt || !moment || !m) return compact;
  const valid = typeof m.isValid === 'function' ? m.isValid() : true;
  const out = valid ? String(m.format(fmt) || '') : '';
  return out && out !== 'Invalid date' ? out : compact;
}
function compactDayText(m, d, y) { return `${d}.${pad2(m)}.${y == null ? '' : y}`; }
function compactTimeText(dt) { return `${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`; }

function fmtDayNum(dayStr) {
  const [, m, d] = dayStr.split('-').map(Number);
  const compact = compactDayText(m, d);
  const fmt = displayFormats().date;
  return fmt ? fmtWithMoment(moment(dayStr, 'YYYY-MM-DD', true), fmt, compact) : compact;
}

function fmtTimeHM(iso) {
  const d = new Date(iso);
  const compact = compactTimeText(d);
  const fmt = displayFormats().time;
  return fmt ? fmtWithMoment(moment(d), fmt, compact) : compact;
}

// Synthetic lane order for a timed calendar event: minutes since local
// midnight of its start (09:30 -> 570). Events are read-only and always sort
// by this; tasks sort by their planned_order and can be dropped around them.
function eventLaneOrder(ev) {
  const d = new Date(ev.start);
  return d.getHours() * 60 + d.getMinutes();
}

// One lane = ONE sequence: timed events (order = start minutes), routine
// blocks (order = start minutes, 2026-09-04) and task cards (order =
// plannedOrder), ascending; a tie goes event, routine, task, so a task
// dropped "at 09:00" lands below the 09:00 chip and below a 09:00 routine.
// Every entry kind exposes `plannedOrder` so orderForInsert can rank over
// the mixed list. Known and accepted: tap-menu planning assigns order =
// Date.now() (huge), so those tasks land after every event; legacy hand
// orders like 10/20 render above a 09:00 (540) event until the next drag
// renormalizes them.
const LANE_KIND_RANK = { event: 0, routine: 1, task: 2 };
function laneSequence(laneEvents, cell, routines) {
  const seq = laneEvents
    .map((ev) => ({ kind: 'event', ev, plannedOrder: eventLaneOrder(ev) }))
    .concat((routines || []).map((occ) => ({ kind: 'routine', occ, path: occ.routine.path, plannedOrder: occ.startMin })))
    .concat(cell.map((it) => ({ kind: 'task', it, path: it.path, plannedOrder: it.plannedOrder })));
  return seq.sort((a, b) => (a.plannedOrder - b.plannedOrder) || (LANE_KIND_RANK[a.kind] - LANE_KIND_RANK[b.kind]));
}

// Minutes that `tz` is ahead of UTC at the given instant (cockpit types.js port).
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

// The UTC instant of local wall-clock time (y,m,d,hh,mm,ss) in IANA zone tz.
// Two-pass offset probe: guess with the offset at the UTC-interpreted instant,
// then re-probe at the corrected instant (handles DST boundaries).
function zonedToUtc(y, m, d, hh, mm, ss, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let inst = guess - off * 60000;
  off = tzOffsetMinutes(new Date(inst), tz);
  return new Date(guess - off * 60000);
}

/* ========================================================================== *
 * Time zone resolution for ICS feeds (2026-09-04)
 *
 * Outlook, Exchange, and any calendar that re-exports a subscription to one
 * of them, write WINDOWS display names into TZID ("W. Australia Standard
 * Time"). Intl rejects those. Until now the rejection was caught and the wall
 * clock was reinterpreted in the machine's own zone, silently: a Perth 08:30
 * rendered as 08:30 on a Sydney machine, two hours early, with no marker.
 *
 * The resolver tries, in order: an IANA id, the CLDR Windows-to-IANA table,
 * a VTIMEZONE block from the feed itself, a fixed offset spelled inside the
 * id ("(UTC+08:00) Perth"). Whatever still fails is FLAGGED (tzUnresolved)
 * and rendered as written, never as a confident guess. A calendar-level
 * X-WR-TIMEZONE fills a MISSING TZID only; it never silently replaces an id
 * the feed did write, because a wrong zone stated with confidence is the
 * exact defect this block exists to remove.
 * ========================================================================== */

// CLDR windowsZones.xml, territory 001 rows only (the canonical IANA id per
// Windows zone). Generated from unicode-org/cldr main at commit c33a1f0a
// (2025-04-10), file typeVersion 2021a, by a one-line script over the XML.
// Regenerate the whole table rather than hand-editing rows.
const WINDOWS_TZ_TO_IANA = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'UTC': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Calcutta',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Central Asia Standard Time': 'Asia/Bishkek',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
};

// Strip the decorations feeds wrap around a zone id: surrounding quotes, a
// leading slash, the Mozilla and libical registry prefixes, doubled spaces.
function normalizeTzid(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/^"(.*)"$/, '$1').trim();
  s = s.replace(/^\/(mozilla\.org\/[^/]+\/|freeassociation\.sourceforge\.net\/(Tzfile\/)?)/i, '');
  s = s.replace(/^\//, '');
  return s.replace(/\s+/g, ' ').trim();
}

// "(UTC+08:00) Perth" -> 480, "(UTC-03:30) Newfoundland" -> -210,
// "(UTC) Coordinated Universal Time" -> 0, anything else -> null.
function tzidUtcPrefixOffset(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\(UTC\)/i.test(s)) return 0;
  const m = /^\(UTC([+-])(\d{2}):(\d{2})\)/i.exec(s);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// RFC 5545 UTC-OFFSET ("+0800", "-0330", "+053000") -> minutes east of UTC.
function icsUtcOffsetToMinutes(s) {
  const m = /^([+-])(\d{2})(\d{2})?(\d{2})?$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// Does Intl know this id? Memoized: the probe constructs a formatter.
const _ianaProbe = new Map();
function isIanaZone(tz) {
  if (!tz) return false;
  if (_ianaProbe.has(tz)) return _ianaProbe.get(tz);
  let ok = false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; }
  _ianaProbe.set(tz, ok);
  return ok;
}

// A VTIMEZONE reduced to its two offsets (minutes east of UTC) names a zone
// only by its behaviour, so the search is over the IANA ids the CLDR table
// knows: the first one whose January and July offsets are the same pair, in
// either order (the southern hemisphere has its standard time in July).
const _offsetPairMatch = new Map();
function ianaForOffsets(standardOffset, daylightOffset) {
  const key = `${standardOffset}/${daylightOffset}`;
  if (_offsetPairMatch.has(key)) return _offsetPairMatch.get(key);
  const year = new Date().getFullYear();
  const jan = new Date(Date.UTC(year, 0, 15, 12));
  const jul = new Date(Date.UTC(year, 6, 15, 12));
  let hit = null;
  for (const tz of new Set(Object.values(WINDOWS_TZ_TO_IANA))) {
    if (!isIanaZone(tz)) continue;
    const a = tzOffsetMinutes(jan, tz);
    const b = tzOffsetMinutes(jul, tz);
    if ((a === standardOffset && b === daylightOffset) || (b === standardOffset && a === daylightOffset)) {
      hit = tz;
      break;
    }
  }
  _offsetPairMatch.set(key, hit);
  return hit;
}

// -> { tz: IANA id | null, fixedOffsetMin: minutes | null, unresolved: the id
// as written | null }. Exactly one of tz / fixedOffsetMin / unresolved is set
// for a non-empty id. `ctx.vtimezones` is what parseIcs collected from the
// feed, keyed by the VTIMEZONE's own TZID (raw and normalized).
function resolveTzid(tzid, ctx) {
  const c = ctx || {};
  const raw = String(tzid == null ? '' : tzid).trim();
  const name = normalizeTzid(raw);
  const none = { tz: null, fixedOffsetMin: null, unresolved: null };
  if (!name) return none;
  if (isIanaZone(name)) return { tz: name, fixedOffsetMin: null, unresolved: null };
  const mapped = WINDOWS_TZ_TO_IANA[name];
  if (mapped) return { tz: mapped, fixedOffsetMin: null, unresolved: null };
  const vt = c.vtimezones ? (c.vtimezones[raw] || c.vtimezones[name] || null) : null;
  if (vt) {
    if (vt.standardOffset != null && vt.daylightOffset != null) {
      const tz = ianaForOffsets(vt.standardOffset, vt.daylightOffset);
      if (tz) return { tz, fixedOffsetMin: null, unresolved: null };
    }
    // STANDARD only, or a pair no known zone produces: a fixed offset, no DST.
    if (vt.standardOffset != null) return { tz: null, fixedOffsetMin: vt.standardOffset, unresolved: null };
  }
  const prefixed = tzidUtcPrefixOffset(name);
  if (prefixed != null) return { tz: null, fixedOffsetMin: prefixed, unresolved: null };
  return { tz: null, fixedOffsetMin: null, unresolved: raw };
}

// The one warning line the board shows after a sync with unresolved zones.
// One line for the whole feed, never a Notice per event.
function calendarTzWarning(defs) {
  const flagged = (defs || []).filter((d) => d && d.tzUnresolved);
  if (!flagged.length) return null;
  const n = flagged.length;
  return `${n} event${n === 1 ? ' uses' : 's use'} an unknown time zone (${flagged[0].tzUnresolved}); times are shown as written.`;
}

/* ========================================================================== *
 * Text helpers
 * ========================================================================== */

// A vault-safe file basename from a task title. Windows-illegal + Obsidian-hot
// characters are stripped; length bounded so paths stay sane.
// The id part of a note name. A Todoist, ClickUp or IMAP id is short and
// plain; a Graph message id runs to 150 characters that share a long prefix
// per mailbox, so its first 70 would collide. Such an id is named by its
// tail and a hash of the whole, never truncated at the front.
function noteIdPart(id) {
  const s = String(id == null ? '' : id);
  if (s.length <= 40) return safeBasename(s);
  return `${safeBasename(s.slice(-16))}-${Math.abs(hashStr(s)).toString(36)}`;
}

function safeBasename(title) {
  const cleaned = String(title || 'untitled')
    .replace(/[\\/:*?"<>|#^[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70)
    .replace(/[. ]+$/, '');
  return cleaned || 'untitled';
}

// RFC 2047 encoded-word decoder for mail subjects: =?charset?B|Q?data?=
function decodeRfc2047(raw) {
  if (!raw || raw.indexOf('=?') === -1) return raw || '';
  return raw.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s*(?==\?))?/g, (_m, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(data, 'base64');
      } else {
        const qp = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) =>
          String.fromCharCode(parseInt(h, 16)));
        bytes = Buffer.from(qp, 'binary');
      }
      const cs = charset.toLowerCase().split('*')[0];
      if (cs === 'utf-8' || cs === 'us-ascii') return bytes.toString('utf8');
      if (cs === 'iso-8859-1' || cs === 'latin1') return bytes.toString('latin1');
      return bytes.toString('utf8'); // best effort for anything else
    } catch {
      return raw;
    }
  });
}

// ICS TEXT unescaping per RFC 5545: \\n -> newline, \\, \\; \\\\ literals.
function icsUnescape(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

function hmToMin(hm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

// Height of the lunch band in px, scaled to its duration (cockpit break-fill:
// 28px floor so a short break still reads as a band).
function lunchBandHeight(startHM, endHM) {
  const mins = Math.max(0, hmToMin(endHM, 810) - hmToMin(startHM, 750));
  return Math.max(28, Math.round(mins * 0.55));
}

// Google Calendar descriptions arrive as HTML soup. Flatten to readable
// text: brs/blocks to newlines, anchors to "text url", tags stripped,
// entities decoded. Pure regex (no DOM) so it is headless-testable.
function htmlishToText(raw) {
  let x = String(raw || '');
  if (!/<[a-z!/][^>]*>/i.test(x)) return x;
  x = x
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, inner) => {
      const txt = inner.replace(/<[^>]+>/g, '').trim();
      return txt && txt !== href ? `${txt} ${href}` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return x.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Render text into el with bare URLs as clickable anchors.
function linkifyInto(el, text) {
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"']+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const clean = part.replace(/[).,;:!?]+$/, '');
      const trail = part.slice(clean.length);
      const a = el.createEl('a', { text: clean, href: clean });
      a.addEventListener('click', (e) => { e.preventDefault(); window.open(clean, '_external'); });
      if (trail) el.appendChild(document.createTextNode(trail));
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}

// Which board segment is `minsNow` in, and how far along (cockpit countdown).
// Segments derive from dayStart / lunch (or split) / dayEnd. null outside.
function segmentInfo(settings, minsNow) {
  const dayStart = hmToMin(settings.dayStart, 480);
  const dayEnd = hmToMin(settings.dayEnd, 1080);
  const lunchOn = !!settings.lunchEnabled;
  const amEnd = lunchOn ? hmToMin(settings.lunchStart, 750) : hmToMin(settings.splitTime, 780);
  const pmStart = lunchOn ? hmToMin(settings.lunchEnd, 810) : amEnd;
  const seg = (name, a, b) => (minsNow >= a && minsNow < b && b > a)
    ? { name, pct: (minsNow - a) / (b - a), leftMin: b - minsNow } : null;
  return seg('MORNING', dayStart, amEnd) || (lunchOn && seg('LUNCH', amEnd, pmStart)) ||
    seg('AFTERNOON', pmStart, dayEnd) || null;
}

const DAY_TITLES = ['Monday.', 'Tuesday.', 'Wednesday.', 'Thursday.', 'Friday.', 'Saturday.', 'Sunday.'];
function fmtDayTitle(day, today) {
  if (day === today) return 'Today.';
  const [y, m, d] = day.split('-').map(Number);
  return DAY_TITLES[(new Date(y, m - 1, d, 12).getDay() + 6) % 7];
}
// The weekday stays in front; the date after it follows the display format.
function fmtDayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  const idx = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
  const compact = compactDayText(m, d, y);
  const fmt = displayFormats().date;
  const date = fmt ? fmtWithMoment(moment(day, 'YYYY-MM-DD', true), fmt, compact) : compact;
  return `${DAY_NAMES[idx]} ${date}`;
}

// Live pass 2026-08-30: with one task the board footer read "1 OPEN ITEMS",
// and one task is exactly what the first session has. One helper owns the
// string; a gate asserts no second call site hand-builds it.
function fmtOpenItems(count) {
  return count === 1 ? '1 OPEN ITEM' : `${count} OPEN ITEMS`;
}

function fmtLeft(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}H ${pad2(m)}M LEFT` : `${m}M LEFT`;
}

function clampPriorityRank(n) {
  if (n == null || !Number.isFinite(n)) return 5;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/* ========================================================================== *
 * Connector results (cockpit contract: never throw upward)
 * ========================================================================== */

// `hint` (optional) is the second line a failure may carry: what to DO about
// it, when the classifier knows. `warning` (optional) rides a HEALTHY result
// whose data is complete but deserves one line on the board.
function degraded(source, reason, message, hint, docUrl) {
  const out = { ok: false, source, reason, message, items: [] };
  if (hint) out.hint = hint;
  if (docUrl) out.docUrl = docUrl;
  return out;
}
// `complete` is the third state a HEALTHY result needs. A page walk that
// stopped at its own cap, and a mailbox read that took only the newest N of a
// larger flagged set, both return real items and no error, and the open set
// they return is still a WINDOW rather than the whole truth. Reconcile reads
// this flag: absence from an incomplete set proves nothing, so nothing is
// marked done from it. It is deliberately NOT `degraded`, because a degraded
// source skips the upsert altogether and would freeze a member's board for
// good the moment their account passed the ceiling.
function okResult(source, items, warning, complete = true) {
  const out = { ok: true, source, items };
  if (warning) out.warning = warning;
  if (complete === false) out.complete = false;
  return out;
}

// The line an incomplete walk shows on the board. It reports what WAS read,
// never a guess at what was missed: the cap is the exact point at which the
// connector stopped counting, so the remainder is unknown, not estimable.
function truncatedWarning(read) {
  const n = Number(read) || 0;
  return `sync incomplete, stopped after ${n} item${n === 1 ? '' : 's'} with more still open, so nothing was marked done.`;
}

/* ========================================================================== *
 * Three-way merge for two-way fields (due, priority, description).
 * shadow = the value both sides agreed on at the last sync. Per field:
 *   local changed, source unchanged -> PUSH local (keep local in the note)
 *   source changed (local too or not) -> PULL source (source wins conflicts)
 *   neither changed -> nothing
 * No shadow yet (first sync of an item) -> pull everything, seed the shadow.
 * ========================================================================== */

// The SHARED fields: the ones that round-trip. Everything else on a note is
// either source-owned and pulled (url, tags, source_status, list_id,
// parent_id, recurring) or plan-owned and never sent anywhere
// (PLAN_OWNED_ITEM_FIELDS). Quinn's Sunsama research (2026-09-17) calls this
// split the reason their sync is boring and reliable, and the Planner keeps
// it. `title` joined the set in 0.15.0 on Tom's rule: Sunsama deliberately
// never writes a title or a description back, so there is no prior art here
// and none to blame. Subtasks, comments and time tracking stay local, which
// is where Sunsama stops too.
const TWO_WAY_FIELDS = ['title', 'due', 'priority', 'description'];

// A title is the one shared field a source cannot be handed empty: a blank
// `title:` in a note is a hand-edit accident, and pushing it would wipe the
// task's name at the source. An empty local title keeps the source's.
function pushableTitle(value) {
  const t = trimmed(value);
  return t ? t : null;
}

function threeWayMerge(sourceVals, localVals, shadow, pushEnabled) {
  const pushes = {};
  const finals = {};
  const nextShadow = {};
  for (const f of TWO_WAY_FIELDS) {
    const src = sourceVals[f] == null || sourceVals[f] === '' ? (f === 'priority' ? 5 : null) : sourceVals[f];
    const loc = localVals[f] == null || localVals[f] === '' ? (f === 'priority' ? 5 : null) : localVals[f];
    // No baseline for this field: either no shadow at all, or a shadow
    // written before the field joined the shared set (every install carries
    // one of those for `title` after 0.15.0). Without a baseline there is no
    // way to tell a local edit from a value that was always there, so the
    // source seeds it. Getting this wrong would push every task's title back
    // to its source on the first sync after the upgrade.
    if (!shadow || !(f in shadow)) { finals[f] = src; nextShadow[f] = src; continue; }
    const base = shadow[f] == null || shadow[f] === '' ? (f === 'priority' ? 5 : null) : shadow[f];
    const srcChanged = src !== base;
    const locChanged = loc !== base;
    if (locChanged && !srcChanged && pushEnabled) {
      pushes[f] = loc; finals[f] = loc; nextShadow[f] = loc;
    } else if (srcChanged) {
      finals[f] = src; nextShadow[f] = src;      // source wins (incl. conflicts)
    } else {
      finals[f] = loc; nextShadow[f] = base;      // unchanged, or local kept unpushed
    }
  }
  return { pushes, finals, nextShadow };
}

/* ========================================================================== *
 * Connector: Todoist (unified API v1, Bearer token, cursor pagination)
 * ========================================================================== */

// Todoist API priority is INVERTED: 4 = P1 (highest) .. 1 = none.
function todoistPriorityRank(apiPriority) {
  if (!apiPriority || apiPriority === 1) return apiPriority === 1 ? 4 : 5;
  return clampPriorityRank(5 - apiPriority);
}

async function todoistFetchOpen(settings, deps) {
  const token = (settings.todoistToken || '').trim();
  if (!token) return degraded('todoist', 'no-token', 'Todoist is not connected (no token).');
  const rq = requestUrlOf(deps);
  const base = 'https://api.todoist.com/api/v1';
  const items = [];
  let cursor = null;
  try {
    for (let page = 0; page < 20; page++) {
      const url = `${base}/tasks?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await rq({
        url, method: 'GET', throw: false,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return degraded('todoist', 'misconfigured', 'Todoist rejected the token.');
      }
      if (res.status < 200 || res.status >= 300) {
        return degraded('todoist', 'unreachable', `Todoist returned HTTP ${res.status}.`);
      }
      const body = res.json || {};
      for (const t of body.results || []) {
        items.push({
          source: 'todoist',
          id: String(t.id),
          title: t.content || '(untitled)',
          description: (t.description || '').replace(/\s+$/, ''),
          due: t.due && t.due.date ? String(t.due.date).slice(0, 10) : null,
          priority: todoistPriorityRank(t.priority),
          // v1 returns no url field (verified in the cockpit 2026-06-03);
          // the app deep link is constructed from the id.
          url: t.url || `https://app.todoist.com/app/task/${encodeURIComponent(String(t.id))}`,
          tags: Array.isArray(t.labels) ? t.labels : [],
          status: null,
          // The recurrence flag on the Due object is named `is_recurring` in
          // some api/v1 documents and `recurring` in others; both are read so
          // a doc-side rename cannot silently turn every task non-recurring.
          recurring: !!(t.due && (t.due.is_recurring || t.due.recurring)),
          dueString: t.due && t.due.string ? String(t.due.string) : null,
          // A subtask is an ordinary task with a parent id (2026-09-04).
          parentId: t.parent_id ? String(t.parent_id) : null,
        });
      }
      cursor = body.next_cursor || null;
      if (!cursor) break;
    }
    // The loop only ever leaves `cursor` set by running out of pages: every
    // other exit clears it first. A cursor still in hand is Todoist saying
    // there is more, and those tasks are open, not finished.
    return cursor
      ? okResult('todoist', items, truncatedWarning(items.length), false)
      : okResult('todoist', items);
  } catch (e) {
    return degraded('todoist', 'unreachable', 'Todoist is unreachable.');
  }
}

/* ========================================================================== *
 * Connector: ClickUp (API v2, RAW token in Authorization - no Bearer prefix)
 * ========================================================================== */

async function clickupApi(token, path, deps) {
  const res = await requestUrlOf(deps)({
    url: `https://api.clickup.com/api/v2${path}`,
    method: 'GET', throw: false,
    headers: { Authorization: token },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('auth'); err.auth = true; throw err;
  }
  if (res.status === 404) throw goneError('ClickUp');
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.json || {};
}

// The task query, one place: the open set assigned to me, ordered by due,
// paged; subtasks only when the setting asks (ClickUp omits them otherwise).
function clickupQuery(settings, myId, page) {
  const qs = new URLSearchParams({
    include_closed: 'false',
    subtasks: settings && settings.clickupIncludeSubtasks === true ? 'true' : 'false',
    order_by: 'due_date',
    page: String(page),
  });
  qs.append('assignees[]', String(myId));
  return qs.toString();
}

// The identity of that query, as one string. Everything that can shrink the
// open set WITHOUT anything having been completed belongs in here: the
// subtasks toggle, the pinned workspace, and the account the token resolves
// to. It rides back on the result and is stored beside each item's shadow, so
// a later sync asking a narrower question can tell "this task is finished"
// from "this task is no longer being asked about".
function clickupScopeKey(settings, myId) {
  const s = settings || {};
  const sub = s.clickupIncludeSubtasks === true ? '1' : '0';
  const team = (s.clickupTeamId || '').trim() || '*';
  return `sub=${sub}|team=${team}|me=${myId == null ? '' : String(myId)}`;
}

async function clickupFetchOpen(settings, deps) {
  const token = (settings.clickupToken || '').trim();
  if (!token) return degraded('clickup', 'no-token', 'ClickUp is not connected (no token).');
  try {
    // Who am I - assignee filter derives from the token, never hard-coded.
    const me = await clickupApi(token, '/user', deps);
    const myId = me && me.user && me.user.id;
    if (!myId) return degraded('clickup', 'misconfigured', 'ClickUp: could not derive the user from the token.');

    // Which workspaces - configured id first, else every team on the token.
    let teamIds = [];
    const configured = (settings.clickupTeamId || '').trim();
    if (configured) {
      teamIds = [configured];
    } else {
      const teams = await clickupApi(token, '/team', deps);
      teamIds = ((teams && teams.teams) || []).map((t) => String(t.id));
    }
    if (!teamIds.length) return degraded('clickup', 'misconfigured', 'ClickUp: no workspace visible to this token.');

    const items = [];
    let truncated = false;
    for (const teamId of teamIds) {
      // Set only by an exit that ClickUp itself declared final. Running the
      // page counter out is not such an exit.
      let walked = false;
      for (let page = 0; page < 20; page++) {
        const data = await clickupApi(token, `/team/${encodeURIComponent(teamId)}/task?${clickupQuery(settings, myId, page)}`, deps);
        const tasks = (data && data.tasks) || [];
        for (const t of tasks) {
          const st = (t.status && t.status.type || '').toLowerCase();
          if (st === 'done' || st === 'closed') continue;
          const dueMs = t.due_date ? Number(t.due_date) : null;
          items.push({
            source: 'clickup',
            id: String(t.id),
            title: t.name || '(untitled)',
            description: ((t.text_content || t.description || '')).replace(/\s+$/, ''),
            due: dueMs && Number.isFinite(dueMs) ? localDayStr(new Date(dueMs)) : null,
            priority: t.priority && t.priority.id != null ? clampPriorityRank(Number(t.priority.id)) : 5,
            url: t.url || null,
            tags: Array.isArray(t.tags) ? t.tags.map((x) => x.name).filter(Boolean) : [],
            status: (t.status && t.status.status) || null,
            listId: t.list && t.list.id ? String(t.list.id) : null,
            // ClickUp's API exposes no recurrence flag (recurrence is an
            // automation, not a task field). Unknown, so the occurrence rule
            // still applies when the due moves forward past its baseline.
            recurring: null,
            dueString: null,
            parentId: t.parent ? String(t.parent) : null,
          });
        }
        if (!tasks.length || (data && data.last_page === true)) { walked = true; break; }
      }
      if (!walked) truncated = true;
    }
    const out = truncated
      ? okResult('clickup', items, truncatedWarning(items.length), false)
      : okResult('clickup', items);
    out.scope = clickupScopeKey(settings, myId);
    return out;
  } catch (e) {
    if (e && e.auth) return degraded('clickup', 'misconfigured', 'ClickUp rejected the token.');
    return degraded('clickup', 'unreachable', 'ClickUp is unreachable.');
  }
}

/* ========================================================================== *
 * Source WRITE clients (v0.2.0, armed by settings only; never called
 * otherwise). Every writer throws on failure - callers catch and Notice.
 * ========================================================================== */

// rank 1..5 back to the Todoist API's inverted scale (1=P1 highest -> api 4).
function todoistApiPriority(rank) {
  const r = clampPriorityRank(rank);
  return r >= 5 ? 1 : 5 - r;
}

async function todoistWrite(token, path, payload) {
  const res = await requestUrl({
    url: `https://api.todoist.com/api/v1${path}`,
    method: 'POST', throw: false,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (res.status === 404) throw goneError('Todoist');
  if (res.status < 200 || res.status >= 300) throw new Error(`Todoist HTTP ${res.status}`);
}

// Is this task still in Todoist? true = deleted, false = still there,
// null = could not tell (network, auth, anything but a clean answer).
// GET /tasks/{id} answers 404 for a task that was deleted OR permanently
// removed after completion; a completed task that still exists answers 200
// with is_completed true, which is "still there" and reconcile's own
// business.
async function todoistProbeGone(token, id, deps) {
  try {
    const res = await requestUrlOf(deps)({
      url: `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(id)}`,
      method: 'GET', throw: false,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return true;
    if (res.status >= 200 && res.status < 300) return false;
    return null;
  } catch { return null; }
}

async function todoistSetClosed(token, id, closed) {
  await todoistWrite(token, `/tasks/${encodeURIComponent(id)}/${closed ? 'close' : 'reopen'}`);
}

async function todoistPushFields(token, id, pushes) {
  const payload = {};
  if ('title' in pushes) {
    const name = pushableTitle(pushes.title);
    if (name) payload.content = name;
  }
  if ('description' in pushes) payload.description = pushes.description || '';
  if ('priority' in pushes) payload.priority = todoistApiPriority(pushes.priority);
  if ('due' in pushes) {
    if (pushes.due) payload.due_date = pushes.due;
    else payload.due_string = 'no date';
  }
  if (Object.keys(payload).length) await todoistWrite(token, `/tasks/${encodeURIComponent(id)}`, payload);
}

async function clickupWrite(token, path, payload) {
  const res = await requestUrl({
    url: `https://api.clickup.com/api/v2${path}`,
    method: 'PUT', throw: false,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status === 404) throw goneError('ClickUp');
  if (res.status < 200 || res.status >= 300) throw new Error(`ClickUp HTTP ${res.status}`);
}

// ClickUp has no universal close: statuses are per-list. Resolve the list's
// own done/closed (or open) status name once and cache it for the session.
const _clickupStatusCache = new Map();
async function clickupStatusName(token, listId, wantClosed) {
  const cacheKey = `${listId}`;
  if (!_clickupStatusCache.has(cacheKey)) {
    const res = await requestUrl({
      url: `https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}`,
      method: 'GET', throw: false, headers: { Authorization: token },
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`ClickUp HTTP ${res.status}`);
    _clickupStatusCache.set(cacheKey, (res.json && res.json.statuses) || []);
  }
  const statuses = _clickupStatusCache.get(cacheKey);
  const byType = (t) => statuses.find((x) => (x.type || '').toLowerCase() === t);
  const hit = wantClosed ? (byType('closed') || byType('done')) : byType('open');
  if (!hit || !hit.status) throw new Error('ClickUp: no matching list status');
  return hit.status;
}

async function clickupSetClosed(token, id, listId, closed) {
  if (!listId) throw new Error('ClickUp: task has no list id yet (resync first)');
  const status = await clickupStatusName(token, listId, closed);
  await clickupWrite(token, `/task/${encodeURIComponent(id)}`, { status });
}

// Is this task still in ClickUp? 404 is the plain answer; a task in the
// ClickUp trash answers 200 with `deleted: true`, which is the same thing
// as far as the vault is concerned. A task that is there with a status that
// is neither done nor closed answers 'open': it left the query (unassigned,
// or its parent closed), it was not finished, and the note is left alone.
async function clickupProbeGone(token, id, deps) {
  try {
    const res = await requestUrlOf(deps)({
      url: `https://api.clickup.com/api/v2/task/${encodeURIComponent(id)}`,
      method: 'GET', throw: false,
      headers: { Authorization: token },
    });
    if (res.status === 404) return true;
    if (res.status >= 200 && res.status < 300) {
      if (res.json && res.json.deleted === true) return true;
      const st = (res.json && res.json.status && res.json.status.type || '').toLowerCase();
      return st && st !== 'done' && st !== 'closed' ? 'open' : false;
    }
    return null;
  } catch { return null; }
}

async function clickupPushFields(token, id, pushes) {
  const payload = {};
  if ('title' in pushes) {
    const name = pushableTitle(pushes.title);
    if (name) payload.name = name;
  }
  if ('description' in pushes) payload.description = pushes.description || '';
  if ('priority' in pushes) {
    const r = clampPriorityRank(pushes.priority);
    payload.priority = r >= 5 ? null : r;
  }
  if ('due' in pushes) {
    if (pushes.due) {
      const [y, m, d] = pushes.due.split('-').map(Number);
      payload.due_date = new Date(y, m - 1, d, 12, 0, 0).getTime();
      payload.due_date_time = false;
    } else {
      payload.due_date = null;
    }
  }
  if (Object.keys(payload).length) await clickupWrite(token, `/task/${encodeURIComponent(id)}`, payload);
}

/* ========================================================================== *
 * Connector: Outlook through Microsoft Graph (2026-09-06), signed in with the
 * member's OWN Entra app registration. myICOR holds no developer account,
 * never sees a client id or a token; each member registers the app in their
 * own Microsoft account (docs/outlook-setup-guide.md) and pastes the
 * Application (client) ID here.
 *
 * The sign-in is the authorization code flow with PKCE (S256), a public
 * client, no secret. The redirect is the obsidian:// protocol handler,
 * registered in the Entra app as obsidian://icor-for-life-planner/auth under
 * "Mobile and desktop applications": the one redirect that works the same on
 * desktop and mobile, so the one path built. The device code flow is the
 * fallback for a device where that path is closed by policy; there is no
 * loopback listener (it would cover desktop only, which the scheme already
 * covers, at the price of a second auth path to keep).
 *
 * Every call to Microsoft goes through Obsidian's requestUrl, never the
 * renderer's fetch: fetch carries Origin: app://obsidian.md, and Entra then
 * treats the token call as a browser (SPA) request and refuses it
 * (AADSTS9002326). requestUrl is a native request with no Origin.
 *
 * Scopes are incremental. The first sign-in asks for
 *   offline_access openid profile Mail.Read Calendars.Read
 * and Mail.ReadWrite joins only when Complete on source is switched on: the
 * one write this connector ever makes (a flag status) is the one that earns
 * the write-capable permission, and a member who never turns the toggle on
 * never sees one on their consent screen.
 *
 * Tokens go through the secret vault and nowhere else. The refresh token
 * rotates on every use, so whatever comes back is stored over the old one;
 * an absent refresh_token in a response leaves the stored one untouched.
 * ========================================================================== */

const OUTLOOK_REDIRECT_URI = 'obsidian://icor-for-life-planner/auth';
// The action string for registerObsidianProtocolHandler: the redirect URI
// with the scheme stripped. Obsidian hands the whole pre-query string to
// one handler, so the action is the full path, never the host alone.
const OUTLOOK_PROTOCOL_ACTION = 'icor-for-life-planner/auth';
const OUTLOOK_LOGIN_HOST = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const OUTLOOK_TENANTS = ['common', 'organizations', 'consumers'];
const OUTLOOK_SCOPES_READ = ['offline_access', 'openid', 'profile', 'Mail.Read', 'Calendars.Read'];
const OUTLOOK_SCOPES_WRITE = ['offline_access', 'openid', 'profile', 'Mail.Read', 'Mail.ReadWrite', 'Calendars.Read'];
// Refresh this long before the access token's stated expiry.
const OUTLOOK_TOKEN_SLACK_MS = 60000;
// The notice under the client id field. Shipped exactly as given.
const OUTLOOK_NOTICE = 'You are creating this in your own Microsoft account. Paperless Movement, S.L. never sees or stores your client id or token; you are bound by Microsoft\'s developer terms for it.';
const OUTLOOK_GUIDE_URL = 'https://github.com/myICOR/icor-for-life-planner/blob/main/docs/outlook-setup-guide.md';
// Where the member revokes the grant on Microsoft's side. Signing out here
// deletes the local tokens; it cannot revoke anything server-side.
const OUTLOOK_REVOKE_URLS = {
  work: 'https://myaccount.microsoft.com/',
  personal: 'https://account.live.com/consent/Manage',
};

/* ---- the injectable runtime: requestUrl, sleep, now, crypto ---- */
// Every network path takes `deps` so a test can script the wire; the real
// thing is what runs when nothing is handed in.
const requestUrlOf = (deps) => (deps && deps.requestUrl) || requestUrl;

/* ---- "that task is not there any more" (0.15.0) --------------------------
 * A source task can leave the open set for two reasons that look identical
 * from outside: it was completed, or it was deleted. The plugin used to read
 * both as completion, so a deleted task stayed in the vault forever as a
 * card that could not be opened, and any write aimed at it answered 404 in a
 * toast that came back every sync ("reopen on ClickUp failed (HTTP 404).
 * Will retry on sync.").
 *
 * The flag rides ON the error, set by the writers that read the status code,
 * and NOTHING else counts. A message carrying "404" is not evidence: inside
 * clickupSetClosed the list lookup (GET /list/{listId}) can 404 on its own,
 * for a stale list_id or a list the token can no longer see, and reading
 * that as "the task is gone" would trash a note whose task is alive and
 * well (Flint, 2026-09-17, finding 1). Every writer that can tell sets the
 * flag: todoistWrite, clickupWrite, clickupApi and graphHttpError.
 */
function goneError(label) {
  const e = new Error(`${label} HTTP 404`);
  e.gone = true;
  return e;
}
function isGoneError(e) {
  return !!e && e.gone === true;
}
const sleepOf = (deps) => (deps && deps.sleep) || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
const nowOf = (deps) => (deps && deps.now) || (() => Date.now());
const cryptoOf = (deps) => (deps && deps.crypto) || globalThis.crypto;

/* ---- PKCE, the state nonce, the authorize URL ---- */
function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// The S256 challenge of a verifier: base64url(SHA-256(verifier)), no padding.
// WebCrypto on desktop and mobile alike (Node's global crypto in the tests).
async function pkceChallenge(verifier, deps) {
  const digest = await cryptoOf(deps).subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
async function pkcePair(deps) {
  const raw = new Uint8Array(32);
  cryptoOf(deps).getRandomValues(raw);
  const verifier = base64url(raw);
  return { verifier, challenge: await pkceChallenge(verifier, deps) };
}
function randomState(deps) {
  const raw = new Uint8Array(16);
  cryptoOf(deps).getRandomValues(raw);
  return base64url(raw);
}

function outlookTenant(settings) {
  const t = trimmed(settings && settings.outlookTenant);
  return OUTLOOK_TENANTS.includes(t) ? t : 'common';
}
function outlookScopeString(write) { return (write ? OUTLOOK_SCOPES_WRITE : OUTLOOK_SCOPES_READ).join(' '); }

function authorizeUrl({ clientId, tenant, scopes, redirectUri, state, challenge }) {
  const q = [
    ['client_id', clientId],
    ['response_type', 'code'],
    ['redirect_uri', redirectUri || OUTLOOK_REDIRECT_URI],
    ['response_mode', 'query'],
    ['scope', scopes],
    ['state', state],
    ['code_challenge', challenge],
    ['code_challenge_method', 'S256'],
    // A member may have a work and a personal account: never silently reuse
    // whichever one the browser last signed into.
    ['prompt', 'select_account'],
  ].map(([k, v]) => `${k}=${encodeURIComponent(String(v == null ? '' : v))}`).join('&');
  return `${OUTLOOK_LOGIN_HOST}/${tenant || 'common'}/oauth2/v2.0/authorize?${q}`;
}

// What came back on the obsidian:// URL, checked against the state nonce
// this session issued. Never trusts a code whose state does not match.
function parseAuthCallback(params, expectedState) {
  const p = params && typeof params === 'object' ? params : {};
  if (p.error) {
    const m = mapAadError({ error: String(p.error), error_description: p.error_description ? String(p.error_description) : '' });
    return { ok: false, reason: m.reason, message: m.message, hint: m.hint || null };
  }
  const code = trimmed(p.code);
  if (!code) return { ok: false, reason: 'misconfigured', message: 'Microsoft sent no code back.', hint: null };
  if (!expectedState) return { ok: false, reason: 'misconfigured', message: 'No sign-in was waiting for this reply. Start the sign-in again from the settings.', hint: null };
  if (trimmed(p.state) !== String(expectedState)) return { ok: false, reason: 'misconfigured', message: 'The reply did not match the sign-in that was started (state mismatch). Start the sign-in again.', hint: null };
  return { ok: true, code };
}

/* ---- token responses and the AADSTS error mapping ---- */
// The body as JSON, or null. requestUrl's `json` is a getter that throws on
// a non-JSON body, so both doors are tried and neither is allowed to throw.
function tokenJson(res) {
  if (!res) return null;
  try { if (res.json && typeof res.json === 'object') return res.json; } catch { /* not JSON */ }
  try { return res.text ? JSON.parse(res.text) : null; } catch { return null; }
}

function outlookError(reason, message, hint, codes) {
  const e = new Error(message);
  e.reason = reason;
  if (hint) e.hint = hint;
  if (codes && codes.length) e.codes = codes;
  return e;
}

// The AADSTS numbers a response carries: the error_codes array and the
// ones spelled inside the description, deduplicated.
function aadCodesOf(body) {
  const out = new Set();
  const b = body || {};
  for (const c of Array.isArray(b.error_codes) ? b.error_codes : []) if (Number.isFinite(Number(c))) out.add(Number(c));
  const re = /AADSTS(\d+)/g;
  let m;
  while ((m = re.exec(String(b.error_description || '')))) out.add(Number(m[1]));
  return Array.from(out).sort((a, b2) => a - b2);
}
// Microsoft's description: the sentence, without the AADSTS prefix and the
// trace, correlation and timestamp tail.
function cleanAadDescription(desc) {
  let s = String(desc == null ? '' : desc).trim();
  const cut = s.search(/\s+Trace ID:/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/^AADSTS\d+:\s*/, '').trim();
  return s;
}

// The plain-language map. `message` is what the tray shows; `hint` the
// second line when there is something to do. Anything not listed shows
// Microsoft's own sentence rather than a blank; the table is Microsoft's
// and changes, so it is not chased beyond these rows.
const AAD_ERROR_ROWS = [
  { codes: [7000218], reason: 'misconfigured', message: 'Your Entra app isn\'t set up as a public client yet.', hint: 'Open Authentication in the Azure/Entra portal and set \'Allow public client flows\' to Yes.' },
  { codes: [50011], reason: 'misconfigured', message: 'The sign-in redirect doesn\'t match what\'s registered.', hint: `Check that ${OUTLOOK_REDIRECT_URI} is added exactly under 'Mobile and desktop applications'.` },
  { codes: [65001, 90094], reason: 'misconfigured', message: 'Consent is needed for one of the permissions.', hint: 'If you\'re on a work account, ask your admin to grant consent, or try again and approve the prompt yourself.' },
  { codes: [700016], reason: 'misconfigured', message: 'Wrong Client ID, or the app is registered in a different tenant than the Tenant field says.', hint: 'Recheck the Overview page.' },
  { codes: [70008, 700082], reason: 'no-token', message: 'You haven\'t used this connection in a while, so Microsoft expired it. Sign in again.' },
  { codes: [700020], reason: 'no-token', message: 'Microsoft needs you to sign in interactively again.' },
];
const AAD_CONFIG_ERRORS = new Set(['invalid_client', 'unauthorized_client', 'invalid_request', 'invalid_scope', 'unsupported_grant_type', 'invalid_resource']);

function mapAadError(body) {
  const b = body || {};
  const codes = aadCodesOf(b);
  const error = trimmed(b.error);
  for (const row of AAD_ERROR_ROWS) {
    if (row.codes.some((c) => codes.includes(c))) return { reason: row.reason, message: row.message, hint: row.hint || null, codes };
  }
  if (error === 'interaction_required') return { reason: 'no-token', message: 'Microsoft needs you to sign in interactively again.', hint: null, codes };
  if (error === 'invalid_grant') return { reason: 'no-token', message: 'Some of the authentication material (code, refresh token, or PKCE challenge) is no longer valid. Sign in again.', hint: null, codes };
  if (error === 'access_denied') return { reason: 'no-token', message: 'The sign-in was declined, so nothing is connected.', hint: null, codes };
  const desc = cleanAadDescription(b.error_description);
  const reason = AAD_CONFIG_ERRORS.has(error) ? 'misconfigured' : 'unreachable';
  const message = desc || (error ? `Microsoft sign-in failed (${error}).` : 'Microsoft sign-in failed.');
  return { reason, message, hint: null, codes };
}

// A token endpoint reply -> { accessToken, refreshToken | null, expiresIn,
// scope }, or a thrown error carrying the mapped reason and the AADSTS codes.
function parseTokenResponse(res) {
  const status = Number(res && res.status) || 0;
  const json = tokenJson(res);
  if (status >= 200 && status < 300 && json && json.access_token) {
    return {
      accessToken: String(json.access_token),
      refreshToken: json.refresh_token ? String(json.refresh_token) : null,
      expiresIn: Number(json.expires_in) || 0,
      scope: json.scope ? String(json.scope) : '',
    };
  }
  if (json && (json.error || json.error_description)) {
    const m = mapAadError(json);
    throw outlookError(m.reason, m.message, m.hint, m.codes);
  }
  const body = String((res && res.text) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  throw outlookError('unreachable', `Microsoft returned HTTP ${status}${body ? `: ${body}` : '.'}`);
}

// Retry-After in milliseconds; 2 seconds when the header is missing (one
// retry, so the backoff is one step).
function retryAfterMs(res) {
  const h = (res && res.headers) || {};
  const raw = h['retry-after'] != null ? h['retry-after'] : h['Retry-After'];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : 2000;
}

// One form-encoded POST to login.microsoftonline.com, retried exactly once
// after a 429 or 503, waiting the Retry-After it named.
async function oauthPost(url, form, deps) {
  const rq = requestUrlOf(deps);
  const body = new URLSearchParams(form).toString();
  const send = () => rq({
    url, method: 'POST', throw: false,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  let res = await send();
  if (res && (res.status === 429 || res.status === 503)) {
    await sleepOf(deps)(retryAfterMs(res));
    res = await send();
  }
  return res;
}
const tokenEndpoint = (tenant) => `${OUTLOOK_LOGIN_HOST}/${tenant || 'common'}/oauth2/v2.0/token`;

async function tokenExchange({ clientId, tenant, code, redirectUri, verifier, scopes }, deps) {
  const res = await oauthPost(tokenEndpoint(tenant), {
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || OUTLOOK_REDIRECT_URI,
    code_verifier: verifier,
    scope: scopes,
  }, deps);
  return parseTokenResponse(res);
}
async function tokenRefresh({ clientId, tenant, refreshToken, scopes }, deps) {
  const res = await oauthPost(tokenEndpoint(tenant), {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: scopes,
  }, deps);
  return parseTokenResponse(res);
}

/* ---- the device code fallback ---- */
async function deviceCodeStart({ clientId, tenant, scopes }, deps) {
  const res = await oauthPost(`${OUTLOOK_LOGIN_HOST}/${tenant || 'common'}/oauth2/v2.0/devicecode`, { client_id: clientId, scope: scopes }, deps);
  const json = tokenJson(res);
  const status = Number(res && res.status) || 0;
  if (status >= 200 && status < 300 && json && json.device_code && json.user_code) {
    return {
      deviceCode: String(json.device_code),
      userCode: String(json.user_code),
      verificationUri: String(json.verification_uri || 'https://microsoft.com/devicelogin'),
      expiresIn: Number(json.expires_in) || 900,
      interval: Number(json.interval) || 5,
      message: json.message ? String(json.message) : '',
    };
  }
  if (json && (json.error || json.error_description)) {
    const m = mapAadError(json);
    throw outlookError(m.reason, m.message, m.hint, m.codes);
  }
  throw outlookError('unreachable', `Microsoft returned HTTP ${status}.`);
}
// Poll until Microsoft confirms, declines, or the code expires; slow_down
// widens the interval as the protocol asks. `deps.cancelled()` stops it.
async function deviceCodePoll({ clientId, tenant, deviceCode, interval, expiresIn }, deps) {
  const sleep = sleepOf(deps);
  const now = nowOf(deps);
  const deadline = now() + (Number(expiresIn) || 900) * 1000;
  let wait = Math.max(1, Number(interval) || 5) * 1000;
  const expired = () => outlookError('no-token', 'The code expired before it was used. Start the sign-in again.');
  while (now() < deadline) {
    if (deps && typeof deps.cancelled === 'function' && deps.cancelled()) throw outlookError('cancelled', 'Sign-in cancelled.');
    await sleep(wait);
    if (now() >= deadline) break; // the code expired while waiting: no pointless call
    const res = await oauthPost(tokenEndpoint(tenant), {
      client_id: clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    }, deps);
    const json = tokenJson(res);
    if (json && json.access_token) return parseTokenResponse(res);
    const err = json ? trimmed(json.error) : '';
    if (err === 'authorization_pending') continue;
    if (err === 'slow_down') { wait += 5000; continue; }
    if (err === 'expired_token') throw expired();
    if (err === 'authorization_declined') throw outlookError('no-token', 'The sign-in was declined, so nothing is connected.');
    parseTokenResponse(res); // throws the mapped error for anything else
  }
  throw expired();
}

/* ---- the stored sign-in ---- */
function outlookSignedIn(settings) {
  const s = settings || {};
  return !!(trimmed(s.outlookClientId) && trimmed(s.outlookRefreshToken));
}
function outlookHasWriteScope(settings) {
  return /(^|\s)Mail\.ReadWrite(\s|$)/.test(String((settings && settings.outlookScopes) || ''));
}
function outlookTokens(settings) {
  const s = settings || {};
  return {
    refreshToken: trimmed(s.outlookRefreshToken),
    accessToken: trimmed(s.outlookAccessToken),
    expiresAt: Number(s.outlookExpiresAt) || 0,
    account: trimmed(s.outlookAccount),
  };
}
// Where a token write lands when it happens inside a connector: the copy the
// connector holds knows the settings it was resolved from and the vault
// (withSecrets). `view` is that copy, kept current so the rest of the same
// run reads the rotated token, never the one Microsoft just retired.
function outlookTokenSink(s) {
  const view = s || {};
  return { live: view._live || view, vault: view._vault || null, view };
}
// Persist what a token response carried. The refresh token rotates: a new
// one overwrites the stored one; an absent one leaves it untouched.
function saveOutlookTokens(sink, tokens, now) {
  const k = sink || {};
  const live = k.live || {};
  const t = tokens || {};
  const at = (now == null ? Date.now() : now) + Math.max(0, Number(t.expiresIn) || 0) * 1000;
  let held = true;
  const put = (field, value) => {
    held = writeSecret(live, k.vault, field, value) && held;
    if (k.view && k.view !== live) k.view[field] = value;
  };
  put('outlookAccessToken', t.accessToken ? String(t.accessToken) : '');
  put('outlookExpiresAt', t.accessToken ? String(at) : '');
  if (t.refreshToken) put('outlookRefreshToken', String(t.refreshToken));
  if (t.account != null) put('outlookAccount', String(t.account));
  // A token the backend did not take on the spot lives in the settings
  // (no store, or the env file, which moves it at the save): reach disk
  // now, not at the next save that happens to come along.
  if (!held && typeof live._persist === 'function') live._persist();
}
// Sign-out: the four keys cleared, in the store or in the settings.
function clearOutlookTokens(sink) {
  const k = sink || {};
  const live = k.live || {};
  for (const f of ['outlookRefreshToken', 'outlookAccessToken', 'outlookExpiresAt', 'outlookAccount']) {
    writeSecret(live, k.vault, f, '');
    if (k.view && k.view !== live) k.view[f] = '';
  }
  if (!(k.vault && k.vault.available()) && typeof live._persist === 'function') live._persist();
}

// A usable access token: the cached one while it has a minute left, else a
// refresh (proactive), and a refresh on demand (`force`, after a 401).
async function ensureAccessToken(s, deps, force) {
  const t = outlookTokens(s);
  if (!t.refreshToken) throw outlookError('no-token', 'Outlook is not signed in.');
  const now = nowOf(deps)();
  if (!force && t.accessToken && t.expiresAt - now > OUTLOOK_TOKEN_SLACK_MS) return t.accessToken;
  const fresh = await tokenRefresh({
    clientId: trimmed(s.outlookClientId), tenant: outlookTenant(s),
    refreshToken: t.refreshToken, scopes: outlookScopeString(outlookHasWriteScope(s)),
  }, deps);
  saveOutlookTokens(outlookTokenSink(s), fresh, now);
  return fresh.accessToken;
}

/* ---- Graph requests ---- */
function graphHttpError(res) {
  const status = Number(res && res.status) || 0;
  const json = tokenJson(res);
  const code = json && json.error && json.error.code ? String(json.error.code) : '';
  if (status === 401) return outlookError('no-token', 'Microsoft rejected the token. Sign in again.');
  if (status === 403) return outlookError('misconfigured', `Microsoft refused the request${code ? ` (${code})` : ''}: a permission is missing.`, 'Sign in again and approve every permission on the consent screen.');
  // "No such message": the one Graph status that means the mirror is stale
  // rather than that something went wrong. Flagged here because the Outlook
  // probe and the flag write are the only callers that care, and because
  // isGoneError trusts the flag and nothing else.
  if (status === 404) {
    return Object.assign(outlookError('unreachable', 'Microsoft Graph returned HTTP 404.'), { gone: true });
  }
  return outlookError('unreachable', `Microsoft Graph returned HTTP ${status}${code ? ` (${code})` : ''}.`);
}
// One Graph call with the retry contract: a 401 refreshes the token once
// and retries once (never twice); a 429 or 503 waits Retry-After and
// retries once; anything else that is not 2xx is the mapped error, without
// a retry. Returns the JSON body ({} for an empty reply).
async function graphRequest(s, deps, req) {
  const rq = requestUrlOf(deps);
  const r = req || {};
  const call = (token) => rq({
    url: r.url, method: r.method || 'GET', throw: false,
    headers: Object.assign(
      { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      r.body ? { 'Content-Type': 'application/json' } : {},
      r.headers || {},
    ),
    body: r.body ? JSON.stringify(r.body) : undefined,
  });
  let token = await ensureAccessToken(s, deps, false);
  let res = await call(token);
  if (res && res.status === 401) {
    token = await ensureAccessToken(s, deps, true);
    res = await call(token);
  } else if (res && (res.status === 429 || res.status === 503)) {
    await sleepOf(deps)(retryAfterMs(res));
    res = await call(token);
  }
  const status = Number(res && res.status) || 0;
  if (status >= 200 && status < 300) return tokenJson(res) || {};
  throw graphHttpError(res);
}

/* ---- flagged mail -> planner items ---- */
// Graph's own pagination link, followed only when it is on Graph's origin.
// The link is server-generated metadata, never mailbox content, but the
// request it feeds carries the bearer token, so a response that named any
// other host (a proxy that terminates TLS, a compromised service) must
// not be able to send the token there. Anything else ends the page walk
// as if there were no next page. Pure; a string in, the string or null.
const GRAPH_ORIGIN = 'https://graph.microsoft.com/';
function graphNextLink(link) {
  const raw = link == null ? '' : String(link);
  return raw.startsWith(GRAPH_ORIGIN) ? raw : null;
}
// The first page. Later pages come from @odata.nextLink, pinned to Graph's
// origin by graphNextLink and otherwise untouched: Graph forbids ordering
// by a property that is not first in the filter, so the list is not
// ordered here (the tray sorts what it shows).
function outlookMessagesQuery() {
  return `$filter=${encodeURIComponent("flag/flagStatus eq 'flagged'")}&$select=id,subject,bodyPreview,from,receivedDateTime,importance,webLink,flag,parentFolderId,conversationId&$top=50`;
}
// Outlook's three levels onto the planner's five, the same rungs ClickUp's
// normal and low land on: high 1, normal 3, low 4.
function outlookPriorityRank(importance) {
  const v = String(importance == null ? '' : importance).toLowerCase();
  if (v === 'high') return 1;
  if (v === 'low') return 4;
  return 3;
}
// One Graph message -> the normalized item every task connector returns.
// Mail carries no due date in this design; the folder id is the list id.
function outlookItemFromMessage(m) {
  const msg = m || {};
  return {
    source: 'outlook',
    id: String(msg.id || ''),
    title: trimmed(msg.subject) || '(no subject)',
    description: String(msg.bodyPreview || '').replace(/\s+$/, ''),
    due: null,
    priority: outlookPriorityRank(msg.importance),
    url: trimmed(msg.webLink) || null,
    tags: [],
    status: msg.flag && msg.flag.flagStatus ? String(msg.flag.flagStatus) : null,
    listId: msg.parentFolderId ? String(msg.parentFolderId) : null,
    recurring: false,
    dueString: null,
    parentId: null,
  };
}
async function outlookFetchOpen(settings, deps) {
  const s = settings || {};
  if (!trimmed(s.outlookClientId)) return degraded('outlook', 'no-token', 'Outlook is not connected (no client id).');
  if (!outlookSignedIn(s)) return degraded('outlook', 'no-token', 'Outlook is not signed in.');
  try {
    const items = [];
    let url = `${GRAPH_BASE}/me/messages?${outlookMessagesQuery()}`;
    let refused = false;
    for (let page = 0; page < 10 && url; page++) {
      const data = await graphRequest(s, deps, { url });
      for (const m of Array.isArray(data.value) ? data.value : []) {
        const it = outlookItemFromMessage(m);
        if (it.id) items.push(it);
      }
      const next = data['@odata.nextLink'];
      url = graphNextLink(next);
      // Graph offered a link the origin guard would not follow. Ending the
      // walk is still right (the bearer token stays on Graph's origin), but
      // what is left behind is a window onto the mailbox, not the mailbox.
      if (next && !url) { refused = true; break; }
    }
    if (refused) {
      return okResult('outlook', items, 'sync incomplete, the next page was offered from another host and refused, so nothing was marked done.', false);
    }
    // Still holding a link after the last allowed page: the cap was reached
    // and there is more flagged mail than was read.
    if (url) return okResult('outlook', items, truncatedWarning(items.length), false);
    return okResult('outlook', items);
  } catch (e) {
    return degraded('outlook', (e && e.reason) || 'unreachable', (e && e.message) || 'Outlook is unreachable.', e && e.hint);
  }
}
// The one write: the flag status. complete on close, flagged on reopen.
// Refused here, before any call, when the sign-in never granted the write
// permission; the toggle's own hint says how to grant it.
async function outlookSetClosed(settings, item, closed, deps) {
  const s = settings || {};
  if (!outlookSignedIn(s)) throw new Error('Outlook is not signed in');
  if (!outlookHasWriteScope(s)) throw new Error('Outlook has not granted the Mail.ReadWrite permission yet: sign in again under Outlook in the settings');
  await graphRequest(s, deps, {
    url: `${GRAPH_BASE}/me/messages/${encodeURIComponent(String(item.id))}`,
    method: 'PATCH',
    body: { flag: { flagStatus: closed ? 'complete' : 'flagged' } },
  });
}

// Is this message still in the mailbox? "Deleted" for a mail connector means
// the message is no longer there at all (moved to Deleted Items counts: the
// id changes on a move, so Graph answers 404 for the old one). A message
// that is still there but no longer flagged is not deleted, it is completed,
// and reconcile handles that as it always has.
async function outlookProbeGone(settings, item, deps) {
  const s = settings || {};
  if (!outlookSignedIn(s)) return null;
  try {
    await graphRequest(s, deps, {
      url: `${GRAPH_BASE}/me/messages/${encodeURIComponent(String(item.id))}?$select=id`,
      method: 'GET',
    });
    return false;
  } catch (e) {
    return isGoneError(e) ? true : null;
  }
}

// The settings tab's one line on the sign-in.
function outlookStatusText(settings) {
  const s = settings || {};
  if (!trimmed(s.outlookClientId)) return 'Paste your Application (client) ID above, then sign in.';
  if (!outlookSignedIn(s)) return 'Not signed in. Sign in opens Microsoft in your browser and brings you back here.';
  const base = `Signed in as ${trimmed(s.outlookAccount) || 'your Microsoft account'}.`;
  if (s.completeOnSource === true && !outlookHasWriteScope(s)) return `${base} Flag changes need one more permission (Mail.ReadWrite): sign in again to grant it.`;
  return base;
}

/* ---- the Outlook calendar through calendarView ---- */
// The window: from a week before the earliest week the board shows (or
// this week) to two weeks past the latest one. Day strings, end exclusive.
function graphCalendarWindow(today, visibleWeekStarts) {
  const starts = [mondayOf(today)]
    .concat((visibleWeekStarts || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))).map((d) => mondayOf(String(d))))
    .sort();
  return { startDay: addDays(starts[0], -7), endDay: addDays(starts[starts.length - 1], 7 + 14) };
}
const localDayStart = (day) => { const [y, m, d] = String(day).split('-').map(Number); return new Date(y, m - 1, d); };
// The query string for one window. The bounds carry a trailing Z: Graph
// reads them by the offset they state, whatever the Prefer header says.
function graphCalendarQuery(win) {
  const start = localDayStart(win.startDay).toISOString();
  const end = localDayStart(win.endDay).toISOString();
  return `startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$select=id,subject,bodyPreview,start,end,isAllDay,location,onlineMeeting,isOnlineMeeting,webLink,importance&$top=200`;
}
// A Graph dateTimeTimeZone -> the ICS-shaped timed date. The trap: with
// Prefer: outlook.timezone="UTC" the string comes back WITHOUT a trailing Z
// even though it is UTC, so it is read as UTC explicitly, never handed to
// new Date() to guess local time. Any other zone Microsoft names goes
// through the same resolver the ICS path uses; one it cannot resolve is
// read as UTC and flagged, never guessed with confidence.
function graphInstant(x) {
  const raw = String((x && x.dateTime) || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  const parts = [+y, +mo, +d, +hh, +mm, +ss];
  const utc = () => new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]));
  if (zone === 'Z') return { allDay: false, day: null, instant: utc(), tzUnresolved: null };
  if (zone) return { allDay: false, day: null, instant: new Date(`${y}-${mo}-${d}T${hh}:${mm}:${ss}${zone}`), tzUnresolved: null };
  const tz = trimmed(x && x.timeZone) || 'UTC';
  if (/^utc$/i.test(tz)) return { allDay: false, day: null, instant: utc(), tzUnresolved: null };
  const r = resolveTzid(tz, null);
  if (r.tz) {
    try { return { allDay: false, day: null, instant: zonedToUtc(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], r.tz), tzUnresolved: null }; } catch { /* flagged below */ }
  }
  if (r.fixedOffsetMin != null) return { allDay: false, day: null, instant: new Date(utc().getTime() - r.fixedOffsetMin * 60000), tzUnresolved: null };
  return { allDay: false, day: null, instant: utc(), tzUnresolved: tz };
}
function graphAllDay(x) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String((x && x.dateTime) || ''));
  if (!m) return null;
  return { allDay: true, day: `${m[1]}-${m[2]}-${m[3]}`, instant: new Date(+m[1], +m[2] - 1, +m[3]), tzUnresolved: null };
}
// One calendarView row -> one def in the ICS def shape, marked expanded: no
// rrule, no exdates, no override; the server already unrolled the series.
// The meeting link is stated as such (conferenceUrl) only when Graph says
// the event is an online meeting; otherwise the key is absent.
function graphEventDef(ev) {
  if (!ev || !ev.id || !ev.start) return null;
  const allDay = ev.isAllDay === true;
  const start = allDay ? graphAllDay(ev.start) : graphInstant(ev.start);
  if (!start) return null;
  const end = ev.end ? (allDay ? graphAllDay(ev.end) : graphInstant(ev.end)) : null;
  const def = {
    uid: String(ev.id),
    title: trimmed(ev.subject) || '(no title)',
    description: String(ev.bodyPreview || ''),
    location: trimmed(ev.location && ev.location.displayName) || null,
    url: trimmed(ev.webLink) || null,
    start, end,
    rrule: null, exdates: new Set(), recurrenceDay: null,
    tzUnresolved: start.tzUnresolved || (end && end.tzUnresolved) || null,
    expanded: true,
  };
  const join = ev.isOnlineMeeting === true && ev.onlineMeeting ? trimmed(ev.onlineMeeting.joinUrl) : '';
  if (join) def.conferenceUrl = join;
  return def;
}
async function outlookCalendarFetchFeed(feed, settings, deps) {
  const s = settings || {};
  if (!outlookSignedIn(s)) return degraded('outlook-calendar', 'no-token', 'Outlook calendar is not connected (not signed in).');
  try {
    const win = graphCalendarWindow(todayStr(), deps && deps.visibleWeekStarts);
    const defs = [];
    let url = `${GRAPH_BASE}/me/calendarView?${graphCalendarQuery(win)}`;
    for (let page = 0; page < 10 && url; page++) {
      const data = await graphRequest(s, deps, { url, headers: { Prefer: 'outlook.timezone="UTC"' } });
      for (const ev of Array.isArray(data.value) ? data.value : []) {
        const d = graphEventDef(ev);
        if (d) defs.push(d);
      }
      url = graphNextLink(data['@odata.nextLink']);
    }
    return okResult('outlook-calendar', tagCalendarDefs(defs, feed), calendarTzWarning(defs));
  } catch (e) {
    return degraded('outlook-calendar', (e && e.reason) || 'unreachable', (e && e.message) || 'Outlook calendar is unreachable.', e && e.hint);
  }
}


/* ========================================================================== *
 * Connector: starred email over IMAP (Superhuman = the Gmail/Outlook account
 * underneath; a Superhuman star IS the Gmail star, so IMAP \Flagged reads it).
 * Minimal hand-rolled IMAP client: strictly read-only - EXAMINE (not SELECT),
 * UID SEARCH FLAGGED, UID FETCH of header fields only. No STORE, ever.
 * ========================================================================== */

// Parse an IMAP server stream into complete "entries" respecting {n} literals.
// Returns { lines: [...], rest: bufferedRemainder }. Each entry is the raw text
// of one response line WITH any literal payloads inlined after their marker.
function imapSplitResponses(buf) {
  const entries = [];
  let i = 0;
  while (true) {
    // find CRLF
    const nl = buf.indexOf('\r\n', i);
    if (nl === -1) break;
    let line = buf.slice(i, nl);
    let consumed = nl + 2;
    // literal continuation: line ends with {n}
    let m = /\{(\d+)\}$/.exec(line);
    let full = line;
    let cursor = consumed;
    let incomplete = false;
    while (m) {
      const n = Number(m[1]);
      if (buf.length < cursor + n) { incomplete = true; break; }
      const literal = buf.slice(cursor, cursor + n);
      cursor += n;
      const nl2 = buf.indexOf('\r\n', cursor);
      if (nl2 === -1) { incomplete = true; break; }
      const tail = buf.slice(cursor, nl2);
      cursor = nl2 + 2;
      full += '\n' + literal + tail;
      m = /\{(\d+)\}$/.exec(tail);
    }
    if (incomplete) break;
    entries.push(full);
    i = cursor;
  }
  return { entries, rest: buf.slice(i) };
}

function imapQuote(s) {
  // CR and LF cannot appear in a quoted string (RFC 3501 section 9);
  // dropping them keeps the login on one line whatever data.json says.
  return '"' + String(s).replace(/[\r\n]/g, '').replace(/([\\"])/g, '\\$1') + '"';
}

// An IMAP UID is a non-zero 32-bit number (RFC 3501 2.3.1.1). The star write
// puts it on a command line, so anything else is refused here, before a
// socket opens: a note's external_id is vault content, written by any
// editor, agent or sync, and the wire format is line based. The read side
// only ever produces digits (imapFetchStarredRaw). The message echoes at
// most 40 characters of the value, never a credential.
function imapUidOrThrow(uid) {
  const v = String(uid == null ? '' : uid);
  if (!/^[1-9]\d{0,9}$/.test(v) || Number(v) > 4294967295) {
    throw new Error(`invalid IMAP uid ${JSON.stringify(v).slice(0, 40)}`);
  }
  return v;
}

/* ---- IMAP failure classification (2026-09-04) ------------------------------
 *
 * "IMAP login failed" was the whole story for four different failures: bad
 * credentials, credentials fine but the provider wants an APP password,
 * a certificate problem, and a network problem. Gmail literally answers
 * "NO [ALERT] Application-specific password required: <url>", and that text
 * was thrown away. Now the server's tagged reply and the stage ride the
 * Error, a pure classifier names the failure, and the provider table adds
 * the one sentence that unblocks the common case.
 */

// Host -> provider. `hint` is what to do; `appPasswordUrl` is where. Only
// URLs verified against the provider's own pages are linked; the rest name
// the path inside the app in words.
const IMAP_PROVIDERS = [
  {
    // Proton Bridge listens on the machine itself; a loopback host IS the
    // provider. The password is the one Bridge generates and shows, never
    // the Proton account password.
    id: 'proton-bridge', label: 'Proton Bridge', test: (h) => isLoopbackHost(h),
    appPasswordUrl: null,
    hint: 'Use the mailbox password shown inside the Bridge app, not your Proton password. Bridge must be running.',
  },
  {
    id: 'gmail', label: 'Gmail', test: /gmail|googlemail/i,
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    hint: 'Gmail needs an app password, not your account password. Turn on 2-step verification, then create one at myaccount.google.com/apppasswords.',
  },
  {
    id: 'icloud', label: 'iCloud', test: /imap\.mail\.me\.com|icloud|mac\.com|me\.com/i,
    appPasswordUrl: 'https://account.apple.com/account/manage',
    hint: 'iCloud needs an app-specific password, not your Apple Account password. Create one at account.apple.com under Sign-In and Security, App-Specific Passwords.',
  },
  {
    id: 'outlook', label: 'Outlook / Microsoft 365', test: /outlook|office365|office\.com|hotmail|live\.com/i,
    appPasswordUrl: null,
    hint: 'Microsoft retired password sign-in for IMAP, so Outlook and Microsoft 365 mailboxes cannot connect here yet; they need OAuth, which is on the way. Todoist, ClickUp and the calendar still sync.',
  },
  {
    id: 'fastmail', label: 'Fastmail', test: /fastmail/i,
    appPasswordUrl: null,
    hint: 'Fastmail needs an app password: Settings, Privacy & Security, Integrations, then New app password.',
  },
  {
    id: 'gmx', label: 'GMX', test: /gmx\./i,
    appPasswordUrl: null,
    hint: 'GMX: turn on IMAP in the webmail settings first (E-Mail, Einstellungen, POP3/IMAP Abruf).',
  },
  {
    id: 'webde', label: 'web.de', test: /web\.de/i,
    appPasswordUrl: null,
    hint: 'web.de: turn on IMAP in the webmail settings first (E-Mail, Einstellungen, POP3/IMAP).',
  },
  {
    id: 'yahoo', label: 'Yahoo', test: /yahoo|ymail/i,
    appPasswordUrl: null,
    hint: 'Yahoo needs an app password: Account Info, Account Security, Generate app password.',
  },
];
const IMAP_GENERIC_PROVIDER = { id: 'generic', label: 'IMAP', appPasswordUrl: null, hint: null };

function imapProviderOf(host) {
  const h = String(host == null ? '' : host).trim();
  if (!h) return IMAP_GENERIC_PROVIDER;
  for (const p of IMAP_PROVIDERS) {
    const hit = typeof p.test === 'function' ? p.test(h) : p.test.test(h);
    if (hit) return { id: p.id, label: p.label, appPasswordUrl: p.appPasswordUrl, hint: p.hint };
  }
  return IMAP_GENERIC_PROVIDER;
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

// err -> { reason, message, hint, docUrl }. Reasons: auth, auth-app-password,
// auth-oauth-required, tls, dns, refused, timeout, protocol, unsupported.
// Pure: reads err.message / err.code / err.stage / err.serverText and the
// host, touches nothing else.
function classifyImapError(err, host, opts) {
  const e = err || {};
  const port = (opts && opts.port) || 993;
  const msg = String(e.message || '');
  const code = String(e.code || '');
  const serverText = String(e.serverText || '');
  const provider = imapProviderOf(host);
  const out = (reason, message, hint, docUrl) => ({ reason, message, hint: hint || null, docUrl: docUrl || null });
  if (/tls unavailable/i.test(msg)) {
    return out('unsupported', 'Starred email needs the desktop app (IMAP). Todoist, ClickUp and Calendar still sync here.');
  }
  if (provider.id === 'outlook') {
    return out('auth-oauth-required', 'Outlook / Microsoft 365 cannot sign in with a password over IMAP.', provider.hint);
  }
  if (e.stage === 'starttls') {
    return out('protocol', 'The IMAP host does not offer STARTTLS on this port.',
      'Switch the security setting to TLS, or use the port the host offers STARTTLS on. The login was not sent.');
  }
  if (e.stage === 'login' || /^auth$/i.test(msg)) {
    if (/app(lication)?[- ]specific password|app password/i.test(serverText)) {
      const urlInReply = (/https?:\/\/\S+/.exec(serverText) || [null])[0];
      return out('auth-app-password',
        `IMAP login failed: ${provider.label} wants an app password, not your account password.`,
        provider.hint || 'Create an app password in your mail provider\'s security settings and paste it here instead of your normal password.',
        provider.appPasswordUrl || urlInReply);
    }
    if (/AUTHENTICATE|OAuth/i.test(serverText)) {
      return out('auth-oauth-required', 'IMAP login failed: this mailbox wants OAuth sign-in, which this version cannot do.', provider.hint);
    }
    return out('auth', 'IMAP login failed. Check the address and the app password.', provider.hint, provider.appPasswordUrl);
  }
  if (TLS_ERROR_CODES.has(code) || /certificate|self.signed/i.test(msg)) {
    return out('tls', 'The IMAP host presented a certificate this app does not trust.',
      isLoopbackHost(host)
        ? 'A local bridge uses its own certificate. Turn on "Accept a self-signed certificate" (it only ever applies to a host on this machine).'
        : 'A self-signed or expired certificate, or a host name that does not match it. Check the host name; a company or local mail server may need its certificate installed on this machine.');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return out('dns', 'IMAP host not found.', 'Check the host name for typos.');
  }
  if (code === 'ECONNREFUSED' || /server refused/i.test(msg)) {
    return out('refused', 'IMAP host refused the connection.',
      provider.id === 'proton-bridge' ? provider.hint : `Check that the host accepts IMAP on port ${port}.`);
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return out('timeout', 'IMAP host did not answer in time.', 'Check the network, then the host name.');
  }
  return out('protocol', `IMAP host answered unexpectedly${serverText ? ` (${serverText.slice(0, 80)})` : ''}.`);
}

// Provider presets: one click fills the host and the connection shape for
// the providers people actually use. `imapPresetFields` maps a preset onto
// the settings keys; `imapActivePreset` says which chip is pressed.
const IMAP_PRESETS = [
  { id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993, security: 'tls', allowSelfSigned: false },
  { id: 'icloud', label: 'iCloud', host: 'imap.mail.me.com', port: 993, security: 'tls', allowSelfSigned: false },
  { id: 'fastmail', label: 'Fastmail', host: 'imap.fastmail.com', port: 993, security: 'tls', allowSelfSigned: false },
  { id: 'proton-bridge', label: 'Proton Bridge', host: '127.0.0.1', port: 1143, security: 'starttls', allowSelfSigned: true },
];
function imapPresetFields(preset) {
  return { imapHost: preset.host, imapPort: preset.port, imapSecurity: preset.security, imapAllowSelfSigned: preset.allowSelfSigned };
}
function imapActivePreset(settings) {
  const opts = imapTransportOptions(settings);
  const hit = IMAP_PRESETS.find((p) => p.host === opts.host && p.port === opts.port && p.security === opts.security);
  return hit ? hit.id : null;
}

// A host on this machine: the only place a self-signed certificate may be
// accepted. 127.0.0.0/8, ::1 and localhost; nothing that merely starts
// with those (127.0.0.1.example.com is a remote host).
function isLoopbackHost(host) {
  const h = trimmed(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
// An IP literal gets no SNI server name: node rejects a servername that is
// not a host name, and there is no name to verify against anyway.
function isIpLiteral(host) {
  const h = trimmed(host).replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

// Transport parameters for the mailbox, read once off the settings. Pure.
// The port is clamped to a valid one (else 993), the security to one of the
// two modes (else implicit TLS), and the self-signed allowance is dropped
// here already unless the host is loopback, so a hand-edited data.json
// cannot widen it to a remote host.
function imapTransportOptions(settings) {
  const s = settings || {};
  const host = trimmed(s.imapHost);
  const portN = Number(s.imapPort);
  const port = Number.isInteger(portN) && portN > 0 && portN < 65536 ? portN : 993;
  const security = s.imapSecurity === 'starttls' ? 'starttls' : 'tls';
  const allowSelfSigned = !!s.imapAllowSelfSigned && isLoopbackHost(host);
  return { host, port, security, allowSelfSigned };
}

// The object handed to tls.connect: a direct connection (host + port) or an
// upgrade of an already-open plain socket (STARTTLS). Pure, so the suite
// can read what the transport would be asked to do. Certificate
// verification is on unless the allowance holds AND the host is loopback;
// the second check is deliberate belt over braces.
function imapTlsOptions(opts, socket) {
  const o = { rejectUnauthorized: !(opts.allowSelfSigned && isLoopbackHost(opts.host)) };
  if (socket) o.socket = socket; else { o.host = opts.host; o.port = opts.port; }
  if (!isIpLiteral(opts.host)) o.servername = opts.host;
  return o;
}

// The server would not upgrade: the login is never sent in the clear.
function imapStarttlsError(statusLine) {
  return Object.assign(new Error('server does not offer STARTTLS'), { stage: 'starttls', serverText: String(statusLine || '') });
}

// The one place a mailbox socket is opened, for every session. Resolves
// { socket, greeted }: `greeted` says whether the server's greeting line was
// already consumed here (STARTTLS: yes, the plain greeting was read to get
// the upgrade; implicit TLS: no, the session waits for it). `deps.tls` and
// `deps.net` let a test script the transport, or prove no socket was opened
// at all. Rejects 'tls unavailable' where the runtime has no tls module
// (the mobile app).
//
// The two Node modules below are asked for only on desktop, and the check
// is the first statement of the function: that is the guard shape the
// community directory's scanner recognises for a plugin that keeps
// isDesktopOnly false. The mobile app rejects here, before any require, and
// the caller reports the source as unsupported.
//
// STARTTLS: plain connect, read `* OK`, send `A0 STARTTLS`, and ONLY on
// `A0 OK` wrap the socket in TLS. Any other answer (BAD, NO, a PREAUTH
// greeting) rejects before a LOGIN exists; there is no plaintext fallback.
function imapConnect(opts, deps) {
  if (!Platform.isDesktop) return Promise.reject(new Error('tls unavailable'));
  return new Promise((resolve, reject) => {
    let tlsMod = deps && deps.tls;
    if (!tlsMod) { try { tlsMod = require('tls'); } catch { return reject(new Error('tls unavailable')); } }
    // The one raw TLS call site: a direct connection (no plain socket) or
    // the upgrade of one.
    const secure = (plainSocket) => tlsMod.connect(imapTlsOptions(opts, plainSocket));
    if (opts.security !== 'starttls') {
      let socket;
      try { socket = secure(null); } catch (e) { return reject(e); }
      return resolve({ socket, greeted: false });
    }
    let netMod = deps && deps.net;
    if (!netMod) { try { netMod = require('net'); } catch { return reject(new Error('tls unavailable')); } }
    let plain;
    try { plain = netMod.connect({ host: opts.host, port: opts.port }); } catch (e) { return reject(e); }
    let buffer = '';
    let phase = 'greeting';
    let settled = false;
    const abort = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { plain.destroy(); } catch { /* already gone: the teardown is best effort */ }
      reject(err);
    };
    const timer = setTimeout(() => abort(new Error('timeout')), 15000);
    const onError = (err) => abort(err);
    const onData = (chunk) => {
      buffer += chunk.toString('binary');
      const { entries, rest } = imapSplitResponses(buffer);
      buffer = rest;
      for (const entry of entries) {
        if (settled) return;
        if (phase === 'greeting') {
          if (entry.startsWith('* BYE')) return abort(new Error('server refused connection'));
          if (entry.startsWith('* PREAUTH')) return abort(imapStarttlsError(entry));
          if (entry.startsWith('* OK')) { phase = 'starttls'; plain.write('A0 STARTTLS\r\n'); }
          continue;
        }
        if (phase === 'starttls' && entry.startsWith('A0 ')) {
          if (!entry.startsWith('A0 OK')) return abort(imapStarttlsError(entry));
          settled = true;
          clearTimeout(timer);
          plain.removeListener('data', onData);
          plain.removeListener('error', onError);
          let socket;
          try { socket = secure(plain); } catch (e) { try { plain.destroy(); } catch { /* already gone: the TLS failure is what we report */ } return reject(e); }
          return resolve({ socket, greeted: true });
        }
      }
    };
    plain.on('data', onData);
    plain.on('error', onError);
  });
}

// A tagged non-OK reply as an Error that keeps what the server said and
// where in the session it said it; the classifier reads both.
function imapReplyError(stage, statusLine) {
  return Object.assign(new Error(stage === 'login' ? 'auth' : `imap ${stage} failed`), {
    stage, serverText: String(statusLine || ''),
  });
}

// One IMAP session, the only state machine the mailbox ever meets. Connects,
// waits for the greeting, LOGINs, runs `steps` in order, LOGOUTs, resolves
// the shared `ctx`. A step is { stage, cmd(ctx) -> string | null,
// untagged?(entry, ctx) }: `cmd` returning null ends the session early
// (nothing left to ask, for instance no starred mail to fetch). A tagged
// non-OK reply rejects with imapReplyError(stage, line); a `* BYE` greeting
// rejects 'server refused connection'; 20 s of silence rejects 'timeout'.
// The read, the star write and the probe are step lists over this one
// machine, so their greeting / login / error handling cannot drift apart.
function imapSession(opts, user, pass, steps, deps) {
  return new Promise((resolve, reject) => {
    const ctx = {};
    let socket = null;
    let buffer = '';
    let stage = 'connect';
    let tagN = 0;
    let pendingTag = null;
    let stepIndex = -1;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) { try { socket.destroy(); } catch { /* already gone: the failure we report is the one above */ } }
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch { /* already closed: the session succeeded either way */ }
      resolve(ctx);
    };
    const timer = setTimeout(() => fail(new Error('timeout')), 20000);
    const send = (cmd) => {
      tagN += 1;
      pendingTag = `A${tagN}`;
      socket.write(`${pendingTag} ${cmd}\r\n`);
    };
    const login = () => { stage = 'login'; send(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`); };
    const logout = () => { stage = 'logout'; send('LOGOUT'); };
    const next = () => {
      stepIndex += 1;
      if (stepIndex >= steps.length) return logout();
      const step = steps[stepIndex];
      let cmd;
      try { cmd = step.cmd(ctx); } catch (e) { return fail(e); }
      if (cmd == null) return logout();
      stage = step.stage;
      send(cmd);
    };
    const onEntry = (entry) => {
      if (stage === 'greeting') {
        if (entry.startsWith('* OK') || entry.startsWith('* PREAUTH')) return login();
        if (entry.startsWith('* BYE')) return fail(new Error('server refused connection'));
        return;
      }
      if (pendingTag && entry.startsWith(`${pendingTag} `)) {
        if (!entry.startsWith(`${pendingTag} OK`)) return fail(imapReplyError(stage, entry));
        if (stage === 'logout') return finish();
        return next();
      }
      const step = stepIndex >= 0 ? steps[stepIndex] : null;
      if (step && step.untagged && entry.startsWith('* ')) {
        try { step.untagged(entry, ctx); } catch (e) { fail(e); }
      }
    };
    imapConnect(opts, deps).then(({ socket: sock, greeted }) => {
      if (settled) { try { sock.destroy(); } catch { /* already gone: we timed out before the connect landed */ } return; }
      socket = sock;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('binary');
        const { entries, rest } = imapSplitResponses(buffer);
        buffer = rest;
        for (const entry of entries) { if (settled) break; onEntry(entry); }
      });
      socket.on('error', (err) => fail(err));
      if (greeted) login(); else stage = 'greeting';
    }, fail);
  });
}

// Raw FETCH entries (header block inlined after the first newline) to the
// normalized item shape, newest first. Pure.
function imapItemsFromFetch(fetched, host) {
  const items = [];
  for (const entry of fetched) {
    const um = /UID (\d+)/.exec(entry);
    const uid = um ? um[1] : null;
    if (!uid) continue;
    const headerText = entry.includes('\n') ? entry.slice(entry.indexOf('\n') + 1) : '';
    const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
    const header = (name) => {
      const hm = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
      return hm ? hm[1].trim() : null;
    };
    const subject = decodeRfc2047(header('Subject') || '') || '(no subject)';
    const from = decodeRfc2047(header('From') || '');
    const date = header('Date');
    const messageId = (header('Message-ID') || '').replace(/^<|>$/g, '');
    const dateLine = date ? (() => { const d = new Date(date); return isNaN(d) ? null : localDayStr(d); })() : null;
    let url = null;
    if (/gmail|googlemail/i.test(host) && messageId) {
      url = `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(messageId)}`;
    }
    items.push({
      source: 'email',
      id: String(uid),
      title: subject,
      description: [from && `From: ${from}`, dateLine && `Received: ${dateLine}`].filter(Boolean).join('\n'),
      due: null,
      priority: 4,
      url,
      tags: [],
      status: null,
      recurring: false,
      dueString: null,
      // The one identifier a mailbox rebuild cannot change (RFC 5322 3.6.4:
      // globally unique, set by the sending host, never rewritten). The UID
      // is the identity; this is what re-finds the mail when the UID is
      // renumbered out from under the vault.
      messageId: messageId || null,
    });
  }
  items.reverse(); // newest first
  return items;
}

// The read script: EXAMINE (read-only), UID SEARCH FLAGGED, one UID FETCH
// of header fields only. Returns normalized task items.
// `report` (optional) is filled with what the session learned about the set
// as a whole, beside the items it returns: `flagged` is how many UIDs the
// SEARCH found, which is not the same as how many the FETCH read.
function imapFetchStarredRaw(opts, user, pass, maxItems, deps, report) {
  const steps = [
    {
      stage: 'examine', cmd: () => 'EXAMINE INBOX',
      // Every UID below belongs to this generation of the mailbox and to no
      // other. Recorded here, checked again by the probe.
      untagged: (entry, ctx) => { const v = imapUidValidityOf(entry); if (v) ctx.uidValidity = v; },
    },
    {
      stage: 'search', cmd: () => 'UID SEARCH FLAGGED',
      untagged: (entry, ctx) => {
        if (entry.startsWith('* SEARCH')) ctx.uids = entry.slice(8).trim().split(/\s+/).filter((x) => /^\d+$/.test(x));
      },
    },
    {
      stage: 'fetch',
      cmd: (ctx) => {
        const uids = ctx.uids || [];
        if (!uids.length) return null;
        return `UID FETCH ${uids.slice(-maxItems).join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)])`;
      },
      untagged: (entry, ctx) => {
        if (/^\* \d+ FETCH/.test(entry)) (ctx.fetched = ctx.fetched || []).push(Buffer.from(entry, 'binary').toString('utf8'));
      },
    },
  ];
  return imapSession(opts, user, pass, steps, deps).then((ctx) => {
    if (report) {
      report.flagged = (ctx.uids || []).length;
      report.uidValidity = ctx.uidValidity || null;
    }
    return imapItemsFromFetch(ctx.fetched || [], opts.host);
  });
}

// Classifier reason -> connector reason (the contract the UI renders).
function imapReasonToConnector(reason) {
  if (reason === 'no-token') return 'no-token';
  if (reason === 'unsupported') return 'unsupported';
  if (/^auth/.test(reason)) return 'misconfigured';
  return 'unreachable';
}

// What can be said before any socket opens. Pure. Returns null when a
// session is worth trying, else { reason, message, hint, docUrl } in the
// classifier's shape: missing fields, or a host that can never accept a
// password (the failure is known, and a 20 s timeout teaches nothing).
function imapPreflight(opts, user, pass) {
  if (!opts.host || !user || !pass) {
    return { reason: 'no-token', message: 'Starred email is not connected (host, address or app password missing).', hint: null, docUrl: null };
  }
  if (imapProviderOf(opts.host).id === 'outlook') {
    return classifyImapError({ message: 'auth', stage: 'login' }, opts.host, opts);
  }
  return null;
}

// The FETCH takes the newest `EMAIL_MAX_ITEMS` of the flagged set. A mailbox
// with more starred mail than that loses its OLDEST stars from the open set,
// which is precisely the mail most likely to look finished.
const EMAIL_MAX_ITEMS = 50;

async function emailFetchStarred(settings, deps) {
  const opts = imapTransportOptions(settings);
  const user = trimmed(settings.imapUser);
  const pass = trimmed(settings.imapPassword);
  const early = imapPreflight(opts, user, pass);
  if (early) return degraded('email', imapReasonToConnector(early.reason), early.message, early.hint, early.docUrl);
  try {
    const report = {};
    const items = await imapFetchStarredRaw(opts, user, pass, EMAIL_MAX_ITEMS, deps, report);
    const flagged = Number(report.flagged) || 0;
    const out = flagged > EMAIL_MAX_ITEMS
      ? okResult('email', items, `sync incomplete, ${flagged} starred mails but only the newest ${EMAIL_MAX_ITEMS} were read, so nothing was marked done.`, false)
      : okResult('email', items);
    // The generation these UIDs belong to, carried to the shadow the way
    // ClickUp carries its scope: it is the question this answer answered.
    if (report.uidValidity) out.uidValidity = report.uidValidity;
    return out;
  } catch (e) {
    const c = classifyImapError(e, opts.host, opts);
    return degraded('email', imapReasonToConnector(c.reason), c.message, c.hint, c.docUrl);
  }
}

// The probe behind the settings tab's Test connection: LOGIN, then LOGOUT.
// It proves the host, the port, the certificate and the credentials, and it
// never reads a mailbox (no EXAMINE, no SEARCH, no SELECT). Same preflight
// and same classifier as the sync, so the two can never disagree.
async function imapProbe(settings, deps) {
  const opts = imapTransportOptions(settings);
  const user = trimmed(settings.imapUser);
  const pass = trimmed(settings.imapPassword);
  const out = (ok, c) => ({ ok, reason: c.reason || null, message: c.message, hint: c.hint || null, docUrl: c.docUrl || null });
  const early = imapPreflight(opts, user, pass);
  if (early) return out(false, early);
  try {
    await imapSession(opts, user, pass, [], deps);
    return out(true, { message: `Connected as ${user}.` });
  } catch (e) {
    return out(false, classifyImapError(e, opts.host, opts));
  }
}

// The star-write script. Set or clear \Flagged on one message: the ONLY
// write the mailbox ever sees, armed by completeOnSource. SELECT (not
// EXAMINE) + exactly one UID STORE.
function imapSetStarredRaw(opts, user, pass, uid, starred, deps) {
  // The uid is checked before anything else happens: a refused one never
  // opens a socket, and the rejection reaches the caller's notice.
  let safeUid;
  try { safeUid = imapUidOrThrow(uid); } catch (e) { return Promise.reject(e); }
  const steps = [
    { stage: 'select', cmd: () => 'SELECT INBOX' },
    { stage: 'store', cmd: () => `UID STORE ${safeUid} ${starred ? '+' : '-'}FLAGS (\\Flagged)` },
  ];
  return imapSession(opts, user, pass, steps, deps).then(() => undefined);
}

/* ---- UIDVALIDITY: is this UID still worth asking about? (0.15.1) --------
 * RFC 3501 2.3.1.1: a mailbox carries a generation number, and "if unique
 * identifiers from an earlier session fail to persist, the UIDVALIDITY value
 * MUST be greater". A Dovecot rebuild, an Exchange or iCloud migration, a
 * mailbox restored from backup: after one of those every UID the vault holds
 * points at nothing, and the probe's own signal for "no such message" (an
 * empty FETCH, 6.4.8) fires for every starred-email note at once.
 *
 * Absence of the message and absence of the whole numbering are not the same
 * fact, and only the first one may trash a note. So the fetch records the
 * generation, the probe reads it again, and a mismatch resolves to null,
 * which absenceVerdict maps to the harmless completion path. Gmail keeps
 * UIDVALIDITY stable in practice; nothing in the protocol promises it.
 */
function imapUidValidityOf(entry) {
  const m = /^\* OK \[UIDVALIDITY (\d+)\]/i.exec(String(entry == null ? '' : entry));
  return m ? m[1] : null;
}
// Pure. 'same' -> the UID means what it meant, the probe's answer stands.
// 'rebuilt' -> every stored UID is meaningless, the probe knows nothing.
// 'unknown' -> no baseline on one side (a note stamped before 0.15.1, or a
// server that sent no code): behave exactly as the release before this one.
function uidValidityVerdict(stored, live) {
  if (stored == null || stored === '' || live == null || live === '') return 'unknown';
  return String(stored) === String(live) ? 'same' : 'rebuilt';
}

// Is this UID still in the mailbox? EXAMINE, not SELECT: the probe is
// strictly read-only and adds no write surface to the one UID STORE the
// star toggle already owns. An absent UID makes the server answer the FETCH
// with no untagged FETCH line at all, which is the signal.
//
// "Deleted" for IMAP means the message is no longer in INBOX: expunged, or
// moved to another folder, which is the same thing for a planner whose whole
// question is INBOX. A message still in INBOX but unstarred is completed,
// not deleted, and reconcile owns that case as before.
// `wantUidValidity` is the generation the note's UID was fetched under. A
// mailbox answering with a different one has renumbered, and the answer to
// "is UID 42 there" is then meaningless rather than negative: null, never
// true (Flint, 2026-09-17, finding 3).
function imapProbeGoneRaw(opts, user, pass, uid, deps, wantUidValidity) {
  let safeUid;
  try { safeUid = imapUidOrThrow(uid); } catch (e) { return Promise.reject(e); }
  let seen = false;
  let live = null;
  const steps = [
    {
      stage: 'select', cmd: () => 'EXAMINE INBOX',
      untagged: (entry) => { const v = imapUidValidityOf(entry); if (v) live = v; },
    },
    {
      stage: 'fetch',
      cmd: () => `UID FETCH ${safeUid} (UID)`,
      untagged: (entry) => { if (/\bFETCH\b/i.test(entry)) seen = true; },
    },
  ];
  return imapSession(opts, user, pass, steps, deps).then(() => {
    if (uidValidityVerdict(wantUidValidity, live) === 'rebuilt') return null;
    return !seen;
  });
}

// `deps.shadow` is the item's shadow, handed down by probeGoneIds: it carries
// the generation this UID was fetched under. Absent (an older note, another
// caller) the probe behaves as it did before 0.15.1.
async function emailProbeGone(settings, item, deps) {
  const s = settings || {};
  if (!CONNECTORS.email.configured(s)) return null;
  const want = deps && deps.shadow ? deps.shadow.uidvalidity : null;
  try {
    return await imapProbeGoneRaw(imapTransportOptions(s), trimmed(s.imapUser), trimmed(s.imapPassword), item.id, deps, want);
  } catch { return null; }
}

/* ========================================================================== *
 * Connector: Google Calendar via secret ICS URL (read-only, no OAuth).
 * Minimal RFC 5545 parser + best-effort RRULE expansion for the visible week:
 * FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, BYDAY (weekly, and
 * monthly with an optional ordinal such as 3SU or -1FR), UNTIL,
 * COUNT, EXDATE and RECURRENCE-ID overrides. Exotic rules degrade to "shows
 * the master occurrence only", never to a crash.
 * ========================================================================== */

// The parse context: VTIMEZONE blocks collected from the feed (keyed by their
// TZID, raw and normalized) and the calendar-level default zone from
// X-WR-TIMEZONE, itself resolved through the same chain as every TZID.
function parseIcs(text) {
  // Unfold: CRLF (or LF) followed by space/tab continues the line.
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  const ctx = { vtimezones: {}, defaultTz: null };
  let cur = null;       // the open VEVENT
  let vtz = null;       // the open VTIMEZONE
  let vtzPart = null;   // 'STANDARD' | 'DAYLIGHT' while inside one
  let wrTimezone = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { props: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (line === 'BEGIN:VTIMEZONE') { vtz = { tzid: null, standardOffset: null, daylightOffset: null }; vtzPart = null; continue; }
    if (line === 'END:VTIMEZONE') {
      if (vtz && vtz.tzid) {
        ctx.vtimezones[vtz.tzid] = vtz;
        ctx.vtimezones[normalizeTzid(vtz.tzid)] = vtz;
      }
      vtz = null; vtzPart = null;
      continue;
    }
    if (vtz && (line === 'BEGIN:STANDARD' || line === 'BEGIN:DAYLIGHT')) { vtzPart = line.slice(6); continue; }
    if (vtz && (line === 'END:STANDARD' || line === 'END:DAYLIGHT')) { vtzPart = null; continue; }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = left.split(';');
    const params = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    const upper = name.toUpperCase();
    if (vtz) {
      if (upper === 'TZID' && !vtzPart) vtz.tzid = value.trim();
      // Feeds with full history list several STANDARD / DAYLIGHT blocks, oldest
      // first; the last one listed is the rule in force now.
      else if (upper === 'TZOFFSETTO' && vtzPart) {
        const off = icsUtcOffsetToMinutes(value);
        if (off != null) vtz[vtzPart === 'DAYLIGHT' ? 'daylightOffset' : 'standardOffset'] = off;
      }
      continue;
    }
    if (!cur) {
      if (upper === 'X-WR-TIMEZONE') wrTimezone = value.trim();
      continue;
    }
    cur.props.push({ name: upper, params, value });
  }
  if (wrTimezone) ctx.defaultTz = resolveTzid(wrTimezone, ctx).tz || null;
  return events.map((ev) => icsEventDef(ev, ctx)).filter(Boolean);
}

// DTSTART value + params -> { instant: Date|null, day: 'YYYY-MM-DD'|null,
// allDay, tzUnresolved: the TZID as written when no zone could be resolved
// for it (the instant is then the wall clock in the machine's zone) }.
function icsParseDate(value, params, ctx) {
  const isDate = (params.VALUE === 'DATE') || /^\d{8}$/.test(value);
  if (isDate) {
    const y = Number(value.slice(0, 4)), m = Number(value.slice(4, 6)), d = Number(value.slice(6, 8));
    return { allDay: true, day: `${y}-${pad2(m)}-${pad2(d)}`, instant: new Date(y, m - 1, d), tzUnresolved: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (z === 'Z') {
    return { allDay: false, day: null, instant: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)), tzUnresolved: null };
  }
  const c = ctx || {};
  const tzid = params.TZID != null && String(params.TZID).trim() !== '' ? String(params.TZID) : null;
  // A missing TZID on a timed value is a floating time; the calendar's own
  // default zone is the right reading of it when the feed states one.
  const res = tzid
    ? resolveTzid(tzid, c)
    : (c.defaultTz ? { tz: c.defaultTz, fixedOffsetMin: null, unresolved: null } : null);
  if (res && res.tz) {
    try {
      return { allDay: false, day: null, instant: zonedToUtc(+y, +mo, +d, +hh, +mm, +ss, res.tz), tzUnresolved: null };
    } catch { /* the probe passed but the formatter did not: flagged below */ }
  }
  if (res && res.fixedOffsetMin != null) {
    const utc = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) - res.fixedOffsetMin * 60000;
    return { allDay: false, day: null, instant: new Date(utc), tzUnresolved: null };
  }
  // Floating (no TZID, no calendar default) or unresolved: the wall clock in
  // the machine's zone. Only the unresolved case carries a flag; a floating
  // time IS a local time by definition.
  return {
    allDay: false, day: null,
    instant: new Date(+y, +mo - 1, +d, +hh, +mm, +ss),
    tzUnresolved: tzid ? tzid.trim() : null,
  };
}

function icsEventDef(ev, ctx) {
  const prop = (n) => ev.props.find((p) => p.name === n) || null;
  const dtstart = prop('DTSTART');
  if (!dtstart) return null;
  const start = icsParseDate(dtstart.value, dtstart.params, ctx);
  if (!start) return null;
  const dtend = prop('DTEND');
  const end = dtend ? icsParseDate(dtend.value, dtend.params, ctx) : null;
  const rruleProp = prop('RRULE');
  const rrule = rruleProp ? Object.fromEntries(
    rruleProp.value.split(';').map((kv) => {
      const eq = kv.indexOf('=');
      return eq === -1 ? [kv, ''] : [kv.slice(0, eq).toUpperCase(), kv.slice(eq + 1)];
    })
  ) : null;
  const exdates = new Set();
  for (const p of ev.props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const parsed = icsParseDate(v.trim(), p.params, ctx);
      if (parsed) exdates.add(parsed.allDay ? parsed.day : localDayStr(parsed.instant));
    }
  }
  const recurrenceId = prop('RECURRENCE-ID');
  return {
    uid: (prop('UID') || { value: `${dtstart.value}-${Math.abs(hashStr(ev.props.map((p) => p.value).join('|')))}` }).value,
    title: icsUnescape((prop('SUMMARY') || { value: '(no title)' }).value) || '(no title)',
    description: icsUnescape((prop('DESCRIPTION') || { value: '' }).value),
    location: icsUnescape((prop('LOCATION') || { value: '' }).value) || null,
    url: ((prop('URL') || { value: '' }).value || '').trim() || null,
    start, end, rrule, exdates,
    // The TZID as written when start or end could not be resolved; the board,
    // the modal and the cache all carry it so the fallback is never silent.
    tzUnresolved: start.tzUnresolved || (end && end.tzUnresolved) || null,
    recurrenceDay: recurrenceId ? (() => {
      const r = icsParseDate(recurrenceId.value, recurrenceId.params, ctx);
      return r ? (r.allDay ? r.day : localDayStr(r.instant)) : null;
    })() : null,
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

const ICS_BYDAY = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

// Expand one event def into occurrence start Dates within [winStart, winEnd).
function expandOccurrences(def, winStart, winEnd) {
  const startInstant = def.start.instant;
  // An expanded def (one calendarView row) is one occurrence by definition:
  // the server already unrolled the series, and unrolling again would
  // duplicate it. Never enters the recurrence branch, whatever it carries.
  if (def.expanded || !def.rrule) {
    return (startInstant < winEnd) ? [startInstant] : [];
  }
  const freq = def.rrule.FREQ;
  const interval = Math.max(1, Number(def.rrule.INTERVAL || 1));
  const count = def.rrule.COUNT ? Number(def.rrule.COUNT) : null;
  let until = null;
  if (def.rrule.UNTIL) {
    const u = icsParseDate(def.rrule.UNTIL, {}, null); // UNTIL is UTC or date-only by spec
    until = u ? (u.allDay ? new Date(u.instant.getTime() + 86400000) : u.instant) : null;
  }
  const out = [];
  let produced = 0;
  const push = (d) => {
    if (until && d > until) return false;
    produced += 1;
    if (count && produced > count) return false;
    if (d >= winStart && d < winEnd) out.push(d);
    return true;
  };
  const HARD_CAP = 2000;
  if (freq === 'DAILY') {
    for (let i = 0, d = new Date(startInstant); i < HARD_CAP && d < winEnd; i++, d = new Date(d.getTime() + interval * 86400000)) {
      if (!push(new Date(d))) break;
    }
  } else if (freq === 'WEEKLY') {
    const bydays = def.rrule.BYDAY
      ? def.rrule.BYDAY.split(',').map((x) => ICS_BYDAY[x.trim()]).filter((x) => x != null)
      : [(startInstant.getDay() + 6) % 7];
    // Walk week by week from the start's Monday.
    let weekAnchor = new Date(startInstant);
    weekAnchor.setDate(weekAnchor.getDate() - ((weekAnchor.getDay() + 6) % 7));
    for (let w = 0; w < HARD_CAP / 7; w++) {
      let stop = false;
      for (const wd of [...bydays].sort((a, b) => a - b)) {
        const d = new Date(weekAnchor);
        d.setDate(d.getDate() + wd);
        d.setHours(startInstant.getHours(), startInstant.getMinutes(), startInstant.getSeconds(), 0);
        if (d < startInstant) continue;
        if (d >= winEnd && !until && !count) { stop = true; break; }
        if (!push(d)) { stop = true; break; }
      }
      if (stop) break;
      weekAnchor = new Date(weekAnchor.getTime() + interval * 7 * 86400000);
      if (weekAnchor >= winEnd) break;
    }
  } else if (freq === 'MONTHLY') {
    // BYDAY on a monthly rule names weekdays of the month, each with an
    // optional ordinal: 3SU is the third Sunday, -1FR the last Friday, SU
    // every Sunday. Without BYDAY the start's day-of-month repeats.
    const bydays = def.rrule.BYDAY
      ? def.rrule.BYDAY.split(',').map((x) => /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x.trim())).filter(Boolean)
      : null;
    const dom = startInstant.getDate();
    for (let i = 0; i < 240; i++) {
      const d = new Date(startInstant);
      if (bydays && bydays.length) {
        d.setDate(1);
        d.setMonth(d.getMonth() + i * interval);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const days = new Set();
        for (const [, n, wd] of bydays) {
          const all = [];
          for (let day = 1; day <= last; day++) {
            if (new Date(d.getFullYear(), d.getMonth(), day).getDay() === (ICS_BYDAY[wd] + 1) % 7) all.push(day);
          }
          // A fifth weekday the month does not have picks nothing: the month is skipped.
          for (const day of n ? [all[+n > 0 ? +n - 1 : all.length + +n]] : all) if (day != null) days.add(day);
        }
        let stop = false;
        for (const day of [...days].sort((a, b) => a - b)) {
          const occ = new Date(d);
          occ.setDate(day);
          if (occ < startInstant) continue;
          if (occ >= winEnd && !until && !count) { stop = true; break; }
          if (!push(occ)) { stop = true; break; }
        }
        if (stop) break;
        continue;
      }
      d.setMonth(d.getMonth() + i * interval);
      if (d.getDate() !== dom) continue; // month overflow (e.g. 31st) - skip
      if (d >= winEnd && !until && !count) break;
      if (!push(d)) break;
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; i < 50; i++) {
      const d = new Date(startInstant);
      d.setFullYear(d.getFullYear() + i * interval);
      if (d >= winEnd && !until && !count) break;
      if (!push(d)) break;
    }
  } else {
    return (startInstant >= winStart && startInstant < winEnd) ? [startInstant] : [];
  }
  return out;
}

// Expand parsed defs to per-day event cards for one week.
function icsEventsForWeek(defs, weekStart, splitHour) {
  const winStart = (() => { const [y, m, d] = weekStart.split('-').map(Number); return new Date(y, m - 1, d); })();
  const winEnd = new Date(winStart.getTime() + 7 * 86400000);
  const out = [];
  const overrides = new Map(); // uid::day -> def (RECURRENCE-ID edits)
  for (const def of defs) {
    if (def.recurrenceDay) overrides.set(`${def.uid}::${def.recurrenceDay}`, def);
  }
  for (const def of defs) {
    if (def.recurrenceDay) continue; // rendered via its master's expansion
    const durationMs = (def.end && def.end.instant && def.start.instant)
      ? Math.max(0, def.end.instant.getTime() - def.start.instant.getTime())
      : (def.start.allDay ? 86400000 : 0);
    const occurrences = expandOccurrences(def, winStart, winEnd);
    for (const occStart of occurrences) {
      const occDay = def.start.allDay && !def.rrule ? def.start.day : localDayStr(occStart);
      if (def.exdates.has(occDay)) continue;
      const ov = overrides.get(`${def.uid}::${occDay}`);
      const eff = ov || def;
      const effStart = ov ? ov.start.instant : occStart;
      const effEnd = ov && ov.end ? ov.end.instant : new Date(effStart.getTime() + durationMs);
      const allDay = eff.start.allDay;
      // Raw pieces for the Google Calendar deep link (built lazily in the
      // detail modal): master UID, whether this is an expanded recurrence,
      // and the ORIGINAL occurrence start (the recurrence id Google keys on;
      // an override's edited start is deliberately not used here).
      const recurring = !!def.rrule;
      const occStartUtc = allDay
        ? occDay.replace(/-/g, '')
        : occStart.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
      const tzUnresolved = eff.tzUnresolved || def.tzUnresolved || null;
      // The feed identity rides the MASTER def: an override edits one
      // occurrence of the same event, it does not move it to another feed.
      const feedId = def.feedId || null;
      const feedName = def.feedName || null;
      const feedColor = def.feedColor ? clampSwatch(def.feedColor) : null;
      if (allDay) {
        // DTEND is exclusive for all-day events; emit one card per spanned day.
        const startDay = ov ? ov.start.day : occDay;
        const nDays = Math.max(1, Math.round(durationMs / 86400000));
        for (let i = 0; i < nDays; i++) {
          const day = addDays(startDay, i);
          if (!dayInWeek(day, weekStart)) continue;
          out.push({
            kind: 'event', source: 'calendar',
            uid: `${def.uid}::${day}`, title: eff.title, description: eff.description,
            start: null, end: null, allDay: true, day, half: null,
            location: eff.location, url: eff.url, conferenceUrl: eff.conferenceUrl || null, continues: i > 0,
            masterUid: def.uid, recurring, occStartUtc, tzUnresolved,
            feedId, feedName, feedColor,
          });
        }
      } else {
        const startDay = localDayStr(effStart);
        const endDayInclusive = localDayStr(new Date(Math.max(effStart.getTime(), effEnd.getTime() - 1)));
        let day = startDay;
        let first = true;
        while (day <= endDayInclusive) {
          if (dayInWeek(day, weekStart)) {
            out.push({
              kind: 'event', source: 'calendar',
              uid: `${def.uid}::${occStart.toISOString()}${first ? '' : `::${day}`}`,
              title: eff.title, description: eff.description,
              start: effStart.toISOString(), end: effEnd.toISOString(),
              allDay: !first, day,
              half: first ? (effStart.getHours() < splitHour ? 'am' : 'pm') : null,
              location: eff.location, url: eff.url, conferenceUrl: eff.conferenceUrl || null, continues: !first,
              masterUid: def.uid, recurring, occStartUtc, tzUnresolved,
              feedId, feedName, feedColor,
            });
          }
          day = addDays(day, 1);
          first = false;
        }
      }
    }
  }
  out.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return String(a.start) < String(b.start) ? -1 : 1;
  });
  return out;
}

/* ---- calendar feeds (v0.8.0) ---------------------------------------------
 * A calendar is a LIST of feeds, each with an identity the board can colour,
 * label, isolate and dedupe by. The colour is an index into the four lenses
 * styles.css declares (--iplan-cal-1 .. --iplan-cal-4); the user picks a
 * swatch, never a hex. The settings hold each feed's URL; nothing else does:
 * the defs a fetch returns carry the feed's id, name and colour only, so the
 * cache note and every render path are secret-free by construction.
 */
const CALENDAR_SWATCHES = 4;
// Spoken names for the four lenses (the picker's aria labels).
const CALENDAR_SWATCH_NAMES = ['Indigo', 'Sage', 'Plum', 'Ink'];

// A swatch index is 1..4, whatever data.json says; anything else is lens 1.
function clampSwatch(n) {
  const i = Math.round(Number(n));
  return Number.isFinite(i) && i >= 1 && i <= CALENDAR_SWATCHES ? i : 1;
}

// The lens a new feed takes: the least-used one, lowest index on a tie, so
// two feeds never share a lens until all four are spoken for.
function leastUsedSwatch(feeds) {
  const used = new Array(CALENDAR_SWATCHES + 1).fill(0);
  for (const f of feeds || []) used[clampSwatch(f && f.color)] += 1;
  let best = 1;
  for (let i = 2; i <= CALENDAR_SWATCHES; i++) if (used[i] < used[best]) best = i;
  return best;
}

// An id no existing feed carries.
function newCalendarId(existing) {
  const taken = new Set((existing || []).map((f) => f && f.id));
  let id;
  do {
    id = `cal-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
  } while (taken.has(id));
  return id;
}

// A name for a migrated feed, read off the shape of its URL.
function calendarNameForUrl(url) {
  const u = String(url || '').trim();
  if (/^(https|webcal):\/\/calendar\.google\.com\//i.test(u)) return 'Google Calendar';
  if (/^(https|webcal):\/\/[^/]*icloud\.com\//i.test(u)) return 'iCloud Calendar';
  if (/^(https|webcal):\/\/[^/]*proton\.me\//i.test(u)) return 'Proton Calendar';
  if (/^(https|webcal):\/\/[^/]*(outlook\.(live|office)|office365)\.com\//i.test(u)) return 'Outlook Calendar';
  return 'Calendar';
}

// One feed, sanitised: every field present and typed, whatever data.json said.
function normalizeCalendarFeed(raw, index) {
  const f = raw && typeof raw === 'object' ? raw : {};
  const i = Number(index) || 0;
  return {
    id: typeof f.id === 'string' && f.id.trim() ? f.id.trim() : `cal-${i + 1}`,
    name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : `Calendar ${i + 1}`,
    url: typeof f.url === 'string' ? f.url.trim() : '',
    color: clampSwatch(f.color),
    enabled: f.enabled !== false,
    kind: typeof f.kind === 'string' && f.kind ? f.kind : 'ics',
  };
}

// The feeds in settings order, sanitised. Settings without a `calendars`
// array (a data.json from before 0.8.0, or a bare object in a test) are read
// through the same migration the plugin applies on load, so every caller
// sees one shape and the old icsUrl still counts as a configured calendar.
function calendarFeeds(settings) {
  const s = settings || {};
  const list = Array.isArray(s.calendars) ? s.calendars : migrateCalendarSettings(s).calendars;
  return list.map(normalizeCalendarFeed);
}
// The connector that owns a feed of this kind; an unknown kind is read as an
// iCal feed, the shape every entry had before there was a second kind.
function calendarFeedConnector(kind) {
  return CALENDAR_SOURCES.map((id) => CONNECTORS[id]).find((c) => c.feedKind === kind) || CONNECTORS.calendar;
}
// Can this feed be fetched at all: an address for an iCal feed, a sign-in
// for the Graph one. The connector answers, so every reader agrees.
function calendarFeedReady(feed, settings) {
  return !!(feed && calendarFeedConnector(feed.kind).ready(feed, settings || {}));
}
function enabledCalendarFeeds(settings) {
  return calendarFeeds(settings).filter((f) => f.enabled && calendarFeedReady(f, settings));
}
// The iCal calendar counts as configured when at least one of its feeds is
// on AND has an address. Mirrors the guard in calendarFetchAll, field for
// field.
function calendarFeedConfigured(settings) { return enabledCalendarFeeds(settings).some((f) => f.kind === 'ics'); }

// The Outlook calendar entry, added once on sign-in (removable; a later
// sign-in adds it again). Takes the least-used lens like a pasted feed.
const GRAPH_FEED_ID = 'outlook-graph';
function ensureGraphCalendarFeed(settings) {
  const s = settings || {};
  if (!Array.isArray(s.calendars)) s.calendars = calendarFeeds(s);
  if (s.calendars.some((f) => f && f.kind === 'graph')) return false;
  s.calendars.push({ id: GRAPH_FEED_ID, name: 'Outlook calendar', url: '', color: leastUsedSwatch(s.calendars), enabled: true, kind: 'graph' });
  return true;
}

// 0.7.x -> 0.8.0: the one icsUrl becomes the one feed, on lens 1. Returns
// the SAME object when `calendars` already exists (nothing to do, nothing
// touched), otherwise a copy carrying the new array. icsUrl stays in place
// for one release and is read nowhere else.
function migrateCalendarSettings(settings) {
  const s = settings || {};
  if (Array.isArray(s.calendars)) return s;
  const url = trimmed(s.icsUrl);
  const calendars = url
    ? [{ id: 'cal-1', name: calendarNameForUrl(url), url, color: 1, enabled: true, kind: 'ics' }]
    : [];
  return Object.assign({}, s, { calendars });
}

// The feed an expanded event came from, from the CURRENT settings (the
// event carries the id only; name and URL are looked up, never copied into
// the event, so the URL never rides an event object).
function calendarFeedFor(settings, ev) {
  const id = ev && ev.feedId;
  return id ? calendarFeeds(settings).find((f) => f.id === id) || null : null;
}

// Stamp the feed's identity on every def a fetch returned. Id, name and
// colour only: the URL stops here.
function tagCalendarDefs(defs, feed) {
  for (const d of defs || []) {
    d.feedId = feed.id;
    d.feedName = feed.name;
    d.feedColor = clampSwatch(feed.color);
  }
  return defs;
}

// Fetch ONE feed. Same body every release had for the single URL: webcal
// rewritten, https enforced, the ICS parsed; the defs come back tagged.
async function calendarFetchFeed(feed) {
  let raw = feedUrl(feed);
  if (!raw) return degraded('calendar', 'no-token', 'Calendar is not connected (no iCal URL).');
  if (/^webcal:\/\//i.test(raw)) raw = raw.replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(raw)) {
    return degraded('calendar', 'misconfigured', 'Calendar URL must be https:// (or webcal://).');
  }
  try {
    const res = await requestUrl({ url: raw, method: 'GET', throw: false, headers: { Accept: 'text/calendar' } });
    if (res.status < 200 || res.status >= 300) {
      return degraded('calendar', 'unreachable', `Calendar feed returned HTTP ${res.status}.`);
    }
    const defs = tagCalendarDefs(parseIcs(res.text || ''), feed);
    // Healthy fetch, but some zones could not be resolved: the result stays
    // ok (the events render, as written) and carries ONE warning line.
    return okResult('calendar', defs, calendarTzWarning(defs));
  } catch {
    return degraded('calendar', 'unreachable', 'Calendar feed unreachable.');
  }
}

// Every enabled feed of every calendar connector, fetched at once. One
// feed's failure never touches another's result: allSettled, and a fetch
// that throws anyway becomes a degraded result for that feed alone.
// Returns { feeds, results } with results keyed by feed id in feed order.
async function calendarFetchAll(settings, deps) {
  const jobs = [];
  for (const id of CALENDAR_SOURCES) {
    const c = CONNECTORS[id];
    for (const feed of c.feeds(settings)) if (feed.enabled && c.ready(feed, settings)) jobs.push({ feed, connector: c });
  }
  const settled = await Promise.allSettled(jobs.map(({ feed, connector }) => connector.fetchFeed(feed, settings, deps)));
  const results = {};
  jobs.forEach(({ feed }, i) => {
    const r = settled[i];
    results[feed.id] = r.status === 'fulfilled' && r.value
      ? r.value
      : degraded('calendar', 'unreachable', 'Calendar feed unreachable.');
  });
  return { feeds: jobs.map((j) => j.feed), results };
}

// The same event in two feeds (an Outlook calendar subscribed in Google, a
// shared family calendar) shows once: keyed on uid plus the recurrence day,
// the first feed in settings order wins. Returns the kept defs and a count.
function dedupeCalendarDefs(defs) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const d of defs || []) {
    if (!d) continue;
    const key = `${d.uid}::${d.recurrenceDay || ''}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    out.push(d);
  }
  return { defs: out, duplicates };
}

// The board's def list from the per-feed map: the feeds in the given order
// (settings order), flattened, deduplicated.
function calendarDefsFromByFeed(byFeed, feedIds) {
  const all = [];
  for (const id of feedIds || Object.keys(byFeed || {})) if (byFeed && byFeed[id]) all.push(...byFeed[id]);
  return dedupeCalendarDefs(all);
}

// Merge one sync's per-feed results over the previous per-feed defs. A
// healthy feed replaces its own entry; a failed feed keeps its previous one
// (never prune on a blip); a feed absent from the results (disabled or
// removed since) drops out. Results are keyed by feed id in feed order.
function mergeCalendarFeeds(prevByFeed, results) {
  const ids = Object.keys(results || {});
  const byFeed = {};
  const failed = [];
  const live = [];
  for (const id of ids) {
    const r = results[id];
    if (r && r.ok) { byFeed[id] = r.items || []; live.push(id); continue; }
    failed.push(id);
    if (prevByFeed && Array.isArray(prevByFeed[id])) byFeed[id] = prevByFeed[id];
  }
  const { defs, duplicates } = calendarDefsFromByFeed(byFeed, ids);
  return { byFeed, defs, duplicates, failed, live };
}

// One status for the consumers that want one (the board notice, the badge)
// plus the per-feed rows the settings tab shows. A single failing feed is a
// WARNING on an ok result (the others are live), named by the feed; every
// feed failing is a failure carrying the first feed's reason.
function calendarAggregateStatus(feeds, results, merged, now) {
  const at = (now || new Date()).toISOString();
  const perFeed = {};
  const nameOf = (id) => ((feeds || []).find((f) => f.id === id) || {}).name || id;
  for (const f of feeds || []) {
    const r = results && results[f.id];
    const kept = merged && merged.byFeed && merged.byFeed[f.id];
    perFeed[f.id] = {
      ok: !!(r && r.ok), reason: r ? r.reason || null : null, message: r ? r.message || null : null,
      warning: (r && r.warning) || null,
      count: r && r.ok ? (r.items || []).length : (kept ? kept.length : 0),
      at,
    };
  }
  if (!feeds || !feeds.length) {
    return { ok: false, reason: 'no-token', message: 'Calendar is not connected (no iCal URL).', warning: null, perFeed };
  }
  const failedLines = (merged.failed || []).map((id) => `${nameOf(id)}: ${perFeed[id].message || 'failed.'}`);
  if (!merged.live || !merged.live.length) {
    const first = results[merged.failed[0]] || {};
    return { ok: false, reason: first.reason || 'unreachable', message: failedLines.join(' '), warning: null, perFeed };
  }
  const warnings = failedLines.slice();
  for (const id of merged.live) {
    if (perFeed[id].warning) warnings.push(feeds.length > 1 ? `${nameOf(id)}: ${perFeed[id].warning}` : perFeed[id].warning);
  }
  if (merged.duplicates) {
    const n = merged.duplicates;
    warnings.push(`${n} event${n === 1 ? ' appears' : 's appear'} in more than one feed; shown once.`);
  }
  return { ok: true, reason: null, message: null, warning: warnings.length ? warnings.join(' ') : null, perFeed };
}

// The settings row's status sentence for one feed, from its last sync.
// `vault` is optional: the settings tab passes it so a feed whose address
// lives in the store still reads as connected.
// `settings` (optional, resolved) is what the Graph feed's readiness reads.
function calendarFeedStatusText(feed, st, vault, settings) {
  if (feed && feed.kind === 'graph') {
    if (!outlookSignedIn(settings || {})) return 'Sign in to your Microsoft account under Outlook to connect this calendar.';
  } else if (!feed || !feedUrl(feed, vault)) return 'Paste the iCal address to connect this calendar.';
  if (feed.enabled === false) return 'Off: its events are hidden until it is switched on.';
  if (!st) return 'Not synced yet this session.';
  if (!st.ok) return `Failed: ${st.message || 'no reply.'}`;
  const n = Number(st.count) || 0;
  let text = `${n} event${n === 1 ? '' : 's'}`;
  if (st.at) text += `, synced ${fmtTimeHM(st.at)}`;
  return st.warning ? `${text}. ${st.warning}` : `${text}.`;
}

// The calendar's ConnectorResult for the sync loop: every feed fetched,
// merged over the previous per-feed defs, one status. Items are the merged,
// deduplicated defs; byFeed and perFeed ride along for the plugin state.
async function calendarFetchDefs(settings, prevByFeed, deps) {
  const { feeds, results } = await calendarFetchAll(settings, deps);
  const merged = mergeCalendarFeeds(prevByFeed || {}, results);
  const status = calendarAggregateStatus(feeds, results, merged);
  const out = status.ok
    ? okResult('calendar', merged.defs, status.warning)
    : Object.assign(degraded('calendar', status.reason, status.message), { items: merged.defs });
  out.perFeed = status.perFeed;
  out.byFeed = merged.byFeed;
  out.feeds = feeds;
  return out;
}

/* ========================================================================== *
 * Calendar event cache (v0.5.0, v2 layout since v0.8.0) - the parsed defs
 * mirror into ONE vault file (the cache note under the planner folder) so
 * relaunch renders instantly from the last healthy fetch. File shape: YAML
 * frontmatter, a human/AI-readable list of the next ~14 days, then a fenced
 * ```json block holding { version: 2, updated_at, feeds: [{ id, name, color,
 * updated_at, defs }] }: one entry per feed, each carrying that feed's FULL
 * serialized defs for exact rehydration (Date instants as ISO strings; rrule
 * / exdates / overrides preserved so icsEventsForWeek reproduces identical
 * output). The v1 shape (a bare defs array) still reads; its defs belong to
 * the first feed in the settings.
 * HARD RULE: the cache never contains a feed URL or its private key - a feed
 * is named by id, name and colour only, and event data is all the rest. A
 * malformed cache is ignored; the next fetch rebuilds it.
 * ========================================================================== */

// Meeting-URL detection: scan location, then description, then the URL
// property; inside a field, pattern order decides (first match wins). The
// character class stops at whitespace and quotes so URLs inside Google's
// HTML-soup descriptions come out clean.
const CONFERENCE_URL_PATTERNS = [
  /https?:\/\/[^\s<>"']*zoom\.us\/(?:j|my)\/[^\s<>"']+/i,
  /https?:\/\/meet\.google\.com\/[^\s<>"']+/i,
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+/i,
  /https?:\/\/teams\.live\.com\/[^\s<>"']+/i,
  /https?:\/\/[^\s<>"']*webex\.com\/(?:meet|join)\/[^\s<>"']+/i,
  /https?:\/\/whereby\.com\/[^\s<>"']+/i,
  /https?:\/\/meet\.jit\.si\/[^\s<>"']+/i,
];

// ev needs only { location, description, url } - works for defs AND for the
// expanded per-day events. Returns the clean URL or null.
function detectConferenceUrl(ev) {
  if (!ev) return null;
  // A meeting link the source stated as such (Graph's onlineMeeting.joinUrl)
  // beats anything scanned out of the text.
  if (ev.conferenceUrl) return String(ev.conferenceUrl);
  for (const field of [ev.location, ev.description, ev.url]) {
    if (!field) continue;
    const text = String(field);
    for (const re of CONFERENCE_URL_PATTERNS) {
      const m = re.exec(text);
      if (m) return m[0].replace(/[).,;:!?]+$/, '');
    }
  }
  return null;
}

function serializeIcsDate(x) {
  if (!x) return null;
  return {
    allDay: !!x.allDay,
    day: x.day || null,
    instant: x.instant instanceof Date && !isNaN(x.instant) ? x.instant.toISOString() : null,
  };
}
function reviveIcsDate(x) {
  if (!x || typeof x !== 'object') return null;
  return {
    allDay: !!x.allDay,
    day: x.day || null,
    instant: x.instant ? new Date(x.instant) : null,
  };
}

// defs (from parseIcs) -> plain-JSON array. conferenceUrl is derived and
// stored per def so the vault copy carries it explicitly for the AI team.
function serializeCalendarDefs(defs) {
  return (defs || []).map((def) => ({
    uid: def.uid,
    title: def.title,
    description: def.description || '',
    location: def.location || null,
    url: def.url || null,
    conferenceUrl: detectConferenceUrl(def),
    start: serializeIcsDate(def.start),
    end: serializeIcsDate(def.end),
    rrule: def.rrule || null,
    exdates: Array.from(def.exdates || []),
    recurrenceDay: def.recurrenceDay || null,
    tzUnresolved: def.tzUnresolved || null,
    // Only an expanded def carries the flag, so an iCal def's row is
    // byte-identical to what every earlier release wrote.
    ...(def.expanded ? { expanded: true } : {}),
  }));
}

// plain-JSON array -> defs identical (for expansion purposes) to parseIcs
// output. Returns null when the payload is not an array; skips broken rows.
function reviveCalendarDefs(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object' || !d.start) continue;
    const start = reviveIcsDate(d.start);
    if (!start || (!start.allDay && !(start.instant instanceof Date && !isNaN(start.instant)))) continue;
    out.push({
      uid: String(d.uid || ''),
      title: String(d.title || '(no title)'),
      description: String(d.description || ''),
      location: d.location || null,
      url: d.url || null,
      conferenceUrl: d.conferenceUrl || null,
      start,
      end: reviveIcsDate(d.end),
      rrule: d.rrule && typeof d.rrule === 'object' ? d.rrule : null,
      exdates: new Set(Array.isArray(d.exdates) ? d.exdates : []),
      recurrenceDay: d.recurrenceDay || null,
      tzUnresolved: d.tzUnresolved ? String(d.tzUnresolved) : null,
      ...(d.expanded === true ? { expanded: true } : {}),
    });
  }
  return out;
}

// Defs grouped by the feed they carry, first-seen order. Untagged defs (a
// def with no feed identity) form one group with a null id.
function groupDefsByFeed(defs) {
  const groups = new Map();
  for (const d of defs || []) {
    if (!d) continue;
    const id = d.feedId || null;
    let g = groups.get(id);
    if (!g) {
      g = { id, name: d.feedName || null, color: clampSwatch(d.feedColor), defs: [] };
      groups.set(id, g);
    }
    g.defs.push(d);
  }
  return Array.from(groups.values());
}

// Cached defs meet the CURRENT settings. The cache is a mirror, never an
// authority: a feed's name and colour come from the settings; defs of a
// feed no longer enabled (or gone) are dropped; untagged defs (a 0.7.x
// cache) belong to the first enabled feed when there is one, else nowhere.
function adoptCacheDefs(defs, feeds) {
  const list = feeds || [];
  const byId = new Map(list.map((f) => [f.id, f]));
  const first = list[0] || null;
  const out = [];
  for (const d of defs || []) {
    if (!d) continue;
    const feed = d.feedId ? byId.get(d.feedId) : first;
    if (!feed) continue;
    out.push(tagCalendarDefs([d], feed)[0]);
  }
  return out;
}

// The full cache file content. `defs` is the merged list the board renders
// (each def tagged with its feed); `now` is injectable so tests are
// deterministic; `feedMeta` maps a feed id to its last LIVE fetch time so a
// feed kept from an earlier sync keeps its own, older, updated_at.
function buildCalendarCacheContent(defs, now, plannerFolder, feedMeta) {
  const groups = groupDefsByFeed(defs);
  const feedsOut = groups.map((g) => ({
    id: g.id, name: g.name, color: g.color,
    updated_at: (feedMeta && g.id && feedMeta[g.id]) || now.toISOString(),
    defs: serializeCalendarDefs(g.defs),
  }));
  const total = feedsOut.reduce((n, f) => n + f.defs.length, 0);
  const today = localDayStr(now);
  const lines = [
    '---',
    'type: calendar-cache',
    'source: ics',
    `updated_at: ${now.toISOString()}`,
    `events: ${total}`,
    `feeds: ${feedsOut.length}`,
    // So an agent reading this note knows where the item notes live.
    ...(plannerFolder ? [`planner_folder: ${JSON.stringify(plannerFolder)}`] : []),
    '---',
    '',
    '# Calendar Events',
    '',
    'Last synced calendar state, written by the ICOR for Life - Planner plugin on every',
    'healthy fetch (may be minutes stale). Safe to read for schedule context;',
    'it never contains a calendar feed URL or any secret. Do not edit: the',
    'next sync overwrites this file.',
    '',
    ...(feedsOut.length > 1 || (feedsOut[0] && feedsOut[0].name)
      ? ['## Calendars', '', ...feedsOut.map((f) => `- ${f.name || 'Calendar'} (${f.defs.length} event${f.defs.length === 1 ? '' : 's'}, synced ${f.updated_at})`), '']
      : []),
    `## Upcoming (${today} to ${addDays(today, 13)})`,
    '',
  ];
  // Reuse the board's own expansion so the readable list and the board agree.
  const w0 = mondayOf(today);
  const events = icsEventsForWeek(defs, w0, 13)
    .concat(icsEventsForWeek(defs, addDays(w0, 7), 13))
    .concat(icsEventsForWeek(defs, addDays(w0, 14), 13))
    .filter((ev) => ev.day >= today && ev.day < addDays(today, 14));
  let lastDay = null;
  for (const ev of events) {
    if (ev.day !== lastDay) {
      lines.push(`### ${fmtDayLabel(ev.day)}`);
      lastDay = ev.day;
    }
    const when = ev.allDay || !ev.start
      ? (ev.continues ? 'CONT.' : 'ALL DAY')
      : `${fmtTimeHM(ev.start)}-${fmtTimeHM(ev.end)}`;
    const conf = detectConferenceUrl(ev);
    // [tz?]: the feed named a zone the plugin could not resolve; the time is
    // the wall clock as written, in the machine's zone. [<feed>]: which
    // calendar the event came from, when it carries one.
    const bits = [`- ${when} ${ev.title}${ev.tzUnresolved ? ' [tz?]' : ''}${ev.feedName ? ` [${ev.feedName}]` : ''}`];
    if (ev.location) bits.push(`  - location: ${ev.location}`);
    if (conf) bits.push(`  - conference: ${conf}`);
    lines.push(...bits);
  }
  if (!events.length) lines.push('No events in the next 14 days.');
  const payload = { version: 2, updated_at: now.toISOString(), feeds: feedsOut };
  lines.push('', '## Serialized defs (for the plugin - do not edit)', '', '```json', JSON.stringify(payload), '```', '');
  return lines.join('\n');
}

// Cache file content -> { version, defs, feeds }, or null on any malformed
// shape. v2: one entry per feed, its defs revived and tagged with the
// entry's id, name and colour. v1: a bare array, revived untagged (the
// caller assigns it to a feed via adoptCacheDefs). `feeds` lists each
// entry's id and its own updated_at.
function parseCalendarCache(text) {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(String(text || ''));
  if (!m) return null;
  let raw;
  try { raw = JSON.parse(m[1]); } catch { return null; }
  if (Array.isArray(raw)) {
    const defs = reviveCalendarDefs(raw);
    return defs ? { version: 1, defs, feeds: [] } : null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.feeds)) return null;
  const defs = [];
  const feeds = [];
  for (const f of raw.feeds) {
    if (!f || typeof f !== 'object') continue;
    const feed = {
      id: f.id != null ? String(f.id) : null,
      name: f.name != null ? String(f.name) : null,
      color: clampSwatch(f.color),
      updatedAt: typeof f.updated_at === 'string' ? f.updated_at : null,
    };
    feeds.push(feed);
    const revived = reviveCalendarDefs(f.defs) || [];
    for (const d of revived) {
      d.feedId = feed.id;
      d.feedName = feed.name;
      d.feedColor = feed.color;
    }
    defs.push(...revived);
  }
  return { version: 2, defs, feeds };
}

// Cache file content -> revived defs (both layouts), or null when malformed.
function parseCalendarCacheContent(text) {
  const parsed = parseCalendarCache(text);
  return parsed ? parsed.defs : null;
}

/* ========================================================================== *
 * Next-event strip helpers (0.5.0 as a ribbon badge, 0.9.1 as the strip)
 * ========================================================================== */

// Inside this window the countdown carries the marker: state ink, on the
// number only. Under NEXT_SECONDS_MS the label switches to M:SS and the tick
// to one second.
const NEXT_URGENT_MS = 15 * 60000;
const NEXT_SECONDS_MS = 5 * 60000;

// The countdown two ways: the label the strip paints (mono, short) and the
// spoken form the screen reader gets. startMs and nowMs are epoch millis.
function fmtNextCountdown(startMs, nowMs) {
  const leftMs = startMs - nowMs;
  if (leftMs <= 0) return { label: 'now', spoken: 'running now' };
  if (leftMs <= NEXT_SECONDS_MS) {
    const totalSec = Math.max(0, Math.round(leftMs / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return { label: `in ${m}:${pad2(s)}`, spoken: m > 0 ? `in ${m} ${m === 1 ? 'minute' : 'minutes'}` : `in ${s} seconds` };
  }
  const mins = Math.round(leftMs / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (d > 0) return { label: h > 0 ? `in ${d}d ${h}h` : `in ${d}d`, spoken: `in ${plural(d, 'day')}${h > 0 ? ` ${plural(h, 'hour')}` : ''}` };
  if (h > 0) return { label: m > 0 ? `in ${h}h ${m}m` : `in ${h}h`, spoken: `in ${plural(h, 'hour')}${m > 0 ? ` ${plural(m, 'minute')}` : ''}` };
  return { label: `in ${m} min`, spoken: `in ${plural(m, 'minute')}` };
}

// Routine instances as timed entries for the model: a routine is the one
// planner thing besides a calendar event that owns a clock time (tasks carry
// a date only). Skipped and finished instances are not upcoming.
function routineTimedEntries(occs) {
  const out = [];
  for (const occ of occs || []) {
    if (!occ || !occ.day || occ.skipped) continue;
    if (occ.total > 0 && occ.done === occ.total) continue;
    const [y, mo, d] = String(occ.day).split('-').map(Number);
    const start = new Date(y, mo - 1, d, 0, occ.startMin, 0, 0);
    const end = new Date(y, mo - 1, d, 0, Math.max(occ.endMin, occ.startMin + 1), 0, 0);
    out.push({ title: occ.routine && occ.routine.name ? occ.routine.name : 'Routine', start: start.toISOString(), end: end.toISOString(), joinUrl: null });
  }
  return out;
}

// The next thing on today's clock, as the strip shows it. Pure.
//   events  expanded per-day calendar events (icsEventsForWeek); all-day
//           rows and continuation rows are skipped, the meeting link comes
//           from detectConferenceUrl
//   items   timed entries { title, start, end, joinUrl } from anything else
//           with a clock time (routineTimedEntries)
//   now     a Date
// A RUNNING entry wins (label "now"). Otherwise the earliest start that is
// still ahead TODAY. Anything starting on another day is ignored, so the
// strip is absent rather than reading "in 3d 2h" all week.
// Returns null when nothing qualifies, else
//   { label, spoken, title, joinUrl, urgent, running, imminent, key }
// where urgent is the 15 minute marker window, imminent the 5 minute M:SS
// window, and key identifies the entry so the live region speaks only when
// the entry changes, never on a tick.
function nextBadgeModel(events, items, now) {
  const t = now.getTime();
  const today = localDayStr(now);
  let running = null;
  let next = null;
  const consider = (title, startIso, endIso, joinUrl) => {
    const s = new Date(startIso).getTime();
    const e = new Date(endIso).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return;
    const entry = { title: String(title || ''), start: s, end: e, joinUrl: joinUrl || null };
    if (s <= t && t < e) {
      if (!running || s < running.start) running = entry;
    } else if (s > t && localDayStr(new Date(s)) === today) {
      if (!next || s < next.start) next = entry;
    }
  };
  for (const ev of events || []) {
    if (!ev || ev.allDay || !ev.start || !ev.end || ev.continues) continue;
    consider(ev.title, ev.start, ev.end, detectConferenceUrl(ev));
  }
  for (const it of items || []) {
    if (!it || !it.start || !it.end) continue;
    consider(it.title, it.start, it.end, it.joinUrl);
  }
  const pick = running || next;
  if (!pick) return null;
  const msLeft = pick.start - t;
  const { label, spoken } = fmtNextCountdown(pick.start, t);
  return {
    label, spoken, title: pick.title, joinUrl: pick.joinUrl,
    urgent: msLeft > 0 && msLeft <= NEXT_URGENT_MS,
    imminent: msLeft > 0 && msLeft <= NEXT_SECONDS_MS,
    running: msLeft <= 0,
    key: `${pick.start}|${pick.title}`,
  };
}

// Where the strip mounts, as { place, parent, before } or null.
//
// THE LOGO. The theme paints the banner as the file explorer's
// .nav-header::before, and the Connect plugin may swap in a real
// a.micor-banner inside that same .nav-header. A pseudo-element is always
// the first thing painted in its box, so nothing inserted INTO .nav-header
// can sit above it: "above the logo" means before .nav-header itself, as
// the first child of the explorer's leaf content. That holds for both
// shapes of the banner and for a vault with neither (the strip then simply
// tops the file tree). The leaf content exists on desktop and on the phone
// drawer alike, which is why the strip no longer refuses mobile.
//
// WITHOUT A FILE EXPLORER (core plugin off), the top of the left split's
// tab group, above the tab headers, so the strip still shows.
const NEXT_STRIP_LOGO_HOST = '.workspace-leaf-content[data-type="file-explorer"]';
const NEXT_STRIP_SPLIT_HOST = '.workspace-split.mod-left-split .workspace-tabs';
function nextStripMountPoint(root) {
  const q = (el, sel) => (el && typeof el.querySelector === 'function') ? el.querySelector(sel) : null;
  const explorer = q(root, NEXT_STRIP_LOGO_HOST);
  if (explorer) {
    const header = q(explorer, '.nav-header');
    return { place: 'logo', parent: explorer, before: header || explorer.firstElementChild || null };
  }
  const tabs = q(root, NEXT_STRIP_SPLIT_HOST);
  if (tabs) return { place: 'split', parent: tabs, before: tabs.firstElementChild || null };
  return null;
}

// THE TOOLBAR BUTTON'S MOUNT RULE (0.9.2), pure over a querySelector root.
//
// The row of icons under the sidebar logo is Obsidian's own file-explorer
// toolbar, `.nav-buttons-container`. The ICOR for Life Connect plugin puts
// its four launchers there as `div.clickable-icon.nav-action-button` and
// marks the container `micor-tree-slot`, which is the class INKLINE styles;
// it offers no registration hook for another plugin's button. So this
// plugin mounts into the same container with the same class shape and the
// theme styles it like its siblings. Appended, never inserted at the front:
// the theme leaves launchers at flex order 0 in creation order and pins
// only sort and collapse-all behind them, so appending lands the button
// after Connect's launchers and ahead of the host's two controls.
//
// The rule returns the container and the button already in it, if any, so
// the runtime can be idempotent under the observer that re-runs it: with
// the button present from THIS plugin instance it must return without
// touching the DOM (a mutation under a MutationObserver feeds itself).
// Without a file explorer there is nowhere to mount; the ribbon icon and
// the command are the routes then.
const PLANNER_TOOLBAR_HOST = '.workspace-leaf-content[data-type="file-explorer"] .nav-buttons-container';
const PLANNER_TOOLBAR_CLASS = 'iplan-toolbar-open';
const PLANNER_TOOLBAR_ICON = 'calendar-days';
const PLANNER_TOOLBAR_LABEL = 'Open the Planner';
function plannerToolbarMountPoint(root) {
  const q = (el, sel) => (el && typeof el.querySelector === 'function') ? el.querySelector(sel) : null;
  const bar = q(root, PLANNER_TOOLBAR_HOST);
  if (!bar) return null;
  return { parent: bar, existing: q(bar, '.' + PLANNER_TOOLBAR_CLASS) };
}

/* ========================================================================== *
 * Item store - synced tasks live as markdown notes under <planner folder>/<Source>/.
 * Frontmatter is the plan database (the cockpit's plan_assignments analog):
 *   type: planner-item        source / external_id  - identity (idempotency key)
 *   status: open|done         - SOURCE truth, written by reconcile
 *   planned_day / planned_half / planned_order - the board placement
 *   done_local / weekly_goal  - planner-local flags (never written to source)
 *   linked_note               - plan-owned: the note this task is FOR
 * The AI team edits the same fields to move items; the board re-renders live.
 *
 * PLAN-OWNED FIELDS (PLAN_OWNED_ITEM_FIELDS) are the planner's own half of
 * the note. A sync run pulls what the source owns and never touches these:
 * updateItemFile goes through processFrontMatter and assigns by name, so a
 * field it does not name survives every pull by construction. That is a
 * property worth a test rather than a comment, and vault-writes.test.cjs
 * carries it.
 *
 * `linked_note` (0.14.0) is the same field name `planner-habit` already uses
 * for the same meaning: a wikilink to the note where the MEANING of the thing
 * lives, usually a Project or a Key Element in My Life. The planner never
 * writes into that note and never reads it for the board; it holds the
 * pointer so the vault's own scripts can count a week's committed time
 * against the project it belongs to.
 * ========================================================================== */

// The fields the planner owns on an item note. Sync pulls the rest and leaves
// every one of these alone.
const PLAN_OWNED_ITEM_FIELDS = [
  'planned_day', 'planned_half', 'planned_order', 'done_local', 'weekly_goal', 'linked_note',
];

// A linked-note value as it is STORED: `[[Note]]`, or null for none.
// Accepts a bare name, a wikilink, or a wikilink with an alias or a heading,
// and keeps the note it names WITH the folders it was given - the same shape
// habitFrontmatterOf writes. A typed-in path is the person saying which of
// two same-named notes they mean, so it is kept rather than flattened.
function normalizeLinkedNote(raw) {
  return wikilinkOf(wikilinkTarget(raw));
}

// The normalizer, pure and shared: one place decides what a frontmatter block
// MEANS, so a manual item and a synced item are the same shape by
// construction rather than by two code paths agreeing. Everything downstream
// (board, tray, drag, menus) reads this output and nothing else.
function itemFromFrontmatter(fm, path, basename) {
  if (!fm || fm.type !== 'planner-item' || !fm.source || fm.external_id == null) return null;
  // priority: an ABSENT or EMPTY value means "no priority" (rank 5). Number(null)
  // and Number('') are both 0, which clampPriorityRank would floor up to 1 (the
  // TOP rank) - so the absent case must be caught before the coercion, never
  // after it. Manual items are the first items that can legitimately carry a
  // hand-cleared priority, which is how this surfaced.
  const rawPriority = fm.priority;
  const priority = (rawPriority == null || rawPriority === '')
    ? 5 : clampPriorityRank(Number(rawPriority));
  return {
    path,
    source: String(fm.source),
    id: String(fm.external_id),
    title: fm.title != null ? String(fm.title) : basename,
    status: fm.status === 'done' ? 'done' : 'open',
    due: fm.due ? String(fm.due).slice(0, 10) : null,
    priority,
    url: fm.url ? String(fm.url) : null,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    sourceStatus: fm.source_status != null ? String(fm.source_status) : null,
    listId: fm.list_id != null ? String(fm.list_id) : null,
    plannedDay: fm.planned_day ? String(fm.planned_day).slice(0, 10) : null,
    plannedHalf: fm.planned_half === 'am' || fm.planned_half === 'pm' ? fm.planned_half : null,
    plannedOrder: Number.isFinite(Number(fm.planned_order)) ? Number(fm.planned_order) : 0,
    doneLocal: fm.done_local === true,
    // `weekly_goal` is the key; "pinned to the week" is what it MEANS and
    // what every surface says since 0.14.0. The key is not renamed: a
    // plugin-written field name is a migration, a label is not.
    weeklyGoal: fm.weekly_goal === true,
    // The note this task is for (0.14.0). Plan-owned: no sync run reads it,
    // writes it or clears it. Two readings, because there are two questions:
    // `linkedNote` is what to CALL it (the menu says "Open chaser", not
    // "Open 04 Inner World/My Life/Projects/chaser"), `linkedNoteTarget` is
    // what to RESOLVE and what the editor starts from, folders and all.
    linkedNote: wikilinkBasename(fm.linked_note),
    linkedNoteTarget: wikilinkTarget(fm.linked_note),
    // Recurrence (2026-09-04). `recurring` is three-valued on purpose: true,
    // false, or null for "unknown" (a note from before the field existed, or
    // a ClickUp task, whose API has no flag). The occurrence rule treats
    // unknown as recurring; see occurrenceAdvanced.
    recurring: fm.recurring === true ? true : (fm.recurring === false ? false : null),
    dueString: fm.due_string != null && fm.due_string !== '' ? String(fm.due_string) : null,
    // The uncheck-after-sync signal: the card was reopened here and the
    // source has not confirmed yet. Reconcile must not re-close it meanwhile.
    reopenPending: fm.reopen_pending === true,
    lastCompletedDue: fm.last_completed_due ? String(fm.last_completed_due).slice(0, 10) : null,
    occurrences: normalizeOccurrences(fm.occurrences),
    // The parent's external id within the same source (2026-09-04), or null.
    parentId: fm.parent_id != null && fm.parent_id !== '' ? String(fm.parent_id) : null,
  };
}

// `occurrences` in frontmatter: the finished occurrences of a recurring task,
// oldest first, capped. Each row is { due, planned_day, planned_half, done_at }
// in the note and camelCase here; a malformed row is dropped, never thrown on.
function normalizeOccurrences(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    out.push({
      due: o.due ? String(o.due).slice(0, 10) : null,
      plannedDay: o.planned_day ? String(o.planned_day).slice(0, 10) : null,
      plannedHalf: o.planned_half === 'am' || o.planned_half === 'pm' ? o.planned_half : null,
      doneAt: o.done_at ? String(o.done_at) : null,
    });
  }
  return out;
}

function itemFromFile(app, file) {
  const cache = app.metadataCache.getFileCache(file);
  const item = itemFromFrontmatter(cache && cache.frontmatter, file.path, file.basename);
  if (item) item.file = file;
  return item;
}
function collectItems(app, rootPath) {
  const root = app.vault.getAbstractFileByPath(rootPath);
  const items = [];
  const walk = (folder) => {
    for (const child of folder.children || []) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === 'md') {
        const it = itemFromFile(app, child);
        if (it) items.push(it);
      }
    }
  };
  if (root instanceof TFolder) walk(root);
  return items;
}

// Markdown notes in the room the metadata cache has not read yet. While this
// is above zero, collectItems cannot see every item, so an open task whose
// note is one of these looks new; a sync pass then writes no new note.
function unindexedNoteCount(app, rootPath) {
  const root = app.vault.getAbstractFileByPath(rootPath);
  let n = 0;
  const walk = (folder) => {
    for (const child of folder.children || []) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === 'md' && !app.metadataCache.getFileCache(child)) n += 1;
    }
  };
  if (root instanceof TFolder) walk(root);
  return n;
}

// effective completion: struck when locally checked OR the source closed it
function isDone(item) { return item.doneLocal || item.status === 'done'; }

/* ========================================================================== *
 * Manual items (2026-08-30)
 *
 * A task typed straight into the tray. It is a planner-item like any other,
 * with source: manual and an external_id that CANNOT collide with a synced
 * one: the id is namespaced by the literal 'manual-' prefix, which no Todoist
 * id (digits or a 16-char base62 token), ClickUp id (base36, no hyphen) or
 * IMAP UID (digits) can ever produce. Identity is the (source, external_id)
 * pair, so the prefix is belt on top of braces - it means a hand-edited
 * `source:` field still cannot make a manual note shadow a synced one.
 *
 * Two hard rules, both enforced by SYNCED_SOURCES rather than by testing for
 * the string 'manual':
 *   - a sync run never deletes, closes or overwrites a manual item
 *     (reconcileStaleIds returns nothing for a source it does not own)
 *   - two-way sync never tries to push a manual item anywhere
 *     (canPushToSource / canCompleteOnSource are both false for it)
 * ========================================================================== */

// `manual-<base36 ms>-<6 base36 chars>`. Time-ordered so the ids sort the way
// they were created, random-tailed so two entries in the same millisecond do
// not collide. The caller may inject now/rand to make this deterministic.
function manualExternalId(now, rand) {
  const ms = Number.isFinite(now) ? now : Date.now();
  const r = typeof rand === 'function' ? rand : Math.random;
  let tail = '';
  for (let i = 0; i < 6; i++) tail += Math.floor(r() * 36).toString(36);
  return `manual-${ms.toString(36)}-${tail}`;
}

// The frontmatter object for a new manual item. Every field of the README
// contract is present and explicit: a manual note must be readable by anything
// that reads a synced note, and an ABSENT field is a different thing from a
// null one to the frontmatter parser.
//
// `priority: 5` is written literally rather than left null. 5 is "no
// priority"; see the coercion note in itemFromFrontmatter.
function manualItemFrontmatter(title, id, nowIso) {
  return {
    type: 'planner-item',
    source: MANUAL_SOURCE,
    external_id: String(id),
    title: String(title),
    status: 'open',
    due: null,
    priority: 5,
    url: null,
    tags: [],
    source_status: null,
    planned_day: null,
    planned_half: null,
    planned_order: 0,
    weekly_goal: false,
    done_local: false,
    // Written as null rather than left out: an ABSENT field and a null one
    // are different things to the frontmatter parser, and a manual note must
    // be readable by anything that reads a synced note.
    linked_note: null,
    // Manual items are never synced, so `synced_at` would be a lie. This is
    // the manual-only field, documented in the README contract table.
    created_at: nowIso,
  };
}

// Which of `allItems` a HEALTHY fetch of `source` proves are finished.
//
// The guard that matters is the first one: a source only ever reconciles its
// OWN items. A manual item is invisible to every sync run, including one whose
// external_id happens to look like the id of a task that just vanished from
// Todoist. Extracted as a pure function so that invariant is a test and not a
// comment.
function reconcileStaleIds(source, allItems, openIds, inScope) {
  if (!isSyncedSource(source)) return [];
  const out = [];
  for (const it of allItems || []) {
    if (it.source !== source) continue;
    if (openIds.has(it.id)) continue;
    if (it.status === 'done') continue;
    // Reopened here, not yet confirmed by the source: re-marking it done now
    // would undo the uncheck before the reopen has round-tripped.
    if (it.reopenPending === true) continue;
    // Outside what the fetch just asked for: its absence is the filter
    // talking, not the source. Optional, because only ClickUp has a query
    // the member can narrow.
    if (typeof inScope === 'function' && !inScope(it)) continue;
    out.push(it);
  }
  return out;
}

// Does an absent item's shadow speak for the query that just ran?
//
// A shadow is rewritten with the current scope every time the source returns
// the item, so a shadow carrying a DIFFERENT scope was last confirmed under a
// different question: switching ClickUp subtasks off, pinning a workspace, or
// putting a token for another account in the settings all make items vanish
// from the open set without anything having been completed.
//
// No scope on either side is a yes: a source whose query never narrows passes
// none, and a shadow written before scopes existed has none. That second case
// is a one-sync window on upgrade only, because every item the source still
// returns is stamped before reconcile runs in the same pass.
function scopeAgrees(shadow, scope) {
  if (!scope) return true;
  const was = shadow && shadow.scope;
  if (!was) return true;
  return was === scope;
}

/* ========================================================================== *
 * Completion and recurrence (2026-09-04)
 *
 * Three defects shared two causes. First, reconcile deleted the shadow of a
 * task that left the open set, and the push path needs a shadow to act, so an
 * uncheck after a sync had nowhere to send a reopen. Second, the plugin had
 * no notion of an OCCURRENCE: a recurring Todoist task keeps its id and only
 * moves its due forward, so a local check stayed forever and a plan stayed on
 * the day of an occurrence that was already finished.
 *
 * The decision is pure so the one place that writes completions to a source
 * can be tested for the double-close hazard: if the reset of the local check
 * ran AFTER the completion comparison, the comparison would see a checked
 * card against an unchecked shadow and close the task a second time, which
 * advances the recurrence twice. An advance therefore never pushes anything,
 * in either direction (a reopen on a recurring task reverts its due date).
 * ========================================================================== */

// Did the source's due move forward past the baseline? Unknown recurrence
// (an older note, or ClickUp) counts as recurring: the rule keys on the due
// having MOVED while a baseline existed, which a one-off task's edit also
// satisfies only when the user changed the date at the source, and for a
// one-off the fetch says recurring: false and the rule stands down.
function occurrenceAdvanced(prior, sourceItem, shadow) {
  return prior.recurring !== false
    && !!(shadow && shadow.due && sourceItem && sourceItem.due && sourceItem.due > shadow.due);
}

// The completion decision for one item that IS in the source's open set.
//   advanced         the due moved on: the old occurrence is finished
//   resetDoneLocal   clear the check, status open, done_at gone
//   movePlan         { day, half } to put the card on ('move' mode)
//   clearPlan        send the card back to the tray ('drop' mode)
//   occurrence       what to record about the finished occurrence, or null
//   pushClose        the ONE call to the source (a close), or nothing. There
//                    is no reopen here: the source is the winner, so a
//                    mismatch never writes an open status back to it, and
//                    `pushReopen` is false in every plan this can return.
//   nextShadowDone   the done flag the shadow should carry after this sync
//   clearReopenPending       the source confirmed the reopen (the item is open)
//   resetChildrenDoneLocal   an advance: the new occurrence's subtasks start
//                            unchecked here (upsertSource applies it)
function syncCompletionPlan({ prior, sourceItem, shadow, completeOnSource, recurringAdvance }) {
  const shadowDone = shadow ? !!shadow.done : false;
  const base = {
    advanced: false, resetDoneLocal: false, movePlan: null, clearPlan: false,
    occurrence: null, lastCompletedDue: null,
    // `pushReopen` is permanently false and read by nobody since 0.14.3. It
    // is kept as part of the plan's shape so the invariant it now states is
    // asserted rather than assumed: a sync plan CANNOT carry a reopen,
    // because the source is the winner and only the person's own uncheck
    // (reopen_pending) ever reopens anything there.
    pushClose: false, pushReopen: false, nextShadowDone: shadowDone,
    clearReopenPending: prior.reopenPending === true,
    resetChildrenDoneLocal: false,
  };
  if (occurrenceAdvanced(prior, sourceItem, shadow)) {
    const mode = recurringAdvance === 'drop' ? 'drop' : 'move';
    // A plan on or after the new due was made for the NEXT occurrence and
    // stands in both modes; only a plan for a day before the new due belongs
    // to the occurrence that just finished.
    const plannedBefore = !!(prior.plannedDay && prior.plannedDay < sourceItem.due);
    return {
      ...base,
      advanced: true,
      resetDoneLocal: true,
      movePlan: mode === 'move' && plannedBefore ? { day: sourceItem.due, half: prior.plannedHalf || 'am' } : null,
      clearPlan: mode === 'drop' && plannedBefore,
      occurrence: {
        due: shadow.due,
        plannedDay: plannedBefore ? prior.plannedDay : null,
        plannedHalf: plannedBefore ? (prior.plannedHalf || null) : null,
      },
      lastCompletedDue: shadow.due,
      nextShadowDone: false,
      resetChildrenDoneLocal: true,
    };
  }
  // The caller only asks about items in the open set, so a pending reopen is
  // confirmed by the fetch itself: the source is open, nothing to push. The
  // same holds for a note whose status is done: the source reopened it (a
  // task closed and reopened there, or a subtask the parent's recurrence
  // brought back), so the local check goes with the status and nothing is
  // pushed in either direction; pushing the stale check would close it a
  // second time.
  const reopenedAtSource = prior.status === 'done';
  const sourceDone = (prior.reopenPending === true || reopenedAtSource) ? false : shadowDone;
  const wantDone = reopenedAtSource ? false : !!prior.doneLocal;
  // THE SOURCE IS THE WINNER (Tom's ruling, 2026-09-17). A completion may
  // cross from here to the source; a REOPEN never crosses from a mismatch.
  // This item is IN the open set, so the source already says open: a shadow
  // still reading done is a stale baseline, and writing an open status back
  // to the source so it agrees with the note is exactly the flip that reset
  // published ClickUp tasks to `not started` (PM-12518, 2026-09-16). The one
  // reopen that ever reaches a source is the person's own uncheck, which
  // toggleDoneLocal marks with reopen_pending and the absent-item loop in
  // upsertSource sends.
  // The shadow is "what the source last agreed to", and this fetch just
  // returned the item in the OPEN set. So unless we are keeping a close we
  // already sent (wantDone, which is also the guard against closing a
  // recurring task twice), the shadow heals to open here. That healing is
  // what the removed reopen push used to achieve as a side effect of writing
  // to the source; now it happens in the shadow alone, where it belongs.
  return {
    ...base, resetDoneLocal: reopenedAtSource,
    nextShadowDone: wantDone ? sourceDone : false,
    pushClose: !!completeOnSource && wantDone && !sourceDone,
  };
}

// What unchecking a struck card means, given where the "done" came from.
//   local-only     done_local flips; nothing else is involved
//   push           the source closed it: reopen here now, tell the source
//   refuse-local   the source closed it and nothing may reach the source:
//                  say so, change nothing
function reopenDecision({ statusDone, completeOnSource, synced }) {
  if (!statusDone || !synced) return 'local-only';
  return completeOnSource ? 'push' : 'refuse-local';
}

/* ---- self-write suppression (0.14.3) ------------------------------------
 * Obsidian's metadataCache `changed` event says that a file changed and
 * never who changed it. A sync run writes the SOURCE's own truth into a
 * note (`status: done` from reconcile, the pulled fields from
 * updateItemFile), the event fires on that write, and the push check then
 * reads the plugin's own hand as a local edit and sends it back out. That
 * is the whole of PM-12518: reconcile wrote `status: done`, the push check
 * saw a note that looked unchecked against a shadow that said done, and
 * PUT the list's first open status to ClickUp 1.1 seconds later.
 *
 * So every sync-run write stamps its path, and the push check ignores an
 * event for a stamped path inside the window. It is deliberately NOT a
 * blanket mute: a card action (a check, a plan move) is the person acting
 * and stamps nothing, and toggleDoneLocal clears any stamp on its path, so
 * a check one tick after a sync write still pushes at once.
 *
 * The signal is the FILE's own mtime, not a clock window (0.15.1, Flint's
 * Q1). `processFrontMatter` and `vault.process` both resolve after the
 * adapter has reconciled the index, so the live `TFile.stat.mtime` right
 * after the await IS the mtime of the write that just landed. Record it; in
 * the handler, a file still carrying that exact mtime is one nobody else has
 * touched, and anything else is somebody's edit.
 *
 * A window had to guess how late the `changed` event might be, and the cache
 * indexes from a queue: a large startup index, an Obsidian Sync burst or an
 * iOS suspend can push the event past any window, while a hand edit typed
 * inside the window was deferred to the next sync for nothing. The mtime
 * answers both without a clock.
 *
 * It is not load-bearing either way. If an adapter ever updated the stat
 * after the write resolved, the stamp would simply read as "not ours" and
 * the push check would run, where the note and the shadow already agree
 * after every sync write and a reopen needs the explicit flag. The signal
 * saves work; the invariant is carried by the other two layers.
 */
function syncWriteIsOwn(recordedMtime, liveMtime) {
  if (!Number.isFinite(recordedMtime) || !Number.isFinite(liveMtime)) return false;
  return recordedMtime === liveMtime;
}
// The stamp map is per note path and every sync write overwrites its own
// entry, so it is bounded by the notes one sync touches. The cap is belt on
// top of braces for a vault that renames notes out from under it: oldest
// insertion first, which Map iteration gives for free.
const SYNC_WRITE_MAX_PATHS = 500;

// Newest last, oldest dropped past the cap.
const OCCURRENCE_CAP = 30;
function appendOccurrence(list, occurrence, cap) {
  const max = Number.isFinite(cap) && cap > 0 ? cap : OCCURRENCE_CAP;
  const out = (Array.isArray(list) ? list : []).concat([occurrence]);
  return out.length > max ? out.slice(out.length - max) : out;
}

// Finished occurrences as READ-ONLY board entries: one per recorded occurrence
// that had a plan, on the day and half it was planned, struck. An occurrence
// without a plan is history only and renders nothing. The tray never shows
// these; the board renders them through renderCard with `ghost` set, which
// disables the check, the drag and the menu. `path` is made distinct so lane
// sequencing never confuses a ghost with its live card; `notePath` opens it.
function ghostItemsFor(items) {
  const out = [];
  for (const it of items || []) {
    (it.occurrences || []).forEach((occ, i) => {
      if (!occ.plannedDay || !occ.plannedHalf) return;
      out.push({
        ...it,
        ghost: true,
        path: `${it.path}#occurrence-${i}`,
        notePath: it.path,
        due: occ.due || it.due,
        plannedDay: occ.plannedDay,
        plannedHalf: occ.plannedHalf,
        plannedOrder: 0,
        doneLocal: true,
        status: 'done',
        reopenPending: false,
        weeklyGoal: false,
        occurrences: [],
      });
    });
  }
  return out;
}

// Shadows are the memory of "what the source last agreed to" AND of "did we
// already close or reopen this there". They now survive reconcile (a task
// that left the open set keeps its shadow with done: true), so they are
// pruned by two rules instead: no note carries the id any more, or the done
// shadow is older than `maxDoneAgeMs`. Returns the keys to drop.
const DONE_SHADOW_MAX_AGE_MS = 90 * 86400000;
function pruneShadows(shadowMap, source, existingIds, openIds, nowMs, maxDoneAgeMs) {
  const maxAge = Number.isFinite(maxDoneAgeMs) ? maxDoneAgeMs : DONE_SHADOW_MAX_AGE_MS;
  const drop = [];
  const prefix = `${source}:`;
  for (const key of Object.keys(shadowMap || {})) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    const sh = shadowMap[key] || {};
    if (!existingIds.has(id) && !openIds.has(id)) { drop.push(key); continue; }
    if (sh.done === true && Number.isFinite(sh.doneAt) && nowMs - sh.doneAt > maxAge) drop.push(key);
  }
  return drop;
}

/* ========================================================================== *
 * Deleted at the source (0.15.0)
 *
 * Tom's rule: the planner notes are a MIRROR of the connected sources. A task
 * deleted there is deleted here. Until now absence from the open fetch meant
 * one thing, "completed", so a deleted task stayed in the vault as a card
 * that answered 404 to every write and said so in a toast on every sync.
 *
 * Absence cannot tell the two apart, so the plugin asks: one GET per absent
 * id that is not already done. Three hard limits on that question, because
 * it is the only place the plugin spends requests it did not have to:
 *
 *   - bounded per sync (GONE_PROBE_MAX_PER_SYNC). An absent task past the
 *     budget is NOT asked about and takes the completion path: its note is
 *     marked done, exactly as before this release, and it is never probed
 *     again, because a note that is done is no longer absent-and-open and
 *     so never enters a later batch. A vault with more than 25 tasks
 *     vanishing from one source in one pass therefore mirrors the deletion
 *     of the first 25 and reads the rest as completed.
 *   - asked once per id per sync, never per call site.
 *   - POSITIVE EVIDENCE ONLY. A probe that fails, times out, is refused or
 *     is not implemented for a connector reads as "still there". Marking a
 *     task done writes nothing anywhere and is one click to undo; moving a
 *     note to the trash is not, so a note is never trashed on a guess.
 * ========================================================================== */

const GONE_PROBE_MAX_PER_SYNC = 25;

// Which absent items get the confirming GET this sync, in the order they
// were given, up to the budget. Pure so the budget is a test and not a hope.
function goneProbeBatch(items, max) {
  const cap = Number.isFinite(max) && max >= 0 ? max : GONE_PROBE_MAX_PER_SYNC;
  return (items || []).slice(0, cap);
}

// What an absent item is, given what the probe found.
//   true  -> 'gone'  the source answered "no such task": trash the note
//   false -> 'done'  it is there and simply not open: the rule as it was
//   null  -> 'done'  we could not tell, so we do the harmless thing
//   'open' -> 'open' it is there and still open: it left the query, not the
//                    work, so the note is left exactly as it is
function absenceVerdict(probe) { return probe === true ? 'gone' : probe === 'open' ? 'open' : 'done'; }

// The look back at DONE notes. Until 0.15.0 absence meant "completed" and
// nothing else, so a task deleted at the source before then left a note
// marked done, and a done note never enters the batch above. Each source asks
// about its done notes once, in id order, out of the same per-sync budget;
// `mark` is the persisted progress (settings.goneSweep[source]): absent
// before the first pass, the last id asked while there is more, true when
// finished. Task sources only: a mail id is renumbered by a mailbox rebuild
// or a move, and an older done note has no recorded mailbox generation to
// tell "deleted" from "renumbered", so a UID not found there is no evidence.
const DONE_SWEEP_SOURCES = ['todoist', 'clickup'];
function doneSweepBatch(source, allItems, openIds, mark, max) {
  if (mark === true || !DONE_SWEEP_SOURCES.includes(source)) return { batch: [], next: true };
  const after = typeof mark === 'string' ? mark : null;
  const due = (allItems || [])
    .filter((it) => it.source === source && it.status === 'done' && it.reopenPending !== true
      && !openIds.has(it.id) && (after === null || String(it.id) > after))
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  const batch = goneProbeBatch(due, max);
  if (batch.length === due.length) return { batch, next: true };
  return { batch, next: batch.length ? String(batch[batch.length - 1].id) : mark };
}

// Can this source be asked at all? A connector without a probe (manual, the
// calendars) is never asked and never has an item trashed under this rule.
function canProbeGone(source) {
  const c = CONNECTORS[source];
  return !!(c && typeof c.probeGone === 'function');
}

/* ---- re-mapping a note onto a new id (0.15.1) ---------------------------
 * A mailbox rebuild renumbers every message, so the mail the vault already
 * has a note for comes back as a NEW item under a new UID. Trashing the old
 * note and creating a new one loses the whole planner half of it: the day,
 * the half, the order, the week pin, the linked note.
 *
 * The Message-ID survives the rebuild, so the pairing is available: an item
 * the vault does not know, whose Message-ID matches the shadow of a note
 * whose id the fetch no longer returns, IS that note under a new number.
 * The same pairing rescues an ordinary move out of INBOX and back, which
 * also mints a new UID.
 *
 * Pure, so the pairing is a test and not a hope. Returns
 * [{ from, to, item, prior }] in the order the fetch gave.
 */
function remapByMessageId(source, items, existing, shadowMap) {
  const out = [];
  const byMessageId = new Map();
  const prefix = `${source}:`;
  for (const key of Object.keys(shadowMap || {})) {
    if (!key.startsWith(prefix)) continue;
    const mid = (shadowMap[key] || {}).messageId;
    const id = key.slice(prefix.length);
    // Only a note that still exists and that the fetch no longer knows.
    if (!mid || !existing || !existing.has(id)) continue;
    if (!byMessageId.has(mid)) byMessageId.set(mid, id);
  }
  const claimed = new Set();
  for (const t of (items || [])) {
    const mid = t && t.messageId;
    if (!mid || existing.has(t.id)) continue;
    const from = byMessageId.get(mid);
    // One note per mail: a second item carrying the same Message-ID is a
    // second mail, and gets a note of its own.
    if (!from || claimed.has(from) || from === t.id) continue;
    claimed.add(from);
    out.push({ from, to: t.id, item: t, prior: existing.get(from) });
  }
  return out;
}

// The one notice for a sync that renumbered notes, in plain words.
function remapNotice(label, n) {
  if (!n) return null;
  return n === 1
    ? `Planner: ${label} renumbered its messages, so a note was re-matched to its mail.`
    : `Planner: ${label} renumbered its messages, so ${n} notes were re-matched to their mail.`;
}

// The one notice for a sync that trashed notes, in plain words. Never one
// toast per task, and never the 404 the member cannot act on.
function goneNotice(label, n) {
  if (!n) return null;
  return n === 1
    ? `Planner: a task was deleted in ${label}, so its note moved to the trash.`
    : `Planner: ${n} tasks were deleted in ${label}, so their notes moved to the trash.`;
}

/* ========================================================================== *
 * Subtasks (2026-09-04)
 *
 * A subtask is an ordinary item that names its parent (Todoist parent_id,
 * ClickUp parent), so the vault stays a flat list of notes and the hierarchy
 * is an index built once per render. Resolution is same-source only: a
 * ClickUp id equal to a Todoist parent id must never resolve. A child whose
 * parent is not in the vault (not assigned to me, filtered, another
 * workspace) is an ordinary card with no kicker, and a parent card lists its
 * children as a second view of the same notes, never a second note.
 * ========================================================================== */

function itemKey(source, id) { return `${source}:${id}`; }

// Open before done, then the lane order, then the title.
function subtaskOrder(a, b) {
  const d = (isDone(a) ? 1 : 0) - (isDone(b) ? 1 : 0);
  if (d) return d;
  if (a.plannedOrder !== b.plannedOrder) return a.plannedOrder - b.plannedOrder;
  return String(a.title).localeCompare(String(b.title));
}

// -> { byKey: Map<'source:id', item>, childrenOf: Map<'source:parentId', item[]> }
// Ghost entries (finished occurrences) are skipped: they share their live
// card's id and would otherwise shadow it.
function buildItemIndex(items) {
  const byKey = new Map();
  const childrenOf = new Map();
  for (const it of items || []) {
    if (!it || it.ghost) continue;
    byKey.set(itemKey(it.source, it.id), it);
  }
  for (const it of items || []) {
    if (!it || it.ghost || !it.parentId) continue;
    const key = itemKey(it.source, it.parentId);
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(it);
  }
  for (const list of childrenOf.values()) list.sort(subtaskOrder);
  return { byKey, childrenOf };
}

function parentOf(item, index) {
  if (!item || !item.parentId || !index || !index.byKey) return null;
  return index.byKey.get(itemKey(item.source, item.parentId)) || null;
}
function parentTitleFor(item, index) {
  const p = parentOf(item, index);
  return p ? p.title : null;
}
function childrenOfItem(item, index) {
  if (!item || !index || !index.childrenOf) return [];
  return index.childrenOf.get(itemKey(item.source, item.id)) || [];
}
// -> { done, total } or null when the item has no children in the vault.
function subtaskCounter(item, index) {
  const kids = childrenOfItem(item, index);
  if (!kids.length) return null;
  return { done: kids.filter(isDone).length, total: kids.length };
}
function subtaskCounterText(c) { return `${c.done} of ${c.total} subtask${c.total === 1 ? '' : 's'}`; }
// The chip on a child's row in its parent's list: where the child sits when
// that is not where the parent sits. Same day (or both unplanned): nothing.
function subtaskRowMeta(child, parent) {
  const c = (child && child.plannedDay) || null;
  const p = (parent && parent.plannedDay) || null;
  if (c === p) return null;
  return c ? fmtDayNum(c) : 'TRAY';
}

/* ========================================================================== *
 * Checklists and sentinel log tables (2026-09-04)
 *
 * One checklist block and one log-table parser serve everything that gets
 * checked off INSIDE a card: a routine's steps today, later a habit's daily
 * check-in and a task's subtasks. The log lives in the note BODY as a
 * markdown table under an HTML-comment sentinel, the convention the vault
 * already uses for habit check-ins, so a row the plugin writes and a row an
 * agent appends in chat are the same row.
 *
 * The writer is byte-preserving outside the one line it touches (a
 * hand-written table keeps its wording and its spacing), detects the table's
 * direction and keeps it, and defaults to newest on top. The parser dedupes
 * by keeping the LAST row per date. Every write runs inside vault.process,
 * which is atomic; nothing here reads a body and writes it back in two calls.
 * ========================================================================== */

// The rows a consumer hands in, normalised, plus the progress they add up to.
//   rows: [{ id, label, checked, disabled?, missed?, meta? }]
function checklistModel(spec) {
  const src = spec && Array.isArray(spec.rows) ? spec.rows : [];
  const rows = src.map((r, i) => ({
    id: String(r && r.id != null ? r.id : i),
    label: String(r && r.label != null ? r.label : ''),
    checked: !!(r && r.checked),
    disabled: !!(r && r.disabled),
    missed: !!(r && r.missed),
    meta: r && r.meta != null && r.meta !== '' ? String(r.meta) : null,
  }));
  const done = rows.filter((r) => r.checked).length;
  return { rows, done, total: rows.length, progressText: checklistProgressText(done, rows.length) };
}

function checklistProgressText(done, total) { return `${done} of ${total}`; }

// The DOM block. Rows are native buttons (tab order, Enter and Space for
// free) carrying role=checkbox and aria-checked; a disabled row keeps its
// place in the tab order and says so through aria-disabled. The check
// control carries .iplan-check, so a step reads as the same object as a
// task card's check.
//
// The flip is optimistic: the row changes the moment it is pressed, before
// the write resolves, so every consumer gets the immediate feel without
// repeating the mechanics. A rejected write reverts the row and says so
// once; a write that resolves to `false` (the plugin refused it and has
// already said why) reverts without a second notice. `onToggle(id, next)`
// may return a promise; `onProgress(done, total)` is told after every flip
// so a card can strike itself without waiting for the re-render that
// follows the write. `progress: false` leaves the "n of m" footer out when
// the consumer's own head carries the count.
function renderChecklist(container, model, opts) {
  const o = opts || {};
  const block = document.createElement('div');
  block.className = `iplan-checklist${o.compact ? ' is-compact' : ''}`;
  block.setAttribute('role', 'group');
  if (o.ariaLabel) block.setAttribute('aria-label', o.ariaLabel);
  const state = { done: model.done, total: model.total };
  const progress = document.createElement('span');
  progress.className = 'iplan-checklist-progress';
  const tell = () => {
    progress.textContent = checklistProgressText(state.done, state.total);
    if (typeof o.onProgress === 'function') o.onProgress(state.done, state.total);
  };
  const paint = (row, checked) => {
    row.setAttribute('aria-checked', checked ? 'true' : 'false');
    row.classList.toggle('is-checked', checked);
  };
  for (const r of model.rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `iplan-checklist-row${r.missed ? ' is-missed' : ''}`;
    row.setAttribute('role', 'checkbox');
    row.setAttribute('data-id', r.id);
    paint(row, r.checked);
    if (r.disabled) row.setAttribute('aria-disabled', 'true');
    const check = document.createElement('span');
    check.className = 'iplan-check';
    check.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'iplan-checklist-label';
    label.textContent = r.label;
    row.appendChild(check);
    row.appendChild(label);
    if (r.meta) {
      const chip = document.createElement('span');
      chip.className = 'iplan-chip';
      chip.textContent = r.meta;
      row.appendChild(chip);
    }
    row.addEventListener('click', (e) => {
      // The card behind the row opens its note on click; a check is not that.
      e.preventDefault();
      e.stopPropagation();
      if (row.getAttribute('aria-disabled') === 'true') return;
      const was = row.getAttribute('aria-checked') === 'true';
      const next = !was;
      paint(row, next);
      state.done += next ? 1 : -1;
      tell();
      const revert = () => {
        paint(row, was);
        state.done += next ? -1 : 1;
        tell();
      };
      let result;
      try { result = typeof o.onToggle === 'function' ? o.onToggle(r.id, next) : undefined; }
      catch (err) { result = Promise.reject(err); }
      if (result && typeof result.then === 'function') {
        result.then((v) => { if (v === false) revert(); }, (err) => {
          revert();
          new Notice(`Planner: could not save the check (${(err && err.message) || 'unknown error'}).`);
        });
      } else if (result === false) {
        revert();
      }
    });
    block.appendChild(row);
  }
  progress.textContent = checklistProgressText(state.done, state.total);
  if (o.progress !== false) block.appendChild(progress);
  container.appendChild(block);
  return block;
}

/* ---- the sentinel log table ------------------------------------------------
 *
 *   <!-- routine-log: schema=steps -->
 *   | Date | Done | Steps |
 *   |---|---|---|
 *   | 2026-09-04 | 3/3 | 1,2,3 |
 *
 * Column 1 is the date, column 2 the marker, the rest is carried through as
 * strings. The marker vocabulary is the vault's: Y, a check mark or G is
 * done; N, R or a dash is not done; an underscore or a blank is pending; S
 * is skipped. The parser carries any marker; interpreting it is the
 * consumer's job (markerState is the shared reading).
 */

const LOG_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Lines split on '\n' only: a CRLF line keeps its '\r', and joining the
// array back with '\n' returns the bytes that came in. That is the whole
// byte-preservation mechanism, so it is one function and not a regex.
function splitLogLines(text) { return String(text == null ? '' : text).split('\n'); }

function logSentinelRe(name) { return new RegExp(`<!--\\s*${name}:\\s*([^>]*?)\\s*-->`); }

function parseTableCells(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s.startsWith('|')) return null;
  return s.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function isSeparatorRow(cells) {
  return Array.isArray(cells) && cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function formatLogRow(cells) { return `| ${cells.join(' | ')} |`; }

// -> { found, schema, start, end, header, headerLine, separatorLine,
//      rows: [{ line, date, marker, rest }], direction: 'desc'|'asc'|'unknown' }
// `start` is the sentinel's line index, `end` the first line after the
// table (exclusive). A sentinel with no table under it yet is `found` with a
// null header. Direction compares the first and the last dated row; one row
// or none is 'unknown', which the writer treats as newest on top.
function parseLogTable(body, sentinelName) {
  const lines = splitLogLines(body);
  const re = logSentinelRe(sentinelName);
  const none = {
    found: false, schema: null, start: -1, end: -1, header: null,
    headerLine: -1, separatorLine: -1, rows: [], direction: 'unknown',
  };
  let start = -1;
  let schema = null;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    start = i;
    const sm = /schema=([A-Za-z0-9_-]+)/.exec(m[1] || '');
    schema = sm ? sm[1] : null;
    break;
  }
  if (start < 0) return none;
  let i = start + 1;
  while (i < lines.length && lines[i].trim() === '') i++;
  const header = i < lines.length ? parseTableCells(lines[i]) : null;
  if (!header) return { ...none, found: true, schema, start, end: start + 1 };
  const headerLine = i;
  let separatorLine = -1;
  i++;
  if (i < lines.length && isSeparatorRow(parseTableCells(lines[i]))) { separatorLine = i; i++; }
  const rows = [];
  for (; i < lines.length; i++) {
    const cells = parseTableCells(lines[i]);
    if (!cells) break;
    rows.push({
      line: i,
      date: cells[0] && LOG_DATE_RE.test(cells[0]) ? cells[0] : null,
      marker: cells[1] == null ? '' : cells[1],
      rest: cells.slice(2),
    });
  }
  const dated = rows.filter((r) => r.date);
  let direction = 'unknown';
  if (dated.length >= 2) {
    const a = dated[0].date;
    const b = dated[dated.length - 1].date;
    direction = a > b ? 'desc' : (a < b ? 'asc' : 'unknown');
  }
  return { found: true, schema, start, end: i, header, headerLine, separatorLine, rows, direction };
}

// The row for a date: the LAST one when a date appears twice, so a
// duplicate written by hand is read the way a later correction would be.
function logRowFor(parsed, date) {
  if (!parsed || !parsed.rows) return null;
  let hit = null;
  for (const r of parsed.rows) if (r.date === date) hit = r;
  return hit;
}

// The marker's meaning. Vocabulary from the vault's habit convention: the
// dash is U+2013 as written there (escaped here on purpose), a plain hyphen
// counts too.
function markerState(marker) {
  const m = String(marker == null ? '' : marker).trim();
  if (m === '' || m === '_') return 'pending';
  if (/^(Y|✓|✔|G)$/i.test(m)) return 'done';
  if (/^(N|R|\u2013|-)$/i.test(m)) return 'missed';
  if (/^S$/i.test(m)) return 'skipped';
  return 'unknown';
}

// Writes ONE row: replaced in place when the date exists, inserted per the
// table's direction when it does not (top for newest-on-top or unknown, the
// end for oldest-on-top), or the whole section created from `createWith`
// ({ heading, schema, header }) when the note has no such table. Returns the
// new body. When the row already holds exactly these cells the body comes
// back unchanged, byte for byte. `rest` omitted keeps the existing row's
// trailing cells (a note text the person wrote survives a re-check).
function upsertLogRow(body, sentinelName, spec) {
  const date = String(spec.date);
  const marker = String(spec.marker == null ? '' : spec.marker);
  const lines = splitLogLines(body);
  const eolOf = (idx) => (idx >= 0 && idx < lines.length && lines[idx].endsWith('\r') ? '\r' : '');
  const parsed = parseLogTable(body, sentinelName);

  if (!parsed.found) {
    const cw = spec.createWith;
    if (!cw || !Array.isArray(cw.header)) {
      throw new Error(`the note has no ${sentinelName} table and nothing was given to create it with`);
    }
    const eol = String(body || '').includes('\r\n') ? '\r' : '';
    const width = Math.max(cw.header.length, 2);
    const cells = [date, marker].concat((spec.rest || []).map(String));
    while (cells.length < width) cells.push('');
    const section = [
      '',
      cw.heading || '## Log',
      `<!-- ${sentinelName}: schema=${cw.schema || 'streak'} -->`,
      formatLogRow(cw.header),
      formatLogRow(cw.header.map(() => '---')),
      formatLogRow(cells),
    ];
    let base = String(body || '');
    if (base.length && !base.endsWith('\n')) base += `${eol}\n`;
    return base + section.join(`${eol}\n`) + `${eol}\n`;
  }

  if (parsed.headerLine < 0) {
    // The sentinel is there, the table is not: build it right under it.
    const cw = spec.createWith;
    const header = cw && Array.isArray(cw.header) ? cw.header : ['Date', 'Y/N', 'Note'];
    const eol = eolOf(parsed.start);
    const width = Math.max(header.length, 2);
    const cells = [date, marker].concat((spec.rest || []).map(String));
    while (cells.length < width) cells.push('');
    lines.splice(parsed.start + 1, 0,
      formatLogRow(header) + eol,
      formatLogRow(header.map(() => '---')) + eol,
      formatLogRow(cells) + eol);
    return lines.join('\n');
  }

  const width = Math.max(parsed.header.length, 2);
  const existing = logRowFor(parsed, date);
  const rest = spec.rest != null ? spec.rest.map(String) : (existing ? existing.rest.slice() : []);
  const cells = [date, marker].concat(rest);
  while (cells.length < width) cells.push('');

  if (existing) {
    const had = [existing.date, existing.marker].concat(existing.rest);
    while (had.length < cells.length) had.push('');
    if (had.length === cells.length && had.every((c, k) => c === cells[k])) return String(body || '');
    lines[existing.line] = formatLogRow(cells) + eolOf(existing.line);
    return lines.join('\n');
  }

  const eol = eolOf(parsed.headerLine);
  const afterHead = parsed.separatorLine >= 0 ? parsed.separatorLine + 1 : parsed.headerLine + 1;
  const at = parsed.direction === 'asc' ? parsed.end : afterHead;
  lines.splice(at, 0, formatLogRow(cells) + eol);
  return lines.join('\n');
}

// Removes every row for the date (a duplicate goes with it, by design: one
// row per date is the invariant). Untouched lines keep their bytes.
function removeLogRow(body, sentinelName, date) {
  const parsed = parseLogTable(body, sentinelName);
  const hits = parsed.rows.filter((r) => r.date === date).map((r) => r.line);
  if (!hits.length) return String(body || '');
  const lines = splitLogLines(body);
  for (const idx of hits.slice().sort((a, b) => b - a)) lines.splice(idx, 1);
  return lines.join('\n');
}

/* ========================================================================== *
 * Routines (2026-09-04)
 *
 * A routine is a recurring block of steps that takes a place in the day:
 * from-to, one of three types (morning, afternoon, evening), on chosen
 * weekdays. It is not a task (never in the tray, never dragged, never synced
 * anywhere) and not a habit (a habit is one yes or no per day). It renders
 * in the lane as a time block whose steps check off one by one.
 *
 * One note per routine under <planner folder>/Routines/. The frontmatter is
 * the definition, the "## Steps" checklist is the list of steps (its boxes
 * are labels only, never state), and the "## Log" table under the
 * routine-log sentinel is the record: one row per day that had any
 * interaction, absence meaning nothing happened. Steps are identified by
 * position; editing the list mid-day changes that day's mapping, and the row
 * keeps the count that history needs.
 *
 * Nothing in sync touches a routine: itemFromFrontmatter refuses the type,
 * so collectItems, reconcile and the push path never see one.
 * ========================================================================== */

const ROUTINE_TYPE = 'planner-routine';
const ROUTINE_TYPES = ['morning', 'afternoon', 'evening'];
const ROUTINE_LOG_SENTINEL = 'routine-log';
const ROUTINE_LOG_SECTION = { heading: '## Log', schema: 'steps', header: ['Date', 'Done', 'Steps'] };
const WEEKDAY_CODES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function capitalize(s) { const t = String(s == null ? '' : s); return t.charAt(0).toUpperCase() + t.slice(1); }

// 'mon'..'sun' for a YYYY-MM-DD, the same codes the vault's cadence_days uses.
function dayCode(dayStr) {
  const [y, m, d] = String(dayStr).split('-').map(Number);
  return WEEKDAY_CODES[(new Date(y, m - 1, d, 12).getDay() + 6) % 7];
}

// Valid codes only, canonical order, no duplicates. Accepts an array or a
// comma-separated string, any case, full names too ("Monday" -> mon).
function normalizeWeekdays(raw) {
  const list = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\s]+/);
  const set = new Set();
  for (const v of list) {
    const code = String(v == null ? '' : v).trim().toLowerCase().slice(0, 3);
    if (WEEKDAY_CODES.includes(code)) set.add(code);
  }
  return WEEKDAY_CODES.filter((c) => set.has(c));
}

function routineTypeOf(raw) {
  const t = String(raw == null ? '' : raw).trim().toLowerCase();
  return ROUTINE_TYPES.includes(t) ? t : 'morning';
}

// HH:MM with hours 0-23 and minutes 0-59, zero-padded. A number is read as
// minutes since midnight (what a YAML reader makes of an unquoted 06:30 in
// some dialects). Anything else is null.
function normalizeHM(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw < 1440) {
    return `${pad2(Math.floor(raw / 60))}:${pad2(raw % 60)}`;
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw == null ? '' : raw).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return `${pad2(h)}:${pad2(mm)}`;
}

function fmtMin(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }

// The per-type default times: the stored map merged over the built-in one
// field by field, so a data.json that names one type or one field keeps the
// rest, and a malformed time falls back instead of breaking the settings tab.
function routineDefaultsOf(settings) {
  const base = DEFAULT_SETTINGS.routineDefaults;
  const raw = settings && settings.routineDefaults && typeof settings.routineDefaults === 'object' ? settings.routineDefaults : {};
  const out = {};
  for (const t of ROUTINE_TYPES) {
    const r = raw[t] && typeof raw[t] === 'object' ? raw[t] : {};
    out[t] = { start: normalizeHM(r.start) || base[t].start, end: normalizeHM(r.end) || base[t].end };
  }
  return out;
}

// The weekdays a new routine starts with. An explicit empty list stays
// empty (the person cleared it); only an absent or malformed setting falls
// back to the built-in default.
function routineWeekdaysDefaultOf(settings) {
  const raw = settings ? settings.routineWeekdaysDefault : undefined;
  if (Array.isArray(raw)) return normalizeWeekdays(raw);
  return DEFAULT_SETTINGS.routineWeekdaysDefault.slice();
}

// The steps: list items under "## Steps" until the next heading. A box is
// read as a label, never as state; a plain "- item" counts too.
function routineSteps(body) {
  const out = [];
  let inSteps = false;
  for (const raw of splitLogLines(body)) {
    const line = raw.replace(/\r$/, '');
    if (/^#{1,6}\s/.test(line)) { inSteps = /^#{1,6}\s+steps\s*$/i.test(line); continue; }
    if (!inSteps) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (m) out.push({ index: out.length + 1, label: m[1] });
  }
  return out;
}

function stripFrontmatter(text) {
  return String(text == null ? '' : text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// The routine a note describes, or null for any other note. `fm` is the
// metadata cache's frontmatter, `body` the note text (frontmatter allowed).
function parseRoutineNote(fm, body, path) {
  if (!fm || fm.type !== ROUTINE_TYPE) return null;
  const basename = path ? String(path).split('/').pop().replace(/\.md$/i, '') : '';
  const name = fm.name != null && String(fm.name).trim() ? String(fm.name).trim() : (basename || 'Routine');
  const text = stripFrontmatter(body);
  return {
    path: path || null,
    name,
    routineType: routineTypeOf(fm.routine_type),
    start: normalizeHM(fm.start),
    end: normalizeHM(fm.end),
    weekdays: normalizeWeekdays(fm.weekdays),
    active: fm.active !== false,
    createdAt: fm.created_at ? String(fm.created_at) : null,
    steps: routineSteps(text),
    log: parseLogTable(text, ROUTINE_LOG_SENTINEL),
  };
}

// What a log row says about the day: skipped, or which step indices are
// done. The Steps column is the record; the Done column ("3/3") is the
// human-readable count and is recomputed on every write. A row with a done
// marker and no indices (an agent wrote a habit-style Y) means every step.
function routineRowState(row, total) {
  if (!row) return { skipped: false, done: [] };
  const marker = String(row.marker == null ? '' : row.marker).trim();
  const kind = markerState(marker);
  if (kind === 'skipped') return { skipped: true, done: [] };
  const all = () => Array.from({ length: total }, (_, i) => i + 1);
  const list = String((row.rest && row.rest[0]) || '').trim();
  if (list) {
    const set = new Set(list.split(/[,\s]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= total));
    return { skipped: false, done: Array.from(set).sort((a, b) => a - b) };
  }
  if (kind === 'done') return { skipped: false, done: all() };
  const frac = /^(\d+)\s*\/\s*(\d+)$/.exec(marker);
  if (frac && total > 0 && Number(frac[1]) >= total) return { skipped: false, done: all() };
  return { skipped: false, done: [] };
}

// AM when the routine starts before the split, PM from the split onward.
// Both arguments are HH:MM strings; minutes since midnight are accepted too.
function routineHalf(start, splitTime) {
  const s = typeof start === 'number' ? start : hmToMin(normalizeHM(start), 0);
  const split = typeof splitTime === 'number' ? splitTime : hmToMin(normalizeHM(splitTime), 13 * 60);
  return s < split ? 'am' : 'pm';
}

function routineOccurrence(routine, day, splitTime, defaults) {
  const d = (defaults && defaults[routine.routineType]) || DEFAULT_SETTINGS.routineDefaults[routine.routineType];
  const startMin = hmToMin(routine.start, hmToMin(d.start, 0));
  const endMin = hmToMin(routine.end, hmToMin(d.end, startMin));
  const state = routineRowState(logRowFor(routine.log, day), routine.steps.length);
  const steps = routine.steps.map((s) => ({ index: s.index, label: s.label, done: state.done.includes(s.index) }));
  return {
    routine, day, half: routineHalf(startMin, splitTime), startMin, endMin, steps,
    done: steps.filter((s) => s.done).length, total: steps.length, skipped: state.skipped,
  };
}

// The instances for one day: every active routine whose weekdays include
// the day, in start order. A skipped day is an instance that renders as a
// ghost; a day with no row is an instance with nothing checked yet.
function routineOccurrences(routines, day, splitTime, defaults) {
  const code = dayCode(day);
  return (routines || [])
    .filter((r) => r && r.active && Array.isArray(r.weekdays) && r.weekdays.includes(code))
    .map((r) => routineOccurrence(r, day, splitTime, defaults))
    .sort((a, b) => (a.startMin - b.startMin) || a.routine.name.localeCompare(b.routine.name));
}

// done: every step checked, and there is at least one. ghost: skipped.
function routineCardState(occ) {
  return { ghost: !!occ.skipped, done: !occ.skipped && occ.total > 0 && occ.done === occ.total };
}

function routineKicker(occ) { return `${occ.routine.routineType.toUpperCase()} ROUTINE`; }
function routineTimeLabel(occ) { return `${fmtMin(occ.startMin)} - ${fmtMin(occ.endMin)}`; }

// The next body after one step is checked or unchecked. Reads the day's row
// from the bytes it is given (it runs inside vault.process, so two fast
// taps cannot clobber each other), toggles the index and writes the row
// back with the recomputed count.
function routineLogAfterStep(data, day, index, next, total) {
  const state = routineRowState(logRowFor(parseLogTable(data, ROUTINE_LOG_SENTINEL), day), total);
  const set = new Set(state.done);
  if (next) set.add(index); else set.delete(index);
  const idx = Array.from(set).filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  return upsertLogRow(data, ROUTINE_LOG_SENTINEL, {
    date: day, marker: `${idx.length}/${total}`, rest: [idx.join(',')], createWith: ROUTINE_LOG_SECTION,
  });
}
function routineLogSkipped(data, day) {
  return upsertLogRow(data, ROUTINE_LOG_SENTINEL, { date: day, marker: 'S', rest: [''], createWith: ROUTINE_LOG_SECTION });
}
function routineLogReset(data, day) { return removeLogRow(data, ROUTINE_LOG_SENTINEL, day); }

// The New routine dialog's checks, pure so the sentences are testable.
function validateRoutineInput(input) {
  const i = input || {};
  if (!String(i.name == null ? '' : i.name).trim()) return { ok: false, error: 'Give the routine a name.' };
  const start = normalizeHM(i.start);
  const end = normalizeHM(i.end);
  if (!start || !end) return { ok: false, error: 'Times are HH:MM, for example 06:30.' };
  if (hmToMin(end, 0) <= hmToMin(start, 0)) return { ok: false, error: 'The end must be after the start.' };
  if (!normalizeWeekdays(i.weekdays).length) return { ok: false, error: 'Pick at least one weekday.' };
  return { ok: true, error: null };
}

// The note a new routine starts as. Every contract field is written and
// explicit. `defaults` is the { start, end } pair for the type, or the whole
// per-type map. `opts.steps` seeds the list (one placeholder when empty),
// `opts.nowIso` pins created_at.
function routineTemplate(name, type, weekdays, defaults, opts) {
  const o = opts || {};
  const t = routineTypeOf(type);
  const times = defaults && defaults.start
    ? {
      start: normalizeHM(defaults.start) || DEFAULT_SETTINGS.routineDefaults[t].start,
      end: normalizeHM(defaults.end) || DEFAULT_SETTINGS.routineDefaults[t].end,
    }
    : routineDefaultsOf({ routineDefaults: defaults })[t];
  const clean = String(name == null ? '' : name).trim() || 'Routine';
  let days = normalizeWeekdays(weekdays);
  if (!days.length) days = DEFAULT_SETTINGS.routineWeekdaysDefault.slice();
  const steps = (Array.isArray(o.steps) ? o.steps : []).map((s) => String(s == null ? '' : s).trim()).filter(Boolean);
  const nowIso = o.nowIso || new Date().toISOString();
  return [
    '---',
    `type: ${ROUTINE_TYPE}`,
    `name: ${JSON.stringify(clean)}`,
    `routine_type: ${t}`,
    `start: "${times.start}"`,
    `end: "${times.end}"`,
    `weekdays: [${days.join(', ')}]`,
    'active: true',
    `created_at: ${nowIso}`,
    '---',
    '',
    `# ${clean}`,
    '',
    '## Steps',
    ...(steps.length ? steps : ['First step']).map((s) => `- [ ] ${s}`),
    '',
    ROUTINE_LOG_SECTION.heading,
    `<!-- ${ROUTINE_LOG_SENTINEL}: schema=${ROUTINE_LOG_SECTION.schema} -->`,
    formatLogRow(ROUTINE_LOG_SECTION.header),
    formatLogRow(ROUTINE_LOG_SECTION.header.map(() => '---')),
    '',
  ].join('\n');
}

/* ========================================================================== *
 * Habits (2026-09-04; planner-owned since 0.10.0)
 *
 * A habit is one yes or no per day. The planner owns it: one note per
 * habit under <planner folder>/Habits/ with `type: planner-habit`, created,
 * renamed, paused, archived and deleted from the HABITS tab, its cadence
 * switched there (daily, weekdays, weekly on chosen days, monthly on a day
 * of the month). The My Life Habits room is not read for the board any
 * more: a note there is imported once (its schedule fields and its log
 * table move into the planner note, a pointer line stays in its place) and
 * the planner note keeps `linked_note` pointing back, so the meaning of the
 * habit stays where the person and the AI team write about it.
 *
 * The check-in is a body table under the habit-log sentinel (schema=streak:
 * date, marker, note; schema=process: date, marker, trigger), newest on
 * top, streaks computed and never stored. A check-in never writes
 * frontmatter. Every frontmatter write of the tab goes through
 * processFrontMatter, touches the field it is for and nothing else, and is
 * refused for a path outside <planner folder>/Habits/ before any file is
 * looked up.
 * ========================================================================== */

const HABIT_TYPE = 'planner-habit';
const HABIT_LOG_SENTINEL = 'habit-log';
const HABIT_LOG_SECTION = { heading: '## Log', schema: 'streak', header: ['Date', 'Y/N', 'Note'] };
const HABIT_CADENCES = ['daily', 'weekdays', 'weekly', 'monthly'];
const HABIT_CADENCE_NAMES = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' };
const HABIT_STATUSES = ['active', 'paused', 'archived'];
// A monthly habit lands on one day of the month. 28 is the last day every
// month has, so 29, 30 and 31 are read as 28 rather than skipping February
// and the short months without a word.
const HABIT_MONTH_DAY_MAX = 28;
const HABIT_SKIP_NAMES = /^(index|readme)$/i;
// The schedule fields the tab writes on the planner note, and the fields
// the import removes from the My Life note: the schedule plus the start
// date under either of its names, so a date lives in one note only.
const HABIT_SCHEDULE_FIELDS = ['cadence', 'cadence_days', 'month_day'];
const HABIT_IMPORT_REMOVED_FIELDS = ['cadence', 'cadence_days', 'started_on', 'since'];
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// 'weekday' (a lived alias) reads as 'weekdays'; anything unknown, adhoc
// included, is weekly (with no days it lands nowhere, and the dropdown in
// the tab shows what to fix).
function normalizeCadence(raw) {
  const c = String(raw == null ? '' : raw).trim().toLowerCase();
  if (c === 'weekday') return 'weekdays';
  return HABIT_CADENCES.includes(c) ? c : 'weekly';
}
// 'abandoned' (the My Life shape) reads as archived; anything unknown is active.
function habitStatusOf(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (s === 'abandoned') return 'archived';
  return HABIT_STATUSES.includes(s) ? s : 'active';
}
// The day of the month a monthly habit lands on: 1 to 28, a larger day
// clamped to 28, anything else null (read as the 1st).
function monthDayOf(raw) {
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, HABIT_MONTH_DAY_MAX);
}
// A planner habit note: the type says so, nothing else does.
function isPlannerHabitFrontmatter(fm) {
  return !!fm && typeof fm === 'object' && String(fm.type == null ? '' : fm.type).trim() === HABIT_TYPE;
}
// A My Life habit note, the import's source: the scaffold's `type: habit`
// or a cadence, the folder being the identity. Never read for the board.
function isHabitFrontmatter(fm) {
  return !!fm && typeof fm === 'object'
    && (String(fm.type == null ? '' : fm.type).trim().toLowerCase() === 'habit' || fm.cadence != null);
}
// INDEX.md, README.md and _-prefixed names are room furniture, not habits.
function habitBasenameOk(basename) {
  const b = String(basename == null ? '' : basename);
  return !!b && !b.startsWith('_') && !HABIT_SKIP_NAMES.test(b);
}
function basenameOf(path) {
  return path ? String(path).split('/').pop().replace(/\.md$/i, '') : '';
}
// The note a wikilink names, as a basename: [[a/b|c]] and [[b#h]] are b. A
// bare name passes through. Null for nothing.
function wikilinkBasename(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^\[\[([^\]]+)\]\]$/.exec(s);
  const inner = (m ? m[1] : s).split('|')[0].split('#')[0];
  return basenameOf(inner.trim()) || null;
}
// The note a wikilink names, as a link TARGET: the folders it carries are
// KEPT, the alias, the heading and a ".md" are not. [[a/b|c]] is a/b, a bare
// name is itself, a note path is the path without its extension. Null for
// nothing. The companion of wikilinkBasename, which answers the display
// question ("what is this note called") rather than the storage one ("which
// file does this name"). A habit lives in two notes that share a basename by
// design, so only the target can say which of them a link means.
function wikilinkTarget(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^\[\[([^\]]+)\]\]$/.exec(s);
  const inner = (m ? m[1] : s).split('|')[0].split('#')[0];
  const t = inner.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '');
  return t || null;
}
// The stored shape of a link: `[[<target>]]`, or null for none.
function wikilinkOf(target) { return target ? `[[${target}]]` : null; }
// A target under the folder it is known to live in. A target that already
// names a folder is AUTHORITY and passes through untouched, which is what
// makes the one-time rewrite idempotent and lets a person move a note and
// keep the link. A bare name gains the folder, so the link names one file
// rather than every file with that name.
function qualifyLinkTarget(raw, folder) {
  const t = wikilinkTarget(raw);
  if (!t || t.includes('/')) return t;
  const f = String(folder == null ? '' : folder).trim().replace(/^\/+|\/+$/g, '');
  return f ? `${f}/${t}` : t;
}
// The file a stored link names, or null. The whole TARGET goes to the
// resolver, never the basename: Obsidian resolves a bare name by proximity
// to the note the link sits in, so a planner habit note asking for "Walk"
// got itself back instead of the My Life note it points at.
function linkedFileOf(app, raw, sourcePath) {
  const target = wikilinkTarget(raw);
  if (!target || !app || !app.metadataCache) return null;
  const file = app.metadataCache.getFirstLinkpathDest(target, sourcePath || '');
  return file instanceof TFile ? file : null;
}

// The habit a planner note describes, or null. `fm` is the metadata
// cache's frontmatter, `path` the note path, `body` the note text
// (frontmatter allowed; the log is read from it).
function habitFromFrontmatter(fm, path, body) {
  if (!isPlannerHabitFrontmatter(fm)) return null;
  const basename = basenameOf(path);
  if (!habitBasenameOk(basename)) return null;
  const log = parseLogTable(stripFrontmatter(body), HABIT_LOG_SENTINEL);
  const cadence = normalizeCadence(fm.cadence);
  const startedOn = fm.started_on == null ? '' : String(fm.started_on).slice(0, 10);
  const linked = fm.linked_note == null ? '' : String(fm.linked_note).trim();
  return {
    path: path || null,
    slug: basename,
    name: fm.name != null && String(fm.name).trim() ? String(fm.name).trim() : basename,
    cadence,
    cadenceDays: cadence === 'weekly' ? normalizeWeekdays(fm.cadence_days) : null,
    monthDay: cadence === 'monthly' ? monthDayOf(fm.month_day) : null,
    status: habitStatusOf(fm.status),
    startedOn: ISO_DAY_RE.test(startedOn) ? startedOn : null,
    linkedNote: linked || null,
    // The same two questions the item side asks: what to call it, and which
    // file it is. The My Life note and this one share a basename by design.
    linkedBasename: linked ? wikilinkBasename(linked) : null,
    linkedTarget: linked ? wikilinkTarget(linked) : null,
    logSchema: log.found ? (log.schema || 'streak') : null,
    log,
  };
}

// The weekdays a cadence lands on, for the toggle row: daily all seven,
// weekdays Monday to Friday, weekly the listed days, monthly none (it is a
// day of the month, not a weekday).
function daysFromCadence(cadence, cadenceDays) {
  const c = normalizeCadence(cadence);
  if (c === 'daily') return WEEKDAY_CODES.slice();
  if (c === 'weekdays') return WEEKDAY_CODES.slice(0, 5);
  if (c === 'monthly') return [];
  return normalizeWeekdays(cadenceDays);
}
function habitDays(habit) { return daysFromCadence(habit.cadence, habit.cadenceDays); }
function dayOfMonth(day) { return Number.parseInt(String(day).slice(8, 10), 10); }
// Whether an ACTIVE habit is scheduled on a day: monthly matches the day of
// the month (the 1st when none is set), the rest match the weekday. A
// paused or archived habit never lands anywhere.
function habitLandsOn(habit, day) {
  if (!habit || habit.status !== 'active') return false;
  if (habit.cadence === 'monthly') return dayOfMonth(day) === (habit.monthDay || 1);
  return habitDays(habit).includes(dayCode(day));
}
// The schedule as a predicate over a day, for the streak.
function habitScheduleOf(habit) { return (day) => habitLandsOn(habit, day); }

// Consecutive scheduled days with a done marker, ending today or yesterday
// (today pending does not break it: the day is not over). Unscheduled days
// are skipped, so a weekday habit's Friday and Monday join across the
// weekend and a monthly habit's months join. `schedule` is a list of
// weekday codes or a predicate over a day. Computed at render, never
// written.
function streakOf(log, schedule, today) {
  let on = schedule;
  if (typeof schedule !== 'function') {
    const codes = normalizeWeekdays(schedule);
    if (!codes.length) return 0;
    on = (d) => codes.includes(dayCode(d));
  }
  if (!log || !Array.isArray(log.rows)) return 0;
  const markers = new Map();
  for (const r of log.rows) if (r.date) markers.set(r.date, r.marker);
  const end = String(today);
  let d = end;
  let n = 0;
  for (let guard = 0; guard < 3660; guard++) {
    if (on(d)) {
      const state = markerState(markers.has(d) ? markers.get(d) : '');
      if (state === 'done') n++;
      else if (!(d === end && state === 'pending')) break;
    }
    d = addDays(d, -1);
  }
  return n;
}

// One row's state on the board: checked for a done marker, missed for a
// not-done marker, disabled when the day is still ahead (the week's plan is
// visible, nothing is logged early). Past days stay checkable.
function habitRowState(day, today, marker) {
  const state = markerState(marker);
  return { checked: state === 'done', missed: state === 'missed', disabled: String(day) > String(today) };
}

// The day's habit instances: every active habit scheduled for that day, by
// name, each with its row state and (streak schema only, when asked) its
// streak as of that day.
function habitOccurrences(habits, day, today, opts) {
  const o = opts || {};
  const out = [];
  for (const h of habits || []) {
    if (!habitLandsOn(h, day)) continue;
    const row = logRowFor(h.log, day);
    const marker = row ? row.marker : '';
    const asOf = String(day) > String(today) ? today : day;
    const streak = o.streaks !== false && h.logSchema === 'streak' ? streakOf(h.log, habitScheduleOf(h), asOf) : null;
    out.push({ habit: h, day, marker, ...habitRowState(day, today, marker), streak });
  }
  return out.sort((a, b) => a.habit.name.localeCompare(b.habit.name));
}

// The next body after a check or an uncheck. Runs inside vault.process, on
// the bytes on disk. A check upserts Y (the note text a person wrote on the
// row survives; a process-schema trigger column is left for the check-in
// to fill); a note with no log yet gains "## Log", the sentinel and the
// header. An uncheck writes _ (pending: the day is not over and the
// session-close ask stays alive) when the row carries no text, N when it
// does. No row to uncheck: nothing to do.
function habitLogAfterCheck(data, day, next) {
  if (next) return upsertLogRow(data, HABIT_LOG_SENTINEL, { date: day, marker: 'Y', createWith: HABIT_LOG_SECTION });
  const row = logRowFor(parseLogTable(data, HABIT_LOG_SENTINEL), day);
  if (!row) return String(data == null ? '' : data);
  const noted = row.rest.some((c) => String(c).trim() !== '');
  return upsertLogRow(data, HABIT_LOG_SENTINEL, { date: day, marker: noted ? 'N' : '_' });
}

/* ---- the HABITS tab: its model, its writes and the new-habit note, pure -- */

// One row of the tab: the toggles show the implied days for daily and
// weekdays (inert), the chosen days for weekly (live), and give way to a
// day-of-month field for monthly (monthDayField). The field's value is
// the note's month_day, or null when the note has none: the board reads
// that as the 1st, and the field shows empty so the person can set it
// rather than reading a 1 the note never said. A paused or archived row
// is quiet.
function habitRowModel(habit) {
  const monthly = habit.cadence === 'monthly';
  return {
    weekdays: habitDays(habit),
    weekdaysEditable: habit.cadence === 'weekly',
    monthDayField: monthly,
    monthDay: monthly ? (habit.monthDay == null ? null : habit.monthDay) : null,
    quiet: habit.status !== 'active',
    statusLabel: String(habit.status).toUpperCase(),
  };
}

// The frontmatter after a cadence switch, applied in place (inside
// processFrontMatter in the plugin, on a plain object in the tests): the
// cadence, the field the new cadence reads kept or seeded, the field it
// does not read removed. Nothing else is touched.
function applyHabitCadence(fm, cadence) {
  const c = normalizeCadence(cadence);
  fm.cadence = c;
  if (c === 'weekly') {
    fm.cadence_days = normalizeWeekdays(fm.cadence_days);
    delete fm.month_day;
  } else if (c === 'monthly') {
    fm.month_day = monthDayOf(fm.month_day) || 1;
    delete fm.cadence_days;
  } else {
    delete fm.cadence_days;
    delete fm.month_day;
  }
  return fm;
}

// The New habit dialog's checks, pure so the sentences are testable. The
// import runs them lenient: a My Life adhoc habit arrives as weekly with no
// days, which the dialog would not let a person create.
function validateHabitInput(input, opts) {
  const i = input || {};
  const o = opts || {};
  if (!String(i.name == null ? '' : i.name).trim()) return { ok: false, error: 'Give the habit a name.' };
  const c = String(i.cadence == null ? '' : i.cadence).trim().toLowerCase();
  if (!HABIT_CADENCES.includes(c)) return { ok: false, error: 'Pick a cadence: daily, weekdays, weekly or monthly.' };
  if (c === 'weekly' && !o.lenient && !normalizeWeekdays(i.cadenceDays).length) return { ok: false, error: 'Pick at least one weekday.' };
  if (c === 'monthly') {
    const raw = String(i.monthDay == null ? '' : i.monthDay).trim();
    // The import (lenient) may bring a monthly habit with no day: it stays
    // absent and reads as the 1st. A day that IS given must be a day.
    const absent = raw === '';
    const n = Number.parseInt(raw, 10);
    if (!(o.lenient && absent) && (!Number.isFinite(n) || n < 1 || n > HABIT_MONTH_DAY_MAX)) return { ok: false, error: `The day of the month is 1 to ${HABIT_MONTH_DAY_MAX}.` };
  }
  const s = String(i.startedOn == null ? '' : i.startedOn).trim();
  if (s && !ISO_DAY_RE.test(s)) return { ok: false, error: 'The start date is YYYY-MM-DD.' };
  return { ok: true, error: null };
}

// The frontmatter a new habit note starts with, every contract field
// present and explicit, in the order it is written. `opts.nowIso` pins
// created_at, an instant (UTC). `opts.today` pins the start date when
// none is given: a calendar date, the LOCAL one (todayStr), never the
// UTC day of nowIso. A member importing at 19:20 Pacific got a start date
// one day in the future because the two were the same slice.
// `opts.linkFolder` is the My Life Habits room from the settings: a bare
// linked-note name gains it, so `linked_note` names one file rather than
// every file called that. A value that already names a folder keeps it.
function habitFrontmatterOf(input, opts) {
  const i = input || {};
  const o = opts || {};
  const nowIso = o.nowIso || new Date().toISOString();
  const today = ISO_DAY_RE.test(String(o.today == null ? '' : o.today)) ? String(o.today) : todayStr();
  const cadence = normalizeCadence(i.cadence);
  const started = String(i.startedOn == null ? '' : i.startedOn).trim().slice(0, 10);
  const linked = i.linkedNote == null ? null : qualifyLinkTarget(i.linkedNote, o.linkFolder);
  const fm = {
    type: HABIT_TYPE,
    name: String(i.name == null ? '' : i.name).trim() || 'Habit',
    cadence,
    status: habitStatusOf(i.status),
  };
  if (cadence === 'weekly') fm.cadence_days = normalizeWeekdays(i.cadenceDays);
  if (cadence === 'monthly') {
    // The dialog path (not lenient) validated the day already and keeps
    // writing it; the import path (lenient) leaves an absent day absent,
    // read as the 1st and shown empty in the tab for the person to set.
    const md = monthDayOf(i.monthDay);
    if (md !== null) fm.month_day = md;
    else if (!o.lenient) fm.month_day = 1;
  }
  fm.started_on = ISO_DAY_RE.test(started) ? started : today;
  if (linked) fm.linked_note = `[[${linked}]]`;
  fm.created_at = nowIso;
  return fm;
}

// The note a new habit starts as: the frontmatter above, the title, and the
// log section, empty (the sentinel and the header) or, on import, the
// block moved over from the My Life note byte for byte (`opts.logBlock`).
function habitTemplate(input, opts) {
  const o = opts || {};
  const fm = habitFrontmatterOf(input, o);
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else if (k === 'name' || k === 'linked_note') lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', `# ${fm.name}`, '', HABIT_LOG_SECTION.heading);
  const block = o.logBlock != null && String(o.logBlock).trim() ? String(o.logBlock).replace(/\r?\n$/, '') : null;
  if (block) lines.push(block);
  else {
    lines.push(
      `<!-- ${HABIT_LOG_SENTINEL}: schema=${HABIT_LOG_SECTION.schema} -->`,
      formatLogRow(HABIT_LOG_SECTION.header),
      formatLogRow(HABIT_LOG_SECTION.header.map(() => '---')),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/* ---- the import from My Life, pure --------------------------------------- */

// What a My Life note becomes: the name from `name` or the file name; the
// cadence mapped (daily, weekdays or its weekday alias, weekly with the
// days, monthly with its day; unknown or adhoc is weekly with no days); the
// start from `started_on` or `since`; the status carried (abandoned is
// archived); the link back to the note by its PATH, because the planner
// note about to be created will share its basename.
function importMapping(fm, basename, sourcePath) {
  const f = fm || {};
  const raw = String(f.cadence == null ? '' : f.cadence).trim().toLowerCase();
  const cadence = normalizeCadence(raw);
  const known = raw === 'weekday' || HABIT_CADENCES.includes(raw);
  const since = f.started_on || f.since || null;
  const started = since == null ? '' : String(since).slice(0, 10);
  return {
    name: f.name != null && String(f.name).trim() ? String(f.name).trim() : basename,
    cadence,
    cadenceDays: cadence === 'weekly' && known ? normalizeWeekdays(f.cadence_days) : [],
    // An absent month_day stays absent (2026-09-07): the note is read as
    // the 1st either way, and the import must not replace a documented
    // absence with a specific wrong day. The tab shows the field empty.
    monthDay: cadence === 'monthly' ? monthDayOf(f.month_day) : null,
    startedOn: ISO_DAY_RE.test(started) ? started : null,
    status: habitStatusOf(f.status),
    linkedNote: wikilinkOf(wikilinkTarget(sourcePath) || basename),
  };
}
// The import's rows: the My Life notes that are habits (by the My Life
// shape), are not room furniture, and do not carry the back-link yet
// (importDone, read on the source). When a planner note already links to
// such a note, a run stopped half way; the row carries that note's path as
// `existingPlanner` so the import resumes into it instead of making a
// second one. `notes` are { path, basename, fm }; `plannerHabits` the
// parsed planner notes. Sorted by name.
function importPlan(notes, plannerHabits) {
  const byLink = new Map();
  for (const h of plannerHabits || []) if (h && h.linkedBasename && !byLink.has(h.linkedBasename)) byLink.set(h.linkedBasename, h.path);
  const out = [];
  for (const n of notes || []) {
    if (!n || !isHabitFrontmatter(n.fm) || isPlannerHabitFrontmatter(n.fm) || importDone(n.fm, plannerHabits || [])) continue;
    const basename = n.basename || basenameOf(n.path);
    if (!habitBasenameOk(basename)) continue;
    out.push({ path: n.path, basename, ...importMapping(n.fm, basename, n.path), existingPlanner: byLink.get(basename) || null });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
// The one line the My Life note keeps where its log table was, and the one
// place its sentence is written. The link carries the planner folder for
// the same reason the two frontmatter fields do (0.14.1): a habit lives in
// two notes that share a name, a bare [[X]] resolves by proximity, and from
// the My Life room proximity is the My Life note the line sits in, so the
// one link a person actually clicks was the one still pointing at itself.
// `plannerTarget` is the planner note's TARGET (its path without the
// extension), never a bare name this would have to guess a folder for.
const HABIT_POINTER_PREFIX = 'Schedule and check-ins: ';
function habitPointerLine(plannerTarget) { return `${HABIT_POINTER_PREFIX}[[${plannerTarget}]]`; }
// The target a pointer line names, or null when the line is not one. BOTH
// shapes are read: the bare [[Walk]] every note pointed before 0.14.2
// carries, and the qualified [[02 Planner/Habits/Walk]] written now. Only
// the shape this file writes is recognised; an alias, a heading or anything
// after the link is a line a person shaped by hand, and it is left to them.
const HABIT_POINTER_LINK_RE = /^\[\[([^\]|#]+)\]\]$/;
function habitPointerTargetOf(line) {
  const s = String(line == null ? '' : line).replace(/\r$/, '');
  if (!s.startsWith(HABIT_POINTER_PREFIX)) return null;
  const m = HABIT_POINTER_LINK_RE.exec(s.slice(HABIT_POINTER_PREFIX.length));
  return m ? wikilinkTarget(m[1]) : null;
}
// The index of the first BODY line: past the frontmatter fence when the note
// opens with one, else zero. The pointer is prose a person reads, and its
// sentence happens to have the shape of a YAML key, so the block is skipped
// rather than searched.
function bodyStartIndex(lines) {
  if (!(lines.length > 1 && lines[0].replace(/\r$/, '') === '---')) return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '') === '---') return i + 1;
  return 0;
}
// Does this note already point at the habit `plannerTarget` names? A bare
// line counts, so a note pointed before 0.14.2 never gains a second one; a
// qualified line naming ANOTHER note does not, because it means another
// habit. This is the import's idempotency check.
function habitHasPointer(body, plannerTarget) {
  const want = wikilinkTarget(plannerTarget);
  if (!want) return false;
  const short = want.split('/').pop();
  const lines = splitLogLines(String(body == null ? '' : body));
  for (let i = bodyStartIndex(lines); i < lines.length; i++) {
    const t = habitPointerTargetOf(lines[i]);
    if (t && (t === want || t === short)) return true;
  }
  return false;
}
// The sentinel block of a note: the sentinel line through the last table
// row, byte for byte (line endings included), or null without one.
function habitLogBlockOf(body) {
  const text = String(body == null ? '' : body);
  const parsed = parseLogTable(text, HABIT_LOG_SENTINEL);
  if (!parsed.found) return null;
  return splitLogLines(text).slice(parsed.start, parsed.end).join('\n');
}
// The My Life note after the import: the sentinel block replaced by the
// pointer line; a note with no block gets the pointer at its end; a note
// that already carries the pointer and no block is left as it is. Every
// other byte stays.
function moveHabitLog(body, plannerTarget) {
  const text = String(body == null ? '' : body);
  const pointer = habitPointerLine(plannerTarget);
  const parsed = parseLogTable(text, HABIT_LOG_SENTINEL);
  if (!parsed.found) {
    if (habitHasPointer(text, plannerTarget)) return text;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let base = text;
    if (base.length && !base.endsWith('\n')) base += eol;
    return `${base}${base.length ? eol : ''}${pointer}${eol}`;
  }
  const lines = splitLogLines(text);
  const eol = lines[parsed.start].endsWith('\r') ? '\r' : '';
  lines.splice(parsed.start, parsed.end - parsed.start, pointer + eol);
  return lines.join('\n');
}
// The My Life note's frontmatter after the import, as a TEXT edit
// (2026-09-07). Until 0.10.1 this went through processFrontMatter, which
// reserialises the whole block and dropped a member's YAML comment lines
// (the scaffold's own example note lost the comment that says where the
// schedule lives). This touches only the lines it is asked about:
//   - the top-level keys in HABIT_IMPORT_REMOVED_FIELDS go, each as a
//     scalar line, an inline list, or a key followed by its block-list
//     lines (indented, or "- " at column 0); they live in the planner
//     note now;
//   - `type: habit` is added when the block has no top-level type key, or
//     fills an empty one (a lived-vault note's only habit mark was the
//     cadence that just left);
//   - `planner_habit`, the back-link, is added at the end of the block or
//     replaces the line it already has, quoted the way processFrontMatter
//     writes a value that starts with a bracket. `plannerLink` is the
//     planner note's TARGET (its path without the extension), never a bare
//     slug: the two notes of a habit share a basename, so a bare link
//     cannot name one of them.
// Every other line stays byte for byte, comments and blank lines
// included; CRLF is kept (lines split on "\n" keep their "\r", new lines
// copy the opening line's ending); a note with no block gets one.
const FM_KEY_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:\s|$)/;
const FM_CONTINUATION_RE = /^(\s+\S|-\s)/;
function importSourceFrontmatterText(text, plannerLink) {
  const src = String(text == null ? '' : text);
  const link = `planner_habit: ${JSON.stringify(`[[${plannerLink}]]`)}`;
  const lines = src.split('\n');
  const opens = lines.length > 1 && lines[0].replace(/\r$/, '') === '---';
  let close = -1;
  if (opens) for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '') === '---') { close = i; break; }
  if (close < 0) {
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    return `---${eol}type: habit${eol}${link}${eol}---${eol}${src}`;
  }
  const eol = lines[0].endsWith('\r') ? '\r' : '';
  const removed = new Set(HABIT_IMPORT_REMOVED_FIELDS);
  const out = [lines[0]];
  let hasType = false;
  let linked = false;
  for (let i = 1; i < close; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '');
    const m = FM_KEY_RE.exec(line);
    const key = m ? m[1] : null;
    if (key && (removed.has(key) || key === 'planner_habit')) {
      // the key line and every block-list line under it
      let j = i + 1;
      while (j < close && FM_CONTINUATION_RE.test(lines[j].replace(/\r$/, ''))) j++;
      if (key === 'planner_habit') { out.push(link + eol); linked = true; }
      i = j - 1;
      continue;
    }
    if (key === 'type') {
      const value = line.slice(m[0].length).trim();
      const empty = value === '' || value === '""' || value === "''" || value.startsWith('#');
      if (empty) { out.push(`type: habit${value.startsWith('#') ? ` ${value}` : ''}${eol}`); hasType = true; continue; }
      hasType = true;
    }
    out.push(raw);
  }
  if (!hasType) out.push(`type: habit${eol}`);
  if (!linked) out.push(link + eol);
  for (let i = close; i < lines.length; i++) out.push(lines[i]);
  return out.join('\n');
}
// What the import changes in each My Life note, said at the point of
// consent: the sentence above the modal's checkboxes and under the settings
// button are this one string, so the two can never drift apart.
const IMPORT_EDITS_TEXT = 'In each My Life note the import: removes cadence, cadence_days, started_on, since from the frontmatter; adds type: habit when missing and planner_habit; moves the log table into the planner note and leaves a pointer line.';
// A My Life note is imported once it carries the back-link. Read on the
// SOURCE, never inferred from the planner side, so a run that stopped
// between its writes shows the note again and the import resumes it.
//
// With `plannerHabits` (the parsed planner notes) the back-link must also
// NAME one of them: a link to the note itself, or to a planner note that is
// not there, is not an import. A bare name counts when a planner note has
// that name (every note imported before 0.14.1 carries one); a path counts
// when it is that note's path. Case is ignored, as Obsidian ignores it.
function importDone(fm, plannerHabits) {
  if (!(!!fm && typeof fm === 'object' && fm.planner_habit != null && String(fm.planner_habit).trim() !== '')) return false;
  if (plannerHabits === undefined) return true;
  const want = (wikilinkTarget(fm.planner_habit) || '').toLowerCase();
  if (!want) return false;
  return (plannerHabits || []).some((h) => !!h && !!h.path && (want.includes('/')
    ? (wikilinkTarget(h.path) || '').toLowerCase() === want
    : basenameOf(h.path).toLowerCase() === want));
}

/* ---- the one-time link qualification (0.14.1) ---------------------------- */

// One frontmatter line, rewritten in place. The block is edited as TEXT,
// the same path the import has taken since 0.11.0, so a note's YAML
// comments and blank lines survive; no other line is looked at and the body
// is never touched. A value that already names a folder is left alone, so a
// second run writes nothing at all.
//
// Only the three shapes the plugin itself writes are rewritten: `[[X]]`,
// `"[[X]]"` and `'[[X]]'`, where X is a plain name, with nothing after them.
// Anything else (an empty value, a trailing comment, an alias, a heading, a
// list) is a shape this does not understand well enough to rewrite without
// losing something a person put there, so it is returned untouched.
const FM_PLAIN_LINK_RE = /^(?:"(\[\[[^"\]|#]+\]\])"|'(\[\[[^'\]|#]+\]\])'|(\[\[[^\]|#]+\]\]))$/;
function qualifyFrontmatterLink(text, key, folder) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  if (!(lines.length > 1 && lines[0].replace(/\r$/, '') === '---')) return src;
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '') === '---') { close = i; break; }
  if (close < 0) return src;
  for (let i = 1; i < close; i++) {
    const raw = lines[i];
    const line = raw.replace(/\r$/, '');
    const m = FM_KEY_RE.exec(line);
    if (!m || m[1] !== key) continue;
    const shape = FM_PLAIN_LINK_RE.exec(line.slice(m[0].length).trim());
    if (!shape) return src;
    const target = wikilinkTarget(shape[1] || shape[2] || shape[3]);
    if (!target || target.includes('/')) return src;
    const qualified = qualifyLinkTarget(target, folder);
    if (!qualified || qualified === target) return src;
    lines[i] = `${key}: ${JSON.stringify(`[[${qualified}]]`)}${raw.endsWith('\r') ? '\r' : ''}`;
    return lines.join('\n');
  }
  return src;
}

// The My Life note's pointer line, qualified to the planner folder. One
// line, as a TEXT edit, the same discipline the frontmatter rewrite has: no
// other line is looked at, the frontmatter block is not entered, and a
// pointer that already names a folder is authority and passes through, which
// is what makes a second run a no-op.
function qualifyHabitPointer(text, folder) {
  const src = String(text == null ? '' : text);
  const lines = src.split('\n');
  for (let i = bodyStartIndex(lines); i < lines.length; i++) {
    const target = habitPointerTargetOf(lines[i]);
    if (!target || target.includes('/')) continue;
    const qualified = qualifyLinkTarget(target, folder);
    if (!qualified || qualified === target) return src;
    lines[i] = habitPointerLine(qualified) + (lines[i].endsWith('\r') ? '\r' : '');
    return lines.join('\n');
  }
  return src;
}

// Which notes still carry a folderless cross-link, and what each one needs.
// Pure: `plannerHabits` are the parsed planner notes, `sourceNotes` the
// { path, fm } of the My Life room, `folders` the two settings. An empty
// result is the steady state, which is how "a second run changes nothing"
// is read off the plan rather than off the disk. Each row carries the bare
// `target` it would qualify, so the caller can ask the vault whether that
// note is actually in the folder before naming it.
function qualifyLinkPlan(plannerHabits, sourceNotes, folders) {
  const f = folders || {};
  const out = [];
  const bare = (raw) => { const t = wikilinkTarget(raw); return t && !t.includes('/') ? t : null; };
  for (const h of plannerHabits || []) {
    const t = h && h.path ? bare(h.linkedNote) : null;
    if (t) out.push({ path: h.path, field: 'linked_note', folder: f.importFolder, target: t });
  }
  for (const n of sourceNotes || []) {
    if (!n || !n.path || !importDone(n.fm)) continue;
    const t = bare(n.fm.planner_habit);
    if (t) out.push({ path: n.path, field: 'planner_habit', folder: f.plannerFolder, target: t });
    // The body pointer, the same question one line lower. It lives in the
    // text, so a note whose `body` was not read cannot answer it and no row
    // is emitted for it; the caller decides whose body is worth reading.
    if (n.body == null) continue;
    const lines = splitLogLines(String(n.body));
    for (let i = bodyStartIndex(lines); i < lines.length; i++) {
      const p = habitPointerTargetOf(lines[i]);
      if (!p || p.includes('/')) continue;
      out.push({ path: n.path, field: 'pointer', folder: f.plannerFolder, target: p });
      break;
    }
  }
  return out;
}
// The planner note adopting a log block that is still in the source (a
// run that stopped before the body write): only when the planner note has
// no sentinel block of its own yet; under its Log heading when it has one,
// else appended as a Log section. Pure.
function adoptLogBlock(plannerBody, block) {
  const text = String(plannerBody == null ? '' : plannerBody);
  if (!block || parseLogTable(text, HABIT_LOG_SENTINEL).found) return text;
  const lines = splitLogLines(text);
  const at = lines.findIndex((l) => l.replace(/\r$/, '') === HABIT_LOG_SECTION.heading);
  if (at >= 0) { lines.splice(at + 1, 0, block); return lines.join('\n'); }
  let base = text;
  if (base.length && !base.endsWith('\n')) base += '\n';
  return `${base}\n${HABIT_LOG_SECTION.heading}\n${block}\n`;
}
// The import modal's line under a candidate, and its button.
function importCandidateText(c) {
  const parts = [HABIT_CADENCE_NAMES[c.cadence] || 'Weekly'];
  if (c.cadence === 'weekly') parts[0] += c.cadenceDays && c.cadenceDays.length ? ` on ${c.cadenceDays.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(', ')}` : ', no weekdays yet';
  if (c.cadence === 'monthly') parts[0] += c.monthDay ? ` on day ${c.monthDay}` : ', no day of the month yet';
  if (c.status && c.status !== 'active') parts.push(c.status);
  if (c.startedOn) parts.push(`since ${c.startedOn}`);
  parts.push(`from ${c.basename}.md`);
  return `${parts.join('; ')}.`;
}
function importButtonText(n) { return `Import ${n}`; }
// The Notice after an import.
function importSummaryText(r) {
  const done = r.done || 0;
  const parts = [`Planner: imported ${done} habit${done === 1 ? '' : 's'} from My Life`];
  if (r.skipped) parts.push(`${r.skipped} skipped (linked already)`);
  if (r.failed && r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.join('; ')}`);
  return `${parts.join(', ')}.`;
}
// The Notice when Import is pressed and there is nothing new to take
// (0.14.1). The tap is still the consent moment, so the one-time link
// qualification runs first and this says what it did. For a vault whose
// habits were all imported before 0.14.1 this is the only entry there is.
// Rows left alone are named only when there are any: a person with none
// should not have to read about them.
function qualifySummaryText(r) {
  const done = (r && r.qualified) || 0;
  const left = (r && r.left) || 0;
  const parts = ['Planner: nothing new to import; every habit note in My Life is linked already.'];
  if (done) parts.push(done === 1 ? '1 habit link now carries its folder.' : `${done} habit links now carry their folder.`);
  if (left) parts.push(left === 1 ? '1 link left as it was, its note is not in the folder.' : `${left} links left as they were, their notes are not in the folder.`);
  return parts.join(' ');
}
// The settings tab's line under the import folder.
function importFolderText(folder, n) {
  const tail = n ? `${n} habit note${n === 1 ? '' : 's'} not imported yet.` : 'Every habit note here is imported or linked.';
  return `Read for the import and the link picker only; the planner never writes here except during an import. ${tail}`;
}

// The settings count line.
function habitsCountText(habits, folder) {
  const list = habits || [];
  if (!list.length) return `No habits in ${folder} yet.`;
  const count = (s) => list.filter((h) => h.status === s).length;
  const active = count('active');
  const parts = [`${active} active habit${active === 1 ? '' : 's'}`];
  if (count('paused')) parts.push(`${count('paused')} paused`);
  if (count('archived')) parts.push(`${count('archived')} archived`);
  return `${parts.join(', ')} in ${folder}.`;
}

/* ========================================================================== *
 * Weeks (2026-09-15)
 *
 * One note per ISO week at <planner folder>/Weeks/YYYY-Www.md, `type:
 * planner-week`, with two sentinel blocks in the body. It answers the two
 * questions nothing in the vault could answer before: what am I trying to
 * achieve this week, and what is the one thing that would make today a win.
 *
 * The two words, ruled 2026-09-15:
 *
 *   Weekly priority - one line in this week's note, an outcome with a done
 *                     state. Heading "## Weekly priorities", sentinel
 *                     weekly-priorities.
 *   Daily highlight - one sentence per day, chosen in the morning and
 *                     confirmed in the evening. Heading "## Daily
 *                     highlights", sentinel daily-highlights.
 *
 * Neither is a Goal. A Goal is the note in My Life, and that word stays
 * there. The starred planner item is neither either: it is a task PINNED to
 * the week, and its frontmatter key (`weekly_goal`) is unchanged because a
 * key a plugin has already written under is a migration and a label is not.
 *
 * What the plugin may write in this note: the two sentinel blocks, and the
 * `week` field when the note is created. Nothing else. Everything a person
 * typed around the blocks comes back byte for byte, which is what
 * upsertLogRow and toggleChecklistItem are built for. The note may equally
 * be edited by hand or by the vault's own planner-week.py; the parser reads
 * the shape, never who wrote it.
 * ========================================================================== */

const WEEK_TYPE = 'planner-week';
const WEEK_PRIORITIES_SENTINEL = 'weekly-priorities';
const WEEK_PRIORITIES_SECTION = { heading: '## Weekly priorities', schema: 'checklist' };
const WEEK_HIGHLIGHTS_SENTINEL = 'daily-highlights';
const WEEK_HIGHLIGHTS_SECTION = { heading: '## Daily highlights', schema: 'highlight', header: ['Date', 'Highlight', 'Done'] };
const WEEK_ISO_RE = /^\d{4}-W\d{2}$/;
// The marker set is the habit log's, so one vocabulary covers every check in
// the plugin: Y done, N not done, _ or blank pending.
const WEEK_HIGHLIGHT_MARKERS = ['Y', 'N', '_'];

const p2 = (n) => String(n).padStart(2, '0');
const DAY_MS = 86400000;

// The ISO week a local day falls in, as YYYY-Www. Computed in UTC on purpose:
// the arithmetic is whole days and a local Date crossing a DST boundary can
// land an hour short of the next midnight.
function isoWeekOf(dayStr) {
  const parts = String(dayStr == null ? '' : dayStr).split('-').map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  if (Number.isNaN(dt.getTime())) return null;
  // The Thursday of this week decides which year the week belongs to.
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 3);
  const year = dt.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const firstThu = new Date(Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7) + 3));
  const week = 1 + Math.round((dt.getTime() - firstThu.getTime()) / (7 * DAY_MS));
  return `${year}-W${p2(week)}`;
}

// The Monday of an ISO week, or null when the string is not one. A week
// number a year does not have (2026-W53) is null rather than a silent roll
// into January: the round trip through isoWeekOf is the check.
function mondayOfIsoWeek(iso) {
  const s = String(iso == null ? '' : iso).trim();
  if (!WEEK_ISO_RE.test(s)) return null;
  const year = Number(s.slice(0, 4));
  const week = Number(s.slice(6));
  if (week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const mondayW1 = Date.UTC(year, 0, 4 - ((jan4.getUTCDay() + 6) % 7));
  const d = new Date(mondayW1 + (week - 1) * 7 * DAY_MS);
  const out = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  return isoWeekOf(out) === s ? out : null;
}

// The seven days of an ISO week, Monday first.
function isoWeekDays(iso) {
  const monday = mondayOfIsoWeek(iso);
  return monday ? weekDays(monday) : [];
}

/* ---- the weekly-priorities checklist ------------------------------------- */

// -> { found, schema, start, end, items: [{ line, done, text }] }
// `start` is the sentinel's line index; `end` is where a new item goes (just
// past the last checkbox, or just past the sentinel when there is none). The
// block runs to the next heading, and a line inside it that is not a checkbox
// is ignored and left exactly as it is - a person's note between two
// priorities is not the plugin's to rewrite.
function parseChecklistBlock(body, sentinelName) {
  const lines = splitLogLines(body);
  const re = logSentinelRe(sentinelName);
  const none = { found: false, schema: null, start: -1, end: -1, items: [] };
  let start = -1;
  let schema = null;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    start = i;
    const sm = /schema=([A-Za-z0-9_-]+)/.exec(m[1] || '');
    schema = sm ? sm[1] : null;
    break;
  }
  if (start < 0) return none;
  const items = [];
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (/^#{1,6}\s/.test(line)) break;
    const m = CHECKLIST_ITEM_RE.exec(line);
    if (!m) continue;
    items.push({ line: i, done: m[2].toLowerCase() === 'x', text: m[4] });
    end = i + 1;
  }
  return { found: true, schema, start, end, items };
}

const CHECKLIST_ITEM_RE = /^(\s*(?:[-*+])\s+\[)([ xX])(\]\s+)(.*?)\s*$/;

// Flips ONE box, in place, keeping the line's own bullet, indent, wording and
// line ending. Anything else in the file comes back byte for byte.
function toggleChecklistItem(body, sentinelName, index) {
  const text = String(body == null ? '' : body);
  const parsed = parseChecklistBlock(text, sentinelName);
  const item = parsed.items[index];
  if (!item) return text;
  const lines = splitLogLines(text);
  const raw = lines[item.line];
  const eol = raw.endsWith('\r') ? '\r' : '';
  const flipped = raw.replace(/\r$/, '').replace(CHECKLIST_ITEM_RE,
    (_all, head, _box, tail, label) => `${head}${item.done ? ' ' : 'x'}${tail}${label}`);
  lines[item.line] = flipped + eol;
  return lines.join('\n');
}

// Appends one unchecked item at the end of the block, or creates the whole
// section from `createWith` when the note has no such block yet. An empty or
// blank text is refused (nothing is written), because a blank priority is a
// row nobody can act on.
function addChecklistItem(body, sentinelName, text, createWith) {
  const base = String(body == null ? '' : body);
  const clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return base;
  const parsed = parseChecklistBlock(base, sentinelName);
  if (!parsed.found) {
    if (!createWith) return base;
    const eol = base.includes('\r\n') ? '\r' : '';
    let head = base;
    if (head.length && !head.endsWith('\n')) head += `${eol}\n`;
    const section = [
      '',
      createWith.heading || '## Weekly priorities',
      `<!-- ${sentinelName}: schema=${createWith.schema || 'checklist'} -->`,
      `- [ ] ${clean}`,
    ];
    return head + section.join(`${eol}\n`) + `${eol}\n`;
  }
  const lines = splitLogLines(base);
  const anchor = parsed.items.length ? parsed.items[parsed.items.length - 1].line : parsed.start;
  const eol = lines[anchor] && lines[anchor].endsWith('\r') ? '\r' : '';
  lines.splice(parsed.end, 0, `- [ ] ${clean}${eol}`);
  return lines.join('\n');
}

/* ---- the daily-highlights table ------------------------------------------ */

// One line of plain text for a table cell. A pipe would end the cell and a
// newline would end the row, so both are removed rather than escaped: the
// parser splits on a bare pipe, and a cell nobody can read back is worse
// than a sentence missing one character.
function highlightCellText(raw) {
  return String(raw == null ? '' : raw).replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The row for a date, read out of the Date | Highlight | Done shape: the
// generic table reader calls cell 1 the marker, and here cell 1 is the
// sentence and cell 2 is the marker.
function highlightRowFor(parsed, date) {
  const row = logRowFor(parsed, date);
  if (!row) return null;
  return { date, text: row.marker, done: (row.rest && row.rest[0]) || '' };
}

function weekHighlights(body) {
  const parsed = parseLogTable(body, WEEK_HIGHLIGHTS_SENTINEL);
  return parsed.rows.filter((r) => r.date)
    .map((r) => ({ date: r.date, text: r.marker, done: (r.rest && r.rest[0]) || '' }));
}

// The next body after the day's sentence is set. The marker is carried over
// untouched: setting the words is not confirming the day.
function weekHighlightAfterSet(data, date, text) {
  const row = highlightRowFor(parseLogTable(data, WEEK_HIGHLIGHTS_SENTINEL), date);
  return upsertLogRow(data, WEEK_HIGHLIGHTS_SENTINEL, {
    date,
    marker: highlightCellText(text),
    rest: [row && row.done ? row.done : '_'],
    createWith: WEEK_HIGHLIGHTS_SECTION,
  });
}

// The next body after the day is marked. The sentence is carried over
// untouched, and a day with no sentence yet is still markable (an empty
// first cell, which the table reads back as an empty highlight).
function weekHighlightAfterMark(data, date, marker) {
  const m = String(marker == null ? '' : marker).trim().toUpperCase();
  const row = highlightRowFor(parseLogTable(data, WEEK_HIGHLIGHTS_SENTINEL), date);
  return upsertLogRow(data, WEEK_HIGHLIGHTS_SENTINEL, {
    date,
    marker: row ? row.text : '',
    rest: [WEEK_HIGHLIGHT_MARKERS.includes(m) ? m : '_'],
    createWith: WEEK_HIGHLIGHTS_SECTION,
  });
}

/* ---- the note ------------------------------------------------------------ */

function isPlannerWeekFrontmatter(fm) {
  return !!fm && typeof fm === 'object' && String(fm.type == null ? '' : fm.type).trim() === WEEK_TYPE;
}

// The week a note describes, or null for any other note. The `week` field
// wins; a note whose field is missing or malformed falls back to its own
// filename, which is the ISO week by construction.
function weekFromNote(fm, body, path) {
  if (!isPlannerWeekFrontmatter(fm)) return null;
  const field = String(fm.week == null ? '' : fm.week).trim();
  const base = basenameOf(path);
  const iso = WEEK_ISO_RE.test(field) ? field : (WEEK_ISO_RE.test(base) ? base : null);
  if (!iso) return null;
  const text = stripFrontmatter(body);
  const priorities = parseChecklistBlock(text, WEEK_PRIORITIES_SENTINEL);
  return {
    path: path || null,
    week: iso,
    monday: mondayOfIsoWeek(iso),
    priorities: priorities.items.map((i, k) => ({ index: k, done: i.done, text: i.text })),
    doneCount: priorities.items.filter((i) => i.done).length,
    highlights: weekHighlights(text),
  };
}

// The note a new week starts as: the frontmatter of record, the two headings,
// the two sentinels, and the highlights header. No rows: an empty week is an
// empty week, and a seeded placeholder is a row nobody wrote.
function weekTemplate(iso, nowIso) {
  return [
    '---',
    `type: ${WEEK_TYPE}`,
    `week: ${iso}`,
    `created_at: ${nowIso || new Date().toISOString()}`,
    'tags: []',
    '---',
    '',
    `# ${iso}`,
    '',
    WEEK_PRIORITIES_SECTION.heading,
    `<!-- ${WEEK_PRIORITIES_SENTINEL}: schema=${WEEK_PRIORITIES_SECTION.schema} -->`,
    '',
    WEEK_HIGHLIGHTS_SECTION.heading,
    `<!-- ${WEEK_HIGHLIGHTS_SENTINEL}: schema=${WEEK_HIGHLIGHTS_SECTION.schema} -->`,
    formatLogRow(WEEK_HIGHLIGHTS_SECTION.header),
    formatLogRow(WEEK_HIGHLIGHTS_SECTION.header.map(() => '---')),
    '',
  ].join('\n');
}

// "2 of 3 done", or the empty week in words.
function weekPriorityProgress(week) {
  const total = week && week.priorities ? week.priorities.length : 0;
  if (!total) return 'No priorities yet.';
  return `${checklistProgressText(week.doneCount, total)} done`;
}

/* ========================================================================== *
 * The plugin
 * ========================================================================== */

class IcorPlannerPlugin extends Plugin {
  async onload() {
    // The secret store, when this Obsidian has one (feature-detected; see
    // the secret vault section). Then the settings from disk through
    // adoptSettings: the calendar migration, the secret migration (each
    // secret data.json still holds moves into the store and its field is
    // blanked), the defaults. One write back when anything moved.
    // 0.12.0: the backend is the one data.json names. The env file is read
    // only while it is the selected one; the store is feature-detected once.
    this.secretStorage = secretStorageUsable(this.app && this.app.secretStorage) ? this.app.secretStorage : null;
    const loaded = (await this.loadData()) || {};
    const backend = normalizeSecretsBackend(loaded.secretsBackend);
    const envPath = normalizeEnvFilePath(loaded.envFilePath).path || DEFAULT_ENV_FILE_PATH;
    this.envStore = this.envStoreFor(envPath);
    if (backend === 'env-file') await this.envStore.load();
    this.secrets = this.vaultFor(backend);
    const adopted = adoptSettings(loaded, this.secrets);
    this.settings = adopted.settings;
    this.settings.secretsBackend = backend;
    this.settings.envFilePath = envPath;
    if (adopted.changed || loaded.secretsBackend !== backend || loaded.envFilePath !== envPath) await this.persistSettings();
    // The display formats are resolved at every paint from the live
    // settings and the Templates plugin's options, never cached.
    setDisplayFormatSource(() => resolveDisplayFormats(this.settings, this.app));
    // Without a secret store the Outlook tokens live in these settings, and
    // a refresh token Microsoft rotated inside a sync must reach disk before
    // the app closes. The sink calls this after such a write; hidden from
    // JSON and from every copy.
    Object.defineProperty(this.settings, '_persist', { value: () => { this.persistSettings(); }, enumerable: false, configurable: true });
    // _shadow: per-item last-synced baseline for the two-way fields. Lives in
    // data.json beside the settings; never shown in the settings UI.
    if (!this.settings._shadow || typeof this.settings._shadow !== 'object') this.settings._shadow = {};
    this._pushTimers = new Map();
    // path -> the file mtime this plugin's own sync run left there. Read by
    // the push check so a sync write is never mistaken for a local edit; see
    // the self-write suppression block above syncWriteIsOwn.
    this._syncWrites = new Map();
    // `source:id` asked about during the current sync pass, so one absent
    // item costs one GET however many code paths look at it. Cleared at the
    // start of every sync (syncNow).
    this._goneProbed = new Set();
    this.routines = [];              // the parsed routine notes (refreshRoutines); render reads this
    this._routineCache = new Map();  // path -> { mtime, routine }: zero body reads when nothing changed
    this.habits = [];                // the parsed habit notes (refreshHabits); render reads this
    this._habitCache = new Map();    // path -> { mtime, habit }: same rule
    this.calendarDefs = null;        // merged, deduplicated defs of every feed (mirrored to the cache note on healthy fetches)
    this.calendarDefsByFeed = {};    // feed id -> that feed's defs; a failed feed keeps its last entry
    this.calendarFeedSyncedAt = {};  // feed id -> ISO time of its last LIVE fetch (per-feed updated_at in the cache)
    this.calendarStale = false;      // true while defs come from the vault cache, not a live fetch
    this.calendarStatus = null;      // last calendar ConnectorResult status
    this.syncStatus = {};            // source -> { ok, reason, message, count, at }
    this.syncing = false;
    this.lastSyncAt = null;
    // One auto-reveal of the tray per session (trayRevealDecision).
    this._trayAutoRevealed = false;

    this.registerView(BOARD_VIEW_TYPE, (leaf) => new PlannerBoardView(leaf, this));
    this.registerView(TRAY_VIEW_TYPE, (leaf) => new PlannerTrayView(leaf, this));
    this.registerView(WEEK_VIEW_TYPE, (leaf) => new PlannerWeekView(leaf, this));

    this.addCommand({ id: 'open-board', name: 'Open weekly planner', callback: () => this.openBoard() });
    this.addCommand({ id: 'open-tray', name: 'Open planner tray', callback: () => this.openTray(true) });
    this.addCommand({ id: 'open-week', name: 'Open this week', callback: () => this.openWeek(isoWeekOf(todayStr())) });
    this.addCommand({ id: 'sync-now', name: 'Sync planner sources now', callback: () => this.syncNow(true) });
    this.addCommand({ id: 'add-manual-task', name: 'Add a task', callback: () => this.focusAddTask() });
    this.addCommand({ id: 'new-routine', name: 'New routine', callback: () => this.openNewRoutine() });
    this.addCommand({ id: 'new-habit', name: 'New habit', callback: () => this.openNewHabit() });

    this.addSettingTab(new IcorPlannerSettingTab(this.app, this));

    // The Microsoft sign-in comes back through obsidian://icor-for-life-planner/auth
    // (the redirect URI registered in the member's Entra app), on desktop
    // and mobile alike. Obsidian dispatches the whole pre-query string,
    // icor-for-life-planner/auth, as one action, so that is the one
    // registration; a bare manifest.id would never fire for this URI.
    this.registerObsidianProtocolHandler(OUTLOOK_PROTOCOL_ACTION, (params) => this.outlookAuthCallback(params));

    // Two ways into the board, and neither is the folder. Up to 0.9.1 a
    // capture-phase click listener on the planner folder's row opened the
    // board instead of unfolding the folder, so the one folder in the vault
    // that did not open like a folder was this one, and its notes could
    // only be reached by hand. That hook is gone: the planner folder
    // expands and collapses like every other folder. The board opens from a
    // button on the file-tree toolbar under the sidebar logo (mounted from
    // onLayoutReady below) and from the left ribbon here. `calendar-days`
    // rather than `layout-grid`: the board is a week, and the days glyph
    // says so, while the grid glyph would sit beside the Connect plugin's
    // `layout-dashboard` canvas button and read as a second canvas.
    // Registered once; Obsidian removes it on unload.
    this.addRibbonIcon(PLANNER_TOOLBAR_ICON, PLANNER_TOOLBAR_LABEL, () => this.openBoard());
    this.registerEvent(this.app.workspace.on('layout-change', () => this.mountPlannerToolbarButton()));

    this.app.workspace.onLayoutReady(() => {
      // A renamed room is found before anything reads or writes a path.
      this.adoptPlannerFolder();
      this.ensureGitignore();
      this.mountPlannerToolbarButton();
      // Instant calendar: rehydrate the last healthy fetch from the vault
      // cache (rendered pale + pulsing) before the live fetch replaces it.
      this.loadCalendarCache();
      // The routine and habit notes are read for their body, so they are
      // parsed once here and re-read only when one changes (the hook below).
      Promise.all([this.refreshRoutines(), this.refreshHabits()]).then(() => this.emitModelChanged());
      this.setupNextBadge();
      // First sync shortly after startup (never blocking plugin load), then on
      // the configured cadence.
      if (this.anySourceConfigured()) {
        window.setTimeout(() => this.syncNow(false), 4000);
      }
      this.scheduleSync();
    });

    // Live re-render when anything under the planner folder changes (sync
    // writes, user edits, or the AI team moving an item by editing
    // frontmatter). The boundary is read at event time (this.paths()).
    const inside = (file) => !!(file && this.paths().isInside(file.path));
    // The habit notes live under the room since 0.10.0, so the one boundary
    // covers them. A habit note is never a planner item, so the push check
    // that fires for any note in the room finds nothing to push for it.
    const watched = (file) => inside(file);
    // A change under Routines/ or Habits/ re-reads that cache BEFORE the
    // views re-render, because steps and logs live in the note body, which
    // the metadata cache does not carry.
    const settle = (path) => {
      if (this.paths().isRoutine(path)) return this.refreshRoutines();
      if (this.paths().isHabit(path)) return this.refreshHabits();
      return Promise.resolve();
    };
    const notify = (file) => { if (watched(file)) settle(file.path).then(() => this.emitModelChanged()); };
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      notify(file);
      // A routine and a week note are never planner items, so there is
      // nothing to push for either. Neither is this plugin's own sync write:
      // the event cannot say who wrote the file, so the sync says so itself.
      if (inside(file) && !this.paths().isRoutine(file.path) && !this.paths().isWeek(file.path)
        && !this.isSyncWrite(file.path)) {
        this.schedulePushCheck(file.path);
      }
    }));
    this.registerEvent(this.app.vault.on('delete', notify));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (watched(file) || this.paths().isInside(oldPath)) {
        Promise.all([settle(file.path), settle(oldPath)]).then(() => this.emitModelChanged());
      }
    }));
  }

  // Every path, derived from the setting at call time.
  paths() { return plannerPaths(this.settings); }

  // The settings with the secrets filled in, for anything that needs a
  // credential: the connectors, the fetchers, the probe, the configured
  // checks. A fresh shallow copy each call; never saved.
  withSecrets() { return withSecrets(this.settings, this.secrets); }

  // The one write of the settings to disk. Belt and braces: a secret that
  // reached the in-memory object by any path (a hand edit, a data.json
  // synced in from a machine without a store, a keystroke in the tab) is
  // moved out first, so data.json never carries one the backend holds. In
  // env-file mode the move waits for the file: a field is blanked only
  // once its line is on disk, and a value whose write failed is saved back
  // into data.json rather than lost (Vex P-1, 2026-09-08).
  async persistSettings() {
    await migrateSecretsSettled(this.settings, this.secrets);
    await this.saveData(this.settings);
    await this.secrets.settle();
  }

  /* ---- the secrets backend (0.12.0) ---- */
  envStoreFor(path) { return new EnvFileStore(this.app && this.app.vault ? this.app.vault.adapter : null, path); }
  // The vault for one backend and nothing else: no fallback.
  vaultFor(backend) {
    return normalizeSecretsBackend(backend) === 'env-file' ? new SecretVault(null, this.envStore) : new SecretVault(this.secretStorage);
  }
  // Every place a secret can be, by backend name, for the settings tab's
  // status rows and the moves. data.json is a source only (never selected).
  secretHolders() {
    return { 'secret-storage': this.secretStorage, 'env-file': this.envStore, 'data-json': dataJsonStore(this.settings) };
  }
  // Choosing a backend moves nothing: the tab offers a Move per key.
  async setSecretsBackend(backend) {
    const b = normalizeSecretsBackend(backend);
    this.settings.secretsBackend = b;
    if (b === 'env-file') await this.envStore.load();
    this.secrets = this.vaultFor(b);
    await this.saveSettings();
  }
  async setEnvFilePath(path) {
    const n = normalizeEnvFilePath(path);
    if (!n.ok) return false;
    this.settings.envFilePath = n.path;
    await this.envStore.settle();
    this.envStore = this.envStoreFor(n.path);
    if (this.secrets.mode === 'env-file') {
      await this.envStore.load();
      this.secrets = this.vaultFor('env-file');
    }
    await this.saveSettings();
    return true;
  }
  // Move the keys of the given slots from one backend into the selected
  // one. Returns how many keys moved; the values never appear anywhere.
  async moveSecretsFrom(from, slots) {
    const holders = this.secretHolders();
    const to = this.secrets.backend;
    if (to === 'data-json' || !holders[to] || !holders[from] || from === to) return 0;
    let n = 0;
    for (const slot of slots || []) {
      for (const id of slot.ids || [slot.id]) {
        if (await moveSecret(id, holders[from], holders[to])) n += 1;
      }
    }
    if (n) this.settings.secretsInStore = true;
    await this.saveSettings();
    return n;
  }

  // Boot: if the configured folder is missing but exactly one top-level
  // folder is called "... planner", use it. Several: say so once and leave
  // the setting alone. The vault is never guessed at.
  async adoptPlannerFolder() {
    try {
      const root = this.app.vault.getRoot();
      const names = (root && root.children ? root.children : []).filter((c) => c instanceof TFolder).map((c) => c.name);
      const d = detectPlannerFolder(names, this.paths().root);
      if (d.action === 'adopt') {
        this.settings.plannerFolder = d.folder;
        await this.persistSettings();
        new Notice(`Planner: using the folder "${d.folder}".`);
      } else if (d.action === 'ask') {
        new Notice(`Planner: several folders look like the planner (${d.candidates.join(', ')}). Pick one under Settings, ICOR for Life - Planner, Planner folder.`, 12000);
      }
    } catch { /* detection is a convenience; ensureFolders covers the rest */ }
  }

  // Nothing this plugin scheduled may run after it is gone: a pending push
  // check would write to a SOURCE from an unloaded plugin, and a pending
  // shadow save would write settings the next load has already replaced.
  onunload() {
    setDisplayFormatSource(null);
    this.removeNextBadge();
    this.removePlannerToolbarButton();
    if (this._cacheWriteTimer) { window.clearTimeout(this._cacheWriteTimer); this._cacheWriteTimer = null; }
    if (this._pushTimers) {
      for (const t of this._pushTimers.values()) window.clearTimeout(t);
      this._pushTimers.clear();
    }
    // The 1.5 s debounce must not cost a quit its shadow state: the timer
    // goes and the save it was waiting to make happens now. Best effort by
    // definition (unload is synchronous, the write is not), which is still
    // strictly more than dropping it.
    if (this._shadowSaveTimer) {
      window.clearTimeout(this._shadowSaveTimer);
      this._shadowSaveTimer = null;
      try { this.persistSettings(); } catch { /* the vault is going away either way */ }
    }
  }

  // Any source with a connector, calendar included. Manual is excluded on
  // purpose: it needs no fetch, so it must never make the scheduler start one.
  anySourceConfigured() {
    const resolved = this.withSecrets();
    return FETCHED_SOURCES.some((k) => sourceConfigured(resolved, k));
  }

  async saveSettings() {
    await this.persistSettings();
    this.scheduleSync();
    this.emitModelChanged();
  }

  scheduleSync() {
    if (this._syncTimer) { window.clearInterval(this._syncTimer); this._syncTimer = null; }
    const minutes = Math.max(2, Number(this.settings.syncMinutes) || 10);
    this._syncTimer = window.setInterval(() => {
      if (this.anySourceConfigured()) this.syncNow(false);
    }, minutes * 60000);
    this.registerInterval(this._syncTimer);
  }

  // Debounced fan-out to both views.
  emitModelChanged() {
    if (this._emitTimer) window.clearTimeout(this._emitTimer);
    this._emitTimer = window.setTimeout(() => {
      this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE).forEach((l) => {
        if (l.view instanceof PlannerBoardView) l.view.render();
      });
      this.app.workspace.getLeavesOfType(TRAY_VIEW_TYPE).forEach((l) => {
        if (l.view instanceof PlannerTrayView) l.view.render();
      });
      // The week tab re-READS rather than re-renders: its model is the note's
      // body, which nothing else in this process is holding.
      this.app.workspace.getLeavesOfType(WEEK_VIEW_TYPE).forEach((l) => {
        if (l.view instanceof PlannerWeekView) void l.view.refresh();
      });
      this.updateNextBadge();
    }, 250);
  }

  /* ---- gitignore guard: token store never reaches the scaffold repo ------ */
  async ensureGitignore() {
    try {
      const adapter = this.app.vault.adapter;
      const gi = '.gitignore';
      let text = '';
      try { text = await adapter.read(gi); } catch { text = ''; }
      const line = gitignoreLineFor(this.manifest);
      const wanted = line ? [line] : [];
      const missing = wanted.filter((line) => !text.split('\n').some((l) => l.trim() === line));
      if (missing.length) {
        const block = `\n# ICOR for Life - Planner is its own git repository (and its data.json holds API keys)\n${missing.join('\n')}\n`;
        await adapter.write(gi, (text.endsWith('\n') || !text ? text : text + '\n') + block);
      }
    } catch { /* never block load on this */ }
  }

  /* ---- calendar event cache (v0.5.0) ------------------------------------- */

  // Rehydrate the last healthy fetch from the cache note. Only fills the
  // gap before the first live fetch; a malformed cache is silently ignored
  // (the next healthy fetch rebuilds it).
  async loadCalendarCache() {
    if (this.calendarDefs) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(this.paths().cache));
      if (!(file instanceof TFile)) return;
      const text = await this.app.vault.cachedRead(file);
      const parsed = parseCalendarCache(text);
      if (!parsed) return;
      // The cache meets today's settings: names and colours from the feeds,
      // a feed that is gone or off drops out, a v1 array joins the first feed.
      const feeds = enabledCalendarFeeds(this.withSecrets());
      const defs = adoptCacheDefs(parsed.defs, feeds);
      if (defs.length && !this.calendarDefs) {
        for (const g of groupDefsByFeed(defs)) if (g.id) this.calendarDefsByFeed[g.id] = g.defs;
        for (const f of parsed.feeds) if (f.id && f.updatedAt && this.calendarDefsByFeed[f.id]) this.calendarFeedSyncedAt[f.id] = f.updatedAt;
        this.calendarDefs = calendarDefsFromByFeed(this.calendarDefsByFeed, feeds.map((f) => f.id)).defs;
        this.calendarStale = true; // pale + pulsing until a healthy fetch lands
        this.emitModelChanged();
      }
    } catch { /* unreadable cache: the fetch path covers it */ }
  }

  // The board's defs from the per-feed map and the CURRENT settings: what
  // the settings tab calls when a feed is switched off or removed, so the
  // board follows at once instead of at the next sync. A feed no longer
  // enabled drops out; the rest keep their order and their dedupe.
  recomputeCalendarDefs() {
    const ids = enabledCalendarFeeds(this.withSecrets()).map((f) => f.id);
    for (const id of Object.keys(this.calendarDefsByFeed)) {
      if (!ids.includes(id)) delete this.calendarDefsByFeed[id];
    }
    if (!ids.length) { this.calendarDefs = null; }
    else if (this.calendarDefs) this.calendarDefs = calendarDefsFromByFeed(this.calendarDefsByFeed, ids).defs;
    this.emitModelChanged();
  }

  // Debounced so a manual sync right after the scheduled one writes once.
  scheduleCalendarCacheWrite() {
    if (this._cacheWriteTimer) window.clearTimeout(this._cacheWriteTimer);
    this._cacheWriteTimer = window.setTimeout(() => {
      this._cacheWriteTimer = null;
      this.writeCalendarCache();
    }, 2000);
  }

  async writeCalendarCache() {
    try {
      if (!this.calendarDefs || this.calendarStale) return; // only persist live fetches
      await this.ensureFolders();
      const content = buildCalendarCacheContent(this.calendarDefs, new Date(), this.paths().root, this.calendarFeedSyncedAt);
      const path = normalizePath(this.paths().cache);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.process(existing, () => content);
      else await this.app.vault.create(path, content);
    } catch { /* the cache is a convenience - never fail a sync on it */ }
  }

  /* ---- next-event strip (0.5.0 ribbon badge, 0.9.1 strip) --------------- */

  // Expanded events for the strip: this ISO week plus the next, so a
  // running event that began before midnight is still seen.
  badgeEvents() {
    if (!this.calendarDefs) return [];
    const w0 = mondayOf(todayStr());
    const split = this.splitHour();
    return icsEventsForWeek(this.calendarDefs, w0, split)
      .concat(icsEventsForWeek(this.calendarDefs, addDays(w0, 7), split));
  }

  // The toolbar button under the sidebar logo. Mounted where
  // plannerToolbarMountPoint says, from onLayoutReady, on layout-change and
  // from the strip's left-split observer. Idempotent: a button this
  // instance already put there is left alone; one left by an earlier
  // instance (an in-place upgrade) is replaced, because it keeps its old
  // click handler forever.
  mountPlannerToolbarButton() {
    const at = plannerToolbarMountPoint(document);
    if (!at) return;
    if (at.existing) {
      if (at.existing === this._toolbarEl) return;
      at.existing.remove();
    }
    const btn = document.createElement('div');
    btn.className = `clickable-icon nav-action-button ${PLANNER_TOOLBAR_CLASS}`;
    btn.setAttribute('aria-label', PLANNER_TOOLBAR_LABEL);
    btn.setAttribute('role', 'button');
    btn.tabIndex = 0;
    setIcon(btn, PLANNER_TOOLBAR_ICON);
    btn.addEventListener('click', () => this.openBoard());
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      this.openBoard();
    });
    this._toolbarEl = btn;
    at.parent.appendChild(btn);
  }

  removePlannerToolbarButton() {
    if (this._toolbarEl) { this._toolbarEl.remove(); this._toolbarEl = null; }
  }

  // Build the strip once and mount it where nextStripMountPoint says. The
  // 0.5.0 badge hung off the ribbon's action stack, which the theme hides
  // and which was too narrow to read; the strip spans the sidebar column
  // above the logo instead. It re-mounts on layout-change and, through an
  // observer scoped to the left split, when the file explorer appears
  // after us (a plugin loading before the workspace, a leaf reopened).
  setupNextBadge() {
    if (!this.settings.showNextBadge) { this.removeNextBadge(); return; }
    if (!this._badgeEl) {
      const el = document.createElement('div');
      el.className = 'iplan-next-strip';
      el.hidden = true;
      markInkPlugin(el, this.manifest.id);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'iplan-next-strip-button';
      const count = document.createElement('span');
      count.className = 'iplan-next-strip-count';
      count.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span');
      title.className = 'iplan-next-strip-title';
      title.setAttribute('aria-hidden', 'true');
      const join = document.createElement('span');
      join.className = 'iplan-next-strip-join';
      join.setAttribute('aria-hidden', 'true');
      join.textContent = 'Join';
      join.hidden = true;
      btn.appendChild(count);
      btn.appendChild(title);
      btn.appendChild(join);
      // The reader hears the strip once per entry, never per tick: the
      // button's aria-label carries the full sentence and is silent when it
      // changes; this region speaks only when updateNextBadge sees a new key.
      const live = document.createElement('span');
      live.className = 'iplan-next-strip-live iplan-sr-only';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      el.appendChild(btn);
      el.appendChild(live);
      btn.addEventListener('click', () => {
        if (this._badgeConfUrl) window.open(this._badgeConfUrl, '_external');
        else this.openBoard();
      });
      this._badgeEl = el;
      this._badgeParts = { btn, count, title, join, live };
      this._badgeKey = null;
      if (!this._badgeLayoutHooked) {
        this._badgeLayoutHooked = true;
        this.registerEvent(this.app.workspace.on('layout-change', () => this.mountNextStrip()));
      }
      this.observeNextStripHost();
    }
    this.mountNextStrip();
    this.updateNextBadge();
  }

  // Put the strip at the preferred place, or move it there from the
  // fallback once the file explorer shows up. A no-op when it already sits
  // where it belongs, so the observer's own mutations never loop.
  mountNextStrip() {
    const el = this._badgeEl;
    if (!el) return;
    const at = nextStripMountPoint(document);
    if (!at) return;
    // When the strip is already the first child, the point names the strip
    // itself as "before"; read past it, or the move would send it to the end.
    const before = at.before === el ? el.nextElementSibling : at.before;
    const sitsRight = el.isConnected && el.parentElement === at.parent && el.dataset.place === at.place
      && el.nextElementSibling === before;
    if (sitsRight) return;
    el.dataset.place = at.place;
    at.parent.insertBefore(el, before);
  }

  observeNextStripHost() {
    if (this._badgeObserver || typeof MutationObserver !== 'function') return;
    const host = document.querySelector('.workspace-split.mod-left-split')
      || document.querySelector('.workspace-drawer.mod-left');
    if (!host) return;
    this._badgeObserver = new MutationObserver(() => {
      if (this._badgeMountQueued) return;
      this._badgeMountQueued = true;
      window.requestAnimationFrame(() => {
        this._badgeMountQueued = false;
        this.mountNextStrip();
        this.mountPlannerToolbarButton();
      });
    });
    this._badgeObserver.observe(host, { childList: true, subtree: true });
  }

  removeNextBadge() {
    if (this._badgeTimer != null) { window.clearTimeout(this._badgeTimer); this._badgeTimer = null; }
    if (this._badgeObserver) { this._badgeObserver.disconnect(); this._badgeObserver = null; }
    if (this._badgeEl) { this._badgeEl.remove(); this._badgeEl = null; this._badgeParts = null; }
    this._badgeKey = null;
    this._badgeConfUrl = null;
  }

  // Single re-arming timer: 30s cadence normally, 1s once the label reads
  // M:SS. Cleared on unload via removeNextBadge.
  _armBadgeTick(ms) {
    if (this._badgeTimer != null) window.clearTimeout(this._badgeTimer);
    this._badgeTimer = window.setTimeout(() => {
      this._badgeTimer = null;
      this.updateNextBadge();
    }, ms);
  }

  updateNextBadge() {
    if (!this.settings.showNextBadge) { this.removeNextBadge(); return; }
    if (!this._badgeEl) { this.setupNextBadge(); return; }
    if (!this._badgeEl.isConnected) this.mountNextStrip();
    const now = new Date();
    const model = nextBadgeModel(this.badgeEvents(), routineTimedEntries(this.routinesFor(localDayStr(now))), now);
    const el = this._badgeEl;
    const parts = this._badgeParts;
    if (!model) {
      el.hidden = true;
      this._badgeConfUrl = null;
      if (this._badgeKey !== null) { this._badgeKey = null; parts.live.textContent = ''; }
      this._armBadgeTick(30000);
      return;
    }
    this._badgeConfUrl = model.joinUrl;
    el.hidden = false;
    parts.count.textContent = model.label;
    parts.title.textContent = model.title;
    parts.join.hidden = !model.joinUrl;
    el.classList.toggle('is-urgent', model.urgent);
    el.classList.toggle('is-now', model.running);
    const sentence = `Next: ${model.title}, ${model.spoken}`;
    parts.btn.setAttribute('aria-label', `${sentence}, ${model.joinUrl ? 'join meeting' : 'open the board'}`);
    parts.btn.title = `${model.title} \u00b7 ${model.label}${model.joinUrl ? '\nClick to join the meeting' : ''}`;
    if (model.key !== this._badgeKey) { this._badgeKey = model.key; parts.live.textContent = sentence; }
    this._armBadgeTick(model.imminent ? 1000 : 30000);
  }

  /* ---- views ------------------------------------------------------------- */
  async openBoard() {
    const existing = this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE);
    const leaf = existing.length ? existing[0] : this.app.workspace.getLeaf(true);
    if (!existing.length) await leaf.setViewState({ type: BOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    await this.autoRevealTray();
    // Focus belongs on the board the user just asked for, never on the tray we
    // opened beside it.
    try { this.app.workspace.setActiveLeaf(leaf, { focus: true }); } catch { /* older API */ }
  }

  // Reveal the tray alongside the board, once per session, without fighting a
  // user who closed it. See trayRevealDecision for why the memory is
  // session-scoped rather than persisted.
  async autoRevealTray() {
    let collapsed = false;
    try { collapsed = !!(this.app.workspace.rightSplit && this.app.workspace.rightSplit.collapsed); } catch { collapsed = false; }
    const decision = trayRevealDecision({
      autoRevealedThisSession: !!this._trayAutoRevealed,
      trayLeafExists: this.app.workspace.getLeavesOfType(TRAY_VIEW_TYPE).length > 0,
      rightSplitCollapsed: collapsed,
    });
    if (decision === 'none' || decision === 'already-visible') {
      // The tray still has to EXIST even when we are not revealing it, which is
      // what openTray(false) has always done.
      if (decision === 'already-visible') return;
      await this.openTray(false);
      return;
    }
    if (trayRevealSpendsTurn(decision)) this._trayAutoRevealed = true;
    await this.openTray(true);
  }

  async openTray(reveal) {
    let leaves = this.app.workspace.getLeavesOfType(TRAY_VIEW_TYPE);
    if (!leaves.length) {
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: TRAY_VIEW_TYPE, active: false });
      leaves = [leaf];
    }
    if (reveal) this.app.workspace.revealLeaf(leaves[0]);
    return leaves[0];
  }

  // Reveal the tray on its TASKS tab with the add-a-task field open and
  // focused. One capture surface, reachable from the command palette on
  // desktop and mobile alike, rather than a second modal to design and keep.
  async focusAddTask() {
    const leaf = await this.openTray(true);
    const view = leaf && leaf.view;
    if (view instanceof PlannerTrayView) view.openComposer();
  }

  /* ---- sync engine -------------------------------------------------------- */
  async ensureFolders() {
    const mk = async (path) => {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!existing) { try { await this.app.vault.createFolder(path); } catch { /* another call got there first, or the vault refuses it: every write checks its own room */ } }
    };
    const p = this.paths();
    await mk(p.root);
    // Manual included: the folder must exist on a vault with no keys at all.
    for (const key of TASK_SOURCES) {
      await mk(p.sourceFolder(key));
    }
    // Routines too: a vault with none renders no routine cards, and the
    // folder is where the New routine command puts the first one.
    await mk(p.routines);
    // And Habits (0.10.0): where New habit and the import put the notes.
    await mk(p.habits);
    // And Weeks (0.14.0): one note per ISO week. The note itself is created
    // on demand, the room is created here so it is visible from day one.
    await mk(p.weeks);
  }

  async syncNow(manual) {
    if (this.syncing) { if (manual) new Notice('Planner sync already running.'); return; }
    this.syncing = true;
    this.emitModelChanged();
    try {
      // One confirming GET per absent task per sync, not per code path.
      this._goneProbed = new Set();
      await this.ensureFolders();
      if (this.secrets.mode === 'env-file') await this.envStore.load();
      const s = this.withSecrets();
      // Every task connector starts at once, in registry order; results are
      // awaited and applied in that same order.
      const runs = SYNCED_SOURCES.map((k) => [k, CONNECTORS[k].fetchOpen(s)]);
      for (const [source, promise] of runs) {
        const result = await promise;
        this.syncStatus[source] = {
          ok: result.ok, reason: result.reason || null, message: result.message || null,
          hint: result.hint || null, docUrl: result.docUrl || null,
          warning: result.warning || null, complete: result.complete !== false,
          count: result.items.length, at: new Date().toISOString(),
        };
        if (result.ok) await this.upsertSource(source, result);
      }
      // A sync the user pressed for, with a source misconfigured: say what
      // went wrong and what to do about it, once, here, not only in the tray.
      if (manual) {
        for (const key of SYNCED_SOURCES) {
          const st = this.syncStatus[key];
          if (st && st.reason === 'misconfigured') new Notice(`${SOURCES[key].label}: ${st.message}${st.hint ? `\n${st.hint}` : ''}`, 12000);
        }
      }
      // Calendar: no per-event notes. Every enabled feed is fetched on its
      // own; a healthy feed replaces its own entry, a failed feed keeps its
      // previous one (never prune on a blip), and the board renders the
      // merged, deduplicated union. At least one live feed clears the stale
      // look and rewrites the ONE cache file. No feeds at all: nothing to
      // show, and nothing stale to keep.
      const cal = await calendarFetchDefs(s, this.calendarDefsByFeed, this.connectorDeps());
      this.calendarStatus = {
        ok: cal.ok, reason: cal.reason || null, message: cal.message || null,
        warning: cal.warning || null, perFeed: cal.perFeed || {}, at: new Date().toISOString(),
      };
      if (cal.reason === 'no-token') {
        this.calendarDefs = null;
        this.calendarDefsByFeed = {};
      } else {
        this.calendarDefsByFeed = cal.byFeed || {};
        this.calendarDefs = cal.items;
        for (const id of Object.keys(cal.perFeed || {})) {
          if (cal.perFeed[id].ok) this.calendarFeedSyncedAt[id] = cal.perFeed[id].at;
        }
        if (cal.ok) {
          this.calendarStale = false;
          this.scheduleCalendarCacheWrite();
        }
      }
      this.lastSyncAt = new Date().toISOString();
      await this.persistSettings(); // persist the refreshed shadows
      if (manual) {
        const okCount = SYNCED_SOURCES.filter((k) => this.syncStatus[k] && this.syncStatus[k].ok).length;
        new Notice(`Planner sync done (${okCount} task source${okCount === 1 ? '' : 's'} healthy).`);
      }
    } finally {
      this.syncing = false;
      this.emitModelChanged();
    }
  }

  // Upsert one source's OPEN set into the vault + reconcile completions.
  // The fetch succeeded, so absence from `items` is a true completion signal
  // (the cockpit's reconcileOpenIds contract), never a window artifact.
  // v0.2.0: per item, the two-way fields go through threeWayMerge against the
  // stored shadow - local edits push, source edits pull, source wins conflicts.
  // Failed pushes keep the old baseline so the next sync retries them.
  async upsertSource(source, result) {
    const items = (result && result.items) || [];
    // What question this answer answered (ClickUp's filter today, nothing
    // anywhere else). Null means the query cannot narrow.
    const scope = (result && result.scope) || null;
    // The mailbox generation these ids belong to (IMAP only). Same contract
    // as `scope`: it rides on the result and is stored beside each shadow.
    const uidValidity = (result && result.uidValidity) || null;
    const folder = this.paths().sourceFolder(source);
    const s = this.withSecrets(); // shallow: s._shadow is the live map
    const allItems = collectItems(this.app, this.paths().root);
    // A cold metadata cache (first open on a new device) hides notes that
    // exist, so this pass creates nothing; the next sync does.
    const cacheCold = unindexedNoteCount(this.app, this.paths().root) > 0;
    const existing = new Map(); // external id -> item
    for (const it of allItems) {
      if (it.source === source) existing.set(it.id, it);
    }
    const index = buildItemIndex(allItems);
    // A renumbered mailbox first: the notes follow their mail onto the new
    // ids BEFORE anything reads the open set, so the rest of this pass sees
    // an ordinary sync and neither creates a duplicate nor reconciles the
    // old id as absent.
    const remapped = remapByMessageId(source, items, existing, s._shadow);
    for (const r of remapped) {
      if (!r.prior || !r.prior.file) continue;
      const oldKey = `${source}:${r.from}`;
      const newKey = `${source}:${r.to}`;
      // `external_id` is the identity the plugin reads; the id in the
      // filename is display, and renaming a note would churn Sync, links and
      // the cache for no gain (Flint, 2026-09-17, Q3).
      await this.app.fileManager.processFrontMatter(r.prior.file, (fm) => { fm.external_id = String(r.to); });
      this.markSyncWrite(r.prior.file);
      s._shadow[newKey] = Object.assign({}, s._shadow[oldKey] || {});
      delete s._shadow[oldKey];
      // `allItems` holds these same objects, so reconcile below sees the new
      // id too and never reads the note as an absent one.
      r.prior.id = r.to;
      existing.delete(r.from);
      existing.set(r.to, r.prior);
    }
    const advancedParents = [];
    const openIds = new Set();
    // Notes this pass moved to the trash because the source no longer has
    // the task. One notice at the end, never one per task.
    let trashed = 0;
    for (const t of items) {
      openIds.add(t.id);
      const prior = existing.get(t.id);
      if (!prior) {
        if (cacheCold) continue;
        await this.createItemFile(folder, source, t);
        const fresh = s._shadow[`${source}:${t.id}`];
        if (fresh) {
          if (uidValidity) fresh.uidvalidity = uidValidity;
          if (t.messageId) fresh.messageId = t.messageId;
        }
        continue;
      }
      const key = `${source}:${t.id}`;
      const shadow = s._shadow[key] || null;
      const body = await this.readBody(prior.file);
      const sourceVals = { title: t.title, due: t.due || null, priority: t.priority, description: (t.description || '').trim() };
      const localVals = { title: prior.title, due: prior.due, priority: prior.priority, description: body };
      const pushEnabled = !!s.pushEdits && canPushToSource(source);
      const { pushes, finals, nextShadow } = threeWayMerge(sourceVals, localVals, shadow, pushEnabled);
      // A write that answers "no such task" is the source telling us the
      // mirror is stale. Trash the note and move on: there is nothing to
      // retry and nothing to merge.
      let gone = false;
      if (Object.keys(pushes).length) {
        try {
          await CONNECTORS[source].pushFields(s, t, pushes);
          new Notice(`Planner: pushed ${Object.keys(pushes).join(', ')} to ${SOURCES[source].label}.`);
        } catch (e) {
          if (isGoneError(e)) gone = true;
          else {
            new Notice(`Planner: ${SOURCES[source].label} push failed (${e.message}). Will retry.`);
            for (const f of Object.keys(pushes)) {
              finals[f] = localVals[f];
              nextShadow[f] = shadow ? shadow[f] : sourceVals[f];
            }
          }
        }
      }
      if (gone) { await this.removeGoneItem(source, prior); trashed += 1; continue; }
      // Completion state, decided in one pure place (syncCompletionPlan): an
      // occurrence advance resets the check and never pushes; otherwise a
      // pending close is retried at sync time too. A reopen is never decided
      // here - the item is in the source's open set, so the source already
      // says open, and the source is the winner.
      const plan = syncCompletionPlan({
        prior, sourceItem: t, shadow,
        completeOnSource: !!s.completeOnSource,
        recurringAdvance: s.recurringAdvance,
      });
      nextShadow.done = plan.nextShadowDone;
      if (plan.pushClose) {
        try {
          await this.applyDoneOnSource(prior, true);
          nextShadow.done = true;
        } catch (e) {
          if (isGoneError(e)) { await this.removeGoneItem(source, prior); trashed += 1; continue; }
          new Notice(`Planner: ${SOURCES[source].label} close failed (${e.message}). Will retry.`);
        }
      }
      if (nextShadow.done && shadow && shadow.doneAt) nextShadow.doneAt = shadow.doneAt;
      if (scope) nextShadow.scope = scope;
      // Stamped on every pass the source returns the item, so the baseline
      // the probe compares against is never older than the last sync.
      if (uidValidity) nextShadow.uidvalidity = uidValidity;
      if (t.messageId) nextShadow.messageId = t.messageId;
      s._shadow[key] = nextShadow;
      await this.updateItemFile(prior, t, finals, body, plan);
      if (plan.resetChildrenDoneLocal) advancedParents.push(key);
    }
    // A recurring parent moved on: the new occurrence starts with its
    // subtasks unchecked here. Only children the source still lists are
    // touched (they are open there, so the shadow says so too); a child the
    // source closed stays done through reconcile.
    for (const key of advancedParents) {
      for (const child of index.childrenOf.get(key) || []) {
        if (!openIds.has(child.id) || !child.doneLocal || !child.file) continue;
        await this.app.fileManager.processFrontMatter(child.file, (fm) => { fm.done_local = false; });
        this.markSyncWrite(child.file);
        const ck = `${source}:${child.id}`;
        if (s._shadow[ck]) s._shadow[ck].done = false;
      }
    }
    // Reconcile: open file whose id vanished from the healthy open set -> done.
    // The decision runs over EVERY item in the vault, not a pre-filtered set,
    // so the "a source only reconciles its own items" rule is enforced by
    // reconcileStaleIds itself and is testable there. Manual items are never
    // returned, whatever their external_id looks like.
    //
    // The shadow is KEPT, marked done: it is what lets an uncheck after this
    // sync still reach the source. Pruning happens by pruneShadows below.
    const nowMs = Date.now();
    // Three things have to hold before absence counts as evidence.
    //
    // The walk must have read the WHOLE open set: one that stopped at its page
    // cap read a window, and every task behind the cap is open, not finished.
    // The fetch must have returned something: a healthy fetch of zero items is
    // indistinguishable from a filter that matched nothing, and reconciling it
    // retires the entire source in a single pass. And per item, the query that
    // last saw it must be the query that just ran.
    //
    // The upserts above ran either way, so the board stays live while a source
    // is over its ceiling; only the writes that say "done" stand down.
    const complete = !(result && result.complete === false);
    const stale = complete && items.length > 0
      ? reconcileStaleIds(source, allItems, openIds, (it) => scopeAgrees(s._shadow[`${source}:${it.id}`], scope))
      : [];
    // Absence alone cannot tell "completed there" from "deleted there", and
    // Tom's rule needs them told apart: the notes are a mirror, so a deleted
    // task takes its note with it. One bounded GET per absent id answers it;
    // anything short of a clear "no such task" keeps the old completion path.
    const openThere = new Set();
    const goneIds = await this.probeGoneIds(source, stale, undefined, openThere);
    for (const it of stale) {
      if (goneIds.has(it.id)) {
        await this.removeGoneItem(source, it);
        trashed += 1;
        continue;
      }
      // Still open at the source, only outside what the fetch asked for.
      if (openThere.has(it.id)) continue;
      const key = `${source}:${it.id}`;
      s._shadow[key] = Object.assign({}, s._shadow[key] || {
        due: it.due, priority: it.priority, description: '',
      }, { done: true, doneAt: nowMs });
      await this.app.fileManager.processFrontMatter(it.file, (fm) => {
        fm.status = 'done';
        // The source closed it, so the card is CHECKED here, not merely
        // struck by its status. Leaving `done_local` false left the note in
        // a state no person can produce - status done, check off - and the
        // push check read exactly that as an uncheck and sent a reopen back
        // to the source (PM-12518). The two flags now agree by construction,
        // so there is no difference left to misread. `updateItemFile` clears
        // both again the moment the source shows the task open.
        fm.done_local = true;
        fm.done_at = new Date().toISOString();
        fm.synced_at = new Date().toISOString();
      });
      this.markSyncWrite(it.file);
    }
    // The done notes from before 0.15.0, asked about once per source with
    // whatever budget the absent open tasks left. Only a clear "no such
    // task" acts; closed or unknown leaves a done note exactly as it is.
    const sweep = doneSweepBatch(source, allItems, openIds, (this.settings.goneSweep || {})[source],
      GONE_PROBE_MAX_PER_SYNC - Math.min(stale.length, GONE_PROBE_MAX_PER_SYNC));
    const sweptGone = await this.probeGoneIds(source, sweep.batch);
    for (const it of sweep.batch) {
      if (!sweptGone.has(it.id)) continue;
      await this.removeGoneItem(source, it);
      trashed += 1;
    }
    if (sweep.next !== undefined && sweep.next !== (this.settings.goneSweep || {})[source]) {
      this.settings.goneSweep = Object.assign({}, this.settings.goneSweep, { [source]: sweep.next });
    }
    // A reopen that has not reached the source yet (the push path failed, or
    // the sync ran first): send it now. The flag is cleared only when the
    // task is back in the open set (updateItemFile), never on the promise.
    if (s.completeOnSource) {
      for (const it of allItems) {
        if (it.source !== source || openIds.has(it.id) || it.reopenPending !== true) continue;
        // The note is already in the trash: there is nothing left to retry,
        // and this is exactly the loop whose 404 toast came back every five
        // minutes on a deleted task.
        if (goneIds.has(it.id)) continue;
        // A pending reopen is skipped by reconcileStaleIds by design, so it
        // was never in the probe batch above. Ask about this one now: the
        // per-sync cache means it still costs at most one GET, and this is
        // the loop whose 404 came back every five minutes.
        const late = await this.probeGoneIds(source, [it]);
        if (late.has(it.id)) { await this.removeGoneItem(source, it); trashed += 1; continue; }
        const key = `${source}:${it.id}`;
        if (s._shadow[key] && s._shadow[key].done === false) continue; // already sent
        try {
          await this.applyDoneOnSource(it, false);
          s._shadow[key] = Object.assign({}, s._shadow[key] || { due: it.due, priority: it.priority, description: '' }, { done: false });
        } catch (e) {
          // A retry aimed at a task that is not there any more is not a
          // failure to report, it is the mirror catching up.
          if (isGoneError(e)) { await this.removeGoneItem(source, it); trashed += 1; continue; }
          new Notice(`Planner: ${SOURCES[source].label} reopen failed (${e.message}). Will retry.`);
        }
      }
    }
    const rnote = remapNotice(SOURCES[source].label, remapped.length);
    if (rnote) new Notice(rnote, 8000);
    const gnote = goneNotice(SOURCES[source].label, trashed);
    if (gnote) new Notice(gnote, 8000);
    for (const key of pruneShadows(s._shadow, source, new Set(existing.keys()), openIds, nowMs)) {
      delete s._shadow[key];
    }
  }

  async readBody(file) {
    try {
      const content = await this.app.vault.cachedRead(file);
      return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    } catch { return ''; }
  }

  // The source says this task is not there any more. Mirror that: the note
  // goes to the SYSTEM trash, the shadow goes, any pending push for it is
  // dropped, and nothing is ever sent to the source about it again.
  //
  // `vault.trash(file, true)` rather than `fileManager.trashFile`, which
  // obeys the member's "Deleted files" setting: one of its three values is
  // "permanently delete", and a member on that setting would lose the note
  // to a REMOTE signal while the settings text, the README and the CHANGELOG
  // all promise a trash they can recover from (Flint, 2026-09-17, finding 2;
  // Larry's ruling). A deletion the member asked for still obeys their
  // setting; this one was not asked for here. The same method serves both discoveries: a probe during reconcile,
  // and a write that came back 404.
  async removeGoneItem(source, item) {
    const key = `${source}:${item.id}`;
    delete this.settings._shadow[key];
    if (this._pushTimers.has(item.path)) {
      window.clearTimeout(this._pushTimers.get(item.path));
      this._pushTimers.delete(item.path);
    }
    this.clearSyncWrite(item.path);
    if (item.file) await this.app.vault.trash(item.file, true);
  }

  // One confirming GET per absent id, bounded and asked once per sync.
  // Returns the set of ids the source says are gone; ids the source says are
  // still open go into `stillOpen` when the caller passes one.
  async probeGoneIds(source, items, deps, stillOpen) {
    const gone = new Set();
    if (!canProbeGone(source)) return gone;
    // syncNow resets this at the top of every pass; an upsert driven from
    // anywhere else still gets a set rather than a crash.
    if (!this._goneProbed) this._goneProbed = new Set();
    const s = this.withSecrets();
    for (const it of goneProbeBatch(items, GONE_PROBE_MAX_PER_SYNC)) {
      if (this._goneProbed.has(`${source}:${it.id}`)) continue;
      this._goneProbed.add(`${source}:${it.id}`);
      let probe = null;
      // The shadow rides along: it carries what the connector needs to tell
      // "this id is gone" from "this id cannot be asked about any more"
      // (IMAP's UIDVALIDITY today). A connector that needs none ignores it.
      const probeDeps = Object.assign({}, deps || {}, { shadow: s._shadow ? (s._shadow[`${source}:${it.id}`] || null) : null });
      try { probe = await CONNECTORS[source].probeGone(s, it, probeDeps); } catch { probe = null; }
      const verdict = absenceVerdict(probe);
      if (verdict === 'gone') gone.add(it.id);
      else if (verdict === 'open' && stillOpen) stillOpen.add(it.id);
    }
    return gone;
  }

  // The one place a completion crosses to the source. Throws on failure.
  async applyDoneOnSource(item, closed) {
    const c = CONNECTORS[item.source];
    if (!c || !c.setClosed) return; // manual: nowhere to write
    await c.setClosed(this.withSecrets(), item, closed);
    new Notice(c.doneNotice(closed));
  }

  /* ---- Outlook sign-in (2026-09-06) ---------------------------------------
   * Authorization code with PKCE, the redirect through the obsidian://
   * protocol handler, the device code as the fallback when that path is
   * closed. The verifier and the state nonce live in memory for the one
   * round-trip; the tokens go through the secret vault and nowhere else.
   */

  // What a connector may take beyond the resolved settings: here, the weeks
  // the board shows, so the Outlook calendar window covers them.
  connectorDeps() {
    const weeks = [];
    this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE).forEach((l) => {
      if (l.view instanceof PlannerBoardView && l.view.weekStart) weeks.push(l.view.weekStart);
    });
    return { visibleWeekStarts: weeks };
  }

  async outlookSignIn(opts) {
    const o = opts || {};
    const clientId = trimmed(this.settings.outlookClientId);
    if (!clientId) { new Notice('Planner: paste your Application (client) ID under Outlook first.'); return; }
    // Mail.ReadWrite is asked for only once Complete on source is on: the
    // one feature that writes a flag is the one that earns the permission.
    const write = o.write === true || this.settings.completeOnSource === true;
    const tenant = outlookTenant(this.settings);
    const scopes = outlookScopeString(write);
    const { verifier, challenge } = await pkcePair();
    const state = randomState();
    const url = authorizeUrl({ clientId, tenant, scopes, redirectUri: OUTLOOK_REDIRECT_URI, state, challenge });
    this._outlookPending = { state, verifier, clientId, tenant, scopes, onDone: typeof o.onDone === 'function' ? o.onDone : null };
    if (this._outlookModal) this._outlookModal.close();
    this._outlookModal = new OutlookSignInModal(this.app, this, { url });
    this._outlookModal.open();
    window.open(url, '_external');
  }

  // The protocol handler's target. `params` is what Obsidian parsed off the
  // obsidian:// URL: code and state on success, error and error_description
  // when Microsoft declined.
  async outlookAuthCallback(params) {
    const pending = this._outlookPending;
    const modal = this._outlookModal;
    const parsed = parseAuthCallback(params, pending ? pending.state : null);
    if (!parsed.ok) {
      const text = `Outlook sign-in failed: ${parsed.message}`;
      if (modal) modal.setStatus(text, true); else new Notice(text, 10000);
      return;
    }
    this._outlookPending = null;
    if (modal) modal.setStatus('Signed in. Finishing up...', false);
    try {
      const tokens = await tokenExchange({
        clientId: pending.clientId, tenant: pending.tenant, code: parsed.code,
        redirectUri: OUTLOOK_REDIRECT_URI, verifier: pending.verifier, scopes: pending.scopes,
      });
      await this.outlookFinishSignIn(tokens, pending);
    } catch (e) {
      const text = `Outlook sign-in failed: ${(e && e.message) || e}${e && e.hint ? ` ${e.hint}` : ''}`;
      if (modal) modal.setStatus(text, true);
      new Notice(text, 12000);
    }
  }

  // The fallback: a code typed on any device, polled here until Microsoft
  // confirms, gives up, or the modal is closed.
  async outlookDeviceSignIn() {
    const pending = this._outlookPending;
    const modal = this._outlookModal;
    if (!pending || !modal) return;
    try {
      const dc = await deviceCodeStart({ clientId: pending.clientId, tenant: pending.tenant, scopes: pending.scopes });
      modal.showDeviceCode(dc);
      const tokens = await deviceCodePoll(
        { clientId: pending.clientId, tenant: pending.tenant, deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn },
        { cancelled: () => modal.closed || this._outlookPending !== pending },
      );
      this._outlookPending = null;
      await this.outlookFinishSignIn(tokens, pending);
    } catch (e) {
      if (e && e.reason === 'cancelled') return;
      const text = `Outlook sign-in failed: ${(e && e.message) || e}${e && e.hint ? ` ${e.hint}` : ''}`;
      if (!modal.closed) modal.setStatus(text, true);
      new Notice(text, 12000);
    }
  }

  async outlookFinishSignIn(tokens, pending) {
    const sink = { live: this.settings, vault: this.secrets };
    saveOutlookTokens(sink, tokens);
    this.settings.outlookScopes = trimmed(tokens.scope) || (pending && pending.scopes) || '';
    let account = '';
    try {
      const me = await graphRequest(this.withSecrets(), undefined, { url: `${GRAPH_BASE}/me?$select=userPrincipalName,mail,displayName` });
      account = trimmed(me.mail) || trimmed(me.userPrincipalName) || trimmed(me.displayName);
    } catch { /* the account line is a nicety; the tokens are what matter */ }
    writeSecret(this.settings, this.secrets, 'outlookAccount', account || 'Microsoft account');
    ensureGraphCalendarFeed(this.settings);
    delete this.syncStatus.outlook;
    await this.saveSettings();
    if (this._outlookModal) { this._outlookModal.close(); this._outlookModal = null; }
    new Notice(`Planner: signed in to Outlook${account ? ` as ${account}` : ''}.`);
    if (pending && pending.onDone) pending.onDone();
    this.syncNow(false);
  }

  // Sign-out clears the four vault keys and the granted scopes. The notes
  // stay, like a removed token elsewhere; the Outlook calendar row stays
  // and says it wants a sign-in. Revoking on Microsoft's side is the
  // member's own click, linked from the settings tab.
  async outlookSignOut() {
    clearOutlookTokens({ live: this.settings, vault: this.secrets });
    this.settings.outlookScopes = '';
    this._outlookPending = null;
    delete this.syncStatus.outlook;
    await this.saveSettings();
    this.recomputeCalendarDefs();
    new Notice('Planner: signed out of Outlook. The token is gone from this vault; to revoke the app on Microsoft\'s side too, use the link in settings.', 8000);
  }

  // A sync run announcing its own hand. Called by every write a sync makes
  // to an item note, and by nothing else: a card action is the person acting
  // and must reach the source at once.
  // Takes the TFile wherever the caller has one (no lookup, and it works for
  // a file the index has not published yet), a path otherwise.
  markSyncWrite(fileOrPath) {
    if (!fileOrPath || !this._syncWrites) return;
    const file = typeof fileOrPath === 'string' ? this.app.vault.getAbstractFileByPath(fileOrPath) : fileOrPath;
    if (!file || !file.path) return;
    const mtime = file.stat ? Number(file.stat.mtime) : NaN;
    // No stat, no signal: leave no stamp rather than a false one.
    if (!Number.isFinite(mtime)) { this._syncWrites.delete(file.path); return; }
    this._syncWrites.delete(file.path);
    this._syncWrites.set(file.path, mtime);
    while (this._syncWrites.size > SYNC_WRITE_MAX_PATHS) {
      const oldest = this._syncWrites.keys().next();
      if (oldest.done) break;
      this._syncWrites.delete(oldest.value);
    }
  }

  // The person's own action on a note the sync just wrote: the stamp goes,
  // so the push check treats the next event as what it is.
  clearSyncWrite(path) { if (this._syncWrites) this._syncWrites.delete(path); }

  isSyncWrite(path) {
    if (!this._syncWrites || !this._syncWrites.has(path)) return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    const live = file && file.stat ? Number(file.stat.mtime) : NaN;
    const own = syncWriteIsOwn(this._syncWrites.get(path), live);
    // Once the file has moved on, the stamp can never match again: spend it
    // here rather than leave it to be re-read on every later event.
    if (!own) this._syncWrites.delete(path);
    return own;
  }

  // Debounced per-file: a local edit (user typing, a card action, or an agent
  // editing frontmatter) pushes out without waiting for the next sync.
  schedulePushCheck(path) {
    if (this._pushTimers.has(path)) window.clearTimeout(this._pushTimers.get(path));
    this._pushTimers.set(path, window.setTimeout(() => {
      this._pushTimers.delete(path);
      this.detectAndPush(path);
    }, 900));
  }

  async detectAndPush(path) {
    // Defence in depth, and the seam the regression tests drive: the
    // `changed` handler already declines to schedule a check for a write the
    // sync just made, and any other caller is declined here too. A sync run
    // has just settled every field on this note against the source; there is
    // by definition nothing local in it to push back.
    if (this.isSyncWrite(path)) return;
    const s = this.withSecrets(); // shallow: s._shadow is the live map
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const item = itemFromFile(this.app, file);
    if (!item) return;
    // A manual item has no source to write to. Guarded explicitly rather than
    // relying on "it has no shadow entry, so it falls out below": that is true
    // today and would stop being true the moment anything else seeds a shadow.
    if (!isSyncedSource(item.source)) return;
    const key = `${item.source}:${item.id}`;
    const sh = s._shadow[key];
    // No baseline yet: the next sync seeds it. A pending reopen is the one
    // signal that must act without a shadow (older installs, or a note the
    // AI team reopened by hand).
    if (!sh && item.reopenPending !== true) return;
    let dirty = false;
    if (sh && s.pushEdits && canPushToSource(item.source)) {
      const body = await this.readBody(file);
      const localVals = { title: item.title, due: item.due, priority: item.priority, description: body };
      const pushes = {};
      for (const f of TWO_WAY_FIELDS) {
        // Same rule as threeWayMerge: a field the shadow has no baseline for
        // cannot be read as a local edit. The next sync seeds it.
        if (!(f in sh)) continue;
        const base = sh[f] == null || sh[f] === '' ? (f === 'priority' ? 5 : null) : sh[f];
        const loc = localVals[f] == null || localVals[f] === '' ? (f === 'priority' ? 5 : null) : localVals[f];
        if (loc !== base) pushes[f] = loc;
      }
      if (Object.keys(pushes).length) {
        try {
          await CONNECTORS[item.source].pushFields(s, item, pushes);
          for (const f of Object.keys(pushes)) sh[f] = pushes[f];
          dirty = true;
          new Notice(`Planner: pushed ${Object.keys(pushes).join(', ')} to ${SOURCES[item.source].label}.`);
        } catch (e) {
          if (isGoneError(e)) { await this.removeGoneItem(item.source, item); return; }
          new Notice(`Planner: ${SOURCES[item.source].label} push failed (${e.message}). Will retry on sync.`);
        }
      }
    }
    // A reopen the card asked for (uncheck on a source-closed task) acts even
    // when the shadow already says done. It is the ONE reopen that reaches a
    // source, and `reopen_pending` is written in exactly one place:
    // toggleDoneLocal, on the person's own uncheck.
    const wantReopen = item.reopenPending === true && !item.doneLocal;
    // A difference against the shadow may CLOSE at the source, never reopen.
    // The source is the winner (Tom's ruling, 2026-09-17): the note reflects
    // the source, never the other way round, so a note reading open where the
    // shadow reads done is a note that has not caught up - or, until 0.14.3,
    // the plugin's own reconcile write - and neither is anyone asking for a
    // closed task to come back. The old `doneDiffers` test pushed both ways
    // and is what reset published ClickUp tasks to `not started`.
    // `item.status !== 'done'` is Flint's guard (2026-09-17, finding 1):
    // `status: done` has exactly one writer, the reconcile, so it MEANS the
    // source closed this task. A close against it is never needed, and a
    // shadow that lost its done flag - a quit before the debounced data.json
    // save, or a second device taking the note through Sync ahead of the
    // settings - would otherwise read the reconcile's own `done_local: true`
    // as intent and close it again. Harmless on Todoist, IMAP and Outlook;
    // on a ClickUp list with more than one closed-type status it rewrites
    // the status, which is still a source write born of a source completion.
    const wantClose = sh ? (item.doneLocal && item.status !== 'done' && !sh.done) : false;
    if (s.completeOnSource && canCompleteOnSource(item.source) && (wantReopen || wantClose)) {
      try {
        await this.applyDoneOnSource(item, item.doneLocal);
        if (sh) {
          sh.done = item.doneLocal;
        } else {
          s._shadow[key] = { due: item.due, priority: item.priority, description: await this.readBody(file), done: item.doneLocal };
        }
        dirty = true;
        if (wantReopen) {
          await this.app.fileManager.processFrontMatter(file, (fm) => { delete fm.reopen_pending; });
        }
      } catch (e) {
        // The toast the member saw every five minutes on a deleted task.
        // There is nothing to retry against a task that is not there.
        if (isGoneError(e)) { await this.removeGoneItem(item.source, item); return; }
        new Notice(`Planner: ${item.doneLocal ? 'close' : 'reopen'} on ${SOURCES[item.source].label} failed (${e.message}). Will retry on sync.`);
      }
    }
    if (dirty) {
      if (this._shadowSaveTimer) window.clearTimeout(this._shadowSaveTimer);
      this._shadowSaveTimer = window.setTimeout(() => this.persistSettings(), 1500);
    }
  }

  // The name is built from two strings the source chose, and both pass
  // safeBasename: an id is API-assigned and plain in practice, and the note
  // is confined to the folder whatever it carries.
  async createItemFile(folder, source, t) {
    let base = `${safeBasename(t.title)} (${source}-${noteIdPart(t.id)})`;
    let path = normalizePath(`${folder}/${base}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${base}-2.md`);
    }
    const fmLines = [
      '---',
      'type: planner-item',
      `source: ${source}`,
      `external_id: "${String(t.id).replace(/"/g, '')}"`,
      `title: ${JSON.stringify(t.title)}`,
      'status: open',
      `due: ${t.due || null}`,
      `priority: ${t.priority}`,
      `url: ${t.url ? JSON.stringify(t.url) : null}`,
      `tags: ${JSON.stringify(t.tags || [])}`,
      `source_status: ${t.status ? JSON.stringify(t.status) : null}`,
      `list_id: ${t.listId ? JSON.stringify(String(t.listId)) : null}`,
      `parent_id: ${t.parentId ? JSON.stringify(String(t.parentId)) : null}`,
      `recurring: ${t.recurring == null ? null : !!t.recurring}`,
      `due_string: ${t.dueString ? JSON.stringify(String(t.dueString)) : null}`,
      'planned_day: null',
      'planned_half: null',
      'planned_order: 0',
      'weekly_goal: false',
      'done_local: false',
      'linked_note: null',
      `synced_at: ${new Date().toISOString()}`,
      '---',
      '',
    ];
    const body = (t.description || '').trim();
    try {
      const created = await this.app.vault.create(path, fmLines.join('\n') + (body ? body + '\n' : ''));
      this.settings._shadow[`${source}:${t.id}`] = {
        due: t.due || null, priority: t.priority, description: body, done: false,
      };
      this.markSyncWrite(created || path);
    } catch { /* a race with another writer - the next sync settles it */ }
  }

  // Applies the merge result: `finals` carries the settled two-way fields
  // (due / priority / description); source-owned metadata always pulls.
  //
  // Every write below names its field. PLAN_OWNED_ITEM_FIELDS are not among
  // them and never will be: `planned_day`, `planned_half`, `planned_order`,
  // `done_local`, `weekly_goal` and `linked_note` are the planner's half of
  // the note, and processFrontMatter leaves a field nobody assigns exactly as
  // it was. The `ops` block below is the one exception and it is the plan
  // acting on itself (a finished occurrence clearing its own placement),
  // never the source reaching in.
  // `plan` (optional) is the syncCompletionPlan result: the occurrence
  // advance and the reopen confirmation are applied to the note here, in the
  // same frontmatter write as the source pull.
  async updateItemFile(prior, t, finals, currentBody, plan) {
    // `title` is a shared field since 0.15.0, so the settled value wins here
    // the way `due` and `priority` already did. An empty settled title falls
    // back to the source's: the note never blanks a task's name.
    const wantTitle = finals.title != null && String(finals.title).trim() !== '' ? finals.title : t.title;
    const wantDue = finals.due || null;
    const wantPriority = clampPriorityRank(finals.priority);
    const wantRecurring = t.recurring == null ? null : !!t.recurring;
    const wantDueString = t.dueString ? String(t.dueString) : null;
    const wantParent = t.parentId ? String(t.parentId) : null;
    const ops = plan || {};
    const hasOps = !!(ops.resetDoneLocal || ops.clearPlan || ops.movePlan || ops.occurrence || ops.clearReopenPending);
    const changed =
      prior.title !== wantTitle || prior.due !== wantDue ||
      prior.priority !== wantPriority || prior.url !== (t.url || null) ||
      prior.status === 'done' || // reopened at the source
      prior.recurring !== wantRecurring || prior.dueString !== wantDueString ||
      prior.parentId !== wantParent ||
      hasOps ||
      JSON.stringify(prior.tags) !== JSON.stringify(t.tags || []) ||
      prior.sourceStatus !== (t.status || null) ||
      prior.listId !== (t.listId ? String(t.listId) : null);
    if (changed) {
      const nowIso = new Date().toISOString();
      await this.app.fileManager.processFrontMatter(prior.file, (fm) => {
        fm.title = wantTitle;
        fm.due = wantDue;
        fm.priority = wantPriority;
        fm.url = t.url || null;
        fm.tags = t.tags || [];
        fm.source_status = t.status || null;
        if (t.listId) fm.list_id = String(t.listId);
        fm.recurring = wantRecurring;
        fm.due_string = wantDueString;
        fm.parent_id = wantParent;
        // Back in the open set: the source shows it open, whatever asked for
        // it, and the local check goes with the status (a reopen at the
        // source is a reopen here).
        if (fm.status === 'done') { fm.status = 'open'; delete fm.done_at; fm.done_local = false; }
        if (ops.clearReopenPending) delete fm.reopen_pending;
        if (ops.resetDoneLocal) { fm.done_local = false; fm.status = 'open'; delete fm.done_at; }
        if (ops.clearPlan) { fm.planned_day = null; fm.planned_half = null; fm.planned_order = 0; }
        if (ops.movePlan) {
          // Appended at the end of the lane: the tap-to-plan convention
          // (order = wall-clock ms, past every hand order).
          fm.planned_day = ops.movePlan.day;
          fm.planned_half = ops.movePlan.half;
          fm.planned_order = Date.now();
        }
        if (ops.occurrence) {
          fm.occurrences = appendOccurrence(fm.occurrences, {
            due: ops.occurrence.due,
            planned_day: ops.occurrence.plannedDay,
            planned_half: ops.occurrence.plannedHalf,
            done_at: nowIso,
          });
          fm.last_completed_due = ops.lastCompletedDue;
        }
        fm.synced_at = nowIso;
      });
      this.markSyncWrite(prior.file);
    }
    // Body follows the settled description, never blindly the source.
    const desc = (finals.description || '').trim();
    try {
      if ((currentBody || '').trim() !== desc) {
        await this.app.vault.process(prior.file, (data) => {
          const m = /^---\n[\s\S]*?\n---\n?/.exec(data);
          const head = m ? m[0] : '';
          return head + (desc ? desc + '\n' : '');
        });
        this.markSyncWrite(prior.file);
      }
    } catch { /* body refresh is cosmetic - never fail the sync on it */ }
  }

  /* ---- plan writes (the drag-and-drop write path) ------------------------- */
  async assignItem(path, day, half, order) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.planned_day = day;
      fm.planned_half = half;
      fm.planned_order = order;
    });
  }

  async unassignItem(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.planned_day = null;
      fm.planned_half = null;
      fm.planned_order = 0;
    });
  }

  // The check toggles the EFFECTIVE done state (isDone), not the flag alone:
  // a card the source closed reads as done, and unchecking it must reopen
  // it, which before this only flipped done_local to true on a struck card.
  // Returns false when nothing changed (a refused reopen, a missing note),
  // so a checklist row that flipped optimistically can flip back.
  async toggleDoneLocal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const item = itemFromFile(this.app, file);
    if (!item) return false;
    // The person acting beats any stamp a sync left on this note a moment
    // ago: a check made one tick after a sync write must still reach the
    // source at once, not wait for the next sync to notice it.
    this.clearSyncWrite(path);
    if (!isDone(item)) {
      await this.app.fileManager.processFrontMatter(file, (fm) => { fm.done_local = true; });
      return true;
    }
    const decision = reopenDecision({
      statusDone: item.status === 'done',
      completeOnSource: !!this.settings.completeOnSource,
      synced: isSyncedSource(item.source),
    });
    if (decision === 'refuse-local') {
      new Notice(`This task is closed in ${(SOURCES[item.source] || {}).label || item.source}. Turn on Complete on source to reopen it from here.`);
      return false;
    }
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.done_local = false;
      if (fm.status === 'done') { fm.status = 'open'; delete fm.done_at; }
      // Optimistic: the card un-strikes now; the push path sends the reopen
      // and clears the flag; reconcile stands down while it is set.
      if (decision === 'push') fm.reopen_pending = true;
    });
    return true;
  }

  async toggleWeeklyGoal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.weekly_goal = fm.weekly_goal !== true;
    });
  }

  // The note this task is FOR (0.14.0). Plan-owned: written only here and
  // from a hand edit, never by a sync run. An empty value clears the field
  // rather than writing an empty string, so "no link" reads the same as it
  // does on a note that never had one. The linked note itself is never
  // touched; the pointer lives on the planner side only.
  async setItemLinkedNote(path, raw) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const value = normalizeLinkedNote(raw);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (value) fm.linked_note = value;
      else delete fm.linked_note;
    });
    return value;
  }

  /* ---- weeks (0.14.0): the week note's two blocks ------------------------ */

  // Every week write starts here: the boundary first, the lookup second, the
  // same shape habitFile has. A path outside <root>/Weeks/ is refused before
  // any file is looked up.
  weekFile(iso) {
    if (!WEEK_ISO_RE.test(String(iso == null ? '' : iso).trim())) throw new Error('not an ISO week');
    const path = normalizePath(this.paths().weekNote(iso));
    if (!this.paths().isWeek(path)) throw new Error('week note outside the planner Weeks folder');
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }

  // This week's note, created from the template when it is missing. Creation
  // is the ONE write that touches anything outside the two sentinel blocks,
  // and it only ever writes a file that did not exist: a note already there
  // is returned as it is, never overwritten.
  async ensureWeekNote(iso) {
    const existing = this.weekFile(iso);
    if (existing) return existing;
    const folder = normalizePath(this.paths().weeks);
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      try { await this.app.vault.createFolder(folder); } catch { /* a race with another writer */ }
    }
    const path = normalizePath(this.paths().weekNote(iso));
    try {
      await this.app.vault.create(path, weekTemplate(iso, new Date().toISOString()));
    } catch { /* a race with another writer - the lookup below settles it */ }
    return this.weekFile(iso);
  }

  // The week as it is on disk, or null when the note does not exist yet.
  // Read through the metadata cache for the frontmatter and the vault for
  // the body, the same pair habitFromFrontmatter is fed.
  async readWeek(iso) {
    const file = this.weekFile(iso);
    if (!file) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    const body = await this.app.vault.read(file);
    return weekFromNote(cache && cache.frontmatter, body, file.path);
  }

  // Every body write runs inside vault.process on the bytes on disk, so two
  // fast taps cannot clobber each other, and every one of them is a pure
  // function of those bytes.
  async writeWeekBody(iso, fn) {
    const file = await this.ensureWeekNote(iso);
    if (!file) throw new Error('the week note could not be created');
    await this.app.vault.process(file, (data) => fn(data));
    // The week tab re-reads on this signal (emitModelChanged), which is also
    // what carries a hand edit in another pane back into the tab.
    this.emitModelChanged();
    return file;
  }

  async togglePriority(iso, index) {
    await this.writeWeekBody(iso, (data) => toggleChecklistItem(data, WEEK_PRIORITIES_SENTINEL, index));
  }

  async addPriority(iso, text) {
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return;
    await this.writeWeekBody(iso, (data) =>
      addChecklistItem(data, WEEK_PRIORITIES_SENTINEL, clean, WEEK_PRIORITIES_SECTION));
  }

  async setHighlight(iso, date, text) {
    await this.writeWeekBody(iso, (data) => weekHighlightAfterSet(data, date, text));
  }

  async markHighlight(iso, date, marker) {
    await this.writeWeekBody(iso, (data) => weekHighlightAfterMark(data, date, marker));
  }

  // The week tab, on the week containing `day` (today by default).
  async openWeek(iso) {
    const week = WEEK_ISO_RE.test(String(iso == null ? '' : iso).trim()) ? iso : isoWeekOf(todayStr());
    const existing = this.app.workspace.getLeavesOfType(WEEK_VIEW_TYPE);
    const leaf = existing.length ? existing[0] : this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: WEEK_VIEW_TYPE, active: true, state: { week } });
    this.app.workspace.revealLeaf(leaf);
  }

  /* ---- routines (2026-09-04): the body write path ------------------------- */

  // The effective split as HH:MM: the lunch start while the lunch band is
  // on, the split time otherwise. splitHour is the same rule in whole hours.
  splitHM() {
    const s = this.settings;
    return normalizeHM(s.lunchEnabled ? s.lunchStart : s.splitTime) || '13:00';
  }

  // The routine notes, parsed. render() is synchronous and reads
  // this.routines; this fills it. The body read is cached by the file's
  // mtime, so a week render costs zero reads when nothing changed.
  async refreshRoutines() {
    const out = [];
    try {
      const folder = this.app.vault.getAbstractFileByPath(this.paths().routines);
      const files = [];
      const walk = (f) => {
        for (const c of f.children || []) {
          if (c instanceof TFolder) walk(c);
          else if (c instanceof TFile && c.extension === 'md') files.push(c);
        }
      };
      if (folder instanceof TFolder) walk(folder);
      const seen = new Set();
      for (const file of files) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache && cache.frontmatter;
        if (!fm || fm.type !== ROUTINE_TYPE) continue;
        seen.add(file.path);
        const mtime = file.stat ? file.stat.mtime : 0;
        const hit = this._routineCache.get(file.path);
        if (hit && hit.mtime === mtime) { out.push(hit.routine); continue; }
        const text = await this.app.vault.cachedRead(file);
        const routine = parseRoutineNote(fm, text, file.path);
        if (!routine) continue;
        routine.file = file;
        this._routineCache.set(file.path, { mtime, routine });
        out.push(routine);
      }
      for (const key of Array.from(this._routineCache.keys())) if (!seen.has(key)) this._routineCache.delete(key);
    } catch { /* an unreadable note is skipped; the next change re-reads it */ }
    this.routines = out;
    return out;
  }

  // The day's routine instances for the board and the agenda.
  routinesFor(day) {
    if (this.settings.routinesEnabled === false) return [];
    return routineOccurrences(this.routines || [], day, this.splitHM(), routineDefaultsOf(this.settings));
  }

  // Every log write goes through vault.process: the transform runs on the
  // bytes on disk, atomically, never on a body read a moment earlier. The
  // write asserts its own folder: a path outside Routines is refused here,
  // whatever the caller believed.
  async processRoutine(path, fn) {
    if (!this.paths().isRoutine(path)) throw new Error('routine note outside the planner folder');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('the routine note is gone');
    await this.app.vault.process(file, fn);
  }
  toggleRoutineStep(path, day, index, next, total) {
    return this.processRoutine(path, (data) => routineLogAfterStep(data, day, index, next, total));
  }
  skipRoutine(path, day) { return this.processRoutine(path, (data) => routineLogSkipped(data, day)); }
  unskipRoutine(path, day) { return this.processRoutine(path, (data) => routineLogReset(data, day)); }
  resetRoutineDay(path, day) { return this.processRoutine(path, (data) => routineLogReset(data, day)); }

  async setRoutineActive(path, active) {
    if (!this.paths().isRoutine(path)) throw new Error('routine note outside the planner folder');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.active = !!active; });
  }

  openNewRoutine() { new NewRoutineModal(this.app, this).open(); }

  // Creates the note and returns its path. The parsed routine is put into
  // the cache right away from the text just written, so the settings list
  // and the board show it before the metadata cache has indexed the file;
  // the changed hook re-reads it when that happens (same mtime: no read).
  async createRoutine(input) {
    const v = validateRoutineInput(input);
    if (!v.ok) throw new Error(v.error);
    await this.ensureFolders();
    const folder = this.paths().routines;
    const base = safeBasename(input.name);
    let path = normalizePath(`${folder}/${base}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && n < 50; n++) {
      path = normalizePath(`${folder}/${base}-${n}.md`);
    }
    const nowIso = new Date().toISOString();
    const text = routineTemplate(input.name, input.type, input.weekdays,
      { start: input.start, end: input.end }, { steps: input.steps, nowIso });
    const file = await this.app.vault.create(path, text);
    const fm = {
      type: ROUTINE_TYPE, name: String(input.name).trim(), routine_type: routineTypeOf(input.type),
      start: normalizeHM(input.start), end: normalizeHM(input.end),
      weekdays: normalizeWeekdays(input.weekdays), active: true, created_at: nowIso,
    };
    const routine = parseRoutineNote(fm, text, path);
    if (routine && file instanceof TFile) {
      routine.file = file;
      this._routineCache.set(path, { mtime: file.stat ? file.stat.mtime : 0, routine });
      this.routines = (this.routines || []).filter((r) => r.path !== path).concat([routine]);
    }
    this.emitModelChanged();
    new Notice(`Planner: created the routine "${fm.name}".`);
    return path;
  }

  /* ---- habits (0.10.0): the planner's own notes, under <root>/Habits/ ---- */

  habitsFolder() { return this.paths().habits; }
  habitsImportFolder() { return habitsImportFolderOf(this.settings); }
  openNewHabit() { new NewHabitModal(this.app, this).open(); }
  // The tap on Import is the consent moment for the one write the planner
  // makes in the My Life room, and nothing new to take does not make it a
  // different moment: a vault whose habits were all imported before 0.14.1
  // has no candidates left, so this is the only place its two bare
  // cross-links can still be qualified. The Notice says what that did.
  async openImportHabits(candidates, onDone) {
    const list = candidates || this.importCandidates();
    if (!list.length) {
      const r = await this.qualifyHabitLinks();
      new Notice(qualifySummaryText(r));
      if (r.qualified) this.emitModelChanged();
      if (onDone) onDone();
      return;
    }
    new ImportHabitsModal(this.app, this, list, onDone).open();
  }

  // The planner habit notes, parsed. The folder is flat (one note per
  // habit, never a folder), so subfolders are not walked. Cached by mtime
  // like routines.
  async refreshHabits() {
    const out = [];
    try {
      const folder = this.app.vault.getAbstractFileByPath(this.habitsFolder());
      const seen = new Set();
      const files = folder instanceof TFolder
        ? (folder.children || []).filter((c) => c instanceof TFile && c.extension === 'md')
        : [];
      for (const file of files) {
        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache && cache.frontmatter;
        if (!isPlannerHabitFrontmatter(fm) || !habitBasenameOk(file.basename)) continue;
        seen.add(file.path);
        const mtime = file.stat ? file.stat.mtime : 0;
        const hit = this._habitCache.get(file.path);
        if (hit && hit.mtime === mtime) { out.push(hit.habit); continue; }
        const text = await this.app.vault.cachedRead(file);
        const habit = habitFromFrontmatter(fm, file.path, text);
        if (!habit) continue;
        habit.file = file;
        this._habitCache.set(file.path, { mtime, habit });
        out.push(habit);
      }
      for (const key of Array.from(this._habitCache.keys())) if (!seen.has(key)) this._habitCache.delete(key);
    } catch { /* an unreadable note is skipped; the next change re-reads it */ }
    this.habits = out;
    return out;
  }

  // The day's habit rows for the board block and the agenda.
  habitsFor(day, today) {
    if (this.settings.habitsEnabled === false) return [];
    return habitOccurrences(this.habits || [], day, today || todayStr(), { streaks: this.settings.habitStreaks !== false });
  }

  // Every habit write starts here: the boundary first, the lookup second.
  // A path outside <root>/Habits/ is refused before any file is looked up.
  habitFile(path) {
    if (!habitPathInside(this.settings, path)) throw new Error('habit note outside the planner Habits folder');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error('the habit note is gone');
    return file;
  }

  // The check-in: one row in the note body, through vault.process. Never a
  // frontmatter write.
  async toggleHabit(path, day, next) {
    const file = this.habitFile(path);
    await this.app.vault.process(file, (data) => habitLogAfterCheck(data, day, next));
  }
  // The weekday toggles: cadence_days, on a weekly habit only.
  async setHabitDays(path, days) {
    const file = this.habitFile(path);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (normalizeCadence(fm.cadence) !== 'weekly') throw new Error('only a weekly habit takes weekdays');
      fm.cadence_days = normalizeWeekdays(days);
    });
  }
  // The cadence dropdown: the cadence and the fields it reads, nothing else
  // (applyHabitCadence).
  async setHabitCadence(path, cadence) {
    const file = this.habitFile(path);
    await this.app.fileManager.processFrontMatter(file, (fm) => { applyHabitCadence(fm, cadence); });
  }
  // The day-of-month field: month_day, on a monthly habit only, 1 to 28.
  async setHabitMonthDay(path, day) {
    const file = this.habitFile(path);
    const n = monthDayOf(day);
    if (n === null) throw new Error(`the day of the month is 1 to ${HABIT_MONTH_DAY_MAX}`);
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      if (normalizeCadence(fm.cadence) !== 'monthly') throw new Error('only a monthly habit takes a day of the month');
      fm.month_day = n;
    });
  }
  // Pause, resume, archive, restore: status and nothing else.
  async setHabitStatus(path, status) {
    const file = this.habitFile(path);
    const s = String(status == null ? '' : status).trim().toLowerCase();
    if (!HABIT_STATUSES.includes(s)) throw new Error(`unknown habit status "${status}"`);
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.status = s; });
  }
  // Rename: the name in the frontmatter, and the file when its safe name
  // changes, through fileManager.renameFile so every link to it follows.
  // Returns the path the note has afterwards.
  async renameHabit(path, name) {
    const file = this.habitFile(path);
    const clean = String(name == null ? '' : name).trim();
    if (!clean) throw new Error('Give the habit a name.');
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.name = clean; });
    const base = safeBasename(clean);
    if (base === file.basename) return path;
    const next = this.freeHabitPath(base);
    await this.app.fileManager.renameFile(file, next);
    return next;
  }
  // Delete: Obsidian's trash (the vault's .trash folder or the system bin,
  // as the person set it), never a hard delete.
  async deleteHabit(path) {
    const file = this.habitFile(path);
    await this.app.fileManager.trashFile(file);
  }
  // The first free path for a habit basename under the folder.
  freeHabitPath(base) {
    const folder = this.habitsFolder();
    let path = normalizePath(`${folder}/${base}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && n < 50; n++) {
      path = normalizePath(`${folder}/${base}-${n}.md`);
    }
    return path;
  }
  // Creates the note and returns its path. The parsed habit is put into the
  // cache right away from the text just written, like a routine, so the tab
  // shows it before the metadata cache has indexed the file. `opts.logBlock`
  // is the import's moved table; `opts.quiet` skips the Notice.
  async createHabit(input, opts) {
    const o = opts || {};
    const v = validateHabitInput(input, { lenient: !!o.lenient });
    if (!v.ok) throw new Error(v.error);
    await this.ensureFolders();
    const path = this.freeHabitPath(safeBasename(input.name));
    // created_at is the instant; started_on (when the input has none) is
    // the local calendar date. Pinned once so the note and its cache agree.
    const nowIso = new Date().toISOString();
    const today = todayStr();
    const lenient = !!o.lenient;
    // The room the linked note lives in, from the setting: a bare name from
    // the dialog's dropdown becomes the path of the note it came from.
    const linkFolder = this.habitsImportFolder();
    const text = habitTemplate(input, { nowIso, today, lenient, linkFolder, logBlock: o.logBlock });
    const file = await this.app.vault.create(path, text);
    const habit = habitFromFrontmatter(habitFrontmatterOf(input, { nowIso, today, lenient, linkFolder }), path, text);
    if (habit && file instanceof TFile) {
      habit.file = file;
      this._habitCache.set(path, { mtime: file.stat ? file.stat.mtime : 0, habit });
      this.habits = (this.habits || []).filter((h) => h.path !== path).concat([habit]);
    }
    this.emitModelChanged();
    if (!o.quiet) new Notice(`Planner: created the habit "${habit ? habit.name : input.name}".`);
    return path;
  }

  // The notes the import could take: a flat read of the My Life Habits
  // folder, frontmatter from the cache, no body read (that happens at
  // import time, for the chosen notes only).
  importCandidates() {
    const folder = this.app.vault.getAbstractFileByPath(this.habitsImportFolder());
    const files = folder instanceof TFolder
      ? (folder.children || []).filter((c) => c instanceof TFile && c.extension === 'md')
      : [];
    const notes = files.map((f) => {
      const cache = this.app.metadataCache.getFileCache(f);
      return { path: f.path, basename: f.basename, fm: cache && cache.frontmatter };
    });
    return importPlan(notes, this.habits || []);
  }
  // The notes the New habit dialog can link to: every note in the My Life
  // Habits folder that is not room furniture, by basename.
  linkableNotes() {
    const folder = this.app.vault.getAbstractFileByPath(this.habitsImportFolder());
    const files = folder instanceof TFolder
      ? (folder.children || []).filter((c) => c instanceof TFile && c.extension === 'md' && habitBasenameOk(c.basename))
      : [];
    return files.map((f) => f.basename).sort((a, b) => a.localeCompare(b));
  }
  // The one-time link qualification (0.14.1). Both cross-links between a
  // habit's two notes are rewritten to the full vault path, once each: a
  // habit exists twice by design, the two notes share a name, and a bare
  // [[X]] cannot say which of them it means. It runs at the top of an
  // import because that is the one moment the person has agreed to a write
  // in the My Life room; the settings sentence already says so. Idempotent
  // by construction: the plan only names a note whose value is still
  // folderless, and the text edit refuses anything it does not recognise,
  // so a second run writes nothing.
  // Returns { qualified, left }: notes whose bytes changed, and rows left
  // alone because the note the bare link names is not in the folder.
  async qualifyHabitLinks() {
    const result = { qualified: 0, left: 0 };
    const folders = { importFolder: this.habitsImportFolder(), plannerFolder: this.habitsFolder() };
    const folder = this.app.vault.getAbstractFileByPath(folders.importFolder);
    const sources = [];
    for (const c of (folder instanceof TFolder ? (folder.children || []) : [])) {
      if (!(c instanceof TFile) || c.extension !== 'md') continue;
      const fm = (this.app.metadataCache.getFileCache(c) || {}).frontmatter;
      // Only a note that has been imported can carry a pointer line, and only
      // its text can say whether that line still lacks the folder, so the body
      // of exactly those notes is read. cachedRead: Obsidian already holds it.
      sources.push({ path: c.path, fm, body: importDone(fm) ? await this.app.vault.cachedRead(c) : null });
    }
    for (const row of qualifyLinkPlan(this.habits || [], sources, folders)) {
      // The same boundary every other write has: the planner room for the
      // planner note, the import room for the My Life note, checked before
      // the file is looked up.
      const inside = row.field === 'linked_note'
        ? habitPathInside(this.settings, row.path)
        : importPathInside(this.settings, row.path);
      if (!inside) continue;
      const file = this.app.vault.getAbstractFileByPath(row.path);
      if (!(file instanceof TFile)) continue;
      // A bare link resolves by proximity, so one whose note has moved out
      // of the folder is still working. Naming the folder would point it at
      // a path that holds nothing, which is worse than the ambiguity, so the
      // row is left as it is and counted.
      const named = this.app.vault.getAbstractFileByPath(`${row.folder}/${row.target}.md`);
      if (!(named instanceof TFile)) { result.left++; continue; }
      try {
        // A text edit, never Obsidian's frontmatter editor: that one
        // reserialises the block and drops the note's comment lines (0.11.0).
        let changed = false;
        await this.app.vault.process(file, (data) => {
          const next = row.field === 'pointer'
            ? qualifyHabitPointer(data, row.folder)
            : qualifyFrontmatterLink(data, row.field, row.folder);
          changed = next !== data;
          return next;
        });
        if (changed) result.qualified++;
      } catch (e) {
        console.error('icor-planner: could not qualify', row.field, 'on', row.path, e);
      }
    }
    return result;
  }

  // The import, for the chosen candidates. Per note, in this order: the
  // planner note is created with the log block copied into it; then the My
  // Life note gives up the block for the pointer line (vault.process) and
  // its schedule fields, gaining its type and the back-link in one more
  // vault.process, a text edit of the named lines that keeps the block's
  // comments (importSourceFrontmatterText). The three writes are not one
  // transaction, so each is written to be redone: a note is done only when
  // its own frontmatter carries the back-link (importDone, read here on
  // the source), and a note that is not done resumes from whatever is
  // missing. A planner note that already links back is reused (never a
  // second one); it adopts the log block only if the source still holds
  // it; the body is rewritten only while the block or the pointer says
  // so; the frontmatter step always runs last. Nothing is ever lost: the
  // block leaves the source only after the planner note holds it.
  // Returns { done, skipped, failed }.
  async importHabits(candidates) {
    const result = { done: 0, skipped: 0, failed: [] };
    await this.qualifyHabitLinks();
    for (const c of candidates || []) {
      if (!c || !importPathInside(this.settings, c.path)) { result.skipped++; continue; }
      try {
        const src = this.app.vault.getAbstractFileByPath(c.path);
        if (!(src instanceof TFile)) { result.skipped++; continue; }
        const cache = this.app.metadataCache.getFileCache(src);
        if (importDone(cache && cache.frontmatter, this.habits || [])) { result.skipped++; continue; }
        const body = await this.app.vault.read(src);
        const logBlock = habitLogBlockOf(body);
        const existing = c.existingPlanner && this.app.vault.getAbstractFileByPath(c.existingPlanner);
        let path;
        if (existing instanceof TFile) {
          path = c.existingPlanner;
          if (logBlock) await this.app.vault.process(this.habitFile(path), (data) => adoptLogBlock(data, logBlock));
        } else {
          path = await this.createHabit(c, { logBlock, quiet: true, lenient: true });
        }
        // One reading of the planner note, its PATH, for both writes
        // (0.14.2). The body pointer used to keep the short name, on the
        // reasoning that it is prose a person reads; but it is prose that
        // names a file, and from the My Life room a bare name resolves to
        // the note the line sits in. A note pointed the old way is still
        // recognised as pointed, so it never gains a second line.
        const plannerLink = wikilinkTarget(path);
        if (logBlock || !habitHasPointer(body, plannerLink)) {
          await this.app.vault.process(src, (data) => moveHabitLog(data, plannerLink));
        }
        // A text edit, never Obsidian's frontmatter editor (which would
        // rewrite the block and drop its comment lines). The metadata
        // cache reparses after the write, so importDone reads the
        // back-link on the next run.
        await this.app.vault.process(src, (data) => importSourceFrontmatterText(data, plannerLink));
        result.done++;
      } catch (e) {
        result.failed.push(`${c.basename}: ${(e && e.message) || e}`);
      }
    }
    new Notice(importSummaryText(result));
    this.emitModelChanged();
    return result;
  }

  /* ---- manual items: the write path with no API key in front of it ------- */

  // Create one manual task and return its path (or null on an empty title).
  // Deliberately the same shape as createItemFile's output so the board, the
  // tray, the drag logic and the card menu cannot tell the difference.
  async addManualItem(title, opts) {
    const clean = String(title == null ? '' : title).trim();
    if (!clean) return null;
    await this.ensureFolders();
    const folder = this.paths().sourceFolder(MANUAL_SOURCE);
    const fm = manualItemFrontmatter(clean, manualExternalId(), new Date().toISOString());
    if (opts && opts.day) {
      fm.planned_day = opts.day;
      fm.planned_half = opts.half === 'pm' ? 'pm' : 'am';
      fm.planned_order = Date.now();
    }
    // The id is collision-proof by construction; this loop only guards against
    // a file that already sits at the path for an unrelated reason.
    let path = normalizePath(`${folder}/${safeBasename(clean)} (${fm.external_id}).md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && n < 50; n++) {
      path = normalizePath(`${folder}/${safeBasename(clean)} (${fm.external_id}-${n}).md`);
    }
    const yaml = [
      '---',
      'type: planner-item',
      `source: ${fm.source}`,
      `external_id: "${fm.external_id}"`,
      `title: ${JSON.stringify(fm.title)}`,
      `status: ${fm.status}`,
      `due: ${fm.due === null ? 'null' : fm.due}`,
      `priority: ${fm.priority}`,
      'url: null',
      'tags: []',
      'source_status: null',
      `planned_day: ${fm.planned_day === null ? 'null' : fm.planned_day}`,
      `planned_half: ${fm.planned_half === null ? 'null' : fm.planned_half}`,
      `planned_order: ${fm.planned_order}`,
      `weekly_goal: ${fm.weekly_goal}`,
      `done_local: ${fm.done_local}`,
      `created_at: ${fm.created_at}`,
      '---',
      '',
    ].join('\n');
    try {
      await this.app.vault.create(path, yaml);
    } catch (e) {
      new Notice(`Planner: could not create the task (${(e && e.message) || 'unknown error'}).`);
      return null;
    }
    // No shadow entry: a manual item has no source baseline, and detectAndPush
    // must never find one for it.
    this.emitModelChanged();
    return path;
  }

  // Open the plugin's own settings tab. Obsidian exposes this on app.setting;
  // guarded because it is not part of the published API surface.
  openPluginSettings() {
    try {
      const setting = this.app.setting;
      if (!setting || typeof setting.open !== 'function') {
        new Notice('Open Settings, Community plugins, ICOR for Life - Planner to add a key.');
        return;
      }
      setting.open();
      if (typeof setting.openTabById === 'function') setting.openTabById(this.manifest.id);
    } catch {
      new Notice('Open Settings, Community plugins, ICOR for Life - Planner to add a key.');
    }
  }

  splitHour() {
    const src = this.settings.lunchEnabled
      ? (this.settings.lunchStart || '12:30')
      : (this.settings.splitTime || '13:00');
    const m = /^(\d{1,2}):(\d{2})$/.exec(src);
    return m ? Number(m[1]) : 13;
  }

  // Fractional rank for an insertion at `index` among `siblings` (sorted by
  // plannedOrder). The cockpit's server-computed-position rule, client-side.
  // Since 0.4.3 `siblings` is the lane's MIXED sequence from laneSequence():
  // read-only event entries (plannedOrder = start minutes since midnight)
  // interleaved with task entries (plannedOrder = planned_order). Dropping
  // between a 09:00 event (540) and an 11:00 event (660) yields 600, so the
  // task keeps its slot between them on the next render.
  orderForInsert(siblings, index) {
    if (!siblings.length) return 10;
    if (index <= 0) return siblings[0].plannedOrder - 10;
    if (index >= siblings.length) return siblings[siblings.length - 1].plannedOrder + 10;
    return (siblings[index - 1].plannedOrder + siblings[index].plannedOrder) / 2;
  }
}

/* ========================================================================== *
 * Shared card rendering (board + tray speak the same visual grammar)
 * ========================================================================== */

// The theme's plugin-surface contract: declare this subtree a plugin surface,
// so the INKLINE theme's own control rules stand down inside it. Without it the theme's input-well
// rule sits at (0,5,1) and beats every (0,2,0) rule in styles.css on
// background, border, font-family and both focus properties, and the tray's
// underline field renders as a filled well. Measured against the shipped theme
// bytes 2026-08-30. Reads the manifest, never a literal, so a rename cannot
// silently unhook it.
function markInkPlugin(el, pluginId) {
  if (el && el.dataset && pluginId) el.dataset.inkPlugin = pluginId;
}

function sourceMarkEl(source) {
  const meta = SOURCES[source] || SOURCES.todoist;
  const span = document.createElement('span');
  span.className = `iplan-source-mark iplan-source-${source}`;
  span.setAttribute('aria-label', meta.label);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', meta.svg);
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function dueChipText(item, today) {
  if (!item.due) return null;
  const bucket = dueBucketOf(item.due, today);
  if (bucket === 'today') return 'TODAY';
  if (bucket === 'overdue') {
    const days = Math.round((new Date(today) - new Date(item.due)) / 86400000);
    return days === 1 ? '1D OVER' : `${days}D OVER`;
  }
  return fmtDayNum(item.due);
}

// The chips in a card's meta row, in order, as data: due, priority, goal,
// repeat. A ghost's due is a date that has passed by design; "3D OVER" would
// be a lie about a finished occurrence, so it shows the date, neutrally. The
// repeat chip is a glyph with a spoken label (the recurrence phrase when the
// source gave one); it appears for a known recurrence only, never for the
// unknown case.
function cardChips(item, today, ghost) {
  const out = [];
  const due = ghost ? (item.due ? fmtDayNum(item.due) : null) : dueChipText(item, today);
  if (due) {
    out.push({
      kind: 'due', text: due,
      cls: ghost ? 'iplan-chip' : `iplan-chip iplan-due-${dueBucketOf(item.due, today)}`,
    });
  }
  if (item.priority <= 2) out.push({ kind: 'priority', cls: `iplan-chip iplan-prio-${item.priority}`, text: `P${item.priority}` });
  // The chip says WEEK, not GOAL (ruling 2026-09-15): the star pins a task
  // to the week, and the word "goal" belongs to the My Life note. `kind` and
  // the CSS class keep their names - they are keys, not labels.
  if (item.weeklyGoal) out.push({ kind: 'goal', cls: 'iplan-chip iplan-goal-chip', text: 'WEEK' });
  if (item.recurring === true) {
    out.push({
      kind: 'repeat', cls: 'iplan-chip iplan-repeat-chip', text: '', icon: 'repeat',
      label: `Repeats${item.dueString ? `, ${item.dueString}` : ''}`,
    });
  }
  return out;
}

// One read-only calendar chip's behavior, shared by the board lanes and the
// tray's AGENDA tab: stale look while defs come from the vault cache, the
// feed's lens on the left edge, an aria label, and click-through into the
// detail modal (with the feed, looked up from the settings, so the Google
// edit deep-link can be built when the feed is Google's).
function wireEventChip(plugin, chip, ev) {
  if (plugin.calendarStale) chip.addClass('is-stale');
  // An unresolved zone is visible on the chip itself (dashed edge, a mark)
  // and spoken in the label; the modal names the zone.
  if (ev.tzUnresolved) chip.addClass('is-tz-unresolved');
  // The feed's lens is the chip's left edge and nothing else (never a text
  // ink, never a tint); the label speaks the feed's name, so colour is
  // never the only carrier.
  if (ev.feedColor) chip.addClass(`iplan-cal-${clampSwatch(ev.feedColor)}`);
  if (ev.feedId) chip.setAttribute('data-feed', ev.feedId);
  chip.setAttribute('aria-label',
    `${ev.title}${ev.location ? ', ' + ev.location : ''}${ev.feedName ? ', ' + ev.feedName : ''}${ev.tzUnresolved ? ', time zone not recognised, shown as written' : ''}`);
  chip.addEventListener('click', () => new EventDetailModal(plugin.app, ev, calendarFeedFor(plugin.withSecrets(), ev), plugin.manifest.id).open());
}

// One task card. mode: 'board' | 'tray'. `view.index` (buildItemIndex) is
// where the parent kicker and the subtask counter come from; `view.expanded`
// is the Set of parent paths whose list is open.
function renderCard(plugin, item, mode, view) {
  const today = todayStr();
  const index = view && view.index ? view.index : null;
  const parent = parentOf(item, index);
  const card = document.createElement('div');
  card.className = 'iplan-card';
  card.setAttribute('data-path', item.path);
  card.setAttribute('data-order', String(item.plannedOrder));
  card.setAttribute('data-source', item.source);
  // A ghost is a finished occurrence of a recurring task (ghostItemsFor):
  // struck, not draggable, no check action, no menu. It opens the note.
  const ghost = item.ghost === true;
  const notePath = item.notePath || item.path;
  card.draggable = !ghost;
  if (isDone(item)) card.classList.add('is-done');
  if (ghost) card.classList.add('is-ghost');
  if (item.weeklyGoal) card.classList.add('is-goal');

  if (!ghost) {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.path);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
      document.body.classList.add('iplan-dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      document.body.classList.remove('iplan-dragging');
      document.querySelectorAll('.iplan-drop-line').forEach((el) => el.remove());
    });
  }

  const check = document.createElement('button');
  check.className = 'iplan-check';
  if (ghost) {
    check.disabled = true;
    check.setAttribute('aria-label', 'Completed occurrence');
  } else {
    check.setAttribute('aria-label', isDone(item) ? 'Reopen' : 'Mark done');
    check.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      plugin.toggleDoneLocal(item.path);
    });
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'iplan-card-body';
  // The parent kicker: a child card says which task it belongs to, in the
  // meta voice above its own title. Spoken as "Part of <parent>".
  if (parent) {
    const kicker = document.createElement('div');
    kicker.className = 'iplan-card-parent';
    const said = document.createElement('span');
    said.className = 'iplan-sr-only';
    said.textContent = 'Part of ';
    kicker.appendChild(said);
    kicker.appendChild(document.createTextNode(parent.title));
    bodyEl.appendChild(kicker);
  }
  const titleEl = document.createElement('div');
  titleEl.className = 'iplan-card-title';
  titleEl.textContent = item.title;
  const meta = document.createElement('div');
  meta.className = 'iplan-card-meta';
  meta.appendChild(sourceMarkEl(item.source));
  for (const c of cardChips(item, today, ghost)) {
    const chip = document.createElement('span');
    chip.className = c.cls;
    if (c.icon) {
      chip.setAttribute('role', 'img');
      chip.setAttribute('aria-label', c.label);
      setIcon(chip, c.icon);
    } else {
      chip.textContent = c.text;
    }
    meta.appendChild(chip);
  }
  bodyEl.appendChild(titleEl);
  bodyEl.appendChild(meta);
  // The subtask counter and its list, on a live parent card only.
  const counter = !ghost && plugin.settings.subtaskChecklist !== false ? subtaskCounter(item, index) : null;
  if (counter) renderSubtaskRow(plugin, item, index, counter, bodyEl, view);

  card.appendChild(check);
  card.appendChild(bodyEl);

  // Click opens the local note; the source link lives in the context menu.
  card.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const file = plugin.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
  });
  if (ghost) return card;
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCardMenu(plugin, item, view, { x: e.clientX, y: e.clientY });
  });

  wireLongPress(card, (pos) => showCardMenu(plugin, item, view, pos));
  return card;
}

// The "n of m subtasks" row on a parent card (2026-09-04): a chevron button
// (aria-expanded, aria-controls) opens the shared checklist of the children.
// Open state lives in `view.expanded` per parent path, so it survives the
// re-render that follows every write and is forgotten with the view. A
// child's check goes through toggleDoneLocal, the same path its own card
// uses; the list is a second view of the same notes. Dragging the card
// carries the parent only: the children keep their own plan.
function renderSubtaskRow(plugin, item, index, counter, bodyEl, view) {
  const kids = childrenOfItem(item, index);
  const listId = `iplan-subs-${Math.abs(hashStr(item.path)).toString(36)}`;
  const expanded = view && view.expanded instanceof Set ? view.expanded : null;
  let open = !!(expanded && expanded.has(item.path));
  const row = document.createElement('div');
  row.className = 'iplan-card-sub';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'iplan-card-sub-toggle';
  btn.setAttribute('aria-controls', listId);
  const chevron = document.createElement('span');
  chevron.className = 'iplan-card-sub-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  setIcon(chevron, 'chevron-right');
  const text = document.createElement('span');
  text.textContent = subtaskCounterText(counter);
  btn.appendChild(chevron);
  btn.appendChild(text);
  row.appendChild(btn);
  bodyEl.appendChild(row);
  const list = document.createElement('div');
  list.id = listId;
  list.className = 'iplan-card-subs';
  bodyEl.appendChild(list);
  const paint = () => {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} subtasks of ${item.title}`);
    row.classList.toggle('is-open', open);
    list.hidden = !open;
  };
  const fill = () => {
    const model = checklistModel({
      rows: kids.map((k) => ({ id: k.path, label: k.title, checked: isDone(k), meta: subtaskRowMeta(k, item) })),
    });
    renderChecklist(list, model, {
      compact: true,
      progress: false,
      ariaLabel: `Subtasks of ${item.title}`,
      onToggle: (id) => plugin.toggleDoneLocal(String(id)),
      onProgress: (done, total) => { text.textContent = subtaskCounterText({ done, total }); },
    });
  };
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    open = !open;
    if (expanded) { if (open) expanded.add(item.path); else expanded.delete(item.path); }
    if (open && !list.childElementCount) fill();
    paint();
  });
  if (open) fill();
  paint();
}

// Touch long-press opens the same menu as right-click: mobile webviews fire
// neither contextmenu nor HTML5 drag events, so this is the whole mobile
// write path for a card. Shared by task cards and routine cards. The click
// that ends the press is swallowed (capture, once) so it neither opens the
// note nor flips a step under the menu.
function wireLongPress(el, onMenu) {
  let lpTimer = null, lpStart = null;
  const lpCancel = () => { if (lpTimer != null) { window.clearTimeout(lpTimer); lpTimer = null; } };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    lpStart = { x: e.clientX, y: e.clientY };
    lpCancel();
    lpTimer = window.setTimeout(() => {
      lpTimer = null;
      el.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); },
        { once: true, capture: true });
      onMenu(lpStart);
    }, 480);
  });
  el.addEventListener('pointermove', (e) => {
    if (lpTimer != null && lpStart
      && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 8) lpCancel();
  });
  el.addEventListener('pointerup', lpCancel);
  el.addEventListener('pointercancel', lpCancel);
}

// The habits block (2026-09-04): under the afternoon lane, all-day, one row
// per habit scheduled for that weekday. Not a lane (nothing drops here, it
// is never wired as one) and not a card (nothing here drags). The head
// carries the count in the day-head voice; the shared checklist carries the
// rows, a future day's rows disabled; a streak chip on the row when the
// habit's log is the streak schema. Right-click or long-press a row opens
// the habit note.
function renderHabitsBlock(plugin, occs, day, today, view) {
  const block = document.createElement('div');
  block.className = 'iplan-habits';
  if (String(day) > String(today)) block.classList.add('is-future');
  const head = document.createElement('div');
  head.className = 'iplan-habits-head';
  const word = document.createElement('span');
  word.textContent = 'HABITS';
  const count = document.createElement('span');
  count.className = 'iplan-habits-count';
  const say = (n, m) => { count.textContent = `${n} OF ${m}`; };
  say(occs.filter((o) => o.checked).length, occs.length);
  head.appendChild(word);
  head.appendChild(count);
  block.appendChild(head);
  const model = checklistModel({
    rows: occs.map((o) => ({
      id: o.habit.path, label: o.habit.name, checked: o.checked, missed: o.missed, disabled: o.disabled,
      meta: o.streak > 0 ? `STREAK ${o.streak}` : null,
    })),
  });
  renderChecklist(block, model, {
    ariaLabel: `Habits for ${fmtDayLabel(day)}`,
    progress: false,
    onToggle: (id, next) => plugin.toggleHabit(String(id), day, next),
    onProgress: say,
  });
  const rowMenu = (target, pos) => {
    const row = target instanceof Element ? target.closest('.iplan-checklist-row') : null;
    if (!row) return;
    const path = row.getAttribute('data-id');
    const menu = new Menu();
    menu.addItem((mi) => mi.setTitle('Open habit note').setIcon('file-text').onClick(() => {
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
    }));
    menu.showAtPosition(pos);
  };
  block.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    rowMenu(e.target, { x: e.clientX, y: e.clientY });
  });
  wireLongPress(block, (pos) => rowMenu(document.elementFromPoint(pos.x, pos.y), pos));
  return block;
}

// One routine block (2026-09-04). Not draggable: it sits where its time
// puts it. Row one the kicker (type and time), row two the name, row three
// the steps as the shared checklist with its "n of m". Complete strikes
// like a task; skipped is a ghost with its rows disabled. The type is said
// by the kicker word and by the lane half it sits in, never by a colour.
function renderRoutineCard(plugin, occ, view) {
  const state = routineCardState(occ);
  const routine = occ.routine;
  const card = document.createElement('div');
  card.className = `iplan-card iplan-routine is-${routine.routineType}`;
  card.setAttribute('data-routine', routine.path);
  card.setAttribute('data-order', String(occ.startMin));
  card.draggable = false;
  if (state.done) card.classList.add('is-done');
  if (state.ghost) card.classList.add('is-ghost');

  const meta = document.createElement('div');
  meta.className = 'iplan-card-meta iplan-routine-kicker';
  const kind = document.createElement('span');
  kind.textContent = routineKicker(occ);
  const time = document.createElement('span');
  time.className = 'iplan-routine-time';
  time.textContent = routineTimeLabel(occ);
  meta.appendChild(kind);
  meta.appendChild(time);
  if (state.ghost) {
    const chip = document.createElement('span');
    chip.className = 'iplan-chip';
    chip.textContent = 'SKIPPED';
    meta.appendChild(chip);
  }
  const title = document.createElement('div');
  title.className = 'iplan-card-title';
  title.textContent = routine.name;
  card.appendChild(meta);
  card.appendChild(title);

  const model = checklistModel({
    rows: occ.steps.map((s) => ({ id: s.index, label: s.label, checked: s.done, disabled: state.ghost })),
  });
  renderChecklist(card, model, {
    ariaLabel: `${routine.name}, ${routineKicker(occ).toLowerCase()} steps`,
    onToggle: (id, next) => plugin.toggleRoutineStep(routine.path, occ.day, Number(id), next, occ.total),
    onProgress: (done, total) => card.classList.toggle('is-done', total > 0 && done === total),
  });

  const openNote = () => {
    const file = plugin.app.vault.getAbstractFileByPath(routine.path);
    if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
  };
  card.addEventListener('click', (e) => { if (!e.defaultPrevented) openNote(); });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showRoutineMenu(plugin, occ, view, { x: e.clientX, y: e.clientY });
  });
  wireLongPress(card, (pos) => showRoutineMenu(plugin, occ, view, pos));
  return card;
}

// The routine menu, shared by right-click and long-press. Skip writes an S
// row for the day; Unskip and Reset delete the day's row.
function showRoutineMenu(plugin, occ, view, pos) {
  const menu = new Menu();
  const path = occ.routine.path;
  if (occ.skipped) {
    menu.addItem((mi) => mi.setTitle('Unskip today').setIcon('rotate-ccw')
      .onClick(() => plugin.unskipRoutine(path, occ.day)));
  } else {
    menu.addItem((mi) => mi.setTitle('Skip today').setIcon('skip-forward')
      .onClick(() => plugin.skipRoutine(path, occ.day)));
  }
  menu.addItem((mi) => mi.setTitle('Reset today').setIcon('eraser')
    .onClick(() => plugin.resetRoutineDay(path, occ.day)));
  menu.addItem((mi) => mi.setTitle('Open routine note').setIcon('file-text').onClick(() => {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
  }));
  menu.showAtPosition(pos);
}

// The card menu, shared by right-click (desktop) and long-press (touch).
function showCardMenu(plugin, item, view, pos) {
  const menu = new Menu();
  menu.addItem((mi) => mi.setTitle(isDone(item) ? 'Reopen' : 'Mark done')
    .setIcon('check').onClick(() => plugin.toggleDoneLocal(item.path)));
  menu.addItem((mi) => mi.setTitle(item.weeklyGoal ? 'Unpin from this week' : 'Pin to this week')
    .setIcon('star').onClick(() => plugin.toggleWeeklyGoal(item.path)));
  // The note this task is for: plan-owned, and the only place it is edited
  // from. Two rows, never one that changes meaning with the state.
  menu.addItem((mi) => mi.setTitle(item.linkedNote ? 'Change the linked note' : 'Link a note')
    .setIcon('link').onClick(() => new LinkNoteModal(plugin.app, plugin, item).open()));
  if (item.linkedNote) {
    menu.addItem((mi) => mi.setTitle(`Open ${item.linkedNote}`)
      .setIcon('file-symlink').onClick(() => {
        const file = linkedFileOf(plugin.app, item.linkedNoteTarget, item.path);
        if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
        else new Notice(`No note named ${item.linkedNote} in this vault.`);
      }));
  }
  menu.addItem((mi) => mi.setTitle('Plan on...')
    .setIcon('calendar').onClick(() => showPlanMenu(plugin, item, view, pos)));
  if (item.plannedDay) {
    menu.addItem((mi) => mi.setTitle('Send back to tray')
      .setIcon('inbox').onClick(() => plugin.unassignItem(item.path)));
  }
  if (item.url) {
    menu.addItem((mi) => mi.setTitle(`Open in ${(SOURCES[item.source] || {}).label || item.source}`)
      .setIcon('external-link').onClick(() => window.open(item.url, '_external')));
  }
  menu.addItem((mi) => mi.setTitle('Open note')
    .setIcon('file-text').onClick(() => {
      const file = plugin.app.vault.getAbstractFileByPath(item.path);
      if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
    }));
  const parent = parentOf(item, view && view.index);
  if (parent) {
    menu.addItem((mi) => mi.setTitle('Open parent note')
      .setIcon('corner-left-up').onClick(() => {
        const file = plugin.app.vault.getAbstractFileByPath(parent.path);
        if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
      }));
  }
  menu.showAtPosition(pos);
}

// Tap-to-plan: pick a day and half of the board's current week. The card
// lands at the end of the lane (order = wall-clock ms, past every hand
// order); the next drag renormalizes via orderForInsert.
function showPlanMenu(plugin, item, view, pos) {
  const weekStart = (view && view.weekStart) || mondayOf(todayStr());
  const today = todayStr();
  const days = weekDays(weekStart)
    .filter((d, i) => plugin.settings.showWeekend || i < 5);
  const menu = new Menu();
  days.forEach((day, i) => {
    const label = `${DAY_NAMES[i]} ${fmtDayNum(day)}${day === today ? ' (today)' : ''}`;
    for (const half of ['am', 'pm']) {
      menu.addItem((mi) => mi
        .setTitle(`${label} · ${half === 'am' ? 'morning' : 'afternoon'}`)
        .setIcon(half === 'am' ? 'sunrise' : 'sunset')
        .onClick(() => plugin.assignItem(item.path, day, half, Date.now())));
    }
  });
  menu.showAtPosition(pos);
}

// Wire one element as a drop lane. onDrop(path, index) receives the insertion
// index among the lane's current sequence: timed event chips AND non-dragged
// task cards in DOM order (the same order laneSequence() rendered them in), so
// a task can be dropped above, between or below calendar events. Event chips
// are never draggable; they only take part as positions.
function wireDropLane(laneEl, onDrop) {
  const clearLine = () => laneEl.querySelectorAll('.iplan-drop-line').forEach((el) => el.remove());
  // Ghost cards (finished occurrences) sit after the live sequence and take
  // no part in it, so they are excluded here exactly as they are excluded
  // from the sequence the drop handler ranks over. A routine block IS in the
  // sequence, skipped (ghost) or not, so it is a position like an event chip.
  const cardsOf = () => Array.from(laneEl.querySelectorAll('.iplan-event, .iplan-card.iplan-routine, .iplan-card:not(.is-dragging):not(.is-ghost)'));
  const indexForY = (y) => {
    const cards = cardsOf();
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  };
  laneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    laneEl.classList.add('is-drop-target');
    clearLine();
    const idx = indexForY(e.clientY);
    const line = document.createElement('div');
    line.className = 'iplan-drop-line';
    const cards = cardsOf();
    if (idx >= cards.length) laneEl.appendChild(line);
    else laneEl.insertBefore(line, cards[idx]);
  });
  laneEl.addEventListener('dragleave', (e) => {
    if (laneEl.contains(e.relatedTarget)) return;
    laneEl.classList.remove('is-drop-target');
    clearLine();
  });
  laneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    laneEl.classList.remove('is-drop-target');
    const idx = indexForY(e.clientY);
    clearLine();
    const path = e.dataTransfer.getData('text/plain');
    if (path) onDrop(path, idx);
  });
}

/* ========================================================================== *
 * Event detail modal - a calendar chip opens this on click (read-only)
 * ========================================================================== */

// Deep link into Google Calendar's edit view for an event that arrived via a
// Google secret iCal feed. The feed URL carries the calendarId
// (https://calendar.google.com/calendar/ical/<calendarId>/private-<key>/basic.ics);
// Google's per-event id is the ICS UID's localpart (trailing @google.com
// stripped), suffixed for expanded recurrences with the occurrence start
// (UTC basic format for timed, YYYYMMDD for all-day). The edit URL's eid is
// base64url("<eventId> <calendarId>") with the = padding stripped.
// Returns null when the feed is not that Google shape (caller falls back to
// a day-view link).
function googleCalendarEventUrl(ev, icsUrl) {
  const normalized = String(icsUrl || '').trim().replace(/^webcal:\/\//i, 'https://');
  const m = /^https:\/\/calendar\.google\.com\/calendar\/ical\/([^/?#]+)\//i.exec(normalized);
  if (!m || !ev || !ev.masterUid) return null;
  const calendarId = decodeURIComponent(m[1]);
  let eventId = ev.masterUid.replace(/@google\.com$/i, '');
  if (ev.recurring && ev.occStartUtc) eventId += `_${ev.occStartUtc}`;
  let b64;
  try { b64 = btoa(`${eventId} ${calendarId}`); } catch { return null; } // non-Latin1 uid
  const eid = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://calendar.google.com/calendar/u/0/r/eventedit/${eid}`;
}

class EventDetailModal extends Modal {
  // `feed` is the settings entry the event came from ({ id, name, url }),
  // or null for an event with no feed identity. The URL is read here for
  // ONE purpose: deciding whether a Google edit link can be built.
  constructor(app, ev, feed, inkPluginId) {
    super(app);
    this.ev = ev;
    this.feed = feed && typeof feed === 'object' ? feed : null;
    this.inkPluginId = inkPluginId || '';
  }
  onOpen() {
    const { contentEl } = this;
    const ev = this.ev;
    contentEl.addClass('iplan-event-modal');
    markInkPlugin(contentEl, this.inkPluginId);
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    // The kicker names the calendar the event came from.
    kicker.createSpan({ text: ` ${String((this.feed && this.feed.name) || 'Calendar').toUpperCase()}` });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: ev.title });
    const meta = contentEl.createDiv({ cls: 'iplan-event-modal-meta' });
    const dayLabel = (() => {
      const [y, m, d] = ev.day.split('-').map(Number);
      const idx = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
      return `${DAY_NAMES[idx]} ${fmtDayNum(ev.day)}`;
    })();
    // Labeled property rows: when / location / conference are first-class
    // fields, never only buried in the description text.
    const metaRow = (label, value, href) => {
      const rowEl = meta.createDiv({ cls: 'iplan-event-modal-row' });
      rowEl.createSpan({ cls: 'iplan-event-modal-row-label', text: label });
      if (href) {
        const a = rowEl.createEl('a', { cls: 'iplan-event-modal-row-value', text: value, href });
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(href, '_external'); });
      } else {
        rowEl.createSpan({ cls: 'iplan-event-modal-row-value', text: value });
      }
    };
    metaRow('WHEN', ev.allDay && !ev.start
      ? `${dayLabel} ALL DAY`
      : `${dayLabel} ${fmtTimeHM(ev.start)} - ${fmtTimeHM(ev.end)}`);
    if (ev.continues) meta.createDiv({ cls: 'iplan-event-modal-when', text: 'CONTINUED FROM AN EARLIER DAY' });
    if (ev.tzUnresolved) metaRow('TIME ZONE', `${ev.tzUnresolved} (not recognised, shown as written)`);
    if (ev.location) metaRow('WHERE', ev.location);
    const confUrl = detectConferenceUrl(ev);
    if (confUrl) metaRow('CONFERENCE', confUrl, confUrl);
    const descText = htmlishToText(ev.description);
    if (descText) {
      const desc = contentEl.createDiv({ cls: 'iplan-event-modal-desc' });
      linkifyInto(desc, descText);
    }
    const row = contentEl.createDiv({ cls: 'iplan-event-modal-actions' });
    // JOIN MEETING is the primary action when the event carries a meeting URL.
    if (confUrl) {
      const btn = row.createEl('button', { cls: 'iplan-event-modal-open is-primary', text: 'JOIN MEETING' });
      btn.addEventListener('click', () => window.open(confUrl, '_external'));
    }
    // The edit deep link exists only for a feed whose address is Google's
    // iCal shape; an iCloud, Proton or Outlook feed has no web edit URL, so
    // there is no calendar button to invent for it. The event's own URL
    // property, when it has one, is the fallback link.
    const gcalUrl = this.feed ? googleCalendarEventUrl(ev, feedUrl(this.feed)) : null;
    if (gcalUrl) {
      const btn = row.createEl('button', { cls: 'iplan-event-modal-open', text: 'EDIT IN GOOGLE CALENDAR' });
      btn.addEventListener('click', () => window.open(gcalUrl, '_external'));
    }
    // A URL property on a Google event points back at the event itself; the
    // edit button above already covers it, so only render a second button for
    // genuinely external links (and not for the meeting link again).
    if (ev.url && ev.url !== confUrl && !(gcalUrl && /google\.com\/calendar/i.test(ev.url))) {
      const btn = row.createEl('button', { cls: `iplan-event-modal-open${gcalUrl ? ' is-secondary' : ''}`, text: 'OPEN EVENT LINK' });
      btn.addEventListener('click', () => window.open(ev.url, '_external'));
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ========================================================================== *
 * Outlook sign-in modal (2026-09-06). Open while the browser round-trip is
 * out; offers the page again, the device code, and cancel. The status line
 * is a live region so the outcome is heard, not hunted for.
 * ========================================================================== */

class OutlookSignInModal extends Modal {
  constructor(app, plugin, opts) {
    super(app);
    this.plugin = plugin;
    this.url = (opts && opts.url) || '';
    this.closed = false;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('iplan-event-modal');
    contentEl.addClass('iplan-auth-modal');
    markInkPlugin(contentEl, this.plugin.manifest.id);
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' MICROSOFT SIGN-IN' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: 'Sign in to Outlook' });
    this.statusEl = contentEl.createDiv({ cls: 'iplan-auth-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.setStatus('Your browser opened Microsoft\'s sign-in page. Sign in there and approve the permissions; you will be brought back here.', false);
    this.bodyEl = contentEl.createDiv({ cls: 'iplan-auth-body' });
    const row = contentEl.createDiv({ cls: 'iplan-event-modal-actions' });
    const again = row.createEl('button', { cls: 'iplan-event-modal-open is-primary', text: 'OPEN THE SIGN-IN PAGE AGAIN', attr: { type: 'button' } });
    again.addEventListener('click', () => window.open(this.url, '_external'));
    const code = row.createEl('button', { cls: 'iplan-event-modal-open', text: 'USE A CODE INSTEAD', attr: { type: 'button' } });
    code.addEventListener('click', () => { code.disabled = true; this.plugin.outlookDeviceSignIn(); });
    const cancel = row.createEl('button', { cls: 'iplan-event-modal-open is-secondary', text: 'CANCEL', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    again.focus();
  }
  setStatus(text, failed) {
    if (!this.statusEl) return;
    this.statusEl.empty();
    this.statusEl.setText(text);
    this.statusEl.toggleClass('is-failed', !!failed);
  }
  // The device code view: the page to open, the code to type, a copy button.
  showDeviceCode(dc) {
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: 'iplan-auth-lead', text: 'Open this page on any device and enter the code:' });
    const uri = dc.verificationUri || 'https://microsoft.com/devicelogin';
    const link = this.bodyEl.createEl('a', { cls: 'iplan-auth-link', text: uri, href: uri });
    link.addEventListener('click', (e) => { e.preventDefault(); window.open(uri, '_external'); });
    this.bodyEl.createEl('code', {
      cls: 'iplan-auth-code', text: dc.userCode,
      attr: { 'aria-label': `Device code ${String(dc.userCode).split('').join(' ')}` },
    });
    const copy = this.bodyEl.createEl('button', { cls: 'iplan-event-modal-open', text: 'COPY CODE', attr: { type: 'button' } });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(dc.userCode);
        this.setStatus('Code copied. Waiting for Microsoft to confirm the sign-in...', false);
      } catch { this.setStatus('Could not copy; type the code by hand. Waiting for Microsoft to confirm the sign-in...', true); }
    });
    this.setStatus('Waiting for Microsoft to confirm the sign-in...', false);
  }
  onClose() {
    this.closed = true;
    this.contentEl.empty();
    if (this.plugin._outlookModal === this) this.plugin._outlookModal = null;
  }
}

/* ========================================================================== *
 * New routine modal (2026-09-04) and the weekday row it shares with settings
 * ========================================================================== */

// Seven toggle buttons, M T W T F S S, each with aria-pressed and the full
// day name as its label. `get()` returns the current codes, `set(codes)`
// keeps them (may be async); the buttons repaint from get() after a press.
// Seven aria-pressed toggles, one tab stop per row (the toolbar pattern):
// arrow keys, Home and End move inside the row. `opts.disabled` keeps the
// row reachable and inert (aria-disabled, no write), for a habit that takes
// no weekday edit.
function weekdayToggleRow(container, get, set, groupLabel, opts) {
  const o = opts || {};
  const group = container.createDiv({
    cls: 'iplan-seg iplan-settings-presets iplan-weekdays',
    attr: { role: 'group', 'aria-label': groupLabel },
  });
  if (o.disabled) group.setAttribute('aria-disabled', 'true');
  const buttons = [];
  const paint = () => {
    const on = get();
    for (const b of buttons) {
      const is = on.includes(b.dataset.day);
      b.classList.toggle('is-active', is);
      b.setAttribute('aria-pressed', is ? 'true' : 'false');
    }
  };
  const rove = (to) => {
    for (const x of buttons) x.setAttribute('tabindex', x === to ? '0' : '-1');
    to.focus();
  };
  WEEKDAY_CODES.forEach((code, i) => {
    const b = group.createEl('button', {
      cls: 'iplan-seg-btn', text: WEEKDAY_NAMES[code].charAt(0),
      attr: {
        type: 'button', 'aria-label': WEEKDAY_NAMES[code], 'aria-pressed': 'false', 'data-day': code,
        tabindex: i === 0 ? '0' : '-1',
      },
    });
    if (o.disabled) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', async () => {
      if (o.disabled) return;
      const on = new Set(get());
      if (on.has(code)) on.delete(code); else on.add(code);
      await set(normalizeWeekdays(Array.from(on)));
      paint();
    });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const k = buttons.indexOf(b);
      if (e.key === 'Home') rove(buttons[0]);
      else if (e.key === 'End') rove(buttons[buttons.length - 1]);
      else rove(buttons[(k + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]);
    });
    buttons.push(b);
  });
  paint();
  return group;
}

// Name, type, times (prefilled from the settings for the type), weekdays
// and the steps, one per line. Validation speaks in a live region; no
// browser dialog anywhere.
class NewRoutineModal extends Modal {
  constructor(app, plugin, onCreated) {
    super(app);
    this.plugin = plugin;
    this.onCreated = typeof onCreated === 'function' ? onCreated : null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('iplan-routine-modal');
    contentEl.addClass('iplan-settings');
    markInkPlugin(contentEl, this.plugin.manifest.id);
    const defaults = routineDefaultsOf(this.plugin.settings);
    const state = {
      name: '', type: 'morning',
      start: defaults.morning.start, end: defaults.morning.end,
      weekdays: routineWeekdaysDefaultOf(this.plugin.settings), steps: '',
    };
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' NEW ROUTINE' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: 'A block of steps, at a time of day.' });
    let nameInput = null;
    new Setting(contentEl).setName('Name').addText((t) => {
      nameInput = t.inputEl;
      t.setPlaceholder('Morning launch').onChange((v) => { state.name = v; });
      t.inputEl.setAttribute('aria-label', 'Routine name');
    });
    let fromText = null;
    let untilText = null;
    new Setting(contentEl)
      .setName('Type')
      .setDesc('Prefills the times below from the settings.')
      .addDropdown((d) => {
        for (const t of ROUTINE_TYPES) d.addOption(t, capitalize(t));
        d.setValue(state.type).onChange((v) => {
          state.type = routineTypeOf(v);
          state.start = defaults[state.type].start;
          state.end = defaults[state.type].end;
          if (fromText) fromText.setValue(state.start);
          if (untilText) untilText.setValue(state.end);
        });
        d.selectEl.setAttribute('aria-label', 'Routine type');
      });
    new Setting(contentEl)
      .setName('From / until')
      .setDesc('HH:MM.')
      .addText((t) => {
        fromText = t;
        t.setValue(state.start).onChange((v) => { state.start = v; });
        t.inputEl.setAttribute('aria-label', 'From');
      })
      .addText((t) => {
        untilText = t;
        t.setValue(state.end).onChange((v) => { state.end = v; });
        t.inputEl.setAttribute('aria-label', 'Until');
      });
    const wd = new Setting(contentEl).setName('Weekdays');
    weekdayToggleRow(wd.controlEl, () => state.weekdays, (codes) => { state.weekdays = codes; }, 'Weekdays');
    new Setting(contentEl)
      .setName('Steps')
      .setDesc('One per line. Edit them any time in the note.')
      .addTextArea((t) => {
        t.setPlaceholder('Water, 500 ml\nOne journal page\nPlan the day on the board').onChange((v) => { state.steps = v; });
        t.inputEl.rows = 4;
        t.inputEl.setAttribute('aria-label', 'Steps, one per line');
      });
    const error = contentEl.createDiv({ cls: 'iplan-routine-modal-error', attr: { 'aria-live': 'polite' } });
    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((b) => b.setButtonText('Create').setCta().onClick(() => this.submit(state, error, b)));
    if (nameInput) window.setTimeout(() => nameInput.focus(), 0);
  }
  async submit(state, errorEl, btn) {
    const v = validateRoutineInput(state);
    if (!v.ok) { errorEl.setText(v.error); return; }
    btn.setDisabled(true);
    try {
      await this.plugin.createRoutine({ ...state, steps: String(state.steps || '').split('\n') });
      this.close();
      if (this.onCreated) this.onCreated();
    } catch (e) {
      errorEl.setText(`Could not create the routine: ${(e && e.message) || e}`);
      btn.setDisabled(false);
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ========================================================================== *
 * Habit modals (0.10.0): new, rename, import. Validation speaks in a live
 * region; no browser dialog anywhere.
 * ========================================================================== */

// Name, cadence, the weekdays (weekly) or the day of the month (monthly),
// the start date (today), and the My Life note to link to when the folder
// has any. The rows a cadence does not read are hidden, not disabled.
class NewHabitModal extends Modal {
  constructor(app, plugin, onCreated) {
    super(app);
    this.plugin = plugin;
    this.onCreated = typeof onCreated === 'function' ? onCreated : null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('iplan-habit-modal');
    contentEl.addClass('iplan-settings');
    markInkPlugin(contentEl, this.plugin.manifest.id);
    const state = {
      name: '', cadence: 'daily', cadenceDays: ['mon', 'wed', 'fri'], monthDay: '1',
      startedOn: todayStr(), linkedNote: '',
    };
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' NEW HABIT' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: 'One yes or no per day.' });
    let nameInput = null;
    new Setting(contentEl).setName('Name').addText((t) => {
      nameInput = t.inputEl;
      t.setPlaceholder('Morning pages').onChange((v) => { state.name = v; });
      t.inputEl.setAttribute('aria-label', 'Habit name');
    });
    let daysRow = null;
    let monthRow = null;
    const showFor = (c) => {
      if (daysRow) daysRow.settingEl.classList.toggle('is-hidden', c !== 'weekly');
      if (monthRow) monthRow.settingEl.classList.toggle('is-hidden', c !== 'monthly');
    };
    new Setting(contentEl)
      .setName('Cadence')
      .setDesc('Every day, Monday to Friday, the weekdays you pick, or one day of the month.')
      .addDropdown((d) => {
        for (const c of HABIT_CADENCES) d.addOption(c, HABIT_CADENCE_NAMES[c]);
        d.setValue(state.cadence).onChange((v) => { state.cadence = normalizeCadence(v); showFor(state.cadence); });
        d.selectEl.setAttribute('aria-label', 'Cadence');
      });
    daysRow = new Setting(contentEl).setName('Weekdays');
    weekdayToggleRow(daysRow.controlEl, () => state.cadenceDays, (codes) => { state.cadenceDays = codes; }, 'Weekdays');
    monthRow = new Setting(contentEl)
      .setName('Day of the month')
      .setDesc(`1 to ${HABIT_MONTH_DAY_MAX}.`)
      .addText((t) => {
        t.setValue(state.monthDay).onChange((v) => { state.monthDay = v; });
        t.inputEl.type = 'number';
        t.inputEl.min = '1';
        t.inputEl.max = String(HABIT_MONTH_DAY_MAX);
        t.inputEl.setAttribute('aria-label', 'Day of the month');
      });
    new Setting(contentEl)
      .setName('Start date')
      .setDesc('Today unless you change it.')
      .addText((t) => {
        t.setValue(state.startedOn).onChange((v) => { state.startedOn = v; });
        t.inputEl.type = 'date';
        t.inputEl.setAttribute('aria-label', 'Start date');
      });
    const linkable = this.plugin.linkableNotes();
    if (linkable.length) {
      new Setting(contentEl)
        .setName('Link to a My Life habit note')
        .setDesc(`A note in ${this.plugin.habitsImportFolder()}. The planner note points at it and the row's menu opens it.`)
        .addDropdown((d) => {
          d.addOption('', 'None');
          for (const b of linkable) d.addOption(b, b);
          d.setValue('').onChange((v) => { state.linkedNote = v; });
          d.selectEl.setAttribute('aria-label', 'Linked My Life habit note');
        });
    }
    const error = contentEl.createDiv({ cls: 'iplan-routine-modal-error', attr: { 'aria-live': 'polite' } });
    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((b) => b.setButtonText('Create').setCta().onClick(() => this.submit(state, error, b)));
    showFor(state.cadence);
    if (nameInput) window.setTimeout(() => nameInput.focus(), 0);
  }
  async submit(state, errorEl, btn) {
    const v = validateHabitInput(state);
    if (!v.ok) { errorEl.setText(v.error); return; }
    btn.setDisabled(true);
    try {
      await this.plugin.createHabit(state);
      this.close();
      if (this.onCreated) this.onCreated();
    } catch (e) {
      errorEl.setText(`Could not create the habit: ${(e && e.message) || e}`);
      btn.setDisabled(false);
    }
  }
  onClose() { this.contentEl.empty(); }
}

// One field, Enter submits. The note is renamed with the name through
// Obsidian's own rename, so every link to it follows.
class RenameHabitModal extends Modal {
  constructor(app, plugin, habit, onDone) {
    super(app);
    this.plugin = plugin;
    this.habit = habit;
    this.onDone = typeof onDone === 'function' ? onDone : null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('iplan-habit-modal');
    contentEl.addClass('iplan-settings');
    markInkPlugin(contentEl, this.plugin.manifest.id);
    const state = { name: this.habit.name };
    let error = null;
    let btn = null;
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' RENAME HABIT' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: this.habit.name });
    let input = null;
    new Setting(contentEl)
      .setName('Name')
      .setDesc('The note is renamed with it; links to it follow.')
      .addText((t) => {
        input = t.inputEl;
        t.setValue(state.name).onChange((v) => { state.name = v; });
        t.inputEl.setAttribute('aria-label', 'Habit name');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          this.submit(state, error, btn);
        });
      });
    error = contentEl.createDiv({ cls: 'iplan-routine-modal-error', attr: { 'aria-live': 'polite' } });
    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((b) => { btn = b; b.setButtonText('Rename').setCta().onClick(() => this.submit(state, error, b)); });
    if (input) window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  async submit(state, errorEl, btn) {
    const clean = String(state.name == null ? '' : state.name).trim();
    if (!clean) { if (errorEl) errorEl.setText('Give the habit a name.'); return; }
    if (btn) btn.setDisabled(true);
    try {
      await this.plugin.renameHabit(this.habit.path, clean);
      this.close();
      if (this.onDone) this.onDone();
    } catch (e) {
      if (errorEl) errorEl.setText(`Could not rename: ${(e && e.message) || e}`);
      if (btn) btn.setDisabled(false);
    }
  }
  onClose() { this.contentEl.empty(); }
}

// The candidates as rows with a toggle each, all on; the button counts
// what is ticked. The import itself is the plugin's (importHabits).
class ImportHabitsModal extends Modal {
  constructor(app, plugin, candidates, onDone) {
    super(app);
    this.plugin = plugin;
    this.candidates = (candidates || []).slice();
    this.onDone = typeof onDone === 'function' ? onDone : null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('iplan-habit-modal');
    contentEl.addClass('iplan-settings');
    markInkPlugin(contentEl, this.plugin.manifest.id);
    const n = this.candidates.length;
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' IMPORT FROM MY LIFE' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: `${n} habit note${n === 1 ? '' : 's'} in ${this.plugin.habitsImportFolder()}.` });
    contentEl.createDiv({ cls: 'iplan-settings-note', text: IMPORT_EDITS_TEXT });
    contentEl.createDiv({
      cls: 'iplan-settings-note',
      text: `The planner note is created under ${this.plugin.habitsFolder()}/ with the schedule. Everything else in the My Life note stays. A note whose planner_habit already links to a planner habit note is skipped.`,
    });
    const chosen = new Set(this.candidates.map((c) => c.path));
    let btn = null;
    for (const c of this.candidates) {
      new Setting(contentEl).setName(c.name).setDesc(importCandidateText(c)).addToggle((t) => {
        t.setValue(true).onChange((v) => {
          if (v) chosen.add(c.path); else chosen.delete(c.path);
          if (btn) btn.setButtonText(importButtonText(chosen.size));
        });
        t.toggleEl.setAttribute('aria-label', `Import ${c.name}`);
      });
    }
    const error = contentEl.createDiv({ cls: 'iplan-routine-modal-error', attr: { 'aria-live': 'polite' } });
    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((b) => { btn = b; b.setButtonText(importButtonText(chosen.size)).setCta().onClick(() => this.submit(chosen, error, b)); });
  }
  async submit(chosen, errorEl, btn) {
    const picked = this.candidates.filter((c) => chosen.has(c.path));
    if (!picked.length) { errorEl.setText('Tick at least one note.'); return; }
    btn.setDisabled(true);
    try {
      await this.plugin.importHabits(picked);
      this.close();
      if (this.onDone) this.onDone();
    } catch (e) {
      errorEl.setText(`Could not import: ${(e && e.message) || e}`);
      btn.setDisabled(false);
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ========================================================================== *
 * Board view - the weekly planner in the main pane
 * ========================================================================== */

class PlannerBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.weekStart = mondayOf(todayStr());
    this.mode = 'week'; // 'week' | 'day'
    this.day = todayStr();
    this.index = null;          // buildItemIndex, per render
    this.expanded = new Set();  // parent paths whose subtask list is open
  }

  getViewType() { return BOARD_VIEW_TYPE; }
  getDisplayText() { return 'Planner'; }
  getIcon() { return 'calendar-range'; }

  async onOpen() {
    this.contentEl.addClass('iplan-root');
    markInkPlugin(this.contentEl, this.plugin.manifest.id);
    this.render();
    // Minute tick keeps the now-rail honest.
    this.registerInterval(window.setInterval(() => this.updateNowRail(), 60000));
    if (this.plugin.anySourceConfigured() && !this.plugin.lastSyncAt && !this.plugin.syncing) {
      this.plugin.syncNow(false);
    }
  }

  async onClose() { this.contentEl.empty(); }

  getState() { return { weekStart: this.weekStart, mode: this.mode, day: this.day }; }
  async setState(state, result) {
    if (state) {
      if (state.weekStart) this.weekStart = state.weekStart;
      if (state.mode === 'day' || state.mode === 'week') this.mode = state.mode;
      if (state.day) this.day = state.day;
      this.render();
    }
    return super.setState(state, result);
  }

  setWeek(weekStart) { this.weekStart = weekStart; this.render(); }
  setDay(day) { this.day = day; this.weekStart = mondayOf(day); this.render(); }
  setMode(mode) {
    this.mode = mode;
    if (mode === 'day' && !this.day) this.day = todayStr();
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const today = todayStr();
    const isDay = this.mode === 'day';
    const items = collectItems(this.plugin.app, this.plugin.paths().root);
    this.index = buildItemIndex(items);
    const splitHour = this.plugin.splitHour();
    const eventsWeekStart = isDay ? mondayOf(this.day) : this.weekStart;
    const events = this.plugin.calendarDefs
      ? icsEventsForWeek(this.plugin.calendarDefs, eventsWeekStart, splitHour)
      : [];

    /* ---- masthead ---- */
    const head = el.createDiv({ cls: 'iplan-masthead' });
    const kicker = head.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' ICOR PLANNER' });
    const titleRow = head.createDiv({ cls: 'iplan-title-row' });
    titleRow.createEl('h1', {
      cls: 'iplan-title',
      text: isDay
        ? fmtDayTitle(this.day, today)
        : (this.weekStart === mondayOf(today) ? 'This Week.' : 'The Week.'),
    });

    const nav = titleRow.createDiv({ cls: 'iplan-nav' });
    // WEEK | DAY segment switch
    const seg = nav.createDiv({ cls: 'iplan-seg' });
    const mkSeg = (label, mode) => {
      const b = seg.createEl('button', { cls: 'iplan-seg-btn', text: label });
      if (this.mode === mode) b.addClass('is-active');
      b.addEventListener('click', () => this.setMode(mode));
    };
    mkSeg('WEEK', 'week');
    mkSeg('DAY', 'day');
    const mkNavBtn = (icon, label, fn) => {
      const b = nav.createEl('button', { cls: 'iplan-nav-btn', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    if (isDay) {
      mkNavBtn('chevron-left', 'Previous day', () => this.setDay(addDays(this.day, -1)));
      const todayBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-nav-today', text: 'TODAY' });
      todayBtn.addEventListener('click', () => this.setDay(todayStr()));
      mkNavBtn('chevron-right', 'Next day', () => this.setDay(addDays(this.day, 1)));
      nav.createSpan({ cls: 'iplan-week-label', text: fmtDayLabel(this.day) });
    } else {
      mkNavBtn('chevron-left', 'Previous week', () => this.setWeek(addDays(this.weekStart, -7)));
      const todayBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-nav-today', text: 'TODAY' });
      todayBtn.addEventListener('click', () => this.setWeek(mondayOf(todayStr())));
      mkNavBtn('chevron-right', 'Next week', () => this.setWeek(addDays(this.weekStart, 7)));
      nav.createSpan({ cls: 'iplan-week-label', text: fmtWeekLabel(this.weekStart) });
    }
    // The week note of whatever week is on screen: the priorities and the
    // daily highlights of that week, one click from the board it plans.
    mkNavBtn('list-checks', 'Open the week note',
      () => this.plugin.openWeek(isoWeekOf(isDay ? this.day : this.weekStart)));
    const syncBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-sync-btn', attr: { 'aria-label': 'Sync now' } });
    setIcon(syncBtn, 'refresh-cw');
    if (this.plugin.syncing) syncBtn.addClass('is-syncing');
    syncBtn.addEventListener('click', () => this.plugin.syncNow(true));

    /* ---- source status line (only when something needs saying) ---- */
    const notices = [];
    for (const key of SYNCED_SOURCES) {
      const st = this.plugin.syncStatus[key];
      if (st && !st.ok && st.reason !== 'no-token') {
        notices.push(`${SOURCES[key].label}: ${st.message}${st.hint ? ` ${st.hint}` : ''}`);
      } else if (st && st.ok && st.warning) {
        // Healthy, incomplete: the cards are real, the open set is not the
        // whole open set, and nothing was marked done from it. Same row, same
        // styling as a failure line - there is nothing new to look at here.
        notices.push(`${SOURCES[key].label}: ${st.warning}`);
      }
    }
    if (this.plugin.calendarStatus && !this.plugin.calendarStatus.ok &&
        this.plugin.calendarStatus.reason !== 'no-token') {
      notices.push(`Calendar: ${this.plugin.calendarStatus.message}`);
    } else if (this.plugin.calendarStatus && this.plugin.calendarStatus.warning) {
      // A healthy fetch with unresolved zones: one line, not one per event.
      notices.push(`Calendar: ${this.plugin.calendarStatus.warning}`);
    }
    if (!this.plugin.anySourceConfigured()) {
      // The SAME sentence the tray leads with, from the same constant. Two
      // surfaces describing one state in two different sentences is how a
      // first run starts feeling unfinished, and the old wording said "API
      // keys" when the calendar takes a URL and the mailbox takes three
      // fields. The tray beside this carries the two controls; the board
      // states the fact.
      notices.push(TRAY_COPY.lead);
    }
    if (notices.length) {
      const bar = el.createDiv({ cls: 'iplan-notices' });
      for (const n of notices) bar.createDiv({ cls: 'iplan-notice', text: n });
    }

    /* ---- board ---- */
    const visibleDays = isDay
      ? [this.day]
      : weekDays(this.weekStart).filter((d, i) => this.plugin.settings.showWeekend || i < 5);
    const board = el.createDiv({ cls: 'iplan-board' });
    if (isDay) board.addClass('is-day');
    board.style.setProperty('--iplan-day-count', String(visibleDays.length));

    const itemsByCell = new Map(); // day|half -> items
    for (const it of items) {
      if (!it.plannedDay || !it.plannedHalf) continue;
      const key = `${it.plannedDay}|${it.plannedHalf}`;
      if (!itemsByCell.has(key)) itemsByCell.set(key, []);
      itemsByCell.get(key).push(it);
    }
    for (const list of itemsByCell.values()) list.sort((a, b) => a.plannedOrder - b.plannedOrder);
    // Finished occurrences of recurring tasks, rendered after the live
    // sequence of their lane, read-only.
    const ghostsByCell = new Map();
    for (const g of ghostItemsFor(items)) {
      const key = `${g.plannedDay}|${g.plannedHalf}`;
      if (!ghostsByCell.has(key)) ghostsByCell.set(key, []);
      ghostsByCell.get(key).push(g);
    }
    for (const list of ghostsByCell.values()) list.sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')));
    // Routines (2026-09-04): the day's instances, by lane, sequenced with
    // the events and the tasks below.
    const routinesByCell = new Map();
    for (const day of visibleDays) {
      for (const occ of this.plugin.routinesFor(day)) {
        const key = `${day}|${occ.half}`;
        if (!routinesByCell.has(key)) routinesByCell.set(key, []);
        routinesByCell.get(key).push(occ);
      }
    }

    const eventsByCell = new Map();
    const allDayByDay = new Map();
    for (const ev of events) {
      if (ev.allDay || !ev.half) {
        if (!allDayByDay.has(ev.day)) allDayByDay.set(ev.day, []);
        allDayByDay.get(ev.day).push(ev);
      } else {
        const key = `${ev.day}|${ev.half}`;
        if (!eventsByCell.has(key)) eventsByCell.set(key, []);
        eventsByCell.get(key).push(ev);
      }
    }

    for (const day of visibleDays) {
      const dayIdx = (new Date(day + 'T12:00:00').getDay() + 6) % 7;
      const col = board.createDiv({ cls: 'iplan-day' });
      if (day === today) col.addClass('is-today');
      if (day < today) col.addClass('is-past'); // YYYY-MM-DD compares as text

      const colHead = col.createDiv({ cls: 'iplan-day-head' });
      colHead.createSpan({ cls: 'iplan-day-name', text: DAY_NAMES[dayIdx] });
      colHead.createSpan({ cls: 'iplan-day-date', text: fmtDayNum(day) });
      if (day === today) colHead.createSpan({ cls: 'iplan-day-now', text: 'NOW' });

      const allDay = allDayByDay.get(day) || [];
      if (allDay.length) {
        const band = col.createDiv({ cls: 'iplan-allday' });
        for (const ev of allDay) {
          const chip = band.createDiv({ cls: 'iplan-event iplan-event-allday' });
          if (ev.continues) chip.addClass('is-continues');
          chip.createSpan({ cls: 'iplan-event-title', text: ev.title });
          this.wireEvent(chip, ev);
        }
      }

      for (const half of ['am', 'pm']) {
        if (half === 'pm') {
          const s = this.plugin.settings;
          if (s.lunchEnabled) {
            const band = col.createDiv({ cls: 'iplan-lunch' });
            band.style.height = `${lunchBandHeight(s.lunchStart, s.lunchEnd)}px`;
            band.createSpan({
              cls: 'iplan-split-time',
              text: `${s.lunchStart || '12:30'} - ${s.lunchEnd || '13:30'} LUNCH`,
            });
          } else {
            const divider = col.createDiv({ cls: 'iplan-split' });
            divider.createSpan({ cls: 'iplan-split-time', text: s.splitTime || '13:00' });
          }
        }
        const lane = col.createDiv({ cls: 'iplan-lane', attr: { 'data-day': day, 'data-half': half } });
        const laneEvents = (eventsByCell.get(`${day}|${half}`) || []);
        const cell = itemsByCell.get(`${day}|${half}`) || [];
        const laneRoutines = routinesByCell.get(`${day}|${half}`) || [];
        // One sequential order per lane: event 09:00, routine 09:00, task,
        // event 11:00, task.
        for (const entry of laneSequence(laneEvents, cell, laneRoutines)) {
          if (entry.kind === 'event') {
            const chip = lane.createDiv({ cls: 'iplan-event' });
            chip.createSpan({ cls: 'iplan-event-time', text: `${fmtTimeHM(entry.ev.start)}` });
            chip.createSpan({ cls: 'iplan-event-title', text: entry.ev.title });
            this.wireEvent(chip, entry.ev);
          } else if (entry.kind === 'routine') {
            lane.appendChild(renderRoutineCard(this.plugin, entry.occ, this));
          } else {
            lane.appendChild(renderCard(this.plugin, entry.it, 'board', this));
          }
        }
        const ghosts = ghostsByCell.get(`${day}|${half}`) || [];
        for (const g of ghosts) lane.appendChild(renderCard(this.plugin, g, 'board', this));
        if (!laneEvents.length && !cell.length && !ghosts.length && !laneRoutines.length) lane.createDiv({ cls: 'iplan-lane-empty', text: half === 'am' ? 'morning' : 'afternoon' });

        wireDropLane(lane, (path, index) => {
          // Same mixed sequence the lane was rendered from, minus the dragged
          // task, so `index` (computed over chips, blocks and cards) maps 1:1.
          const current = laneSequence(laneEvents, cell, laneRoutines).filter((x) => x.kind !== 'task' || x.path !== path);
          const order = this.plugin.orderForInsert(current, index);
          this.plugin.assignItem(path, day, half, order);
        });
      }

      // Habits (2026-09-04): the day's all-day block under the afternoon lane.
      const habitOccs = this.plugin.habitsFor(day, today);
      if (habitOccs.length) col.appendChild(renderHabitsBlock(this.plugin, habitOccs, day, today, this));

      if (day === today) {
        const rail = col.createDiv({ cls: 'iplan-now-rail' });
        col.dataset.railState = 'on';
        this._todayCol = col;
        this._nowRail = rail;
        // cockpit countdown: time left in the current half, right under the head
        const cd = document.createElement('div');
        cd.className = 'iplan-countdown';
        const track = document.createElement('div');
        track.className = 'iplan-countdown-track';
        const fill = document.createElement('div');
        fill.className = 'iplan-countdown-fill';
        track.appendChild(fill);
        const cdLabel = document.createElement('span');
        cdLabel.className = 'iplan-countdown-label';
        cd.appendChild(track);
        cd.appendChild(cdLabel);
        colHead.insertAdjacentElement('afterend', cd);
        this._countdown = { wrap: cd, fill, label: cdLabel };
      }
    }
    this.updateNowRail();

    /* ---- foot: last sync stamp ---- */
    const foot = el.createDiv({ cls: 'iplan-foot' });
    const stamp = this.plugin.lastSyncAt
      ? `SYNCED ${fmtTimeHM(this.plugin.lastSyncAt)}`
      : (this.plugin.syncing ? 'SYNCING...' : 'NOT SYNCED YET');
    foot.createSpan({ text: stamp });
    foot.createSpan({ cls: 'iplan-foot-dot', text: ' · ' });
    foot.createSpan({ text: fmtOpenItems(items.filter((i) => !isDone(i)).length) });
  }

  wireEvent(chip, ev) {
    // Cache-rehydrated events render pale + pulsing until a live fetch lands.
    wireEventChip(this.plugin, chip, ev);
  }

  // The live day-progress marker on today's column (cockpit's progress rail).
  updateNowRail() {
    if (!this._todayCol || !this._nowRail || !this._todayCol.isConnected) return;
    const parse = (hm, fallback) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
    };
    const start = parse(this.plugin.settings.dayStart, 480);
    const end = parse(this.plugin.settings.dayEnd, 1080);
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const pct = Math.max(0, Math.min(1, (mins - start) / Math.max(1, end - start)));
    this._todayCol.style.setProperty('--iplan-now-pct', String(pct));
    this._todayCol.dataset.railState = mins < start ? 'before' : (mins > end ? 'after' : 'on');
    if (this._countdown && this._countdown.wrap.isConnected) {
      const seg = segmentInfo(this.plugin.settings, mins);
      // A class, never an inline display: an inline style is out of reach of
      // the stylesheet and of a theme, and this element already carries a
      // display of its own that an inline '' would have to fall back to.
      this._countdown.wrap.classList.toggle('is-hidden', !seg);
      if (seg) {
        this._countdown.wrap.dataset.seg = seg.name.toLowerCase();
        this._countdown.fill.style.width = `${Math.round(seg.pct * 100)}%`;
        this._countdown.label.textContent = `${seg.name} \u00b7 ${fmtLeft(seg.leftMin)}`;
      }
    }
  }
}

/* ========================================================================== *
 * Tray view - the right-panel companion, tabbed since 0.6.0:
 *   TASKS  - the week's pinned tasks + unscheduled items by source (the classic
 *            tray; whole-panel drop unassigns). Internal id 'sync' (pre-0.6.1
 *            name, kept so no state migration is needed). Since 0.6.1 this
 *            tab ONLY exists while the planner board is the context
 *            (trayVisibleTabs); everywhere else the strip is AGENDA | GOALS.
 *   AGENDA - what is planned for TODAY, chronological: all-day chips, then
 *            MORNING / AFTERNOON as the board lane's mixed sequence.
 *            Read-plus-click in v1: no drop targets here.
 *   HABITS - (2026-09-04; managed here since 0.10.0) the planner's habits:
 *            one row per habit with its cadence, its weekdays or day of the
 *            month, its status and a menu (rename, pause, archive, delete,
 *            open); New habit and Import from My Life on the section head.
 *            Board context only, like TASKS.
 *   PINNED - only the tasks pinned to this week (tab id 'goals', label
 *            PINNED, section head PINNED THIS WEEK).
 * Default follows context (trayDefaultTab): board active -> TASKS, any other
 * main-area page -> AGENDA. A manual pick sticks until the context flips.
 * ========================================================================== */

const TRAY_TABS = ['sync', 'habits', 'agenda', 'goals'];
// The tabs that assist planning and exist only beside the board.
const BOARD_ONLY_TABS = ['sync', 'habits'];

// Tom's default rule: with the planner board active the tray assists planning
// (SYNC); on every other page it answers "what is planned today" (AGENDA).
// PINNED is never a default anywhere.
function trayDefaultTab(contextIsBoard) {
  return contextIsBoard ? 'sync' : 'agenda';
}

// 0.6.1, Tom's rule: "your tasks" (the TASKS tab) should only show on the
// planner page; on all other pages only AGENDA and PINNED exist. Pure helper
// so render() and setTab() share one source of truth.
function trayVisibleTabs(contextIsBoard) {
  return contextIsBoard ? TRAY_TABS : TRAY_TABS.filter((t) => !BOARD_ONLY_TABS.includes(t));
}

// Rendered label per tab id. 'sync' renders as TASKS since 0.6.1 (Tom calls
// this panel "your tasks"); the id stays 'sync' so nothing persisted or
// wired to it needs a migration.
function trayTabLabel(tab) {
  if (tab === 'sync') return 'TASKS';
  // 'goals' renders as PINNED since 0.14.0: the tab lists tasks pinned to the
  // week, and "Goal" is the My Life note's word (ruling 2026-09-15). The id
  // stays 'goals' so nothing persisted or wired to it needs a migration, the
  // same reason 'sync' still renders as TASKS.
  if (tab === 'goals') return 'PINNED';
  return tab.toUpperCase();
}

// The tray section head, and the whole surface's name for the starred task.
const PINNED_SECTION_HEAD = 'PINNED THIS WEEK';
// The spoken name of a tab (the label is uppercase for the eye only).
function trayTabName(tab) {
  const l = trayTabLabel(tab);
  return l.charAt(0) + l.slice(1).toLowerCase();
}

// The guarded active tab: whatever state claims, a tab that is not visible
// in this context collapses to the context default - so 'sync' in a
// non-board context can only ever come out as 'agenda'. Pure so the
// invariant is testable headless.
function trayEffectiveTab(contextIsBoard, activeTab) {
  return trayVisibleTabs(contextIsBoard).includes(activeTab)
    ? activeTab
    : trayDefaultTab(contextIsBoard);
}

/* ---- the tray's honest empty states (2026-08-30) -----------------------------
 *
 * The bug this replaces: a fresh vault with no keys showed "WAITING FOR THE
 * FIRST SYNC." under all three sources. No sync was coming, because no key
 * existed and syncNow() is never called without one. The message told a new
 * user to wait for something that could not happen, and made an unconfigured
 * plugin look like a broken one.
 *
 * Four states, three of them previously collapsed into one:
 *   unconfigured  no credential. Waiting is a lie; the way out is a CTA.
 *   error         configured, the fetch failed. Say what went wrong.
 *   unsynced      configured, nothing has run yet. NOW waiting is honest.
 *   empty         configured, a healthy fetch, genuinely zero items.
 * and `null`, meaning the list speaks for itself and the tray says nothing.
 *
 * Configuration is checked FIRST and beats a stale status: a user who deletes
 * a key still has last session's ok status in memory, and "Nothing
 * unscheduled" would be the same class of lie one state over.
 */

// Copy per the design system, 2026-08-30. `lead` names NO source on purpose: a list in
// a status line is a settings page leaking into a state report, the section
// heads below already name each source, and a hardcoded list drifts silently
// the day a fifth source is added. "Set up" rather than "add a key" because
// the calendar takes a URL and the mailbox takes a host, an address and an app
// password; "key" was already wrong for two of the four.
const TRAY_COPY = {
  lead: 'Nothing is connected yet. Set up your task sources in settings, or add your own tasks by hand.',
  leadAction: 'Open settings',
  unconfigured: () => 'Not connected.',
  connectAction: 'Connect',
  // secretsInStore (0.9.0) is a whole-vault flag, set the first time ANY
  // secret lands in Obsidian's per-device secret store. It rides data.json,
  // so it syncs; the secret itself does not (Store secrets doc: local
  // storage keyed to the vault, per device). A fresh device therefore sees
  // secretsInStore true and its OWN sourceConfigured false at once -- the
  // exact signature of "connected on another device, not this one" rather
  // than "never connected anywhere", and it earns a different sentence and
  // button (Flint's mobile audit, fix 4 / finding 7.2).
  unconfiguredDevice: () => 'Not connected on this device.',
  connectDeviceAction: 'Connect this device',
  unsynced: 'Waiting for the first sync.',
  empty: 'Nothing unscheduled.',
  manualEmpty: 'Nothing added yet.',
  errorFallback: 'Unavailable.',
};

function trayEmptyState(source, configured, status, count, total, secretsElsewhere) {
  // Manual has no credential and no fetch. `count` is the unscheduled list;
  // `total` is every manual item that exists. The live pass 2026-08-30 caught
  // the two being conflated: with the only manual task dragged onto the board
  // the tray said "nothing added yet", denying a task that exists. The list
  // under a source head is the UNSCHEDULED list, so its empty copy states
  // that ("nothing unscheduled", the same vocabulary as the synced sections)
  // and never where the items went - a done-but-unscheduled item and a pinned
  // pinned to the week both empty this list without being on the board.
  if (source === MANUAL_SOURCE) {
    if (count > 0) return null;
    const everAdded = (total || 0) > 0;
    return { kind: 'empty', text: everAdded ? TRAY_COPY.empty : TRAY_COPY.manualEmpty };
  }
  if (!configured) {
    return secretsElsewhere
      ? { kind: 'unconfigured-device', text: TRAY_COPY.unconfiguredDevice() }
      : { kind: 'unconfigured', text: TRAY_COPY.unconfigured(source) };
  }
  // A configured source reporting no-token means settings and the connector
  // disagree; trust the connector's message rather than inventing one.
  if (status && !status.ok) {
    // `hint` is the second line: what to do. `docUrl` is where.
    return {
      kind: 'error', text: status.message || TRAY_COPY.errorFallback,
      hint: status.hint || null, docUrl: status.docUrl || null,
    };
  }
  if (!status) return count > 0 ? null : { kind: 'unsynced', text: TRAY_COPY.unsynced };
  return count > 0 ? null : { kind: 'empty', text: TRAY_COPY.empty };
}

// The whole-tray view of the connection state, so the renderer can lead with
// ONE setup call to action instead of repeating the same sentence under three
// empty sections. `allCold` is about the three TASK sources only: the calendar
// has no tray section (it never becomes per-item notes), so a calendar-only
// setup still leaves the task tray with nothing to show and still earns the
// lead block.
function trayConnectionState(settings) {
  const configured = SYNCED_SOURCES.filter((k) => sourceConfigured(settings, k));
  return {
    configured,
    unconfigured: SYNCED_SOURCES.filter((k) => !sourceConfigured(settings, k)),
    calendar: sourceConfigured(settings, 'calendar'),
    allCold: configured.length === 0,
  };
}

/* ---- opening the board should reveal the tray ----------------------------
 *
 * ...but exactly once per session. A user who collapses the right sidebar or
 * closes the tray has said no, and re-revealing on every board open is
 * fighting them. Session-scoped rather than persisted on purpose: a wrongly
 * recorded "dismissed" that survives a restart is the worse failure, and
 * onClose also fires on plugin unload and workspace reload, so it cannot tell
 * a dismissal from a shutdown.
 *
 * 'already-visible' does NOT spend the one reveal: nothing was forced on
 * anyone, so a later collapse-then-reopen still gets its single nudge.
 */
function trayRevealDecision(state) {
  const s = state || {};
  if (s.autoRevealedThisSession) return 'none';
  if (!s.trayLeafExists) return 'create-and-reveal';
  if (s.rightSplitCollapsed) return 'reveal';
  return 'already-visible';
}

function trayRevealSpendsTurn(decision) {
  return decision === 'create-and-reveal' || decision === 'reveal';
}

// Section model for the AGENDA tab, board-parity by construction: events are
// the week's expanded set (icsEventsForWeek output), tasks the full item list.
// Banding mirrors the board exactly - `allDay || !half` goes to the top band
// (so continuation days of multi-day timed events land there too), timed
// events join tasks planned for today's half in ONE laneSequence per half.
// Done tasks stay in (struck at render, like the board); tasks without a
// planned half are skipped (the board skips them too). Events pass through
// by reference so the stale treatment and the detail modal see the real
// objects. No splitHour parameter: expanded events already carry their half.
// Routine instances (2026-09-04, routineOccurrences output for `today`) join
// the same sequence per half, so the AGENDA tab stays board-parity by
// construction as routines arrive.
function agendaSections(items, events, today, routineOccs) {
  const allDay = [];
  const evHalf = { am: [], pm: [] };
  for (const ev of events || []) {
    if (ev.day !== today) continue;
    if (ev.allDay || !ev.half) allDay.push(ev);
    else evHalf[ev.half === 'am' ? 'am' : 'pm'].push(ev);
  }
  const taskHalf = { am: [], pm: [] };
  for (const it of items || []) {
    if (it.plannedDay !== today || !it.plannedHalf) continue;
    taskHalf[it.plannedHalf].push(it);
  }
  const routineHalfOf = { am: [], pm: [] };
  for (const occ of routineOccs || []) {
    if (occ.day !== today) continue;
    routineHalfOf[occ.half === 'am' ? 'am' : 'pm'].push(occ);
  }
  return {
    day: today,
    allDay,
    am: laneSequence(evHalf.am, taskHalf.am, routineHalfOf.am),
    pm: laneSequence(evHalf.pm, taskHalf.pm, routineHalfOf.pm),
  };
}

class PlannerTrayView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.collapsed = {};
    this.composerOpen = false;
    this.composerDraft = '';
    this._composerWantsFocus = false;
    this.contextIsBoard = false;
    this.activeTab = trayDefaultTab(false);
    this.index = null;          // buildItemIndex, per render
    this.expanded = new Set();  // parent paths whose subtask list is open
  }

  getViewType() { return TRAY_VIEW_TYPE; }
  getDisplayText() { return 'Your Tasks'; }
  getIcon() { return 'check-square'; }

  async onOpen() {
    this.contentEl.addClass('iplan-tray-root');
    markInkPlugin(this.contentEl, this.plugin.manifest.id);

    // Whole-panel unassign drop target, wired ONCE on the persistent
    // contentEl (empty() clears children, not the element's own listeners -
    // wiring inside render() stacked a duplicate set per re-render). Guarded
    // to the SYNC tab: AGENDA and PINNED are read-plus-click surfaces.
    const el = this.contentEl;
    el.addEventListener('dragover', (e) => {
      if (this.activeTab !== 'sync') return;
      e.preventDefault();
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('is-drop-target');
      if (this.activeTab !== 'sync') return;
      e.preventDefault();
      const path = e.dataTransfer.getData('text/plain');
      if (path) this.plugin.unassignItem(path);
    });

    // Context default at open: read the most recent MAIN-AREA leaf (the
    // sidebar neighbors, this tray included, are not context).
    try {
      const ctx = typeof this.app.workspace.getMostRecentLeaf === 'function'
        ? this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
        : null;
      this.contextIsBoard = !!(ctx && ctx.view && typeof ctx.view.getViewType === 'function'
        && ctx.view.getViewType() === BOARD_VIEW_TYPE);
    } catch { this.contextIsBoard = false; }
    this.activeTab = trayDefaultTab(this.contextIsBoard);

    this.registerEvent(this.app.workspace.on('active-leaf-change',
      (leaf) => this.onActiveLeafChange(leaf)));
    this.render();
  }
  async onClose() { this.contentEl.empty(); }

  // The context default reasserts ONLY when the context flips between board
  // and non-board; a manual tab pick survives everything else. Sidebar leaves
  // (this tray itself, the file explorer, ...) never count as context, so
  // clicking into the tray does not flip tabs.
  onActiveLeafChange(leaf) {
    if (!leaf || !leaf.view || leaf.view === this) return;
    let root = null;
    try { root = typeof leaf.getRoot === 'function' ? leaf.getRoot() : null; } catch { root = null; }
    if (!root || root !== this.app.workspace.rootSplit) return;
    const isBoard = typeof leaf.view.getViewType === 'function'
      && leaf.view.getViewType() === BOARD_VIEW_TYPE;
    if (isBoard === this.contextIsBoard) return;
    this.contextIsBoard = isBoard;
    this.activeTab = trayDefaultTab(isBoard);
    this.render();
  }

  setTab(tab) {
    if (!trayVisibleTabs(this.contextIsBoard).includes(tab) || tab === this.activeTab) return;
    this.activeTab = tab;
    this.render();
  }

  render() {
    // Hard guard: 'sync' must never survive into a non-board render, even
    // through a path that skips onActiveLeafChange (e.g. a direct render()
    // after some other state change). Falls back to the context default.
    this.activeTab = trayEffectiveTab(this.contextIsBoard, this.activeTab);
    const el = this.contentEl;
    // empty() destroys the composer input. If it held the caret a moment ago -
    // a sync landing mid-typing is the common way in - hand the caret back
    // afterwards. This is restoring OUR OWN focus, never taking someone else's:
    // the flag is only set when the field we are about to destroy had it.
    try {
      const active = el.ownerDocument && el.ownerDocument.activeElement;
      if (active && el.contains(active) && active.classList.contains('iplan-add-input')) {
        this._composerWantsFocus = true;
      }
    } catch { /* no document in a headless context */ }
    el.empty();
    const today = todayStr();
    const items = collectItems(this.plugin.app, this.plugin.paths().root);
    this.index = buildItemIndex(items);

    const head = el.createDiv({ cls: 'iplan-tray-head' });
    const kicker = head.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' YOUR TASKS ' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ` ${trayTabLabel(this.activeTab)}` });
    // The sync button stays visible on every tab: it syncs everything.
    const syncBtn = head.createEl('button', { cls: 'iplan-nav-btn iplan-sync-btn', attr: { 'aria-label': 'Sync now' } });
    setIcon(syncBtn, 'refresh-cw');
    if (this.plugin.syncing) syncBtn.addClass('is-syncing');
    syncBtn.addEventListener('click', () => this.plugin.syncNow(true));

    // Tab strip: same visual family as the board's WEEK | DAY switch. Four
    // labels do not fit a 250px sidebar, so HABITS carries a glyph as well
    // and the stylesheet shows the glyph alone below 300px of tray width;
    // the spoken name is the aria-label either way.
    const tabsRow = el.createDiv({ cls: 'iplan-tray-tabs' });
    const seg = tabsRow.createDiv({ cls: 'iplan-seg', attr: { role: 'tablist', 'aria-label': 'Tray panel' } });
    for (const tab of trayVisibleTabs(this.contextIsBoard)) {
      const b = seg.createEl('button', {
        cls: 'iplan-seg-btn',
        attr: { role: 'tab', 'aria-selected': String(this.activeTab === tab), 'aria-label': trayTabName(tab) },
      });
      if (tab === 'habits') {
        b.addClass('is-collapsible');
        const glyph = b.createSpan({ cls: 'iplan-tab-icon', attr: { 'aria-hidden': 'true' } });
        setIcon(glyph, 'calendar-check');
      }
      b.createSpan({ cls: 'iplan-tab-text', text: trayTabLabel(tab) });
      if (this.activeTab === tab) b.addClass('is-active');
      b.addEventListener('click', () => this.setTab(tab));
    }

    if (this.activeTab === 'agenda') this.renderAgenda(el, items, today);
    else if (this.activeTab === 'goals') this.renderGoals(el, items);
    else if (this.activeTab === 'habits') this.renderHabits(el);
    else this.renderSync(el, items, today);
    // A control in a habit row writes the note, the note re-renders the
    // tray, and the control that had the keyboard is gone with the old DOM.
    // Hand the caret back to its successor: our own focus, never someone
    // else's. `selector` names the control inside the row.
    if (this._habitFocus) {
      const { path, selector } = this._habitFocus;
      this._habitFocus = null;
      const again = selector ? el.querySelector(`.iplan-habit-row[data-path="${CSS.escape(path)}"] ${selector}`) : null;
      if (again) again.focus();
    }
  }

  /* ---- HABITS (0.10.0): the planner's habits, managed in place ----------- */
  renderHabits(el) {
    const s = this.plugin.settings;
    const all = (this.plugin.habits || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const live = all.filter((h) => h.status !== 'archived');
    const archived = all.filter((h) => h.status === 'archived');
    const candidates = s.habitsEnabled === false ? [] : this.plugin.importCandidates();
    const sec = el.createDiv({ cls: 'iplan-tray-section' });
    const head = sec.createDiv({ cls: 'iplan-tray-section-head' });
    head.createSpan({ text: 'HABITS' });
    const tools = head.createDiv({ cls: 'iplan-habits-tools' });
    const newBtn = tools.createEl('button', { cls: 'iplan-action is-quiet', attr: { type: 'button', 'aria-label': 'New habit' } });
    newBtn.createSpan({ cls: 'iplan-kicker-marker', text: '+' });
    newBtn.createSpan({ text: 'NEW' });
    newBtn.addEventListener('click', () => this.plugin.openNewHabit());
    // The import button exists only while there is something to import.
    if (candidates.length) {
      const importBtn = tools.createEl('button', {
        cls: 'iplan-action is-quiet', text: 'IMPORT FROM MY LIFE',
        attr: { type: 'button', 'aria-label': `Import from My Life, ${candidates.length} habit note${candidates.length === 1 ? '' : 's'}` },
      });
      importBtn.addEventListener('click', () => this.plugin.openImportHabits(candidates));
    }
    const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
    if (s.habitsEnabled === false) {
      body.createDiv({ cls: 'iplan-tray-note', text: 'Habits are off in settings.' });
      return;
    }
    if (!live.length) {
      body.createDiv({ cls: 'iplan-tray-note', text: candidates.length ? 'No habits yet. Create one, or import from My Life.' : 'No habits yet. Create one.' });
    }
    for (const h of live) body.appendChild(this.renderHabitRow(h));
    // Archived habits sit in a collapsed section at the bottom, each with
    // the same menu (Restore in place of Pause and Archive).
    if (archived.length) {
      const asec = el.createDiv({ cls: `iplan-tray-section iplan-habits-archived${this._archivedOpen ? '' : ' is-collapsed'}` });
      const ahead = asec.createEl('button', {
        cls: 'iplan-habits-archived-head',
        attr: { type: 'button', 'aria-expanded': this._archivedOpen ? 'true' : 'false' },
      });
      ahead.createSpan({ text: 'ARCHIVED' });
      ahead.createSpan({ cls: 'iplan-tray-count', text: String(archived.length) });
      ahead.addEventListener('click', () => {
        this._archivedOpen = !this._archivedOpen;
        asec.classList.toggle('is-collapsed', !this._archivedOpen);
        ahead.setAttribute('aria-expanded', this._archivedOpen ? 'true' : 'false');
      });
      const abody = asec.createDiv({ cls: 'iplan-tray-section-body' });
      for (const h of archived) abody.appendChild(this.renderHabitRow(h));
    }
    const foot = el.createDiv({ cls: 'iplan-tray-foot' });
    foot.createSpan({ text: `EVERY CHANGE HERE WRITES THE HABIT NOTE UNDER ${this.plugin.habitsFolder().toUpperCase()}/. A CHECK-IN IS A ROW IN ITS LOG.` });
  }

  // One row: the name (a button that opens the note), the status chip, the
  // menu button; then the cadence field and, beside it, the weekday toggles
  // (live for weekly, the implied days inert for daily and weekdays) or the
  // day-of-month field (monthly). Right-click and long-press open the same
  // menu as the button.
  renderHabitRow(h) {
    const m = habitRowModel(h);
    const row = document.createElement('div');
    row.className = `iplan-habit-row${m.quiet ? ' is-quiet' : ''}`;
    row.setAttribute('data-path', h.path);
    const top = row.createDiv({ cls: 'iplan-habit-row-head' });
    const name = top.createEl('button', {
      cls: 'iplan-habit-name', text: h.name,
      attr: { type: 'button', 'aria-label': `Open ${h.name}` },
    });
    name.addEventListener('click', () => this.openHabitNote(h.path));
    top.createSpan({ cls: 'iplan-chip', text: m.statusLabel });
    if (h.linkedBasename) top.createSpan({ cls: 'iplan-chip', text: 'LINKED', attr: { title: `Linked to ${h.linkedBasename}` } });
    const menuBtn = top.createEl('button', {
      cls: 'iplan-nav-btn iplan-habit-menu-btn',
      attr: { type: 'button', 'aria-label': `Menu for ${h.name}`, 'aria-haspopup': 'menu' },
    });
    setIcon(menuBtn, 'more-horizontal');
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = menuBtn.getBoundingClientRect();
      this.habitMenu(h, row).showAtPosition({ x: r.left, y: r.bottom });
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.habitMenu(h, row).showAtPosition({ x: e.clientX, y: e.clientY });
    });
    wireLongPress(row, (pos) => this.habitMenu(h, row).showAtPosition(pos));
    const sched = row.createDiv({ cls: 'iplan-habit-sched' });
    const select = sched.createEl('select', { cls: 'iplan-habit-select', attr: { 'aria-label': `Cadence for ${h.name}` } });
    for (const c of HABIT_CADENCES) select.createEl('option', { value: c, text: HABIT_CADENCE_NAMES[c] });
    select.value = h.cadence;
    select.addEventListener('change', () => {
      this._habitFocus = { path: h.path, selector: 'select.iplan-habit-select' };
      this.habitWrite(() => this.plugin.setHabitCadence(h.path, select.value));
    });
    if (m.monthDayField) {
      const wrap = sched.createDiv({ cls: 'iplan-habit-monthday' });
      wrap.createSpan({ cls: 'iplan-habit-monthday-label', text: 'DAY', attr: { 'aria-hidden': 'true' } });
      // No month_day in the note: the field is empty (the board reads
      // the 1st) with the 1st as its placeholder, so the person sees a
      // day to set rather than one the note never carried.
      const input = wrap.createEl('input', {
        cls: 'iplan-habit-monthday-input',
        attr: { type: 'number', min: '1', max: String(HABIT_MONTH_DAY_MAX), inputmode: 'numeric', placeholder: '1', 'aria-label': `Day of the month for ${h.name}` },
      });
      const shown = m.monthDay === null ? '' : String(m.monthDay);
      input.value = shown;
      input.addEventListener('change', () => {
        const n = monthDayOf(input.value);
        if (n === null) { input.value = shown; return; }
        input.value = String(n);
        this._habitFocus = { path: h.path, selector: 'input.iplan-habit-monthday-input' };
        this.habitWrite(() => this.plugin.setHabitMonthDay(h.path, n));
      });
    } else {
      // The row paints from its own copy so a toggle shows at once; the
      // note's re-render brings the truth a moment later.
      let current = m.weekdays;
      weekdayToggleRow(sched, () => current, async (codes) => {
        current = codes;
        const active = row.ownerDocument && row.ownerDocument.activeElement;
        const day = active && active.dataset ? active.dataset.day : null;
        this._habitFocus = { path: h.path, selector: day ? `[data-day="${day}"]` : null };
        await this.plugin.setHabitDays(h.path, codes);
      }, `Weekdays for ${h.name}`, { disabled: !m.weekdaysEditable });
    }
    return row;
  }

  // A write from a row control: the failure, if any, is said in a Notice
  // (the row itself re-renders from the note either way).
  habitWrite(fn) {
    Promise.resolve().then(fn).catch((e) => { new Notice(`Planner: ${(e && e.message) || e}`); this.render(); });
  }
  openHabitNote(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
  }
  openLinkedNote(h) {
    if (!h.linkedTarget) return;
    // The whole target, never the basename: the My Life note and this one
    // share a name, and a bare link resolves to the nearer of the two,
    // which is this note itself.
    const file = linkedFileOf(this.app, h.linkedTarget, h.path);
    if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
    else new Notice(`Planner: no note called "${h.linkedBasename}" in this vault.`);
  }
  // The row menu. Delete is two presses: the item arms a confirm strip in
  // the row, its button deletes. No browser dialog.
  habitMenu(h, row) {
    const menu = new Menu();
    menu.addItem((mi) => mi.setTitle('Rename').setIcon('pencil').onClick(() => new RenameHabitModal(this.app, this.plugin, h).open()));
    if (h.status === 'archived') {
      menu.addItem((mi) => mi.setTitle('Restore').setIcon('archive-restore').onClick(() => this.habitWrite(() => this.plugin.setHabitStatus(h.path, 'active'))));
    } else {
      const paused = h.status === 'paused';
      menu.addItem((mi) => mi.setTitle(paused ? 'Resume' : 'Pause').setIcon(paused ? 'play' : 'pause')
        .onClick(() => this.habitWrite(() => this.plugin.setHabitStatus(h.path, paused ? 'active' : 'paused'))));
      menu.addItem((mi) => mi.setTitle('Archive').setIcon('archive').onClick(() => this.habitWrite(() => this.plugin.setHabitStatus(h.path, 'archived'))));
    }
    menu.addItem((mi) => mi.setTitle('Open habit note').setIcon('file-text').onClick(() => this.openHabitNote(h.path)));
    if (h.linkedBasename) menu.addItem((mi) => mi.setTitle('Open linked note').setIcon('link').onClick(() => this.openLinkedNote(h)));
    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle('Delete').setIcon('trash').onClick(() => this.armHabitDelete(h, row)));
    return menu;
  }
  armHabitDelete(h, row) {
    const old = row.querySelector('.iplan-habit-confirm');
    if (old) old.remove();
    const strip = row.createDiv({ cls: 'iplan-habit-confirm', attr: { role: 'group', 'aria-label': `Delete ${h.name}` } });
    const say = strip.createSpan({ cls: 'iplan-habit-confirm-text', attr: { 'aria-live': 'polite' } });
    say.setText(`Delete "${h.name}"? The note moves to the trash.`);
    const yes = strip.createEl('button', { cls: 'iplan-action', text: 'DELETE', attr: { type: 'button', 'aria-label': `Confirm: delete ${h.name}` } });
    const no = strip.createEl('button', { cls: 'iplan-action is-quiet', text: 'CANCEL', attr: { type: 'button', 'aria-label': 'Cancel the delete' } });
    // The arm drops after a few seconds, like the calendar remove.
    let timer = window.setTimeout(() => strip.remove(), 8000);
    no.addEventListener('click', () => { window.clearTimeout(timer); strip.remove(); });
    yes.addEventListener('click', async () => {
      window.clearTimeout(timer);
      yes.disabled = true;
      try {
        await this.plugin.deleteHabit(h.path);
        new Notice(`Planner: moved "${h.name}" to the trash.`);
      } catch (e) {
        say.setText(`Could not delete: ${(e && e.message) || e}`);
        yes.disabled = false;
      }
    });
    yes.focus();
  }

  /* ---- AGENDA: today's plan, chronological, read-plus-click ---- */
  renderAgenda(el, items, today) {
    const events = this.plugin.calendarDefs
      ? icsEventsForWeek(this.plugin.calendarDefs, mondayOf(today), this.plugin.splitHour())
      : [];
    const model = agendaSections(items, events, today, this.plugin.routinesFor(today));

    const dayHead = el.createDiv({ cls: 'iplan-tray-agenda-head' });
    dayHead.createSpan({ cls: 'iplan-tray-agenda-title', text: fmtDayTitle(today, today) });
    dayHead.createSpan({ cls: 'iplan-week-label', text: fmtDayLabel(today) });

    if (model.allDay.length) {
      const band = el.createDiv({ cls: 'iplan-tray-allday' });
      for (const ev of model.allDay) {
        const chip = band.createDiv({ cls: 'iplan-event iplan-event-allday' });
        if (ev.continues) chip.addClass('is-continues');
        chip.createSpan({ cls: 'iplan-event-title', text: ev.title });
        wireEventChip(this.plugin, chip, ev);
      }
    }

    for (const half of ['am', 'pm']) {
      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      sec.createDiv({ cls: 'iplan-tray-section-head', text: half === 'am' ? 'MORNING' : 'AFTERNOON' });
      const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
      const seq = model[half];
      if (!seq.length) {
        body.createDiv({ cls: 'iplan-tray-note', text: 'Nothing planned.' });
        continue;
      }
      for (const entry of seq) {
        if (entry.kind === 'event') {
          const chip = body.createDiv({ cls: 'iplan-event' });
          chip.createSpan({ cls: 'iplan-event-time', text: fmtTimeHM(entry.ev.start) });
          chip.createSpan({ cls: 'iplan-event-title', text: entry.ev.title });
          wireEventChip(this.plugin, chip, entry.ev);
        } else if (entry.kind === 'routine') {
          body.appendChild(renderRoutineCard(this.plugin, entry.occ, this));
        } else {
          body.appendChild(renderCard(this.plugin, entry.it, 'tray', this));
        }
      }
    }
    // Habits (2026-09-04): today's block, under AFTERNOON, as on the board.
    const habitOccs = this.plugin.habitsFor(today, today);
    if (habitOccs.length) {
      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      sec.appendChild(renderHabitsBlock(this.plugin, habitOccs, today, today, this));
    }
  }

  /* ---- PINNED: only the tasks pinned to this week ---- */
  renderGoals(el, items) {
    const goals = items.filter((i) => i.weeklyGoal && !isDone(i));
    const sec = el.createDiv({ cls: 'iplan-tray-section' });
    sec.createDiv({ cls: 'iplan-tray-section-head', text: PINNED_SECTION_HEAD });
    const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
    if (!goals.length) {
      body.createDiv({ cls: 'iplan-tray-note', text: 'Nothing pinned to this week yet. Pin one from a card’s menu.' });
    }
    for (const g of goals) body.appendChild(renderCard(this.plugin, g, 'tray', this));
  }

  /* ---- the add-a-task composer (2026-08-30) ---------------------------------
   *
   * Chrome: the first element below the tab strip, and its position never
   * moves. Clicking the trigger replaces the trigger row with the input row IN
   * PLACE, so nothing jumps and no new region opens. Escape restores the
   * trigger. Enter commits and keeps the field open for the next one; Enter on
   * an empty field does nothing and stays open (no error state, no red).
   * Commit feedback is the row appearing in MANUAL, nothing more.
   */
  openComposer() {
    this.composerOpen = true;
    this._composerWantsFocus = true;
    this.render();
  }

  closeComposer() {
    this.composerOpen = false;
    this.composerDraft = '';
    this._composerWantsFocus = false;
    this.render();
  }

  async commitComposer(value) {
    const path = await this.plugin.addManualItem(value);
    if (!path) return false;
    this.composerDraft = '';
    // Keep the field open and focused for a second entry: capture is a burst
    // activity, and reopening the trigger between two tasks costs a click each
    // time. emitModelChanged re-renders us, so the flag is what survives.
    this._composerWantsFocus = true;
    return true;
  }

  renderComposer(el) {
    const wrap = el.createDiv({ cls: 'iplan-tray-add' });
    if (!this.composerOpen) {
      const btn = wrap.createEl('button', {
        cls: 'iplan-action is-quiet',
        attr: { type: 'button', 'aria-label': 'Add a task' },
      });
      btn.createSpan({ cls: 'iplan-kicker-marker', text: '+' });
      btn.createSpan({ text: 'ADD TASK' });
      btn.addEventListener('click', () => this.openComposer());
      return;
    }
    const input = wrap.createEl('input', {
      cls: 'iplan-add-input',
      attr: {
        type: 'text', placeholder: 'What needs doing?',
        'aria-label': 'New task title', enterkeyhint: 'done',
        autocomplete: 'off', spellcheck: 'false',
      },
    });
    input.value = this.composerDraft || '';
    input.addEventListener('input', () => { this.composerDraft = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeComposer(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;              // nothing to say, nothing to complain about
      input.value = '';
      this.composerDraft = '';
      this.commitComposer(value);
    });
    // Blur closes an EMPTY field so the trigger comes back; a field with a
    // draft in it stays, because losing typed text to a stray click is worse
    // than an input that outstays its welcome.
    //
    // Deferred, and that is not cosmetic: blur fires BEFORE click, and
    // closeComposer re-renders the whole tray. Closing synchronously would
    // destroy the card the user just pressed on before its click handler ever
    // ran, so clicking a card while the composer was open would do nothing.
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (this.composerOpen && !(this.composerDraft || '').trim()
          && document.activeElement !== input) this.closeComposer();
      }, 120);
    });
    // Focus only when WE opened it. A re-render triggered by a sync landing
    // must never yank the caret out of whatever the user is typing in.
    if (this._composerWantsFocus) {
      this._composerWantsFocus = false;
      input.focus();
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch { /* not all inputs support it */ }
    }
  }

  /* ---- SYNC: the classic tray (goals pinned + unscheduled by source) ---- */
  renderSync(el, items, today) {
    const resolved = this.plugin.withSecrets();
    const conn = trayConnectionState(resolved);

    // 1. The composer. Chrome, first, always, in every connection state.
    this.renderComposer(el);

    // 2. Nothing connected: ONE call to action, in place of the same sentence
    //    repeated under three section heads. The three heads do not render at
    //    all here: a head carrying a count of nothing, in a state where nothing
    //    can arrive, is three zero-count facts. It sits directly under the
    //    composer because the sentence points at it.
    if (conn.allCold) {
      const lead = el.createDiv({ cls: 'iplan-tray-lead' });
      lead.createDiv({ cls: 'iplan-tray-lead-text', text: TRAY_COPY.lead });
      const cta = lead.createEl('button', {
        cls: 'iplan-action', attr: { type: 'button' }, text: TRAY_COPY.leadAction,
      });
      cta.addEventListener('click', () => this.plugin.openPluginSettings());
    }

    /* ---- the week's pinned tasks, on top of the lists ---- */
    const goals = items.filter((i) => i.weeklyGoal && !isDone(i));
    if (goals.length) {
      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      sec.createDiv({ cls: 'iplan-tray-section-head', text: PINNED_SECTION_HEAD });
      for (const g of goals) sec.appendChild(renderCard(this.plugin, g, 'tray', this));
    }

    /* ---- unscheduled, by source ---- */
    const bucketRank = { overdue: 0, today: 1, upcoming: 2, none: 3 };
    const anyManualEver = items.some((i) => i.source === MANUAL_SOURCE);
    for (const key of TASK_SOURCES) {
      // MANUAL is dropped until a manual task has existed: an empty section
      // under a labelled ADD TASK row says nothing the user cannot already see.
      if (key === MANUAL_SOURCE && !anyManualEver) continue;
      // In the all-cold state the synced heads are replaced by the lead block.
      if (key !== MANUAL_SOURCE && conn.allCold) continue;

      const meta = SOURCES[key];
      const configured = sourceConfigured(resolved, key);
      const st = this.plugin.syncStatus[key];
      const list = items
        .filter((i) => i.source === key && !i.plannedDay && !isDone(i) && !i.weeklyGoal)
        .sort((a, b) => {
          const br = bucketRank[dueBucketOf(a.due, today)] - bucketRank[dueBucketOf(b.due, today)];
          if (br) return br;
          if (a.priority !== b.priority) return a.priority - b.priority;
          return (a.due || '9999').localeCompare(b.due || '9999');
        });

      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      const headRow = sec.createDiv({ cls: 'iplan-tray-section-head is-clickable' });
      headRow.appendChild(sourceMarkEl(key));
      headRow.createSpan({ text: ` ${meta.label.toUpperCase()}` });
      headRow.createSpan({ cls: 'iplan-tray-count', text: String(list.length) });
      const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
      if (this.collapsed[key]) sec.addClass('is-collapsed');
      headRow.addEventListener('click', () => {
        this.collapsed[key] = !this.collapsed[key];
        sec.classList.toggle('is-collapsed', this.collapsed[key]);
      });

      // The one authority on what this section is allowed to claim.
      const total = key === MANUAL_SOURCE
        ? items.filter((i) => i.source === MANUAL_SOURCE).length
        : undefined;
      const state = trayEmptyState(key, configured, st, list.length, total, resolved.secretsInStore === true);
      if (state && (state.kind === 'unconfigured' || state.kind === 'unconfigured-device')) {
        const note = body.createDiv({ cls: 'iplan-tray-note is-unconfigured' });
        note.createSpan({ text: state.text });
        const connect = note.createEl('button', {
          cls: 'iplan-action',
          attr: { type: 'button', 'aria-label': `Connect ${meta.label}` },
          text: state.kind === 'unconfigured-device' ? TRAY_COPY.connectDeviceAction : TRAY_COPY.connectAction,
        });
        connect.addEventListener('click', () => this.plugin.openPluginSettings());
      } else if (state) {
        const note = body.createDiv({ cls: 'iplan-tray-note', text: state.text });
        if (state.hint) {
          const hintEl = note.createDiv({ cls: 'iplan-tray-note-hint', text: state.hint });
          if (state.docUrl) {
            hintEl.appendText(' ');
            const a = hintEl.createEl('a', { text: 'Open', href: state.docUrl });
            a.addEventListener('click', (e) => { e.preventDefault(); window.open(state.docUrl, '_external'); });
          }
        }
      }
      for (const it of list) body.appendChild(renderCard(this.plugin, it, 'tray', this));
    }

    const foot = el.createDiv({ cls: 'iplan-tray-foot' });
    foot.createSpan({ text: 'DRAG A CARD ONTO THE WEEK. DROP IT BACK HERE TO UNSCHEDULE.' });
  }
}

/* ========================================================================== *
 * Link a note - the one editor for an item's plan-owned `linked_note`
 *
 * A field, a Clear and a Save, in the shape RenameHabitModal already has. No
 * note picker: the value is a wikilink the vault resolves the way it resolves
 * every other one, and a name that matches nothing yet is a legitimate thing
 * to write (the note may be made next). "Open" on the card menu is where an
 * unresolvable name is noticed, and it says so there.
 * ========================================================================== */

class LinkNoteModal extends Modal {
  constructor(app, plugin, item, onDone) {
    super(app);
    this.plugin = plugin;
    this.item = item;
    this.onDone = typeof onDone === 'function' ? onDone : null;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('iplan-habit-modal');
    contentEl.addClass('iplan-settings');
    markInkPlugin(contentEl, this.plugin.manifest.id);
    // The field starts from the whole stored target, folders and all: a
    // person who typed a path to disambiguate must not lose it by opening
    // the editor and pressing Save.
    const state = { name: this.item.linkedNoteTarget || '' };
    let input = null;
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' LINK A NOTE' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: this.item.title });
    new Setting(contentEl)
      .setName('Linked note')
      .setDesc('The note this task is for, usually a project or a key element. A name or a [[wikilink]]. Sync never changes it.')
      .addText((t) => {
        input = t.inputEl;
        t.setValue(state.name).onChange((v) => { state.name = v; });
        t.inputEl.setAttribute('aria-label', 'Linked note');
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          this.submit(state.name);
        });
      });
    const error = contentEl.createDiv({ cls: 'iplan-routine-modal-error', attr: { 'aria-live': 'polite' } });
    this.errorEl = error;
    const actions = new Setting(contentEl);
    actions.addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
    actions.addButton((b) => b.setButtonText('Clear').onClick(() => this.submit('')));
    actions.addButton((b) => b.setButtonText('Save').setCta().onClick(() => this.submit(state.name)));
    if (input) window.setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  async submit(raw) {
    try {
      await this.plugin.setItemLinkedNote(this.item.path, raw);
      this.close();
      if (this.onDone) this.onDone();
    } catch (e) {
      if (this.errorEl) this.errorEl.setText(`Could not save: ${(e && e.message) || e}`);
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ========================================================================== *
 * Week view - the weekly priorities and the daily highlights of one ISO week
 *
 * Read and edit, nothing else. Two blocks, in the order the note carries
 * them: the priorities as a checklist whose boxes write the note, and the
 * seven days as rows with today's editable. A day that is not today shows
 * what it says and takes no input, which is the concept's own rule: the
 * highlight is chosen in the morning and confirmed in the evening, of the day
 * it belongs to. Yesterday is history, not a form.
 *
 * The note is created on the first write, never on opening the tab: a week
 * nobody planned should leave no file behind.
 * ========================================================================== */

class PlannerWeekView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.week = isoWeekOf(todayStr());
    this.model = null;
    this.adding = false;
    this.draft = '';
    this.highlightDraft = null;
  }

  getViewType() { return WEEK_VIEW_TYPE; }
  getDisplayText() { return 'Planner week'; }
  getIcon() { return 'list-checks'; }

  getState() { return { week: this.week }; }
  async setState(state, result) {
    if (state && WEEK_ISO_RE.test(String(state.week || ''))) {
      this.week = state.week;
      await this.refresh();
    }
    return super.setState(state, result);
  }

  async onOpen() {
    this.contentEl.addClass('iplan-week-root');
    markInkPlugin(this.contentEl, this.plugin.manifest.id);
    await this.refresh();
  }

  async onClose() { this.contentEl.empty(); }

  async refresh() {
    try {
      this.model = await this.plugin.readWeek(this.week);
    } catch {
      this.model = null;
    }
    this.render();
  }

  setWeek(iso) {
    if (!iso) return;
    this.week = iso;
    this.highlightDraft = null;
    this.adding = false;
    void this.refresh();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const today = todayStr();
    const days = isoWeekDays(this.week);
    const monday = days.length ? days[0] : null;

    /* ---- masthead ---- */
    const head = el.createDiv({ cls: 'iplan-masthead' });
    const kicker = head.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' ICOR PLANNER' });
    const titleRow = head.createDiv({ cls: 'iplan-title-row' });
    titleRow.createEl('h1', {
      cls: 'iplan-title',
      text: this.week === isoWeekOf(today) ? 'This Week.' : 'The Week.',
    });
    const nav = titleRow.createDiv({ cls: 'iplan-nav' });
    const mkNavBtn = (icon, label, fn) => {
      const b = nav.createEl('button', { cls: 'iplan-nav-btn', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
    };
    mkNavBtn('chevron-left', 'Previous week', () => this.setWeek(isoWeekOf(addDays(monday || today, -7))));
    const todayBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-nav-today', text: 'TODAY' });
    todayBtn.addEventListener('click', () => this.setWeek(isoWeekOf(today)));
    mkNavBtn('chevron-right', 'Next week', () => this.setWeek(isoWeekOf(addDays(monday || today, 7))));
    nav.createSpan({ cls: 'iplan-week-label', text: this.week });

    this.renderPriorities(el);
    this.renderHighlights(el, days, today);
  }

  /* ---- the weekly priorities ---- */
  renderPriorities(el) {
    const sec = el.createDiv({ cls: 'iplan-week-section' });
    const headRow = sec.createDiv({ cls: 'iplan-tray-section-head' });
    headRow.setText('WEEKLY PRIORITIES');
    const items = this.model ? this.model.priorities : [];
    sec.createDiv({
      cls: 'iplan-week-progress',
      text: this.model ? weekPriorityProgress(this.model) : 'No priorities yet.',
    });
    const body = sec.createDiv({ cls: 'iplan-week-list' });
    for (const row of items) {
      const line = body.createDiv({ cls: 'iplan-week-row' });
      const box = line.createEl('input', { attr: { type: 'checkbox' } });
      box.checked = row.done;
      box.setAttribute('aria-label', row.text);
      box.addEventListener('change', () => {
        // Optimistic, then corrected by the re-read: a refused write flips
        // the box back rather than leaving the eye and the file disagreeing.
        box.disabled = true;
        void this.plugin.togglePriority(this.week, row.index)
          .catch(() => { box.checked = row.done; })
          .finally(() => { box.disabled = false; });
      });
      const label = line.createSpan({ cls: 'iplan-week-row-label', text: row.text });
      if (row.done) label.addClass('is-done');
    }
    if (!items.length) {
      body.createDiv({ cls: 'iplan-tray-note', text: 'What would make this week a good one? Add up to five.' });
    }
    this.renderAddPriority(sec);
  }

  renderAddPriority(sec) {
    const wrap = sec.createDiv({ cls: 'iplan-tray-add' });
    if (!this.adding) {
      const btn = wrap.createEl('button', {
        cls: 'iplan-action is-quiet', attr: { type: 'button', 'aria-label': 'Add a priority' },
      });
      btn.createSpan({ cls: 'iplan-kicker-marker', text: '+' });
      btn.createSpan({ text: 'ADD PRIORITY' });
      btn.addEventListener('click', () => { this.adding = true; this.render(); });
      return;
    }
    const input = wrap.createEl('input', {
      cls: 'iplan-tray-add-input',
      attr: { type: 'text', placeholder: 'One outcome for this week', 'aria-label': 'New weekly priority' },
    });
    input.value = this.draft;
    input.addEventListener('input', () => { this.draft = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.adding = false; this.draft = ''; this.render(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;
      input.value = '';
      this.draft = '';
      void this.plugin.addPriority(this.week, value);
    });
    window.setTimeout(() => input.focus(), 0);
  }

  /* ---- the daily highlights ---- */
  renderHighlights(el, days, today) {
    const sec = el.createDiv({ cls: 'iplan-week-section' });
    sec.createDiv({ cls: 'iplan-tray-section-head', text: 'DAILY HIGHLIGHTS' });
    const rows = new Map();
    for (const h of (this.model ? this.model.highlights : [])) rows.set(h.date, h);
    const body = sec.createDiv({ cls: 'iplan-week-list' });
    for (const day of days) {
      const row = rows.get(day) || { date: day, text: '', done: '' };
      const line = body.createDiv({ cls: 'iplan-week-row' });
      if (day === today) line.addClass('is-today');
      line.createSpan({ cls: 'iplan-week-day', text: fmtDayLabel(day) });
      if (day === today) this.renderTodayHighlight(line, row);
      else this.renderPastHighlight(line, row);
    }
  }

  renderPastHighlight(line, row) {
    const label = line.createSpan({
      cls: 'iplan-week-row-label',
      text: row.text || 'Nothing recorded.',
    });
    if (!row.text) label.addClass('is-empty');
    const state = markerState(row.done);
    if (row.text) line.createSpan({ cls: `iplan-chip iplan-week-${state}`, text: state.toUpperCase() });
  }

  renderTodayHighlight(line, row) {
    const input = line.createEl('input', {
      cls: 'iplan-tray-add-input',
      attr: {
        type: 'text',
        placeholder: 'The one thing that makes today a win',
        'aria-label': "Today's highlight",
      },
    });
    input.value = this.highlightDraft == null ? row.text : this.highlightDraft;
    input.addEventListener('input', () => { this.highlightDraft = input.value; });
    const commit = () => {
      const value = input.value.trim();
      if (value === row.text) { this.highlightDraft = null; return; }
      this.highlightDraft = null;
      void this.plugin.setHighlight(this.week, row.date, value);
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.highlightDraft = null; this.render(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit();
    });
    const state = markerState(row.done);
    const mark = (marker, label) => {
      const b = line.createEl('button', { cls: 'iplan-seg-btn', text: label, attr: { type: 'button' } });
      if (markerState(marker) === state) b.addClass('is-active');
      b.setAttribute('aria-pressed', markerState(marker) === state ? 'true' : 'false');
      b.addEventListener('click', () => {
        this.highlightDraft = null;
        void this.plugin.markHighlight(this.week, row.date, marker);
      });
    };
    mark('Y', 'DONE');
    mark('N', 'NOT DONE');
    mark('_', 'PENDING');
  }
}

/* ========================================================================== *
 * Settings
 * ========================================================================== */

class IcorPlannerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    // The token aliases (styles.css) reach the tab through this class, so
    // the segmented controls and the calendar swatches resolve what they name.
    containerEl.addClass('iplan-settings');

    const secret = (setting, get, set, placeholder, label) => {
      setting.addText((t) => {
        t.setPlaceholder(placeholder || '').setValue(get());
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'off';
        if (label) t.inputEl.setAttribute('aria-label', label);
        t.onChange(async (v) => {
          set(v.trim());
          await this.plugin.saveSettings();
          // In env-file mode the save moves the key into the file; when
          // that write failed the key stayed in data.json, and the member
          // is told once per failure, with the Env file line refreshed.
          const err = this.plugin.secrets.mode === 'env-file' ? this.plugin.envStore.error : '';
          if (err && err !== this._envWriteWarned) new Notice('Planner: the env file could not be written; the key stays in data.json until it can. See the Env file line in settings.', 8000);
          this._envWriteWarned = err;
          if (this.plugin.secrets.mode === 'env-file') renderEnvStatus();
        });
      });
    };

    // Where the secrets are: the backend, the env file, then one status row
    // per key with a Move button when a value sits in the other backend
    // (0.12.0). All of it before the first field that takes a secret.
    const secrets = this.plugin.secrets;
    const storedIn = ` Stored in ${secretsBackendLabel(secrets.backend)}.`;
    new Setting(containerEl).setName('Secrets').setHeading();
    const whereSetting = new Setting(containerEl)
      .setName('Where they live')
      .setDesc(secretsNoteText(secrets.mode, this.plugin.settings.secretsInStore === true, this.plugin.settings.envFilePath))
      .setClass('iplan-settings-secrets');
    whereSetting.addDropdown((d) => {
      const hasStore = !!this.plugin.secretStorage;
      d.addOption('secret-storage', hasStore ? 'Obsidian\'s keychain' : 'Obsidian\'s keychain (needs Obsidian 1.11.4 or newer)');
      d.addOption('env-file', 'An env file in the vault');
      if (!hasStore) {
        // No store to choose: the option stays visible, so the member sees
        // what a newer Obsidian would offer, and cannot be picked.
        const opt = d.selectEl.querySelector('option[value="secret-storage"]');
        if (opt) opt.disabled = true;
      }
      d.setValue(normalizeSecretsBackend(this.plugin.settings.secretsBackend));
      d.selectEl.setAttribute('aria-label', 'Where the secrets live');
      d.onChange(async (v) => { await this.plugin.setSecretsBackend(v); this.display(); });
    });
    const envSetting = new Setting(containerEl)
      .setName('Env file')
      .setDesc('Checking the file.');
    envSetting.descEl.setAttribute('aria-live', 'polite');
    const renderEnvStatus = () => {
      const store = this.plugin.envStore;
      envSetting.descEl.toggleClass('is-failed', !!store.error);
      const lead = 'A path inside the vault, one KEY=value line per secret; every other line is left as it is. Read only while the env file is selected above.';
      if (store.error) envSetting.setDesc(`${lead} Could not read ${store.path}: ${store.error}`);
      else if (store.exists) envSetting.setDesc(`${lead} Found: ${store.path}.`);
      else envSetting.setDesc(`${lead} Not found: ${store.path}. It is created on the first save.`);
    };
    const keysEl = containerEl.createDiv({ cls: 'iplan-settings-keys' });
    const renderKeys = () => {
      keysEl.empty();
      const holders = this.plugin.secretHolders();
      const selected = this.plugin.secrets.backend;
      const canMove = selected !== 'data-json' && !!holders[selected];
      const movable = [];
      for (const slot of secretSlots(this.plugin.settings)) {
        const present = secretPresence(slot.id, holders);
        const row = new Setting(keysEl).setName(slot.label).setDesc(`${secretStatusText(present, selected)} Env key: ${slot.envKey}.`);
        const from = present.find((b) => b !== selected);
        if (!from || !canMove) continue;
        movable.push({ slot, from });
        row.addButton((b) => b.setButtonText(`Move to ${secretsBackendLabel(selected)}`).onClick(async () => {
          b.setDisabled(true);
          const n = await this.plugin.moveSecretsFrom(from, [slot]);
          new Notice(n ? `Planner: moved ${slot.label} to ${secretsBackendLabel(selected)}.` : `Planner: ${slot.label} was not moved; see the Env file line.`);
          await refreshSecrets();
        }));
      }
      if (movable.length > 1) {
        new Setting(keysEl)
          .setName('Move every key')
          .setDesc(`Moves the ${movable.length} keys above into ${secretsBackendLabel(selected)} and blanks them where they were.`)
          .addButton((b) => b.setButtonText(`Move all to ${secretsBackendLabel(selected)}`).onClick(async () => {
            b.setDisabled(true);
            let n = 0;
            for (const from of [...new Set(movable.map((m) => m.from))]) {
              n += await this.plugin.moveSecretsFrom(from, movable.filter((m) => m.from === from).map((m) => m.slot));
            }
            new Notice(`Planner: moved ${n} ${n === 1 ? 'key' : 'keys'} to ${secretsBackendLabel(selected)}.`);
            await refreshSecrets();
          }));
      }
    };
    const refreshSecrets = async () => {
      await this.plugin.envStore.load();
      renderEnvStatus();
      renderKeys();
    };
    envSetting.addText((t) => {
      t.setPlaceholder(DEFAULT_ENV_FILE_PATH).setValue(this.plugin.settings.envFilePath || '');
      t.inputEl.autocomplete = 'off';
      t.inputEl.spellcheck = false;
      t.inputEl.setAttribute('aria-label', 'Env file path, relative to the vault');
      t.onChange(async (v) => {
        const n = normalizeEnvFilePath(v);
        if (!n.ok) { envSetting.descEl.toggleClass('is-failed', true); envSetting.setDesc(n.error); return; }
        await this.plugin.setEnvFilePath(n.path);
        await refreshSecrets();
      });
    });
    refreshSecrets();

    // The planner folder. Typing validates live (announced); Apply commits,
    // moving the existing notes with a link-safe rename when the new folder
    // does not exist yet, refusing when both exist rather than guessing.
    new Setting(containerEl).setName('Vault').setHeading();
    const folderSetting = new Setting(containerEl).setName('Planner folder');
    folderSetting.descEl.setAttribute('aria-live', 'polite');
    let pendingFolder = this.plugin.settings.plannerFolder;
    let applyBtn = null;
    const folderPlan = () => {
      const n = normalizePlannerFolder(pendingFolder);
      if (!n.ok) return { ok: false, plan: null, text: n.error };
      const current = this.plugin.paths().root;
      const cur = this.app.vault.getAbstractFileByPath(current);
      const nxt = this.app.vault.getAbstractFileByPath(n.folder);
      const plan = plannerFolderChangePlan({ current, next: n.folder, currentExists: cur instanceof TFolder, nextExists: nxt instanceof TFolder });
      return { ok: plan.action !== 'refuse' && plan.action !== 'noop', plan, folder: n.folder, current: cur, text: plan.reason };
    };
    const renderFolderPlan = () => {
      const fp = folderPlan();
      folderSetting.setDesc(fp.text);
      if (applyBtn) {
        applyBtn.setDisabled(!fp.ok);
        applyBtn.setButtonText(fp.plan && fp.plan.action === 'move' ? 'Move and apply' : 'Apply');
      }
    };
    folderSetting.addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.plannerFolder).setValue(pendingFolder)
      .onChange((v) => { pendingFolder = v; renderFolderPlan(); }));
    folderSetting.addButton((b) => {
      applyBtn = b;
      b.setButtonText('Apply').onClick(async () => {
        const fp = folderPlan();
        if (!fp.ok) return;
        b.setDisabled(true);
        try {
          if (fp.plan.action === 'move') await this.app.fileManager.renameFile(fp.current, fp.folder);
          this.plugin.settings.plannerFolder = fp.folder;
          await this.plugin.saveSettings();
          await this.plugin.ensureFolders();
          new Notice(`Planner: now using "${fp.folder}".`);
          this.display();
        } catch (e) {
          folderSetting.setDesc(`Could not apply: ${e && e.message ? e.message : e}`);
          b.setDisabled(false);
        }
      });
      renderFolderPlan();
    });

    new Setting(containerEl).setName('Todoist').setHeading();
    secret(new Setting(containerEl)
      .setName('API token')
      .setDesc(`Todoist -> Settings -> Integrations -> Developer -> API token.${storedIn}`),
      () => readSecret(this.plugin.settings, secrets, 'todoistToken'),
      (v) => { writeSecret(this.plugin.settings, secrets, 'todoistToken', v); }, 'paste token');

    new Setting(containerEl).setName('ClickUp').setHeading();
    secret(new Setting(containerEl)
      .setName('Personal API token')
      .setDesc(`ClickUp -> avatar -> Settings -> Apps -> API Token. Starts with pk_.${storedIn}`),
      () => readSecret(this.plugin.settings, secrets, 'clickupToken'),
      (v) => { writeSecret(this.plugin.settings, secrets, 'clickupToken', v); }, 'pk_...');
    new Setting(containerEl)
      .setName('Workspace ID (optional)')
      .setDesc('Leave empty to read every workspace the token can see.')
      .addText((t) => t.setValue(this.plugin.settings.clickupTeamId)
        .onChange(async (v) => { this.plugin.settings.clickupTeamId = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Include subtasks')
      .setDesc('Also fetch ClickUp subtasks assigned to you. Each becomes a card that names its parent, and the parent card counts them. Off by default so an existing board does not fill up on upgrade.')
      .addToggle((t) => t.setValue(this.plugin.settings.clickupIncludeSubtasks === true)
        .onChange(async (v) => { this.plugin.settings.clickupIncludeSubtasks = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Starred email (IMAP)').setHeading();
    if (!Platform.isDesktopApp) {
      // IMAP needs a raw TLS socket, which the mobile app does not have
      // (imapConnect's own guard has always refused it there). Offering the
      // form here would let someone fill it in and meet a silent failure at
      // the first sync, instead of never seeing fields that cannot work.
      new Setting(containerEl).setDesc('Email accounts connect on the desktop.');
    } else {
      const setup = containerEl.createEl('details', { cls: 'iplan-setup' });
      setup.createEl('summary', { text: 'Setup guide: app passwords per provider' });
      const setupBody = setup.createEl('div', { cls: 'iplan-setup-body' });
      setupBody.createEl('p', {
        text: 'Any IMAP mailbox works: star or flag an email and it lands in the planner tray as a task. Reading is strictly read-only; the one write is unstarring on complete, and only while "Complete on source" is on. Most providers want an app password here, never your normal one:',
      });
      const setupList = setupBody.createEl('ul');
      const li = (before, linkText, href, after) => {
        const item = setupList.createEl('li');
        item.appendText(before);
        if (href) {
          const a = item.createEl('a', { text: linkText, href });
          a.addEventListener('click', (e) => { e.preventDefault(); window.open(href, '_external'); });
        }
        if (after) item.appendText(after);
      };
      li('Gmail: turn on 2-step verification, then create one at ',
        'myaccount.google.com/apppasswords', 'https://myaccount.google.com/apppasswords',
        ' (host imap.gmail.com).');
      li('iCloud: app-specific password at ',
        'account.apple.com', 'https://account.apple.com/account/manage',
        ' (host imap.mail.me.com).');
      li('Fastmail: Settings, Privacy & Security, app passwords (host imap.fastmail.com).', null, null, null);
      li('Proton Mail: install Proton Bridge, pick the Proton Bridge preset above the host, and use the mailbox password Bridge shows (host 127.0.0.1, port 1143, STARTTLS, its own certificate).', null, null, null);
      li('GMX / web.de and most others: enable IMAP in the webmail settings first. Outlook / Microsoft 365 retired password IMAP and cannot connect here: use the Outlook section below instead.', null, null, null);
      // Presets: one chip per known provider fills the host and the
      // connection shape. A radio group for the keyboard and the screen reader
      // (arrow keys move, aria-checked says which is on), rendered on the
      // planner's own segmented control so it reads like the rest of the plugin.
      const presetSetting = new Setting(containerEl)
        .setName('Provider')
        .setDesc('Fills the host and the connection settings for a known provider. Any other IMAP host works too: type it below.');
      const presetGroup = presetSetting.controlEl.createDiv({ cls: 'iplan-seg iplan-settings-presets', attr: { role: 'radiogroup', 'aria-label': 'Email provider preset' } });
      const activePreset = imapActivePreset(this.plugin.settings);
      const presetButtons = [];
      for (const preset of IMAP_PRESETS) {
        const on = preset.id === activePreset;
        const btn = presetGroup.createEl('button', {
          cls: `iplan-seg-btn${on ? ' is-active' : ''}`, text: preset.label,
          attr: { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on || (!activePreset && preset === IMAP_PRESETS[0]) ? '0' : '-1', 'data-preset': preset.id },
        });
        btn.addEventListener('click', async () => {
          Object.assign(this.plugin.settings, imapPresetFields(preset));
          await this.plugin.saveSettings();
          this.display();
          const again = this.containerEl.querySelector(`[data-preset="${preset.id}"]`);
          if (again) again.focus();
        });
        btn.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const i = presetButtons.indexOf(btn);
          const nextBtn = presetButtons[(i + (e.key === 'ArrowRight' ? 1 : presetButtons.length - 1)) % presetButtons.length];
          nextBtn.focus();
        });
        presetButtons.push(btn);
      }
      // The host decides the provider, and the provider decides the one
      // sentence that unblocks most first attempts. It re-renders as the host
      // is typed, so the advice is never about a host the field no longer says.
      const hostSetting = new Setting(containerEl).setName('IMAP host');
      const renderHostHint = (host) => {
        const p = imapProviderOf(host);
        hostSetting.descEl.empty();
        if (!p.hint) return;
        hostSetting.descEl.appendText(p.hint);
        if (p.appPasswordUrl) {
          hostSetting.descEl.appendText(' ');
          const a = hostSetting.descEl.createEl('a', { text: 'Open', href: p.appPasswordUrl });
          a.addEventListener('click', (e) => { e.preventDefault(); window.open(p.appPasswordUrl, '_external'); });
        }
      };
      hostSetting.addText((t) => t.setValue(this.plugin.settings.imapHost)
        .onChange(async (v) => {
          this.plugin.settings.imapHost = v.trim();
          renderHostHint(v);
          renderSelfSigned(v);
          await this.plugin.saveSettings();
        }));
      renderHostHint(this.plugin.settings.imapHost);
      new Setting(containerEl)
        .setName('Port')
        .setDesc('993 for TLS with most providers; 1143 for Proton Bridge.')
        .addText((t) => t.setPlaceholder('993').setValue(String(this.plugin.settings.imapPort || 993))
          .onChange(async (v) => {
            const n = Number(v.trim());
            if (Number.isInteger(n) && n > 0 && n < 65536) { this.plugin.settings.imapPort = n; await this.plugin.saveSettings(); }
          }));
      new Setting(containerEl)
        .setName('Security')
        .setDesc('TLS connects encrypted from the first byte (the default). STARTTLS opens a plain connection and upgrades it before the login; if the host refuses the upgrade, nothing is sent.')
        .addDropdown((d) => d
          .addOption('tls', 'TLS (default)')
          .addOption('starttls', 'STARTTLS')
          .setValue(this.plugin.settings.imapSecurity === 'starttls' ? 'starttls' : 'tls')
          .onChange(async (v) => {
            this.plugin.settings.imapSecurity = v === 'starttls' ? 'starttls' : 'tls';
            await this.plugin.saveSettings();
          }));
      // The allowance is a toggle that only means something for a host on this
      // machine, and the transport enforces the same rule regardless of what
      // the toggle says. Off-loopback it is disabled with the reason stated.
      const selfSignedSetting = new Setting(containerEl).setName('Accept a self-signed certificate');
      let selfSignedToggle = null;
      const renderSelfSigned = (host) => {
        const loop = isLoopbackHost(host);
        selfSignedSetting.setDesc(loop
          ? 'The host is on this machine, so its own certificate (Proton Bridge makes one) can be accepted.'
          : 'Only for a host on this machine (127.0.0.1, localhost). A remote host is always verified.');
        if (selfSignedToggle) selfSignedToggle.setDisabled(!loop);
      };
      selfSignedSetting.addToggle((t) => {
        selfSignedToggle = t;
        t.setValue(!!this.plugin.settings.imapAllowSelfSigned)
          .onChange(async (v) => { this.plugin.settings.imapAllowSelfSigned = v; await this.plugin.saveSettings(); });
        renderSelfSigned(this.plugin.settings.imapHost);
      });
      new Setting(containerEl)
        .setName('Email address')
        .addText((t) => t.setValue(this.plugin.settings.imapUser)
          .onChange(async (v) => { this.plugin.settings.imapUser = v.trim(); await this.plugin.saveSettings(); }));
      secret(new Setting(containerEl)
        .setName('App password')
        .setDesc(`Never your normal password. Paste the app password without spaces.${storedIn}`),
        () => readSecret(this.plugin.settings, secrets, 'imapPassword'),
        (v) => { writeSecret(this.plugin.settings, secrets, 'imapPassword', v.replace(/\s+/g, '')); }, 'app password');
      // Test connection: the probe logs in and straight out, so a wrong host,
      // port, certificate or password is named here, now, with the same
      // sentence the tray would show after the next sync. The outcome lands in
      // a live region so a screen reader hears it without hunting for it.
      const probeSetting = new Setting(containerEl)
        .setName('Test connection')
        .setDesc('Logs in and straight out. Reads nothing, writes nothing.');
      probeSetting.descEl.setAttribute('aria-live', 'polite');
      const renderProbe = (r) => {
        probeSetting.descEl.empty();
        probeSetting.descEl.toggleClass('is-ok', !!r.ok);
        probeSetting.descEl.toggleClass('is-failed', !r.ok);
        probeSetting.descEl.appendText(r.message);
        if (r.hint) { probeSetting.descEl.createEl('br'); probeSetting.descEl.appendText(r.hint); }
        if (r.docUrl) {
          probeSetting.descEl.appendText(' ');
          const a = probeSetting.descEl.createEl('a', { text: 'Open', href: r.docUrl });
          a.addEventListener('click', (e) => { e.preventDefault(); window.open(r.docUrl, '_external'); });
        }
      };
      probeSetting.addButton((b) => b.setButtonText('Test').onClick(async () => {
        b.setDisabled(true);
        probeSetting.descEl.empty();
        probeSetting.descEl.appendText('Connecting...');
        try { renderProbe(await imapProbe(this.plugin.withSecrets())); }
        finally { b.setDisabled(false); }
      }));
    }

    /* ---- Outlook (2026-09-06) ---- */
    new Setting(containerEl).setName('Outlook (Microsoft 365, outlook.com)').setHeading();
    const osetup = containerEl.createEl('details', { cls: 'iplan-setup' });
    osetup.createEl('summary', { text: 'Setup guide: your own Microsoft app registration' });
    const osetupBody = osetup.createEl('div', { cls: 'iplan-setup-body' });
    osetupBody.createEl('p', {
      text: 'Flagged emails land in the tray as tasks and your Outlook calendar joins the board, through an app you register in your own Microsoft account (about ten minutes, once). Reading is read-only; the one write is the flag status on complete, and only while "Complete on source" is on.',
    });
    const olist = osetupBody.createEl('ul');
    for (const line of [
      'entra.microsoft.com, App registrations, New registration. Supported account types: "any organizational directory and personal Microsoft accounts".',
      `Authentication, Add a platform, Mobile and desktop applications, custom redirect URI: ${OUTLOOK_REDIRECT_URI}`,
      'Authentication, Advanced settings: "Allow public client flows" = Yes.',
      'API permissions, Microsoft Graph, Delegated: Mail.Read, Mail.ReadWrite, Calendars.Read, offline_access.',
      'Overview: copy the Application (client) ID into the field below, then Sign in.',
    ]) olist.createEl('li', { text: line });
    const guideP = osetupBody.createEl('p');
    guideP.appendText('The full guide, every step and the error codes: ');
    const guideA = guideP.createEl('a', { text: 'Connecting Outlook to the Planner', href: OUTLOOK_GUIDE_URL });
    guideA.addEventListener('click', (e) => { e.preventDefault(); window.open(OUTLOOK_GUIDE_URL, '_external'); });
    // The client id is a public-client GUID, not a secret: a plain field.
    // The notice under it is the member's own-account terms, verbatim.
    const clientSetting = new Setting(containerEl).setName('Application (client) ID').setDesc(OUTLOOK_NOTICE);
    clientSetting.addText((t) => {
      t.setPlaceholder('00000000-0000-0000-0000-000000000000').setValue(this.plugin.settings.outlookClientId);
      t.inputEl.autocomplete = 'off';
      t.inputEl.spellcheck = false;
      t.inputEl.setAttribute('aria-label', 'Application (client) ID');
      t.onChange(async (v) => {
        this.plugin.settings.outlookClientId = v.trim();
        await this.plugin.saveSettings();
        renderOutlookStatus();
      });
    });
    new Setting(containerEl)
      .setName('Account type')
      .setDesc('Which accounts the sign-in accepts: any Microsoft account (the default), work or school only, or personal only. Match what you chose under "Supported account types" when registering.')
      .addDropdown((d) => d
        .addOption('common', 'Any Microsoft account (common)')
        .addOption('organizations', 'Work or school only (organizations)')
        .addOption('consumers', 'Personal only (consumers)')
        .setValue(outlookTenant(this.plugin.settings))
        .onChange(async (v) => {
          this.plugin.settings.outlookTenant = OUTLOOK_TENANTS.includes(v) ? v : 'common';
          await this.plugin.saveSettings();
        }));
    const acct = new Setting(containerEl).setName('Microsoft account');
    acct.descEl.setAttribute('aria-live', 'polite');
    let signInBtn = null;
    let signOutBtn = null;
    const renderOutlookStatus = () => {
      const r = this.plugin.withSecrets();
      acct.setDesc(outlookStatusText(r));
      const signed = outlookSignedIn(r);
      if (signInBtn) {
        signInBtn.setButtonText(signed ? 'Sign in again' : 'Sign in');
        signInBtn.setDisabled(!trimmed(r.outlookClientId));
        if (!signed) signInBtn.setCta(); else signInBtn.removeCta();
      }
      if (signOutBtn) signOutBtn.setDisabled(!signed);
    };
    acct.addButton((b) => {
      signInBtn = b;
      b.onClick(() => this.plugin.outlookSignIn({ onDone: () => this.display() }));
    });
    acct.addButton((b) => {
      signOutBtn = b;
      b.setButtonText('Sign out').onClick(async () => {
        await this.plugin.outlookSignOut();
        this.display();
      });
    });
    renderOutlookStatus();
    const revoke = new Setting(containerEl)
      .setName('Manage or revoke access')
      .setDesc('Signing out only removes the token from this vault. To fully revoke access on Microsoft\'s side, visit myaccount.microsoft.com (Apps & services), or account.live.com/consent/Manage for a personal account.');
    revoke.addButton((b) => b.setButtonText('myaccount.microsoft.com').onClick(() => window.open(OUTLOOK_REVOKE_URLS.work, '_external')));
    revoke.addButton((b) => b.setButtonText('Personal account').onClick(() => window.open(OUTLOOK_REVOKE_URLS.personal, '_external')));

    // Calendars: one row per feed. Name, the secret address (or, for the
    // Outlook calendar, the account it reads), the four-swatch lens picker
    // (a radio group: arrow keys move, aria-checked says which is on), an
    // on/off toggle, remove, and the feed's own status line from the last
    // sync. The list is normalised in place first so every row has an id to
    // key its controls and its status by.
    const resolved = this.plugin.withSecrets();
    new Setting(containerEl).setName('Calendars').setHeading();
    this.plugin.settings.calendars = calendarFeeds(this.plugin.settings);
    const feedList = this.plugin.settings.calendars;
    const perFeed = (this.plugin.calendarStatus && this.plugin.calendarStatus.perFeed) || {};
    const focusLater = (selector) => {
      const el = this.containerEl.querySelector(selector);
      if (el) el.focus();
    };
    feedList.forEach((feed, i) => {
      const row = new Setting(containerEl)
        .setName(`Calendar ${i + 1}`)
        .setClass('iplan-settings-feed');
      row.setDesc(calendarFeedStatusText(feed, perFeed[feed.id], secrets, resolved));
      row.descEl.setAttribute('aria-live', 'polite');
      row.addText((t) => {
        t.setPlaceholder('Name').setValue(feed.name);
        t.inputEl.setAttribute('aria-label', `Name of calendar ${i + 1}`);
        t.inputEl.setAttribute('data-feed-name', feed.id);
        t.onChange(async (v) => {
          feed.name = v.trim() || `Calendar ${i + 1}`;
          await this.plugin.saveSettings();
          // The board's chips and the cache carry the name; retag now.
          for (const d of this.plugin.calendarDefsByFeed[feed.id] || []) d.feedName = feed.name;
          this.plugin.emitModelChanged();
        });
      });
      if (feed.kind === 'graph') {
        // No address to paste: the feed is the signed-in Microsoft account.
        row.controlEl.createSpan({ cls: 'iplan-settings-feed-source', text: 'Microsoft account', attr: { 'aria-label': `Calendar ${i + 1} reads your Microsoft account` } });
      } else {
        secret(row, () => feedUrl(feed, secrets), (v) => { setFeedUrl(feed, v, secrets); },
          'https://... or webcal://...', `iCal address of calendar ${i + 1} (kept secret)`);
      }
      const group = row.controlEl.createDiv({
        cls: 'iplan-seg iplan-settings-presets iplan-settings-swatches',
        attr: { role: 'radiogroup', 'aria-label': `Colour of calendar ${i + 1}` },
      });
      const swatchButtons = [];
      for (let c = 1; c <= CALENDAR_SWATCHES; c++) {
        const on = clampSwatch(feed.color) === c;
        const btn = group.createEl('button', {
          cls: `iplan-seg-btn iplan-swatch iplan-swatch-${c}${on ? ' is-active' : ''}`, text: String(c),
          attr: {
            type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
            'aria-label': CALENDAR_SWATCH_NAMES[c - 1], tabindex: on ? '0' : '-1',
            'data-swatch': `${feed.id}:${c}`,
          },
        });
        btn.addEventListener('click', async () => {
          feed.color = c;
          await this.plugin.saveSettings();
          for (const d of this.plugin.calendarDefsByFeed[feed.id] || []) d.feedColor = c;
          this.plugin.emitModelChanged();
          this.display();
          focusLater(`[data-swatch="${feed.id}:${c}"]`);
        });
        btn.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
          e.preventDefault();
          const k = swatchButtons.indexOf(btn);
          const nextBtn = swatchButtons[(k + (e.key === 'ArrowRight' ? 1 : swatchButtons.length - 1)) % swatchButtons.length];
          nextBtn.focus();
        });
        swatchButtons.push(btn);
      }
      row.addToggle((t) => {
        t.setValue(feed.enabled !== false).setTooltip('Show this calendar');
        t.toggleEl.setAttribute('aria-label', `Show calendar ${i + 1}`);
        t.onChange(async (v) => {
          feed.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.recomputeCalendarDefs();
          row.setDesc(calendarFeedStatusText(feed, perFeed[feed.id], secrets, resolved));
        });
      });
      // Remove is two presses: the first arms it and says so, the second
      // removes; the arm drops after a few seconds. No browser dialog.
      row.addExtraButton((b) => {
        let armed = false;
        let disarm = null;
        const rest = () => { armed = false; b.setIcon('trash').setTooltip('Remove this calendar'); b.extraSettingsEl.setAttribute('aria-label', 'Remove this calendar'); };
        rest();
        b.onClick(async () => {
          if (!armed) {
            armed = true;
            b.setIcon('alert-triangle').setTooltip('Press again to remove');
            b.extraSettingsEl.setAttribute('aria-label', 'Press again to remove');
            disarm = window.setTimeout(() => { disarm = null; rest(); }, 5000);
            return;
          }
          if (disarm) window.clearTimeout(disarm);
          const at = feedList.indexOf(feed);
          if (at >= 0) feedList.splice(at, 1);
          forgetFeedSecret(feed, secrets);
          await this.plugin.saveSettings();
          this.plugin.recomputeCalendarDefs();
          new Notice(`Planner: removed ${feed.name}.`);
          this.display();
          focusLater('[data-add-calendar]');
        });
      });
    });
    new Setting(containerEl)
      .setName('Add calendar')
      .setDesc(feedList.length
        ? 'One row per feed. A calendar present in two feeds shows each event once.'
        : 'Paste one iCal address per calendar. Events render read-only on the board.')
      .addButton((b) => {
        b.setButtonText('Add').buttonEl.setAttribute('data-add-calendar', '1');
        b.onClick(async () => {
          const id = newCalendarId(feedList);
          feedList.push({ id, name: `Calendar ${feedList.length + 1}`, url: '', color: leastUsedSwatch(feedList), enabled: true, kind: 'ics' });
          await this.plugin.saveSettings();
          this.display();
          focusLater(`[data-feed-name="${id}"]`);
        });
      });
    // Where the address comes from, per provider. Short, and only what is
    // known to hold: a calendar is one address, and a private iCloud
    // calendar has no address of this kind yet.
    const calNote = containerEl.createDiv({ cls: 'iplan-settings-note' });
    calNote.appendText('Where to find the address (one per calendar):');
    const calList = calNote.createEl('ul', { cls: 'iplan-settings-list' });
    for (const line of [
      'Google: Settings, the calendar, Integrate calendar, "Secret address in iCal format". Treat it like a password.',
      'Apple: iCloud Calendar, share the calendar as a Public Calendar, copy the webcal link. A calendar you have not shared cannot be read this way yet.',
      'Proton: Calendar, share via link. Sharing by link needs a paid Proton plan.',
      'Outlook: sign in under Outlook above and the Outlook calendar row appears here by itself; or Publish calendar and paste the ICS link like any other.',
    ]) calList.createEl('li', { text: line });

    new Setting(containerEl).setName('Board').setHeading();
    new Setting(containerEl)
      .setName('Sync interval (minutes)')
      .addText((t) => t.setValue(String(this.plugin.settings.syncMinutes))
        .onChange(async (v) => {
          const n = Math.max(2, Number(v) || 10);
          this.plugin.settings.syncMinutes = n;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Next event strip')
      .setDesc('A strip across the top of the left sidebar, above the logo, shows what is next on today\'s clock with a live countdown. When the event carries a meeting link (Zoom, Google Meet, Teams, Webex, Whereby, Jitsi), clicking the strip opens the meeting; otherwise it opens the board.')
      .addToggle((t) => t.setValue(this.plugin.settings.showNextBadge)
        .onChange(async (v) => {
          this.plugin.settings.showNextBadge = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.setupNextBadge(); else this.plugin.removeNextBadge();
        }));
    new Setting(containerEl)
      .setName('Subtasks on the parent card')
      .setDesc('A card with subtasks in the vault reads "n of m subtasks" and opens the list on the chevron; checking a row there is the same check as on the subtask\'s own card. Off leaves the counter out; subtask cards keep their parent line either way.')
      .addToggle((t) => t.setValue(this.plugin.settings.subtaskChecklist !== false)
        .onChange(async (v) => { this.plugin.settings.subtaskChecklist = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Show weekend')
      .addToggle((t) => t.setValue(this.plugin.settings.showWeekend)
        .onChange(async (v) => { this.plugin.settings.showWeekend = v; await this.plugin.saveSettings(); }));
    // The display formats (2026-09-07). Both blank by default: the board
    // then follows Obsidian's own Templates setting, and with that blank
    // too it draws what it always drew. A filled field here wins.
    new Setting(containerEl)
      .setName('Date format')
      .setDesc('How dates read on the board, in moment tokens, for example DD-MM or MMM D. Blank follows the Date format in Obsidian\'s Templates settings; when that is blank too, dates read 7.09. as before. Only what is shown changes; nothing stored in your notes does.')
      .addText((t) => t.setPlaceholder('D.MM.').setValue(this.plugin.settings.dateFormat || '')
        .onChange(async (v) => {
          this.plugin.settings.dateFormat = String(v || '').trim();
          await this.plugin.saveSettings();
          this.plugin.emitModelChanged();
        }));
    new Setting(containerEl)
      .setName('Time format')
      .setDesc('How times read on the board, in moment tokens, for example LT or h:mm A for 6:15 PM. Blank follows the Time format in Obsidian\'s Templates settings; when that is blank too, times read 18:15 as before. The HH:MM fields below stay 24-hour.')
      .addText((t) => t.setPlaceholder('HH:mm').setValue(this.plugin.settings.timeFormat || '')
        .onChange(async (v) => {
          this.plugin.settings.timeFormat = String(v || '').trim();
          await this.plugin.saveSettings();
          this.plugin.emitModelChanged();
        }));
    new Setting(containerEl)
      .setName('Morning / afternoon split')
      .setDesc('HH:MM. Timed events before this hour land in the morning lane.')
      .addText((t) => t.setValue(this.plugin.settings.splitTime)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.splitTime = v.trim(); await this.plugin.saveSettings(); }
        }));
    new Setting(containerEl)
      .setName('Lunch break')
      .setDesc('Renders a lunch band between morning and afternoon instead of the split line. Its height follows its length.')
      .addToggle((t) => t.setValue(this.plugin.settings.lunchEnabled)
        .onChange(async (v) => { this.plugin.settings.lunchEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Lunch from / until')
      .setDesc('HH:MM. With the lunch break on, its start also decides what still counts as morning.')
      .addText((t) => t.setPlaceholder('12:30').setValue(this.plugin.settings.lunchStart)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.lunchStart = v.trim(); await this.plugin.saveSettings(); }
        }))
      .addText((t) => t.setPlaceholder('13:30').setValue(this.plugin.settings.lunchEnd)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.lunchEnd = v.trim(); await this.plugin.saveSettings(); }
        }));
    new Setting(containerEl)
      .setName('Workday start / end')
      .setDesc('Drives the live progress marker on today.')
      .addText((t) => t.setPlaceholder('08:00').setValue(this.plugin.settings.dayStart)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.dayStart = v.trim(); await this.plugin.saveSettings(); }
        }))
      .addText((t) => t.setPlaceholder('18:00').setValue(this.plugin.settings.dayEnd)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.dayEnd = v.trim(); await this.plugin.saveSettings(); }
        }));

    /* ---- routines (2026-09-04) ---- */
    new Setting(containerEl).setName('Routines').setHeading();
    new Setting(containerEl)
      .setName('Show routines')
      .setDesc('A routine is a block of steps at a time of day, on the weekdays you pick. It sits in the morning or afternoon lane at its time and its steps check off one by one. Off hides the cards; the notes stay.')
      .addToggle((t) => t.setValue(this.plugin.settings.routinesEnabled !== false)
        .onChange(async (v) => { this.plugin.settings.routinesEnabled = v; await this.plugin.saveSettings(); }));
    const rd = routineDefaultsOf(this.plugin.settings);
    this.plugin.settings.routineDefaults = rd;
    for (const type of ROUTINE_TYPES) {
      const row = new Setting(containerEl).setName(`${capitalize(type)} routine from / until`);
      if (type === 'morning') row.setDesc('HH:MM. The times a new routine of this type starts with; each routine keeps its own in its note.');
      const timeField = (t, key) => {
        t.setPlaceholder(rd[type][key]).setValue(rd[type][key]);
        t.inputEl.setAttribute('aria-label', `${capitalize(type)} routine ${key === 'start' ? 'from' : 'until'}`);
        t.onChange(async (v) => {
          const hm = normalizeHM(v);
          if (!hm) return;
          this.plugin.settings.routineDefaults[type][key] = hm;
          await this.plugin.saveSettings();
        });
      };
      row.addText((t) => timeField(t, 'start'));
      row.addText((t) => timeField(t, 'end'));
    }
    const wd = new Setting(containerEl)
      .setName('Weekdays for a new routine')
      .setDesc('What a new routine starts with; each routine keeps its own list in its note.');
    weekdayToggleRow(wd.controlEl,
      () => routineWeekdaysDefaultOf(this.plugin.settings),
      async (codes) => { this.plugin.settings.routineWeekdaysDefault = codes; await this.plugin.saveSettings(); },
      'Weekdays for a new routine');
    const routineList = (this.plugin.routines || []).slice().sort((a, b) =>
      (ROUTINE_TYPES.indexOf(a.routineType) - ROUTINE_TYPES.indexOf(b.routineType))
      || String(a.start || '').localeCompare(String(b.start || ''))
      || a.name.localeCompare(b.name));
    if (!routineList.length) {
      containerEl.createDiv({ cls: 'iplan-settings-note', text: 'No routines yet.' });
    }
    for (const r of routineList) {
      const days = r.weekdays.length ? r.weekdays.map((c) => WEEKDAY_NAMES[c].slice(0, 3)).join(' ') : 'no weekdays';
      const steps = `${r.steps.length} step${r.steps.length === 1 ? '' : 's'}`;
      const row = new Setting(containerEl)
        .setName(r.name)
        .setDesc(`${capitalize(r.routineType)}, ${r.start || rd[r.routineType].start} - ${r.end || rd[r.routineType].end}, ${days}, ${steps}.`);
      row.addToggle((t) => {
        t.setValue(r.active).setTooltip('Active');
        t.toggleEl.setAttribute('aria-label', `${r.name} active`);
        t.onChange((v) => this.plugin.setRoutineActive(r.path, v));
      });
      row.addButton((b) => b.setButtonText('Open').onClick(() => {
        const file = this.app.vault.getAbstractFileByPath(r.path);
        if (file instanceof TFile) this.app.workspace.getLeaf('tab').openFile(file);
      }));
    }
    new Setting(containerEl)
      .setName('New routine')
      .setDesc(`Creates a note under ${this.plugin.paths().routines}/ with the steps and a log table. The steps are edited in the note; the log is written when you check them off.`)
      .addButton((b) => b.setButtonText('New routine').setCta()
        .onClick(() => new NewRoutineModal(this.app, this.plugin, () => this.display()).open()));

    /* ---- habits (2026-09-04; planner-owned since 0.10.0) ---- */
    new Setting(containerEl).setName('Habits').setHeading();
    new Setting(containerEl)
      .setName('Show habits')
      .setDesc(`Reads the habit notes under ${this.plugin.habitsFolder()}/ and puts an all-day HABITS block under each day a habit is scheduled for. Checking one writes a row into that note's log table. Off hides the block and the HABITS tab; the notes stay.`)
      .addToggle((t) => t.setValue(this.plugin.settings.habitsEnabled !== false)
        .onChange(async (v) => { this.plugin.settings.habitsEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Your habits')
      .setDesc(`${habitsCountText(this.plugin.habits, this.plugin.habitsFolder())} Create, rename, pause, archive and delete them in the HABITS tab beside the board.`)
      .addButton((b) => b.setButtonText('New habit')
        .onClick(() => new NewHabitModal(this.app, this.plugin, () => this.display()).open()));
    // The My Life Habits folder: read for the import and the link picker
    // only. Typing validates live (announced); a valid folder is adopted as
    // typed, an invalid one is refused and the last good one stays.
    const importFolderSetting = new Setting(containerEl).setName('My Life Habits folder');
    importFolderSetting.descEl.setAttribute('aria-live', 'polite');
    let importBtn = null;
    const renderImportFolder = (raw) => {
      const n = normalizeHabitsFolder(raw);
      if (!n.ok) { importFolderSetting.setDesc(n.error); if (importBtn) importBtn.setDisabled(true); return; }
      const exists = this.app.vault.getAbstractFileByPath(n.folder) instanceof TFolder;
      const candidates = exists ? this.plugin.importCandidates() : [];
      importFolderSetting.setDesc(exists ? importFolderText(n.folder, candidates.length) : `"${n.folder}" does not exist in this vault.`);
      // Enabled whenever the room exists, not only when something is left to
      // take: pressing it with nothing new still qualifies the links (0.14.1).
      if (importBtn) importBtn.setDisabled(!exists);
    };
    importFolderSetting.addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.habitsImportFolder).setValue(this.plugin.settings.habitsImportFolder)
      .onChange(async (v) => {
        const n = normalizeHabitsFolder(v);
        if (!n.ok) { renderImportFolder(v); return; }
        this.plugin.settings.habitsImportFolder = n.folder;
        await this.plugin.saveSettings();
        renderImportFolder(n.folder);
      }));
    new Setting(containerEl)
      .setName('Import from My Life')
      .setDesc(`${IMPORT_EDITS_TEXT} A note whose planner_habit already links to a planner habit note is skipped.`)
      .addButton((b) => {
        importBtn = b;
        b.setButtonText('Import from My Life')
          .onClick(() => this.plugin.openImportHabits(null, () => this.display()));
      });
    renderImportFolder(this.plugin.settings.habitsImportFolder);
    new Setting(containerEl)
      .setName('Streaks')
      .setDesc('Shows STREAK n on a habit row: consecutive scheduled days with a done mark, computed from the note\'s log at render and never written anywhere. A habit whose log says schema=process shows none.')
      .addToggle((t) => t.setValue(this.plugin.settings.habitStreaks !== false)
        .onChange(async (v) => { this.plugin.settings.habitStreaks = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Two-way sync').setHeading();
    new Setting(containerEl)
      .setName('Complete on source')
      .setDesc('Tasks from a connected source are a mirror: complete here and it completes there, deleted there and it disappears here (the note goes to Obsidian\'s trash, where you can get it back). What this switch does: checking a card here also closes the task in Todoist / ClickUp, unstars the email and marks the Outlook flag complete. Unchecking a card you had checked reopens it, also after a sync has confirmed the close. What it never does: it never changes a status at the source to make it match this vault. The source always wins. When a task is completed there, the card here simply follows and nothing is sent back, so a task you published or closed in the source app can never be reopened by the planner. Off = completing stays local to this vault: a task the source closed cannot be reopened from here, and a checked recurring task stays struck until it is completed in the source app. For Outlook this needs the Mail.ReadWrite permission, which is asked for only when you switch this on: if Outlook is signed in, a Microsoft sign-in opens to grant it (switching off does not take it back; sign out for that).')
      .addToggle((t) => t.setValue(this.plugin.settings.completeOnSource)
        .onChange(async (v) => {
          this.plugin.settings.completeOnSource = v;
          await this.plugin.saveSettings();
          // The incremental-consent round-trip: the permission is requested
          // the moment the feature that uses it is turned on, never before.
          const r = this.plugin.withSecrets();
          if (v && outlookSignedIn(r) && !outlookHasWriteScope(r)) this.plugin.outlookSignIn({ write: true, onDone: () => this.display() });
        }));
    new Setting(containerEl)
      .setName('When a recurring task moves to its next date')
      .setDesc('A recurring task keeps one card. When its due date moves on (completed here or in the source app) the check clears and the card reopens; this decides where it lands. The finished occurrence stays on the day it was planned, struck through.')
      .addDropdown((d) => d
        .addOption('move', 'Move the card to the new date (default)')
        .addOption('drop', 'Send the card back to the tray')
        .setValue(this.plugin.settings.recurringAdvance === 'drop' ? 'drop' : 'move')
        .onChange(async (v) => {
          this.plugin.settings.recurringAdvance = v === 'drop' ? 'drop' : 'move';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Push edits to source')
      .setDesc('Tasks from a connected source are a mirror. Edit the title, the due date, the priority or the body of a note and the change flows back to Todoist and ClickUp. Only what you changed since the last sync is sent; if the same thing changed on both sides, the source wins and your note is updated to match. Your own planning is never sent anywhere: the day a card sits on, its order, the star for the week and the note you linked it to stay in your vault. Off = edits stay in the vault and the source still updates the note.')
      .addToggle((t) => t.setValue(this.plugin.settings.pushEdits)
        .onChange(async (v) => { this.plugin.settings.pushEdits = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc(this.plugin.lastSyncAt ? `Last sync ${fmtTimeHM(this.plugin.lastSyncAt)}.` : 'No sync yet this session.')
      .addButton((b) => b.setButtonText('Sync').setCta()
        .onClick(() => this.plugin.syncNow(true)));
  }
}

module.exports = IcorPlannerPlugin;

// Headless test surface (harmless in Obsidian; the test harness reaches the
// internals through it instead of duplicating them).
module.exports.__test = {
  mondayOf, addDays, dayInWeek, dueBucketOf, weekDays, fmtWeekLabel, todayStr, localDayStr,
  // display formats (2026-09-07)
  setDisplayFormatSource, displayFormats, templatesFormats, resolveDisplayFormats, fmtWithMoment, fmtTimeHM,
  decodeRfc2047, icsUnescape,
  todoistPriorityRank, imapSplitResponses, imapQuote, imapUidOrThrow,
  imapProviderOf, classifyImapError, imapReplyError, imapReasonToConnector, imapConnect, IMAP_PROVIDERS,
  imapTransportOptions, imapTlsOptions, imapSession, imapItemsFromFetch, imapFetchStarredRaw, imapSetStarredRaw,
  imapPreflight, imapProbe, IMAP_PRESETS, imapPresetFields, imapActivePreset,
  isLoopbackHost, isIpLiteral, imapStarttlsError,
  parseIcs, icsParseDate, expandOccurrences, icsEventsForWeek,
  googleCalendarEventUrl,
  CALENDAR_SWATCHES, CALENDAR_SWATCH_NAMES, CALENDAR_SOURCES, clampSwatch, leastUsedSwatch, newCalendarId,
  calendarNameForUrl, normalizeCalendarFeed, calendarFeeds, enabledCalendarFeeds, calendarFeedConfigured,
  migrateCalendarSettings, calendarFeedFor, tagCalendarDefs, calendarFetchFeed, calendarFetchAll,
  dedupeCalendarDefs, calendarDefsFromByFeed, mergeCalendarFeeds, calendarAggregateStatus, calendarFeedStatusText,
  serializeCalendarDefs, reviveCalendarDefs,
  buildCalendarCacheContent, parseCalendarCacheContent, parseCalendarCache, groupDefsByFeed, adoptCacheDefs,
  detectConferenceUrl, nextBadgeModel, fmtNextCountdown, routineTimedEntries, nextStripMountPoint,
  NEXT_URGENT_MS, NEXT_SECONDS_MS, NEXT_STRIP_LOGO_HOST, NEXT_STRIP_SPLIT_HOST,
  plannerToolbarMountPoint, PLANNER_TOOLBAR_HOST, PLANNER_TOOLBAR_CLASS, PLANNER_TOOLBAR_ICON, PLANNER_TOOLBAR_LABEL,
  CONFERENCE_URL_PATTERNS,
  plannerPaths, normalizePlannerFolder, detectPlannerFolder, plannerFolderChangePlan, gitignoreLineFor, collectItems, unindexedNoteCount,
  zonedToUtc, tzOffsetMinutes, hmToMin, lunchBandHeight,
  WINDOWS_TZ_TO_IANA, normalizeTzid, isIanaZone, resolveTzid, tzidUtcPrefixOffset,
  icsUtcOffsetToMinutes, ianaForOffsets, calendarTzWarning, degraded, okResult, truncatedWarning,
  threeWayMerge, todoistApiPriority, TWO_WAY_FIELDS, pushableTitle,
  goneError, isGoneError, goneProbeBatch, absenceVerdict, canProbeGone, goneNotice, doneSweepBatch,
  GONE_PROBE_MAX_PER_SYNC, todoistProbeGone, clickupProbeGone,
  htmlishToText, segmentInfo, fmtLeft, fmtDayTitle, fmtDayLabel,
  trayDefaultTab, trayVisibleTabs, trayTabLabel, trayEffectiveTab,
  trayEmptyState, trayConnectionState, TRAY_COPY, fmtOpenItems,
  trayRevealDecision, trayRevealSpendsTurn,
  sourceConfigured, isSyncedSource, canPushToSource, canCompleteOnSource,
  SYNCED_SOURCES, TASK_SOURCES, MANUAL_SOURCE, FETCHED_SOURCES, CONNECTORS,
  manualExternalId, manualItemFrontmatter, reconcileStaleIds, scopeAgrees, clickupScopeKey, EMAIL_MAX_ITEMS,
  itemFromFrontmatter, clampPriorityRank, safeBasename,
  syncCompletionPlan, occurrenceAdvanced, reopenDecision, appendOccurrence,
  syncWriteIsOwn, SYNC_WRITE_MAX_PATHS,
  imapUidValidityOf, uidValidityVerdict, imapProbeGoneRaw, emailProbeGone,
  remapByMessageId, remapNotice,
  ghostItemsFor, pruneShadows, normalizeOccurrences, OCCURRENCE_CAP, DONE_SHADOW_MAX_AGE_MS,
  agendaSections, laneSequence, TRAY_TABS,
  todoistFetchOpen, clickupFetchOpen, emailFetchStarred, calendarFetchDefs,
  checklistModel, checklistProgressText, parseLogTable, logRowFor, upsertLogRow, removeLogRow, markerState,
  // weeks (0.14.0): the weekly priorities and the daily highlights
  WEEK_TYPE, WEEK_VIEW_TYPE, WEEK_ISO_RE, WEEK_HIGHLIGHT_MARKERS,
  WEEK_PRIORITIES_SENTINEL, WEEK_PRIORITIES_SECTION, WEEK_HIGHLIGHTS_SENTINEL, WEEK_HIGHLIGHTS_SECTION,
  isoWeekOf, mondayOfIsoWeek, isoWeekDays,
  parseChecklistBlock, toggleChecklistItem, addChecklistItem,
  highlightCellText, highlightRowFor, weekHighlights, weekHighlightAfterSet, weekHighlightAfterMark,
  isPlannerWeekFrontmatter, weekFromNote, weekTemplate, weekPriorityProgress,
  // the plan-owned half of a planner item (0.14.0)
  PLAN_OWNED_ITEM_FIELDS, normalizeLinkedNote, PINNED_SECTION_HEAD,
  ROUTINE_TYPE, ROUTINE_TYPES, ROUTINE_LOG_SENTINEL, ROUTINE_LOG_SECTION, WEEKDAY_CODES, LANE_KIND_RANK,
  dayCode, normalizeWeekdays, routineTypeOf, normalizeHM, routineDefaultsOf, routineWeekdaysDefaultOf,
  routineSteps, parseRoutineNote, routineRowState, routineHalf, routineOccurrence, routineOccurrences,
  routineCardState, routineKicker, routineTimeLabel, routineLogAfterStep, routineLogSkipped, routineLogReset,
  validateRoutineInput, routineTemplate,
  clickupQuery, buildItemIndex, parentOf, parentTitleFor, childrenOfItem, subtaskCounter, subtaskCounterText,
  subtaskRowMeta, cardChips, isDone, fmtDayNum,
  HABIT_TYPE, HABIT_LOG_SENTINEL, HABIT_LOG_SECTION, HABIT_CADENCES, HABIT_CADENCE_NAMES, HABIT_STATUSES,
  HABIT_MONTH_DAY_MAX, HABIT_SCHEDULE_FIELDS, HABIT_IMPORT_REMOVED_FIELDS, BOARD_ONLY_TABS,
  normalizeVaultFolder, normalizeHabitsFolder, habitsImportFolderOf, importPathInside, habitPathInside, migrateHabitSettings,
  normalizeCadence, habitStatusOf, monthDayOf, isPlannerHabitFrontmatter, isHabitFrontmatter, habitBasenameOk,
  basenameOf, wikilinkBasename, wikilinkTarget, wikilinkOf, qualifyLinkTarget, linkedFileOf, habitFromFrontmatter,
  daysFromCadence, habitDays, dayOfMonth, habitLandsOn, habitScheduleOf, streakOf, habitRowState, habitOccurrences,
  habitLogAfterCheck, habitRowModel, applyHabitCadence, validateHabitInput, habitFrontmatterOf, habitTemplate,
  importMapping, importPlan, HABIT_POINTER_PREFIX, habitPointerLine, habitPointerTargetOf, habitHasPointer,
  habitLogBlockOf, moveHabitLog, importSourceFrontmatterText,
  importCandidateText, importButtonText, importSummaryText, qualifySummaryText, importFolderText, habitsCountText, trayTabName,
  IMPORT_EDITS_TEXT, importDone, adoptLogBlock, qualifyFrontmatterLink, qualifyHabitPointer, qualifyLinkPlan,
  SOURCES, DEFAULT_SETTINGS,
  SECRET_KEY_PREFIX, SECRET_FIELDS, secretKey, fieldSecretKey, calendarSecretKey, secretStorageUsable, SecretVault,
  feedUrl, setFeedUrl, forgetFeedSecret, readSecret, writeSecret, migrateSecrets, withSecrets, adoptSettings, secretsNoteText,
  settingsHoldSecrets, migrateSecretsSettled, IcorPlannerPlugin,
  // the env file backend (0.12.0)
  DEFAULT_ENV_FILE_PATH, SECRETS_BACKENDS, BACKEND_LABELS, normalizeSecretsBackend, secretsBackendLabel, normalizeEnvFilePath,
  envKeyFor, parseEnvText, envLineFor, upsertEnvLine, envErrorText, EnvFileStore, dataJsonStore, secretPresence, moveSecret,
  SECRET_SLOT_LABELS, SECRET_SLOT_COMPANIONS, secretSlots, secretStatusText,
  // Outlook (2026-09-06)
  OUTLOOK_REDIRECT_URI, OUTLOOK_PROTOCOL_ACTION, OUTLOOK_LOGIN_HOST, GRAPH_BASE, OUTLOOK_TENANTS, OUTLOOK_NOTICE,
  OUTLOOK_GUIDE_URL, OUTLOOK_REVOKE_URLS, OUTLOOK_SCOPES_READ, OUTLOOK_SCOPES_WRITE, OUTLOOK_TOKEN_SLACK_MS,
  base64url, pkceChallenge, pkcePair, randomState, authorizeUrl, parseAuthCallback, tokenJson, parseTokenResponse,
  aadCodesOf, cleanAadDescription, mapAadError, outlookError, retryAfterMs, oauthPost, tokenExchange, tokenRefresh,
  deviceCodeStart, deviceCodePoll, outlookTenant, outlookScopeString, outlookSignedIn, outlookHasWriteScope,
  outlookTokens, outlookTokenSink, saveOutlookTokens, clearOutlookTokens, ensureAccessToken, graphRequest, graphHttpError,
  GRAPH_ORIGIN, graphNextLink,
  outlookMessagesQuery, outlookPriorityRank, outlookItemFromMessage, outlookFetchOpen, outlookSetClosed, outlookStatusText,
  graphCalendarWindow, graphCalendarQuery, graphInstant, graphAllDay, graphEventDef, outlookCalendarFetchFeed,
  calendarFeedConnector, calendarFeedReady, ensureGraphCalendarFeed, GRAPH_FEED_ID, noteIdPart,
};
