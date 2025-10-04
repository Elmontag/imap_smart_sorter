
import { decide, moveOne } from '../api'
import React, { useState } from 'react'
export default function SuggestionCard({s}:{s:any}){
  const [target, setTarget] = useState(s.ranked?.[0]?.name || '')
  const [busy, setBusy] = useState(false)
  const top = s.ranked?.[0]
  return (<div style={{border:'1px solid #ddd', borderRadius:12, padding:16, marginBottom:12}}>
    <div style={{fontWeight:700}}>{s.subject || '(kein Betreff)'}</div>
    <div style={{opacity:.7, fontSize:12}}>{s.from_addr}</div>
    <div style={{marginTop:8}}><label>Zielordner:&nbsp;</label>
      <input value={target} onChange={e=>setTarget(e.target.value)} style={{width:'70%'}}/>
    </div>
    {top && <div style={{marginTop:6, fontSize:12, opacity:.8}}>Top‑Vorschlag: {top.name} (Score {top.score.toFixed(2)})</div>}
    {s.proposal && <div style={{marginTop:6, fontSize:12}}>Neuer Unterordner‑Vorschlag: <code>{s.proposal.parent}/{s.proposal.name}</code> – {s.proposal.reason}</div>}
    <div style={{display:'flex', gap:8, marginTop:10}}>
      <button disabled={busy} onClick={async()=>{ setBusy(true); await moveOne(s.message_uid, target, true); setBusy(false); }}>Simulieren</button>
      <button disabled={busy} onClick={async()=>{ setBusy(true); await decide(s.message_uid, target, 'accept'); setBusy(false); }}>Bestätigen</button>
      <button disabled={busy} onClick={async()=>{ setBusy(true); await decide(s.message_uid, target, 'reject'); setBusy(false); }}>Ablehnen</button>
    </div>
  </div>)
}
