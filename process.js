// process.js
const { Octokit } = require("@octokit/rest");

// env inputs from workflow
const ISSUE_NUMBER = process.env.ISSUE_NUMBER;
const ISSUE_BODY = process.env.ISSUE_BODY || "";
const REQUESTS_OWNER = process.env.REQUESTS_REPO_OWNER;
const REQUESTS_NAME = process.env.REQUESTS_REPO_NAME;

const TOKEN_CODES = process.env.CODES_REPO_READ_TOKEN;
const TOKEN_USERS = process.env.WRITE_TOKEN_USERS_REPO;

if (!TOKEN_CODES || !TOKEN_USERS) {
  console.error("Missing secrets: add WRITE_TOKEN_USERS_REPO and CODES_REPO_READ_TOKEN");
  process.exit(1);
}

const octoCodes = new Octokit({ auth: TOKEN_CODES });
const octoUsers = new Octokit({ auth: TOKEN_USERS });
const octoRequests = new Octokit({ auth: TOKEN_USERS }); // used to comment back on issue (use TOKEN_USERS with repo write)

function parseField(name){
  const line = ISSUE_BODY.split("\n").find(l => l.toLowerCase().startsWith(name + ":"));
  return line ? line.split(":").slice(1).join(":").trim() : "";
}

const username = parseField("username");
const hwid = parseField("hwid");
const code = parseField("code");

async function postComment(text){
  await octoRequests.issues.createComment({
    owner: REQUESTS_OWNER,
    repo: REQUESTS_NAME,
    issue_number: ISSUE_NUMBER,
    body: text
  });
}

if (!username || !hwid || !code) {
  postComment("Invalid request. Please include lines:\n```\nusername: yourname\nhwid: YOUR-HWID\ncode: REDEEM-CODE\n```");
  console.error("Missing fields in issue body");
  process.exit(1);
}

async function getFile(octo, owner, repo, path){
  const res = await octo.repos.getContent({ owner, repo, path });
  const content = Buffer.from(res.data.content, "base64").toString("utf8");
  return { json: JSON.parse(content), sha: res.data.sha };
}

async function updateFile(octo, owner, repo, path, message, jsonObj, sha){
  const content = Buffer.from(JSON.stringify(jsonObj, null, 2)).toString("base64");
  await octo.repos.createOrUpdateFileContents({
    owner, repo, path, message, content, sha
  });
}

(async () => {
  try {
    // 1) fetch active_codes.json from codes-repo
    const codesOwner = "aditya32762-rgb";
    const codesRepo = "codes-repo";
    const codesPath = "active_codes.json";

    const codesFile = await getFile(octoCodes, codesOwner, codesRepo, codesPath);
    const codesJson = codesFile.json;

    // find code
    const found = (codesJson.codes || []).find(c => (c.code || "").trim().toUpperCase() === code.trim().toUpperCase());
    if (!found) {
      await postComment(`Code not found: \`${code}\``);
      return;
    }
    if (found.used) {
      await postComment(`Code already used: \`${code}\``);
      return;
    }

    // 2) fetch users.json
    const usersOwner = "aditya32762-rgb";
    const usersRepo = "users-repo";
    const usersPath = "users.json";

    let usersFile;
    try {
      usersFile = await getFile(octoUsers, usersOwner, usersRepo, usersPath);
    } catch (err) {
      // if users.json missing, initialize
      usersFile = { json: { users: [] }, sha: null };
    }
    const usersJson = usersFile.json;
    usersJson.users = usersJson.users || [];

    // 3) ensure code not already assigned in usersJson
    if (usersJson.users.some(u => (u.code||"").trim().toUpperCase() === code.trim().toUpperCase())) {
      await postComment(`Code already assigned in users.json: \`${code}\``);
      return;
    }

    // 4) create user entry
    const now = new Date();
    const durationDays = found.durationDays || 30;
    const expiry = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const hwidHash = require('crypto').createHash('sha256').update(hwid, 'utf8').digest('hex');

    const newUser = {
      username,
      passwordHash: "",
      hwidHash,
      code: found.code,
      activatedUtc: now.toISOString(),
      expiryUtc: expiry,
      revoked: false
    };
    usersJson.users.push(newUser);

    // 5) mark code used
    for (const c of codesJson.codes) {
      if ((c.code||"").trim().toUpperCase() === code.trim().toUpperCase()) c.used = true;
    }

    // 6) write back users.json
    await updateFile(octoUsers, usersOwner, usersRepo, usersPath, `Add user ${username}`, usersJson, usersFile.sha);

    // 7) write back active_codes.json
    await updateFile(octoCodes, codesOwner, codesRepo, codesPath, `Mark code ${code} used`, codesJson, codesFile.sha);

    // 8) comment success
    await postComment(`Redeem successful for user \`${username}\`. Access granted until **${expiry}**.`);
  } catch (err) {
    console.error("Error:", err);
    try { await postComment("Server error while processing the redeem request. Contact admin."); } catch(e){ console.error("Also failed posting comment", e); }
    process.exit(1);
  }
})();
