/* A SYNC ON A COLD METADATA CACHE MUST NOT WRITE A "-2" COPY OF A NOTE.
 *
 * The first sync runs a few seconds after the layout is ready. On a device
 * that opens the vault for the first time (a phone over a synced folder),
 * the metadata cache has not read the planner notes yet, so
 * getFileCache(file) answers null for them. collectItems reads identity
 * from that cache, so every open task looked new, and createItemFile found
 * its path taken and wrote `<title> (todoist-<id>)-2.md` beside it. From
 * then on each sync updated whichever copy the folder walk returned last.
 *
 * The rule: a pass that cannot read every note in the planner room writes
 * no new note. Updates to the notes it can read, and everything else in the
 * pass, run as before; the next sync, with the cache ready, creates what is
 * really new.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile, TFolder } = T.__obsidian;

const ROOT = '02 Planner';
const FOLDER = `${ROOT}/Todoist`;
const HEAD = '---\ntype: planner-item\n---\n';

function taskNote(id, title) {
  const f = new TFile();
  f.basename = `${title} (todoist-${id})`;
  f.path = `${FOLDER}/${f.basename}.md`;
  f.extension = 'md';
  f.stat = { mtime: 1000, ctime: 1000, size: 10 };
  f.fm = {
    type: 'planner-item', source: 'todoist', external_id: id, title,
    status: 'open', due: null, priority: 4, url: null, tags: [],
    planned_day: null, planned_half: null, planned_order: 0,
    weekly_goal: false, done_local: false, linked_note: null,
  };
  f.body = '';
  return f;
}

// `indexed` holds the paths the metadata cache has read; any other note
// answers null, the way a cold cache does.
function plugin(files, indexed) {
  const sub = new TFolder(); sub.path = FOLDER; sub.children = files;
  const root = new TFolder(); root.path = ROOT; root.children = [sub];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const created = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === ROOT ? root : (byPath.get(p) || null)),
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); f.stat.mtime += 1; },
      create: async (p) => { created.push(p); return { path: p }; },
      trash: async () => { throw new Error('nothing is trashed here'); },
    },
    metadataCache: { getFileCache: (f) => (indexed.has(f.path) ? { frontmatter: f.fm } : null) },
    fileManager: {
      processFrontMatter: async (f, fn) => { fn(f.fm); f.stat.mtime += 1; },
      trashFile: async () => { throw new Error('nothing is trashed here'); },
    },
  };
  const p = Object.create(PluginClass.prototype);
  p.settings = {
    plannerFolder: ROOT, todoistToken: 't', completeOnSource: false, pushEdits: false,
    _shadow: {},
  };
  p.secrets = null;
  p.app = app;
  p._pushTimers = new Map();
  p._syncWrites = new Map();
  p._goneProbed = new Set();
  return { p, created };
}

const fetched = (id, title) => ({
  source: 'todoist', id, title, description: '', due: null, priority: 4, url: null,
  tags: [], status: null, recurring: false, dueString: null,
});

function withWindow(fn) {
  const RealNotice = T.__obsidian.Notice;
  T.__obsidian.Notice = function () { };
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = { setTimeout: () => 0, clearTimeout: () => { } };
  return Promise.resolve(fn()).finally(() => {
    T.__obsidian.Notice = RealNotice;
    if (!hadWindow) delete globalThis.window;
  });
}

test('THE DEFECT: a cold cache over notes that already exist creates no "-2" copy', () => {
  const notes = [taskNote('101', 'Buy milk'), taskNote('102', 'Call the bank')];
  const { p, created } = plugin(notes, new Set());
  return withWindow(async () => {
    await p.upsertSource('todoist', { ok: true, items: [fetched('101', 'Buy milk'), fetched('102', 'Call the bank')] });
    assert.deepEqual(created, [], 'every task already has its note; the cache just has not read them yet');
  });
});

test('a partly read cache defers every new note, not only the ones it cannot see', () => {
  const known = taskNote('101', 'Buy milk');
  const unread = taskNote('102', 'Call the bank');
  const { p, created } = plugin([known, unread], new Set([known.path]));
  return withWindow(async () => {
    await p.upsertSource('todoist', { ok: true, items: [fetched('101', 'Buy milk'), fetched('102', 'Call the bank renamed')] });
    assert.deepEqual(created, [], 'a renamed task would get a second note under its new title');
    assert.ok(known.fm.synced_at, 'the note the cache has read is still updated in the same pass');
  });
});

test('with the cache ready, a task that is really new gets its note', () => {
  const known = taskNote('101', 'Buy milk');
  const { p, created } = plugin([known], new Set([known.path]));
  return withWindow(async () => {
    await p.upsertSource('todoist', { ok: true, items: [fetched('101', 'Buy milk'), fetched('103', 'Book the dentist')] });
    assert.deepEqual(created, [`${FOLDER}/Book the dentist (todoist-103).md`]);
  });
});

test('unindexedNoteCount counts the markdown notes in the room the cache has not read', () => {
  const a = taskNote('101', 'Buy milk');
  const b = taskNote('102', 'Call the bank');
  const pic = new TFile(); pic.path = `${FOLDER}/scan.png`; pic.extension = 'png';
  const { p } = plugin([a, b, pic], new Set([a.path]));
  assert.equal(T.unindexedNoteCount(p.app, ROOT), 1, 'only the unread note; a non-markdown file is never cached');
  const { p: warm } = plugin([a, b], new Set([a.path, b.path]));
  assert.equal(T.unindexedNoteCount(warm.app, ROOT), 0);
  const { p: none } = plugin([], new Set());
  assert.equal(T.unindexedNoteCount(none.app, 'no such folder'), 0);
});
