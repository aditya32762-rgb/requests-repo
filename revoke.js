// revoke.js
const { Octokit } = require("@octokit/rest");
const crypto = require("crypto");

const TOKEN_USERS = process.env.WRITE_TOKEN_USERS_REPO;
const TOKEN_CODES = process.env.CODES_REPO_READ_TOKEN;

if (!TOKEN_USERS || !TOKEN_CODES) {
  console.error("Missing secrets");
  process.exit(1);
}

const octoUsers = new Octokit({ auth: TOKEN_USERS });
const octoCodes = new Octokit({ auth: TOKEN_CODES });

const owner = "aditya32762-rgb";
const usersRepo = "users-repo";
const usersPath = "users.json";
const revokedPath = "revoked.json";

const codesRepo = "codes-repo";
const codesPath = "active_codes.json";
const codesExpiredPath = "expired_codes.json";

function nowUtc() { return new Date(); }

async function getJson(octo, owner, repo, path) {
  try {
    const res = await octo.repos.getContent({ owner, repo, path });
    const content = Buffer.from(res.data.content, "base64").toString("utf8");
    return { json: JSON.parse(content), sha: res.data.sha };
  } catch (err) {
    if (err.status === 404) return { json: null, sha: null };
    throw err;
  }
}

async function putJson(octo, owner, repo, path, message, json, sha) {
  const content = Buffer.from(JSON.stringify(json, null, 2)).toString("base64");
  if (!sha) {
    // create file
    await octo.repos.createOrUpdateFileContents({ owner, repo, path, message, content });
  } else {
    await octo.repos.createOrUpdateFileContents({ owner, repo, path, message, content, sha });
  }
}

(async () => {
  try {
    const usersFile = await getJson(octoUsers, owner, usersRepo, usersPath);
    const revokedFile = await getJson(octoUsers, owner, usersRepo, revokedPath);
    const codesFile = await getJson(octoCodes, owner, codesRepo, codesPath);

    const usersJson = usersFile.json || { users: [] };
    const revokedJson = revokedFile.json || { revoked: [] };
    const codesJson = codesFile.json || { codes: [] };

    const now = nowUtc();
    const stillActive = [];
    const expiredUsers = [];

    for (const u of usersJson.users || []) {
      const exp = u.expiryUtc || u.expiry_utc || null;
      if (!exp) { stillActive.push(u); continue; }
      const ex = new Date(exp);
      if (ex <= now) expiredUsers.push(u);
      else stillActive.push(u);
    }

    if (expiredUsers.length === 0) {
      console.log("No expired users found.");
      return;
    }

    // append expired users to revoked.json
    revokedJson.revoked = revokedJson.revoked || [];
    revokedJson.revoked.push(...expiredUsers);

    // mark codes expired in codes repo (move to expired list)
    const expiredCodes = codesJson.codes.filter(c => expiredUsers.some(u => (u.code||"").toUpperCase() === (c.code||"").toUpperCase()));
    let codesExpiredFile = await getJson(octoCodes, owner, codesRepo, codesExpiredPath);
    let codesExpiredJson = codesExpiredFile.json || { expired: [] };
    codesExpiredJson.expired = codesExpiredJson.expired || [];
    for (const c of expiredCodes) {
      if (!codesExpiredJson.expired.some(x => (x.code||"").toUpperCase() === (c.code||"").toUpperCase())) {
        codesExpiredJson.expired.push({ ...c, movedAt: now.toISOString() });
      }
    }

    // write back users.json (stillActive)
    const outUsers = { users: stillActive };
    await putJson(octoUsers, owner, usersRepo, usersPath, `Remove expired users (${expiredUsers.length})`, outUsers, usersFile.sha);

    // write revoked.json
    await putJson(octoUsers, owner, usersRepo, revokedPath, `Add ${expiredUsers.length} revoked users`, revokedJson, codesExpiredFile ? revokedFile.sha : revokedFile.sha);

    // write expired_codes.json
    await putJson(octoCodes, owner, codesRepo, codesExpiredPath, `Add expired codes from revoke run`, codesExpiredJson, codesExpiredFile.sha);

    console.log(`Moved ${expiredUsers.length} users to revoked.json and updated expired codes.`);
  } catch (err) {
    console.error("Revoke error:", err);
    process.exit(1);
  }
})();
