const { Octokit } = require("@octokit/rest");

// Read environment variables
const issueNumber = process.env.ISSUE_NUMBER;
const issueBody = process.env.ISSUE_BODY || "";
const owner = process.env.REQUESTS_REPO_OWNER;
const repo = process.env.REQUESTS_REPO_NAME;

const tokenCodes = process.env.CODES_REPO_READ_TOKEN;
const tokenUsers = process.env.WRITE_TOKEN_USERS_REPO;

if (!tokenCodes || !tokenUsers) {
    throw new Error("Missing GitHub Secrets. Add WRITE_TOKEN_USERS_REPO and CODES_REPO_READ_TOKEN.");
}

const octoCodes = new Octokit({ auth: tokenCodes });
const octoUsers = new Octokit({ auth: tokenUsers });
const octoRequests = new Octokit({ auth: tokenUsers }); // for comments

// Extract data from issue body
function parseField(name) {
    const line = issueBody.split('\n').find(l => l.toLowerCase().startsWith(name + ":"));
    return line ? line.split(":").slice(1).join(":").trim() : "";
}

const username = parseField("username");
const hwid = parseField("hwid");
const code = parseField("code");

if (!username || !hwid || !code) {
    octoRequests.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: "Invalid issue format. Expected:\n```\nusername: ...\nhwid: ...\ncode: ...\n```"
    });
    process.exit(1);
}

async function main() {
    // 1. Fetch active codes
    const activeFile = await octoCodes.repos.getContent({
        owner: "aditya32762-rgb",
        repo: "codes-repo",
        path: "active_codes.json"
    });

    const activeCodes = JSON.parse(Buffer.from(activeFile.data.content, "base64").toString("utf8"));

    const found = activeCodes.codes.find(c => c.code === code);
    if (!found) {
        await octoRequests.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: `Code not found: ${code}`
        });
        return;
    }

    if (found.used) {
        await octoRequests.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: `Code already used: ${code}`
        });
        return;
    }

    // 2. Fetch users list
    const usersFile = await octoUsers.repos.getContent({
        owner: "aditya32762-rgb",
        repo: "users-repo",
        path: "users.json"
    });

    const usersData = JSON.parse(Buffer.from(usersFile.data.content, "base64").toString("utf8"));
    usersData.users ||= [];

    // 3. Add new user
    const now = new Date();
    const expiry = new Date(now.getTime() + 30 * 86400000);

    usersData.users.push({
        username,
        hwid,
        code,
        activated_utc: now.toISOString(),
        expiry_utc: expiry.toISOString()
    });

    // 4. Mark code used
    found.used = true;

    // 5. Write users.json back to users-repo
    await octoUsers.repos.createOrUpdateFileContents({
        owner: "aditya32762-rgb",
        repo: "users-repo",
        path: "users.json",
        message: `Activate code for ${username}`,
        content: Buffer.from(JSON.stringify(usersData, null, 2)).toString("base64"),
        sha: usersFile.data.sha
    });

    // 6. Write active_codes.json back to codes-repo
    await octoCodes.repos.createOrUpdateFileContents({
        owner: "aditya32762-rgb",
        repo: "codes-repo",
        path: "active_codes.json",
        message: `Mark code ${code} used`,
        content: Buffer.from(JSON.stringify(activeCodes, null, 2)).toString("base64"),
        sha: activeFile.data.sha
    });

    // 7. Success message
    await octoRequests.issues.createComment({
        owner, repo, issue_number: issueNumber,
        body: `Code successfully activated.\nUser: **${username}**\nExpires: **${expiry.toISOString()}**`
    });
}

main().catch(err => {
    console.error("ERROR:", err);
    process.exit(1);
});
