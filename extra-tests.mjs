// Extra edge-case tests for mend, beyond the kit's practice set. Each case: argv, stdin,
// starting files, expected exit/stdout/files. Run: node extra-tests.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
const NODE = process.execPath;

function runCase(c) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-x-'));
  try {
    for (const [p, text] of Object.entries(c.files)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(NODE, [MAIN, ...c.argv], { cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10000 });
    const gotExit = r.status;
    const gotOut = r.stdout ?? '';
    const gotFiles = {};
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else gotFiles[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
      }
    };
    walk(dir);
    const problems = [];
    if (gotExit !== c.exit) problems.push(`exit ${gotExit} != ${c.exit}`);
    if (gotOut !== c.stdout) problems.push(`stdout ${JSON.stringify(gotOut)} != ${JSON.stringify(c.stdout)}`);
    for (const p of new Set([...Object.keys(c.files), ...Object.keys(gotFiles)])) {
      const want = c.expectFiles?.[p] !== undefined ? c.expectFiles[p] : c.files[p];
      if (c.expectFiles && !(p in c.expectFiles) && !(p in c.files)) problems.push(`${p} unexpected`);
      else if (c.expectFiles && p in c.expectFiles && c.expectFiles[p] === null && p in gotFiles) problems.push(`${p} should be deleted`);
      else if (c.expectFiles && p in c.expectFiles && c.expectFiles[p] !== null && gotFiles[p] !== c.expectFiles[p]) problems.push(`${p} = ${JSON.stringify(gotFiles[p])} != ${JSON.stringify(c.expectFiles[p])}`);
      else if (!c.expectFiles && gotFiles[p] !== c.files[p]) problems.push(`${p} changed unexpectedly`);
    }
    if (problems.length) console.log(`FAIL ${c.name}\n  ${problems.join('\n  ')}`);
    else console.log(`ok ${c.name}`);
    return problems.length === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  // 1. unified: section with no hunks, existing file -> ok 0 files
  { name: 'u-nohunk-ok', argv: ['p.patch'], files: { 'p.patch': '--- a/f.txt\n+++ b/f.txt\n', 'f.txt': 'hello\n' }, exit: 0, stdout: 'ok: 0 files\n', expectFiles: {} },
  // 2. unified: section with no hunks, missing file -> missing
  { name: 'u-nohunk-missing', argv: ['p.patch'], files: { 'p.patch': '--- a/nope.txt\n+++ b/nope.txt\n' }, exit: 1, stdout: 'error: missing nope.txt\nfailed: 1 of 1 edits\n', expectFiles: {} },
  // 3. unified: creation with no hunks -> empty file created
  { name: 'u-create-nohunk', argv: ['p.patch'], files: { 'p.patch': '--- /dev/null\n+++ b/new.txt\n' }, exit: 0, stdout: 'A new.txt\nok: 1 file\n', expectFiles: { 'new.txt': '' } },
  // 4. unified: --- without +++ in header -> parse <line after>
  { name: 'u-header-parse', argv: ['p.patch'], files: { 'p.patch': 'diff --git a/f b/f\n--- a/f\n@@ -1 +1 @@\n-a\n+b\n' }, exit: 2, stdout: 'error: parse 3\n', expectFiles: {} },
  // 5. unified: malformed diff --git -> parse <its line>
  { name: 'u-diffgit-parse', argv: ['p.patch'], files: { 'p.patch': 'diff --git f g\n--- a/f\n+++ b/f\n' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 6. unified: hunk before any section -> parse <its line> (format forced so it parses as unified)
  { name: 'u-hunk-first', argv: ['--format=unified', 'p.patch'], files: { 'p.patch': '@@ -1 +1 @@\n-a\n+b\n' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 6b. same patch, auto-detected -> no format detected at all
  { name: 'u-hunk-first-auto', argv: ['p.patch'], files: { 'p.patch': '@@ -1 +1 @@\n-a\n+b\n' }, exit: 2, stdout: 'error: format\n', expectFiles: {} },
  // 7. unified: garbage @@ line -> parse <its line>
  { name: 'u-at-parse', argv: ['p.patch'], files: { 'p.patch': '--- a/f\n+++ b/f\n@@ garbage\n-a\n' }, exit: 2, stdout: 'error: parse 3\n', expectFiles: {} },
  // 8. unified: rename from/to only, no ---/+++
  { name: 'u-rename-only', argv: ['p.patch'], files: { 'p.patch': 'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n@@ -1 +1 @@\n-a\n+b\n', 'old.txt': 'a\n' }, exit: 0, stdout: 'R old.txt -> new.txt\nok: 1 file\n', expectFiles: { 'old.txt': null, 'new.txt': 'b\n' } },
  // 9. unified: empty-O insert at top (A=0)
  { name: 'u-insert-top', argv: ['p.patch'], files: { 'p.patch': '--- a/f\n+++ b/f\n@@ -0,0 +1 @@\n+top\n', 'f': 'a\nb\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', expectFiles: { f: 'top\na\nb\n' } },
  // 10. unified: A beyond EOF clamps insertion to end
  { name: 'u-insert-clamp', argv: ['p.patch'], files: { 'p.patch': '--- a/f\n+++ b/f\n@@ -99,0 +100,1 @@\n+end\n', 'f': 'a\nb\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', expectFiles: { f: 'a\nb\nend\n' } },
  // 11. unified: pure deletion hunk at EOF, file has no trailing newline, \\ after - line
  { name: 'u-noeol-del', argv: ['p.patch'], files: { 'p.patch': '--- a/f\n+++ b/f\n@@ -2,1 +1,0 @@\n-b\n\\ No newline at end of file\n', 'f': 'a\nb' }, exit: 0, stdout: 'M f\nok: 1 file\n', expectFiles: { f: 'a\n' } },
  // 12. unified: two sections, second fails -> exit 1, nothing written
  { name: 'u-atomic', argv: ['p.patch'], files: { 'p.patch': '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+A\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-z\n+Z\n', 'f': 'a\n', 'g': 'g\n' }, exit: 1, stdout: 'error: no-match g\nfailed: 1 of 2 edits\n', expectFiles: {} },
  // 13. search-replace: create over existing -> exists
  { name: 's-create-exists', argv: ['p.patch'], files: { 'p.patch': 'f.txt\n<<<<<<< SEARCH\n=======\nnew\n>>>>>>> REPLACE\n', 'f.txt': 'old\n' }, exit: 1, stdout: 'error: exists f.txt\nfailed: 1 of 1 edits\n', expectFiles: {} },
  // 14. search-replace: replace in missing file -> missing
  { name: 's-replace-missing', argv: ['p.patch'], files: { 'p.patch': 'nope.txt\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' }, exit: 1, stdout: 'error: missing nope.txt\nfailed: 1 of 1 edits\n', expectFiles: {} },
  // 15. search-replace: unsafe path -> unsafe
  { name: 's-unsafe', argv: ['p.patch'], files: { 'p.patch': '../evil.txt\n<<<<<<< SEARCH\n=======\nx\n>>>>>>> REPLACE\n' }, exit: 1, stdout: 'error: unsafe ../evil.txt\nfailed: 1 of 1 edits\n', expectFiles: {} },
  // 16. v4a: pure rename (Move to, no chunks)
  { name: 'v-rename-only', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** End Patch\n', 'a.txt': 'hi\n' }, exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', expectFiles: { 'a.txt': null, 'b.txt': 'hi\n' } },
  // 17. v4a: update with no chunk and no move -> parse at Update line
  { name: 'v-nochunk', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Update File: a.txt\n*** End Patch\n', 'a.txt': 'hi\n' }, exit: 2, stdout: 'error: parse 2\n', expectFiles: {} },
  // 18. v4a: missing End Patch -> parse <lines+1>
  { name: 'v-noend', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Add File: a.txt\n+x\n' }, exit: 2, stdout: 'error: parse 4\n', expectFiles: {} },
  // 19. v4a: first non-blank not Begin -> parse <that line> (format forced)
  { name: 'v-nobegin', argv: ['--format=v4a', 'p.patch'], files: { 'p.patch': '\n\nhello\n*** Begin Patch\n*** End Patch\n' }, exit: 2, stdout: 'error: parse 3\n', expectFiles: {} },
  // 20. v4a: End of File with no chunk -> parse
  { name: 'v-eof-nochunk', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Update File: a.txt\n*** End of File\n*** End Patch\n' }, exit: 2, stdout: 'error: parse 3\n', expectFiles: {} },
  // 21. v4a: add existing -> exists; delete missing -> missing
  { name: 'v-add-exists', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch\n', 'a.txt': 'hi\n' }, exit: 1, stdout: 'error: exists a.txt\nfailed: 1 of 1 edits\n', expectFiles: {} },
  { name: 'v-del-missing', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n' }, exit: 1, stdout: 'error: missing a.txt\nfailed: 1 of 1 edits\n', expectFiles: {} },
  // 22. v4a: add file with interior blank line and trailing blank stripped
  { name: 'v-add-blanks', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Add File: a.txt\n+one\n\n+three\n\n\n*** End Patch\n' }, exit: 0, stdout: 'A a.txt\nok: 1 file\n', expectFiles: { 'a.txt': 'one\n\nthree\n' } },
  // 23. cli: duplicate --check -> usage
  { name: 'c-dup-check', argv: ['--check', '--check', 'p.patch'], files: { 'p.patch': '[]' }, exit: 2, stdout: 'error: usage\n', expectFiles: {} },
  // 24. cli: unknown flag -> usage
  { name: 'c-unknown-flag', argv: ['--bogus', 'p.patch'], files: { 'p.patch': '[]' }, exit: 2, stdout: 'error: usage\n', expectFiles: {} },
  // 25. cli: bad --format value -> usage
  { name: 'c-bad-format', argv: ['--format=bogus', 'p.patch'], files: { 'p.patch': '[]' }, exit: 2, stdout: 'error: usage\n', expectFiles: {} },
  // 26. cli: two positionals -> usage
  { name: 'c-two-pos', argv: ['a.patch', 'b.patch'], files: { 'a.patch': '[]' }, exit: 2, stdout: 'error: usage\n', expectFiles: {} },
  // 27. cli: -- ends options, PATCH after it starting with dash
  { name: 'c-dashdash', argv: ['--', '--weird'], files: { '--weird': '[]' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 28. cli: --check success writes nothing
  { name: 'c-check-ok', argv: ['--check', 'p.patch'], files: { 'p.patch': 'f.txt\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n', 'f.txt': 'a\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', expectFiles: { 'f.txt': 'a\n' } },
  // 29. json: array form fault -> parse at array start line
  { name: 'j-array-fault', argv: ['p.patch'], files: { 'p.patch': '\n[{"command": "bogus", "path": "f.txt"}]\n' }, exit: 2, stdout: 'error: parse 2\n', expectFiles: {} },
  // 30. json: empty array -> parse 1
  { name: 'j-empty-array', argv: ['p.patch'], files: { 'p.patch': '[]\n' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 31. chained moves a->b, b->c
  { name: 'u-chain-move', argv: ['p.patch'], files: { 'p.patch': 'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-a\n+A\ndiff --git a/b.txt b/c.txt\nrename from b.txt\nrename to c.txt\n--- a/b.txt\n+++ b/c.txt\n@@ -1 +1 @@\n-A\n+B\n', 'a.txt': 'a\n' }, exit: 0, stdout: 'D a.txt\nA c.txt\nok: 2 files\n', expectFiles: { 'a.txt': null, 'c.txt': 'B\n' } },
  // 32. move then edit moved file
  { name: 'u-move-edit', argv: ['p.patch'], files: { 'p.patch': 'diff --git a/a.txt b/b.txt\nrename from a.txt\nrename to b.txt\n--- a/a.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-a\n+A\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n-A\n+B\n', 'a.txt': 'a\n' }, exit: 0, stdout: 'R a.txt -> b.txt\nok: 1 file\n', expectFiles: { 'a.txt': null, 'b.txt': 'B\n' } },
  // 33. v4a EOF chunk: O occurs mid-file at tier 0 and at EOF at tier 2 only
  { name: 'v-eof-tier', argv: ['p.patch'], files: { 'p.patch': '*** Begin Patch\n*** Update File: f.txt\n x\n-y\n+z\n*** End of File\n*** End Patch\n', 'f.txt': 'x\ny\n  x\n  y\n' }, exit: 0, stdout: 'M f.txt\nok: 1 file\n', expectFiles: { 'f.txt': 'x\ny\n  x\n  z\n' } },
  // 34. unified: create with \\ after last + line -> no trailing break
  { name: 'u-create-noeol', argv: ['p.patch'], files: { 'p.patch': '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n\\ No newline at end of file\n' }, exit: 0, stdout: 'A new.txt\nok: 1 file\n', expectFiles: { 'new.txt': 'hello' } },
  // 35. unified: format forced, no sections -> parse 1
  { name: 'u-forced-empty', argv: ['--format=unified', 'p.patch'], files: { 'p.patch': 'just prose\n' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 36. search-replace forced, no blocks -> parse 1
  { name: 's-forced-empty', argv: ['--format=search-replace', 'p.patch'], files: { 'p.patch': 'just prose\n' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 37. v4a forced on json text -> parse at first non-blank line
  { name: 'v-forced-wrong', argv: ['--format=v4a', 'p.patch'], files: { 'p.patch': '[{"command":"create","path":"f","file_text":"x"}]\n' }, exit: 2, stdout: 'error: parse 1\n', expectFiles: {} },
  // 38. empty patch, auto -> format error
  { name: 'c-empty-patch', argv: ['p.patch'], files: { 'p.patch': '' }, exit: 2, stdout: 'error: format\n', expectFiles: {} },
  // 39. patch file missing -> no-patch
  { name: 'c-no-patch', argv: ['ghost.patch'], files: {}, exit: 2, stdout: 'error: no-patch\n', expectFiles: {} },
  // 40. unified: hunk body with \\ after context line mid-hunk does not affect final break
  { name: 'u-noeol-mid', argv: ['p.patch'], files: { 'p.patch': '--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n\\ No newline at end of file\n-b\n+B\n', 'f': 'a\nb\n' }, exit: 0, stdout: 'M f\nok: 1 file\n', expectFiles: { f: 'a\nB\n' } },
];

let pass = 0;
for (const c of cases) if (runCase(c)) pass += 1;
console.log(`${pass} of ${cases.length} extra passed`);
