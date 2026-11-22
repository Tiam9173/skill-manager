import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const HOME = os.homedir();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(HOME, '.skill-manager');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BACKUPS = path.join(DATA_DIR, 'backups');
const PORT = Number(process.env.PORT || 4780);
const TAR = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

const NAME_RE = /^[A-Za-z0-9._-]+$/;

function defaultConfig() {
  const wb = path.join(HOME, '.workbuddy-ai', 'skills');
  return {
    lang: 'zh-CN',
    sources: [
      { id: 'codex', kind: 'codex', path: path.join(HOME, '.codex', 'skills') },
      { id: 'workbuddy-cn', kind: 'workbuddy', path: wb },
      { id: 'workbuddy-intl', kind: 'workbuddy', path: wb },
    ],
  };
}

async function loadConfig() {
  try {
    const cfg = JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(cfg.sources) || !cfg.sources.length) return defaultConfig();
    cfg.sources = cfg.sources.filter((s) => s && typeof s.id === 'string' && typeof s.path === 'string');
    return cfg.sources.length ? cfg : defaultConfig();
  } catch {
    return defaultConfig();
  }
}

async function saveConfig(cfg) {
  await ensureDir(DATA_DIR);
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function disabledPathFor(root) {
  return path.join(path.dirname(root), path.basename(root) + '-disabled');
}

function resolveSource(cfg, id) {
  const s = cfg.sources.find((x) => x.id === id);
  if (!s) throw new Error('未知来源');
  return { ...s, root: s.path, disabled: disabledPathFor(s.path) };
}

function assertName(name) {
  if (!name || !NAME_RE.test(name) || name === '.' || name === '..') {
    throw new Error('非法技能名');
  }
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function parseFrontmatter(text) {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const raw = m[1];
  const out = {};
  const nameM = raw.match(/^name:\s*(.+)$/m);
  if (nameM) out.name = nameM[1].trim().replace(/^["']|["']$/g, '');

  const lines = raw.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^description:/.test(l));
  if (idx >= 0) {
    const first = lines[idx].replace(/^description:\s*/, '');
    if (/^[>|][+-]?$/.test(first.trim())) {
      const block = [];
      for (let i = idx + 1; i < lines.length; i++) {
        if (/^\s+\S/.test(lines[i]) || lines[i].trim() === '') block.push(lines[i].trim());
        else break;
      }
      out.description = block.join(' ').replace(/\s+/g, ' ').trim();
    } else {
      out.description = first.trim().replace(/^["']|["']$/g, '');
    }
  }
  return out;
}

async function walk(dir, base = dir, acc = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, base, acc);
    else if (e.isFile()) {
      const st = await fsp.stat(full);
      acc.push({ rel: path.relative(base, full).split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs });
    }
  }
  return acc;
}

async function readYamlFlag(dir) {
  const p = path.join(dir, 'agents', 'openai.yaml');
  if (!(await exists(p))) return { hasYaml: false, allowImplicit: true };
  const text = await fsp.readFile(p, 'utf8');
  const m = text.match(/allow_implicit_invocation:\s*(true|false)/i);
  return { hasYaml: true, allowImplicit: m ? m[1].toLowerCase() === 'true' : true };
}

async function readSkill(dir, state) {
  const skillFile = path.join(dir, 'SKILL.md');
  if (!(await exists(skillFile))) return null;
  const text = await fsp.readFile(skillFile, 'utf8');
  const fm = parseFrontmatter(text);
  const files = await walk(dir);
  const yaml = await readYamlFlag(dir);
  let source = null;
  const srcFile = path.join(dir, '.skill-source.json');
  if (await exists(srcFile)) {
    try { source = JSON.parse(await fsp.readFile(srcFile, 'utf8')); } catch {}
  }
  return {
    name: path.basename(dir),
    displayName: fm.name || path.basename(dir),
    description: fm.description || '',
    state,
    dir,
    bytes: files.reduce((a, f) => a + f.size, 0),
    fileCount: files.length,
    hasYaml: yaml.hasYaml,
    allowImplicit: yaml.allowImplicit,
    source,
    mtime: Math.max(0, ...files.map((f) => f.mtime)),
  };
}

async function listSkills(src) {
  const out = [];
  for (const [dir, state] of [[src.root, 'enabled'], [src.disabled, 'disabled']]) {
    if (!(await exists(dir))) continue;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const meta = await readSkill(path.join(dir, e.name), state);
      if (meta) out.push(meta);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function findSkillDir(src, name, state = 'enabled') {
  const root = state === 'disabled' ? src.disabled : src.root;
  const dir = path.join(root, name);
  if (!inside(root, dir)) throw new Error('路径越界');
  return dir;
}

async function backupDir(dir, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS, stamp, label, path.basename(dir));
  await ensureDir(path.dirname(dest));
  await fsp.cp(dir, dest, { recursive: true });
  return dest;
}

async function moveDir(from, to) {
  await ensureDir(path.dirname(to));
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') {
      await fsp.cp(from, to, { recursive: true });
      await fsp.rm(from, { recursive: true, force: true });
    } else throw e;
  }
}

async function setYamlFlag(dir, allow) {
  const agentsDir = path.join(dir, 'agents');
  const p = path.join(agentsDir, 'openai.yaml');
  await ensureDir(agentsDir);
  if (await exists(p)) {
    let text = await fsp.readFile(p, 'utf8');
    if (/allow_implicit_invocation:\s*(true|false)/i.test(text)) {
      text = text.replace(/allow_implicit_invocation:\s*(true|false)/i, `allow_implicit_invocation: ${allow}`);
    } else {
      text = text.replace(/\s*$/, '') + `\npolicy:\n  allow_implicit_invocation: ${allow}\n`;
    }
    await fsp.writeFile(p, text, 'utf8');
  } else {
    const name = path.basename(dir);
    const content = `interface:\n  display_name: "${name}"\n\npolicy:\n  allow_implicit_invocation: ${allow}\n`;
    await fsp.writeFile(p, content, 'utf8');
  }
  return p;
}

async function fetchRepoZip(repo) {
  const clean = repo.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean)) throw new Error('仓库格式应为 owner/repo');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'skillmgr-'));
  const zipPath = path.join(tmp, 'repo.zip');
  let lastErr;
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`https://codeload.github.com/${clean}/zip/refs/heads/${branch}`, { redirect: 'follow' });
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1000) { lastErr = new Error('下载内容异常'); continue; }
      await fsp.writeFile(zipPath, buf);
      lastErr = null;
      break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) throw lastErr;
  const extractDir = path.join(tmp, 'x');
  await ensureDir(extractDir);
  await execFileP(TAR, ['-xf', zipPath, '-C', extractDir], { windowsHide: true });
  const tops = (await fsp.readdir(extractDir, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (!tops.length) throw new Error('解压后为空');
  const repoRoot = path.join(extractDir, tops[0].name);
  return { tmp, repoRoot, repo: clean };
}

async function discoverSkills(repoRoot) {
  const found = [];
  const skillsDir = path.join(repoRoot, 'skills');
  if (await exists(skillsDir)) {
    for (const e of await fsp.readdir(skillsDir, { withFileTypes: true })) {
      if (e.isDirectory() && (await exists(path.join(skillsDir, e.name, 'SKILL.md')))) {
        found.push({ name: e.name, dir: path.join(skillsDir, e.name) });
      }
    }
  }
  if (await exists(path.join(repoRoot, 'SKILL.md'))) {
    found.push({ name: path.basename(repoRoot).replace(/-[^-]+$/, ''), dir: repoRoot });
  }
  return found;
}

async function installSkill(src, repo, skillName) {
  const { tmp, repoRoot, repo: clean } = await fetchRepoZip(repo);
  try {
    const skills = await discoverSkills(repoRoot);
    if (!skills.length) throw new Error('仓库里没有找到 SKILL.md');
    if (!skillName && skills.length > 1) {
      return { needsSelection: true, repo: clean, skills: skills.map((s) => s.name) };
    }
    const pick = skillName ? skills.find((s) => s.name === skillName) : skills[0];
    if (!pick) throw new Error(`仓库里没有技能 ${skillName}`);
    assertName(pick.name);
    const dest = path.join(src.root, pick.name);
    if (await exists(dest)) throw new Error(`目标已存在：${pick.name}`);
    await ensureDir(src.root);
    await fsp.cp(pick.dir, dest, { recursive: true });
    await fsp.writeFile(path.join(dest, '.skill-source.json'), JSON.stringify({ repo: clean, skill: pick.name, installedAt: new Date().toISOString() }, null, 2));
    return { ok: true, installed: pick.name, dir: dest };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function updateSkill(src, name) {
  assertName(name);
  const dir = findSkillDir(src, name, 'enabled');
  if (!(await exists(dir))) throw new Error('技能不存在或已禁用');
  const srcFile = path.join(dir, '.skill-source.json');
  if (!(await exists(srcFile))) throw new Error('缺少来源记录（.skill-source.json），无法自动更新');
  const meta = JSON.parse(await fsp.readFile(srcFile, 'utf8'));
  const backup = await backupDir(dir, `update-${name}`);
  const { tmp, repoRoot, repo: clean } = await fetchRepoZip(meta.repo);
  try {
    const skills = await discoverSkills(repoRoot);
    const pick = skills.find((s) => s.name === (meta.skill || name));
    if (!pick) throw new Error('新版本中找不到该技能');
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.cp(pick.dir, dir, { recursive: true });
    await fsp.writeFile(path.join(dir, '.skill-source.json'), JSON.stringify({ repo: clean, skill: pick.name, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2));
    return { ok: true, backup };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function createSkill(src, name, description) {
  assertName(name);
  const dir = path.join(src.root, name);
  if (await exists(dir)) throw new Error('同名技能已存在');
  await ensureDir(dir);
  const body = `---\nname: ${name}\ndescription: ${description || 'Describe when this skill should be used.'}\n---\n\n# ${name}\n\n## When to use\n\n- \n\n## Steps\n\n1. \n`;
  await fsp.writeFile(path.join(dir, 'SKILL.md'), body, 'utf8');
  return { ok: true, dir };
}

async function readSkillDetail(src, name, state) {
  const dir = findSkillDir(src, name, state);
  if (!(await exists(dir))) throw new Error('技能不存在');
  const text = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  const files = await walk(dir);
  return {
    name,
    state,
    dir,
    skillMd: text,
    files: files.map((f) => ({ rel: f.rel, size: f.size })).sort((a, b) => a.rel.localeCompare(b.rel)),
  };
}

function send(res, code, data, type = 'application/json; charset=utf-8') {
  const body = type.startsWith('application/json') ? JSON.stringify(data) : data;
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = url.pathname;
    const cfg = await loadConfig();

    if (p === '/api/sources') {
      const out = cfg.sources.map((s) => ({
        id: s.id,
        kind: s.kind,
        path: s.path,
        exists: fs.existsSync(s.path),
        sharedWith: cfg.sources.filter((x) => x.id !== s.id && path.resolve(x.path) === path.resolve(s.path)).map((x) => x.id),
      }));
      return send(res, 200, { sources: out, lang: cfg.lang || 'zh-CN' });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return send(res, 200, cfg);
    }

    if (p === '/api/skills') {
      const id = url.searchParams.get('source') || 'codex';
      return send(res, 200, { skills: await listSkills(resolveSource(cfg, id)) });
    }

    if (p === '/api/skill') {
      const id = url.searchParams.get('source') || 'codex';
      const name = url.searchParams.get('name') || '';
      const state = url.searchParams.get('state') === 'disabled' ? 'disabled' : 'enabled';
      assertName(name);
      return send(res, 200, await readSkillDetail(resolveSource(cfg, id), name, state));
    }

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (p === '/api/config') {
        const next = { ...cfg };
        if (Array.isArray(body.sources)) {
          for (const patch of body.sources) {
            const target = next.sources.find((s) => s.id === patch.id);
            if (!target) continue;
            if (typeof patch.path === 'string' && patch.path.trim()) {
              if (!path.isAbsolute(patch.path.trim())) throw new Error('路径必须是绝对路径');
              target.path = path.normalize(patch.path.trim());
            }
          }
        }
        if (typeof body.lang === 'string' && ['zh-CN', 'en'].includes(body.lang)) next.lang = body.lang;
        await saveConfig(next);
        return send(res, 200, { ok: true, config: next });
      }

      if (p === '/api/toggle') {
        const { source, name, enabled } = body;
        assertName(name);
        const src = resolveSource(cfg, source);
        const from = path.join(enabled ? src.disabled : src.root, name);
        const to = path.join(enabled ? src.root : src.disabled, name);
        if (!(await exists(from))) throw new Error('源目录不存在，可能状态已变化');
        if (await exists(to)) throw new Error('目标已存在同名目录');
        await moveDir(from, to);
        return send(res, 200, { ok: true, state: enabled ? 'enabled' : 'disabled' });
      }

      if (p === '/api/implicit') {
        const { source, name, allow } = body;
        assertName(name);
        const src = resolveSource(cfg, source);
        const file = await setYamlFlag(findSkillDir(src, name, 'enabled'), !!allow);
        return send(res, 200, { ok: true, file });
      }

      if (p === '/api/uninstall') {
        const { source, name } = body;
        assertName(name);
        const src = resolveSource(cfg, source);
        const dir = findSkillDir(src, name, 'enabled');
        if (!(await exists(dir))) throw new Error('技能不存在');
        const backup = await backupDir(dir, `uninstall-${name}`);
        await fsp.rm(dir, { recursive: true, force: true });
        return send(res, 200, { ok: true, backup });
      }

      if (p === '/api/install') {
        const { source, repo, skill } = body;
        return send(res, 200, await installSkill(resolveSource(cfg, source), repo, skill));
      }

      if (p === '/api/update') {
        const { source, name } = body;
        return send(res, 200, await updateSkill(resolveSource(cfg, source), name));
      }

      if (p === '/api/create') {
        const { source, name, description } = body;
        return send(res, 200, await createSkill(resolveSource(cfg, source), name, description));
      }
    }

    let filePath = path.join(PUBLIC, p === '/' ? 'index.html' : p);
    if (!inside(PUBLIC, filePath)) return send(res, 403, { error: 'forbidden' });
    if (!(await exists(filePath))) return send(res, 404, { error: 'not found' });
    const ext = path.extname(filePath).toLowerCase();
    return send(res, 200, await fsp.readFile(filePath), MIME[ext] || 'application/octet-stream');
  } catch (e) {
    return send(res, 400, { error: e.message || String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Skill Manager running at http://127.0.0.1:${PORT}`);
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`backups: ${BACKUPS}`);
});
