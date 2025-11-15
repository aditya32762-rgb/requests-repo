// process.js
expiredSha = fe.sha;
}catch(e){
// if missing, start empty and we'll create
expired = [];
}
expired.push(usedEntry);


// 3) update users.json (append token/record)
let users=[]; let usersSha=null;
try{
const fu = await getFile(usersOwner, usersRepo, 'users.json');
users = JSON.parse(fu.raw);
usersSha = fu.sha;
}catch(e){
users = [];
}
// find user record
let userRec = users.find(u => u.username && u.username.toLowerCase() === username.toLowerCase());
if (!userRec){
// create minimal record
userRec = { username, hwid: hwid || null, created: now, tokens: [] };
users.push(userRec);
}
// append token info (simple)
userRec.tokens = userRec.tokens || [];
userRec.tokens.push({ code: usedEntry.code, redeemed_at: now });


// 4) commit changes (retry naive)
try{
// Update active_codes.json
await putFile(codesOwner, codesRepo, 'active_codes.json', JSON.stringify(active, null, 2), activeSha, `Mark code ${code} used by ${username}`);
}catch(e){
console.error('failed to update active_codes.json', e);
await commentIssue(owner, requestRepo, issueNumber, '❌ Conflict updating codes; please retry.');
return;
}


try{
if (expiredSha){
await putFile(codesOwner, codesRepo, 'expired_codes.json', JSON.stringify(expired, null, 2), expiredSha, `Append expired code ${code} by ${username}`);
} else {
// create new expired_codes.json
await gh(`/repos/${codesOwner}/${codesRepo}/contents/${encodeURIComponent('expired_codes.json')}`, 'PUT', { message: `Create expired_codes.json`, content: Buffer.from(JSON.stringify(expired, null,2), 'utf8').toString('base64') });
}
}catch(e){
console.error('failed to update expired_codes.json', e);
// best-effort: continue
}


try{
if (usersSha){
await putFile(usersOwner, usersRepo, 'users.json', JSON.stringify(users, null, 2), usersSha, `Update user ${username} token`);
} else {
await gh(`/repos/${usersOwner}/${usersRepo}/contents/${encodeURIComponent('users.json')}`, 'PUT', { message: `Create users.json`, content: Buffer.from(JSON.stringify(users, null,2), 'utf8').toString('base64') });
}
}catch(e){
console.error('failed to update users.json', e);
await commentIssue(owner, requestRepo, issueNumber, '❌ Failed updating user record (server error).');
return;
}


// 5) success - post comment
const expires = new Date(Date.now() + 30*24*3600*1000).toISOString().split('T')[0];
await commentIssue(owner, requestRepo, issueNumber, `✅ Redeem OK — expires: ${expires}`);


// optionally add label and close issue
await gh(`/repos/${owner}/${requestRepo}/issues/${issueNumber}/labels`, 'POST', { labels: ['processed'] });
await gh(`/repos/${owner}/${requestRepo}/issues/${issueNumber}`, 'PATCH', { state: 'closed' });


}catch(e){
console.error('process.js error', e);
}
})();
