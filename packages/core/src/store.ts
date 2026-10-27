import {readFile,writeFile,mkdir,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {watch} from 'node:fs';
import {initializeApp,getApps,cert,applicationDefault} from 'firebase-admin/app';
import {getFirestore,FieldPath,type Firestore} from 'firebase-admin/firestore';
export type RecordData=Record<string,any>;
export type Filter=[string,'=='|'in'|'<=',any];
export interface Tx {get(collection:string,id:string):Promise<RecordData|null>;set(collection:string,id:string,data:RecordData):void;create(collection:string,id:string,data:RecordData):void;}
export interface RecordPage {records:RecordData[];nextAfter:string|null;}
export interface Store {get(collection:string,id:string):Promise<RecordData|null>;list(collection:string,filters?:Filter[]):Promise<RecordData[]>;page(collection:string,limit:number,after?:string):Promise<RecordPage>;transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>;subscribe(collections:string[],onChange:()=>void,onError:()=>void):()=>void;}
export const isLocal=()=>process.env.DATA_MODE==='local'&&process.env.NODE_ENV!=='production';
export function localDataPath(){return process.env.LOCAL_DATA_PATH||path.resolve(process.cwd(),(process.cwd().endsWith('/apps/web')||process.cwd().endsWith('/services/automation-worker'))?'../../.local/data.json':'.local/data.json');}
export class LocalStore implements Store{
 constructor(readonly file=localDataPath()){}
 async read(){try{return JSON.parse(await readFile(this.file,'utf8')) as Record<string,Record<string,RecordData>>}catch(e:any){if(e.code==='ENOENT')return {};throw e;}}
 async get(c:string,id:string){return (await this.read())[c]?.[id]??null;}
 async list(c:string,filters:Filter[]=[]){return Object.values((await this.read())[c]||{}).filter(d=>filters.every(([k,op,v])=>op==='=='?d[k]===v:op==='in'?v.includes(d[k]):d[k]<=v));}
 async page(c:string,limit:number,after?:string):Promise<RecordPage>{const records=Object.entries((await this.read())[c]||{}).sort(([a],[b])=>a<b?-1:a>b?1:0).filter(([key])=>!after||key>after).slice(0,limit+1);return {records:records.slice(0,limit).map(([key,data])=>({...data,id:key})),nextAfter:records.length>limit?records[limit-1]![0]:null};}
 subscribe(_collections:string[],onChange:()=>void,onError:()=>void){const listener=watch(path.dirname(this.file),(_event,filename)=>{if(String(filename)===path.basename(this.file))onChange();});listener.on('error',onError);queueMicrotask(onChange);return ()=>listener.close();}
 async transaction<T>(fn:(tx:Tx)=>Promise<T>):Promise<T>{
  await mkdir(path.dirname(this.file),{recursive:true});const lock=this.file+'.lock';const start=Date.now();
  while(true){try{await mkdir(lock);break}catch(e:any){if(e.code!=='EEXIST')throw e;if(Date.now()-start>15000)throw new Error('Local database is busy. Retry shortly.');await new Promise(r=>setTimeout(r,20));}}
  try{const state=await this.read();const tx:Tx={get:async(c,id)=>state[c]?.[id]??null,set:(c,id,data)=>{state[c]??={};state[c]![id]=structuredClone({...data,id})},create:(c,id,data)=>{if(state[c]?.[id])throw new Error('Record already exists');state[c]??={};state[c]![id]=structuredClone({...data,id})}};const result=await fn(tx);const temp=this.file+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(state,null,2));await rename(temp,this.file);return result;}finally{await rm(lock,{recursive:true});}
 }
}
let firestore:Firestore|undefined;
export function firebaseDb(){if(firestore)return firestore;const projectId=process.env.FIREBASE_PROJECT_ID;if(!projectId)throw new Error('Set FIREBASE_PROJECT_ID before enabling Firebase mode');const app=getApps()[0]??initializeApp({projectId,credential:process.env.FIREBASE_CLIENT_EMAIL&&process.env.FIREBASE_PRIVATE_KEY?cert({projectId,clientEmail:process.env.FIREBASE_CLIENT_EMAIL,privateKey:process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')}):applicationDefault()});return firestore=getFirestore(app);}
export class FirebaseStore implements Store{
 async get(c:string,id:string){const s=await firebaseDb().collection(c).doc(id).get();return s.exists?{...s.data(),id:s.id}:null;}
 async list(c:string,filters:Filter[]=[]){let q:FirebaseFirestore.Query=firebaseDb().collection(c);for(const [k,op,v]of filters)q=q.where(k,op,v);const docs=await q.get();return docs.docs.map(d=>({...d.data(),id:d.id}));}
 async page(c:string,limit:number,after?:string):Promise<RecordPage>{let q=firebaseDb().collection(c).orderBy(FieldPath.documentId());if(after)q=q.startAfter(after);const snap=await q.limit(limit+1).get();return {records:snap.docs.slice(0,limit).map(d=>({...d.data(),id:d.id})),nextAfter:snap.size>limit?snap.docs[limit-1]!.id:null};}
 subscribe(collections:string[],onChange:()=>void,onError:()=>void){const disposers=collections.map(collection=>firebaseDb().collection(collection).onSnapshot(()=>onChange(),()=>onError()));return ()=>disposers.forEach(dispose=>dispose());}
 async transaction<T>(fn:(tx:Tx)=>Promise<T>){const db=firebaseDb();return db.runTransaction(async t=>fn({get:async(c,id)=>{const s=await t.get(db.collection(c).doc(id));return s.exists?{...s.data(),id:s.id}:null},set:(c,id,d)=>{t.set(db.collection(c).doc(id),{...d,id})},create:(c,id,d)=>{t.create(db.collection(c).doc(id),{...d,id})}}));}
}
export function getStore():Store{return isLocal()?new LocalStore():new FirebaseStore();}
