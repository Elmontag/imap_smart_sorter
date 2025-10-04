
import { useEffect, useState } from 'react'
import { getSuggestions } from '../api'

export function useSuggestions(){
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(()=>{
    let alive = true
    getSuggestions().then(r => { if(alive){ setData(r); setLoading(false) }})
    return ()=>{ alive = false }
  },[])
  return { data, loading }
}
