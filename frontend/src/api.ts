
const BASE = 'http://localhost:8000'
export async function getMode(){ return (await fetch(`${BASE}/api/mode`)).json() }
export async function setMode(mode){ const r = await fetch(`${BASE}/api/mode`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({mode})}); return r.json() }
export async function getFolders(){ return (await fetch(`${BASE}/api/folders`)).json() }
export async function getSuggestions(){ return (await fetch(`${BASE}/api/suggestions`)).json() }
export async function decide(uid, target_folder, decision){ const r = await fetch(`${BASE}/api/decide`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({message_uid: uid, target_folder, decision})}); return r.json() }
export async function moveOne(uid, target_folder, dry_run=false){ const r = await fetch(`${BASE}/api/move`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({message_uid: uid, target_folder, dry_run})}); return r.json() }
