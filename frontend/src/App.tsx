
import React, { useEffect, useState } from 'react'
import { getMode, setMode, getFolders, getSuggestions } from './api'
import SuggestionCard from './components/SuggestionCard'
export default function App(){
  const [mode, setModeState] = useState('DRY_RUN')
  const [folders, setFolders] = useState<string[]>([])
  const [sugs, setSugs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(()=>{
    getMode().then(m => setModeState(m.mode))
    getFolders().then(setFolders).catch(()=>setFolders([]))
    getSuggestions().then(r => { setSugs(r); setLoading(false) })
  },[])
  return (<div style={{maxWidth:900, margin:'24px auto', padding:'0 16px'}}>
    <header style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:16}}>
      <h2>IMAP Smart Sorter</h2>
      <div>
        <label>Modus:&nbsp;</label>
        <select value={mode} onChange={async (e)=>{ const m = e.target.value as any; await setMode(m); setModeState(m) }}>
          <option>DRY_RUN</option><option>CONFIRM</option><option>AUTO</option>
        </select>
      </div>
    </header>
    <div style={{marginBottom:12, fontSize:12, opacity:.8}}>Ordner: {folders.length ? folders.join(' · ') : '(keine/IMAP nicht verbunden)'}</div>
    {loading ? <div>Lade Vorschläge…</div> : (sugs.length ? sugs.map((s:any)=>(<SuggestionCard key={s.message_uid} s={s}/>)) : <div>Keine offenen Vorschläge.</div>)}
  </div>)
}
