import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {createRestoreTestsClient} from './restore-tests-client.js';

// One card per site, loaded from the restore-test API and refreshed while a test is active. A site whose card cannot
// be loaded simply has no card, so the overview shows "Not tested" and nothing else breaks.
export function useRestoreTests(api,siteIds,enabled=true){
 const client=useMemo(()=>createRestoreTestsClient(api),[api]);
 const [cards,setCards]=useState({}),cardsRef=useRef(cards),key=siteIds.join('|');
 cardsRef.current=cards;
 const load=useCallback(async ids=>{
  const out=await Promise.all(ids.map(async id=>{try{return [id,await client.card(id)]}catch(e){return [id,e?.status===401?undefined:null]}}));
  setCards(previous=>{const next={...previous};for(const [id,card] of out)if(card!==undefined)next[id]=card;return next});
 },[client]);
 useEffect(()=>{
  if(!enabled||!siteIds.length)return;
  let alive=true,tick=0;
  load(siteIds);
  const timer=setInterval(()=>{
   if(!alive||document.hidden)return;
   tick+=1;
   const ids=tick%6===0?siteIds:siteIds.filter(id=>cardsRef.current[id]?.active);
   if(ids.length)load(ids);
  },5000);
  return()=>{alive=false;clearInterval(timer)};
 },[enabled,key,load]);
 return {client,cards,reload:id=>load([id])};
}
