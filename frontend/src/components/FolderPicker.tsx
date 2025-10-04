
import React from 'react'

export default function FolderPicker({folders, onPick}:{folders:string[], onPick:(f:string)=>void}){
  return (
    <select onChange={e=>onPick(e.target.value)}>
      {folders.map(f => <option key={f} value={f}>{f}</option>)}
    </select>
  )
}
