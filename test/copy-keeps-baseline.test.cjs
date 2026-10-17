/* A "-2" COPY NEVER MOVES THE BASELINE.
 *
 * The defect: when a sync pass does not recognise a note that already sits
 * at a task's path (its frontmatter could not be read, or the cache was
 * cold), createItemFile writes `<title> (<source>-<id>)-2.md` beside it and
 * then REPLACED the task's shadow with the source's current values. If the
 * source had changed in the meantime (a due date removed in Todoist), the
 * original note kept its old value while its baseline now said the new one.
 * From then on threeWayMerge read the old value as a local edit, and with
 * "Push edits to the source" off it was kept, unpushed, for ever.
 *
 * The rule now: a copy written beside an existing note leaves that note's
 * baseline alone. A task seen for the first time still gets its shadow
 * seeded from the source, exactly as before.
 *
 * Both gates drive the real upsertSource against a recording connector.
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
const ID = '6Xq2mT9vLp4RkW8n';
const TITLE = 'Book the garage';
const DUE = '2026-10-03';
const KEY = `todoist:${ID}`;

function file(path) {
  const f = new TFile();
  f.path = path;
  f.basename = path.split('/').pop().replace(/\.md$/, '');
  f.extension = 'md';
  f.body = '';
  f.stat = { mtime: 1000, ctime: 1000, size: 0 };
  return f;
}

// A synced note whose frontmatter the cache can read (or, with
// `unreadable`, cannot: the YAML-error case Obsidian reports as no
// frontmatter at all).
function note(id, title, fm) {
  const f = file(`${FOLDER}/${title} (todoist-${id}).md`);
  f.fm = Object.assign({
    type: 'planner-item', source: 'todoist', external_id: id, title,
    status: 'open', due: null, priority: 4, url: null, tags: [], source_status: null,
    list_id: null, parent_id: null, recurring: false, due_string: null,
    planned_day: null, planned_half: null, planned_order: 0,
    weekly_goal: false, done_local: false, linked_note: null,
  }, fm || {});
  return f;
}

function plugin(shadow, files) {
  const sub = new TFolder(); sub.path = FOLDER; sub.children = files.slice();
  const root = new TFolder(); root.path = ROOT; root.children = [sub];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const created = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === ROOT ? root : (byPath.get(p) || null)),
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); f.stat.mtime += 1; },
      // A new note lands in the folder, and the cache has not read it yet.
      create: async (p, content) => {
        const f = file(p);
        f.fm = null;
        f.content = content;
        created.push(f);
        sub.children.push(f);
        byPath.set(p, f);
        return f;
      },
    },
    metadataCache: { getFileCache: (f) => (f.unreadable || !f.fm ? {} : { frontmatter: f.fm }) },
    fileManager: {
      processFrontMatter: async (f, fn) => { fn(f.fm); f.stat.mtime += 1; },
    },
  };
  const p = Object.create(PluginClass.prototype);
  p.settings = { plannerFolder: ROOT, todoistToken: 'tok', completeOnSource: false, pushEdits: false, _shadow: shadow };
  p.secrets = null;
  p.app = app;
  p._pushTimers = new Map();
  p._syncWrites = new Map();
  p._goneProbed = new Set();
  // The member removing a duplicate: the file leaves the folder.
  const remove = (f) => { sub.children = sub.children.filter((c) => c !== f); byPath.delete(f.path); };
  return { p, created, remove };
}

// Swap the methods that speak HTTP for a recorder, for the duration.
function recordConnector(fn) {
  const c = T.CONNECTORS.todoist;
  const realClosed = c.setClosed;
  const realPush = c.pushFields;
  const writes = [];
  c.setClosed = async (s, item, closed) => { writes.push({ id: item.id, closed }); };
  c.pushFields = async (s, item, pushes) => { writes.push({ id: item.id, pushes }); };
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = { setTimeout: () => 0, clearTimeout: () => { } };
  return Promise.resolve(fn(writes)).finally(() => {
    c.setClosed = realClosed;
    c.pushFields = realPush;
    if (!hadWindow) delete globalThis.window;
  });
}

// The task as the source returns it today: its due date was removed there.
const sourceTask = (id, title, due) => ({
  id, title, due: due || null, priority: 4, description: '',
  status: null, listId: null, tags: [], url: null,
  parentId: null, recurring: false, dueString: null,
});

test('a due date removed at the source is emptied in the note on the next sync, and a first sight still seeds the shadow', async () => {
  const kept = note(ID, TITLE, { due: DUE });
  const { p, created } = plugin({ [KEY]: { title: TITLE, due: DUE, priority: 4, description: '', done: false } }, [kept]);
  await recordConnector(async (writes) => {
    await p.upsertSource('todoist', {
      items: [sourceTask(ID, TITLE, null), sourceTask('6Xq2mT9vLp4RkW8p', 'Buy the window stay', '2026-10-20')],
    });
    assert.deepEqual(writes, [], 'push is off: nothing goes to the source');
  });
  assert.equal(kept.fm.due, null, 'the note follows the source');
  assert.equal(p.settings._shadow[KEY].due, null, 'the baseline follows the source');
  assert.equal(created.length, 1, 'only the task never seen before gets a note');
  assert.equal(created[0].path, `${FOLDER}/Buy the window stay (todoist-6Xq2mT9vLp4RkW8p).md`);
  assert.deepEqual(p.settings._shadow['todoist:6Xq2mT9vLp4RkW8p'],
    { due: '2026-10-20', priority: 4, description: '', done: false },
    'a task seen for the first time is seeded from the source');
});

test('THE BUG: a "-2" copy beside an unreadable note keeps that note\'s baseline, so the removed due still reaches it', async () => {
  const original = note(ID, TITLE, { due: DUE });
  original.unreadable = true; // its frontmatter cannot be read on this pass
  const { p, created, remove } = plugin({ [KEY]: { title: TITLE, due: DUE, priority: 4, description: '', done: false } }, [original]);
  await recordConnector(async (writes) => {
    await p.upsertSource('todoist', { items: [sourceTask(ID, TITLE, null)] });
    assert.equal(created.length, 1, 'the pass did not see the note, so it wrote a copy');
    assert.equal(created[0].path, `${FOLDER}/${TITLE} (todoist-${ID})-2.md`);
    // THE RED: on 0.16.2 the copy replaced the shadow, so this read null
    // while the original note still said DUE.
    assert.equal(p.settings._shadow[KEY].due, DUE, 'the copy must not move the original note\'s baseline');

    // The member removes the duplicate and the frontmatter is readable
    // again. The next pass must now read the source's change, not a local
    // edit: the original note loses the due date the source removed.
    remove(created[0]);
    original.unreadable = false;
    await p.upsertSource('todoist', { items: [sourceTask(ID, TITLE, null)] });
    assert.deepEqual(writes, [], 'push is off: nothing goes to the source');
  });
  assert.equal(original.fm.due, null, 'the original note follows the source');
  assert.equal(p.settings._shadow[KEY].due, null, 'and so does its baseline');
});
