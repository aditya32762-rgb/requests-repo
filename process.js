// process.js
// Handles redeem request issues and updates private repos.

const fs = require('fs');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));

const GITHUB_API = 'https://api.github.com';
const PRIVATE_TOKEN = process.env.PRIVATE_REPO_PAT;
if (!PRIVATE_TOKEN) {
    console.error('PRIVATE_REPO_PAT not set');
    process.exit(1);
}

async function gh(path, method = 'GET', body = null, headers = {}) {
    const url = `${GITHUB_API}${path}`;
    const opts = {
        method,
        headers: Object.assign(
            {
                'Authorization': `token ${PRIVATE_TOKEN}`,
                'User-Agent': 'request-action',
                'Accept': 'application/vnd.github.v3+json'
            },
            headers
        )
    };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { json = text; }
    return { ok: r.ok, status: r.status, body: json, text };
}

function parseIssueBody(body) {
    const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const out = {};
    for (const l of lines) {
        const m = l.match(/^([^:]+):\s*(.+)$/);
        if (m) out[m[1].toLowerCase()] = m[2].trim();
    }
    return out;
}

async function getFile(owner, repo, filePath) {
    const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`);
    if (!res.ok) throw new Error(`GET ${filePath} failed ${res.status}`);
    const contentB64 = res.body.content.replace(/\n/g, '');
    const raw = Buffer.from(contentB64, 'base64').toString('utf8');
    return { raw, sha: res.body.sha };
}

async function putFile(owner, repo, filePath, newContent, sha, message) {
    const body = {
        message,
        content: Buffer.from(newContent, 'utf8').toString('base64'),
        sha
    };
    const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, 'PUT', body);
    if (!res.ok) throw new Error(`PUT ${filePath} failed ${res.status}`);
    return res.body;
}

async function createFileIfMissing(owner, repo, filePath, newContent, message) {
    const body = {
        message,
        content: Buffer.from(newContent, 'utf8').toString('base64')
    };
    const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, 'PUT', body);
    if (!res.ok) throw new Error(`CREATE ${filePath} failed ${res.status}`);
    return res.body;
}

async function commentIssue(owner, repo, issueNumber, text) {
    return gh(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, 'POST', { body: text });
}

function isoNow() {
    return new Date().toISOString();
}

(async () => {
    try {
        const eventPath = process.env.GITHUB_EVENT_PATH;
        if (!eventPath) throw new Error('No GITHUB_EVENT_PATH');
        const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
        const issue = ev.issue;
        const owner = ev.repository.owner.login;
        const requestRepo = ev.repository.name;
        const issueNumber = issue.number;
        const parsed = parseIssueBody(issue.body || '');

        if ((parsed.action || '').toLowerCase() !== 'redeem') {
            await commentIssue(owner, requestRepo, issueNumber, '❌ Unsupported action.');
            return;
        }

        const username = parsed.username;
        const hwid = parsed.hwid || null;
        const code = parsed.code;
        if (!username || !code) {
            await commentIssue(owner, requestRepo, issueNumber, '❌ Missing username or code.');
            return;
        }

        // private repos
        const usersRepo = 'users';
        const codesRepo = 'codes';

        // load active_codes.json
        let active = [];
        let activeSha = null;
        try {
            const f = await getFile(owner, codesRepo, 'active_codes.json');
            active = JSON.parse(f.raw);
            activeSha = f.sha;
        } catch (e) {
            await commentIssue(owner, requestRepo, issueNumber, '❌ Error reading codes.');
            return;
        }

        const codeNorm = code.trim().toUpperCase();
        const idx = active.findIndex(c => (c.code || '').toUpperCase() === codeNorm && !c.used);
        if (idx === -1) {
            await commentIssue(owner, requestRepo, issueNumber, '❌ Invalid or already used code.');
            return;
        }

        const entry = Object.assign({}, active[idx]);
        const usedAt = isoNow();

        // determine expiry
        let grantedExpiry = null;
        if (entry.expiry) {
            const dt = new Date(entry.expiry);
            if (dt < new Date()) {
                await commentIssue(owner, requestRepo, issueNumber, '❌ Code expired.');
                return;
            }
            grantedExpiry = entry.expiry;
        } else {
            const days = Number(entry.duration_days) || 30;
            const exp = new Date(new Date().getTime() + days * 24 * 3600 * 1000);
            grantedExpiry = exp.toISOString();
        }

        // mark used
        const usedEntry = Object.assign({}, entry, {
            used: true,
            used_by: username,
            used_by_hwid: hwid,
            used_at: usedAt,
            granted_expiry: grantedExpiry
        });

        active.splice(idx, 1);

        // load expired_codes.json
        let expired = [];
        let expiredSha = null;
        try {
            const fe = await getFile(owner, codesRepo, 'expired_codes.json');
            expired = JSON.parse(fe.raw);
            expiredSha = fe.sha;
        } catch (e) {
            expired = [];
        }
        expired.push(usedEntry);

        // load users.json
        let users = [];
        let usersSha = null;
        try {
            const fu = await getFile(owner, usersRepo, 'users.json');
            users = JSON.parse(fu.raw);
            usersSha = fu.sha;
        } catch (e) {
            users = [];
        }

        let userRec = users.find(u => (u.username || '').toLowerCase() === username.toLowerCase());
        if (!userRec) {
            userRec = {
                username,
                hwid,
                tokens: []
            };
            users.push(userRec);
        }
        userRec.hwid = userRec.hwid || hwid;
        userRec.tokens.push({
            code: usedEntry.code,
            granted_expiry: grantedExpiry,
            redeemed_at: usedAt
        });

        // write back changes
        await putFile(owner, codesRepo, 'active_codes.json', JSON.stringify(active, null, 2), activeSha, `Mark ${entry.code} used`);
        if (expiredSha) {
            await putFile(owner, codesRepo, 'expired_codes.json', JSON.stringify(expired, null, 2), expiredSha, `Add expired ${entry.code}`);
        } else {
            await createFileIfMissing(owner, codesRepo, 'expired_codes.json', JSON.stringify(expired, null, 2), 'Create expired_codes.json');
        }

        if (usersSha) {
            await putFile(owner, usersRepo, 'users.json', JSON.stringify(users, null, 2), usersSha, `Update user ${username}`);
        } else {
            await createFileIfMissing(owner, usersRepo, 'users.json', JSON.stringify(users, null, 2), 'Create users.json');
        }

        const dateOnly = grantedExpiry.split('T')[0];
        await commentIssue(owner, requestRepo, issueNumber, `✅ Redeem OK — expires: ${dateOnly}`);

        await gh(`/repos/${owner}/${requestRepo}/issues/${issueNumber}/labels`, 'POST', { labels: ['processed'] });
        await gh(`/repos/${owner}/${requestRepo}/issues/${issueNumber}`, 'PATCH', { state: 'closed' });

    } catch (e) {
        console.error('process.js error:', e);
    }
})();
