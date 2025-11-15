// process.js
// Minimal Node script that runs inside the request repo GitHub Action.
// It reads the issue body, parses simple key:value lines, checks active_codes.json in the private codes repo,
// updates codes/users via GitHub Contents API using the PRIVATE_REPO_PAT secret, and comments the issue with the result.


const fs = require('fs');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));


const GITHUB_API = 'https://api.github.com';
const PRIVATE_TOKEN = process.env.PRIVATE_REPO_PAT;
if (!PRIVATE_TOKEN) { console.error('PRIVATE_REPO_PAT not set'); process.exit(1); }


async function gh(path, method='GET', body=null, headers={}){
const url = `${GITHUB_API}${path}`;
const opts = { method, headers: Object.assign({ 'Authorization': `token ${PRIVATE_TOKEN}`, 'User-Agent': 'request-action', 'Accept': 'application/vnd.github.v3+json' }, headers) };
if (body) opts.body = JSON.stringify(body);
const r = await fetch(url, opts);
const text = await r.text();
let json = null;
try { json = JSON.parse(text); } catch (_) { json = text; }
return { ok: r.ok, status: r.status, body: json, text };
}


function parseIssueBody(body){
// Accept lines like: KEY: value
const lines = body.split(/\r?\n/).map(l => l.trim()).filter(l => l.length>0);
const out = {};
for (const l of lines){
const m = l.match(/^([^:]+):\s*(.+)$/);
if (m) out[m[1].toLowerCase()] = m[2].trim();
}
return out;
}


async function getFile(owner, repo, filePath){
const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`);
if (!res.ok) throw new Error(`GET ${filePath} failed ${res.status}`);
const contentB64 = res.body.content.replace(/\n/g,'');
const raw = Buffer.from(contentB64, 'base64').toString('utf8');
return { raw, sha: res.body.sha };
}


async function putFile(owner, repo, filePath, newContent, sha, message){
const body = { message, content: Buffer.from(newContent, 'utf8').toString('base64'), sha };
const res = await gh(`/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`, 'PUT', body);
if (!res.ok) throw new Error(`PUT ${filePath} failed ${res.status} - ${JSON.stringify(res.body)}`);
return res.body;
}


async function commentIssue(owner, repo, issue_number, text){
const res = await gh(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, 'POST', { body: text });
return res;
}


(async ()=>{
try{
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) throw new Error('No GITHUB_EVENT_PATH');
const ev = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const issue = ev.issue || ev; // for safety
const owner = ev.repository.owner.login;
const requestRepo = ev.repository.name;
const issueNumber = issue.number;
const body = issue.body || '';


const parsed = parseIssueBody(body);
if ((parsed.action || '').toLowerCase() !== 'redeem'){
await commentIssue(owner, requestRepo, issueNumber, '❌ Unsupported action.');
return;
}
const username = parsed.username;
const hwid = parsed.hwid;
const code = parsed.code;
if (!username || !code){
await commentIssue(owner, requestRepo, issueNumber, '❌ Missing username or code.');
return;
}


// CONFIG: set your private repos' owner and names (adjust if different)
const usersOwner = owner; // same org/user
})();
