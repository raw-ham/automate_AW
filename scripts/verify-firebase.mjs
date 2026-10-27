import 'dotenv/config';
import {createPrivateKey} from 'node:crypto';
import {initializeApp,cert} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {getAuth} from 'firebase-admin/auth';
const projectId=process.env.FIREBASE_PROJECT_ID,email=process.env.FIREBASE_CLIENT_EMAIL,key=process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g,'\n');
const results=[];
if(!projectId||!email||!key){console.log('Firebase Admin credentials are incomplete.');process.exit(1);}
if(!/^[^@]+@[^@]+\.iam\.gserviceaccount\.com$/.test(email)){console.log('FIREBASE_CLIENT_EMAIL is not a service-account email.');process.exit(1);}
try{createPrivateKey(key);results.push({check:'Private key format',ok:true});}catch{console.log('FIREBASE_PRIVATE_KEY could not be parsed as a private key. Check PEM formatting and newline escapes.');process.exit(1);}
const app=initializeApp({projectId,credential:cert({projectId,clientEmail:email,privateKey:key})});
const safeCode=e=>typeof e?.code==='string'||typeof e?.code==='number'?e.code:'request_failed';
try{await app.options.credential.getAccessToken();results.push({check:'Service-account authentication',ok:true});}catch(e){results.push({check:'Service-account authentication',ok:false,code:safeCode(e)});console.log(JSON.stringify(results,null,2));process.exit(1);}
const db=getFirestore(app);db.settings({timeoutSeconds:15});
try{const snap=await db.collection('appConfig').doc('settings').get();results.push({check:'Firestore database read',ok:true,settingsPresent:snap.exists});}catch(e){results.push({check:'Firestore database read',ok:false,code:safeCode(e),detail:typeof e.details==='string'?e.details:undefined});}
try{await getAuth(app).listUsers(1);results.push({check:'Firebase Authentication Admin access',ok:true});}catch(e){results.push({check:'Firebase Authentication Admin access',ok:false,code:safeCode(e)});}
try{const token=await app.options.credential.getAccessToken();for(const [label,suffix] of [['Google sign-in provider','defaultSupportedIdpConfigs/google.com'],['Authorized domains','config']]){const response=await fetch(`https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/${suffix}`,{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(15000)});const data=await response.json();results.push(label==='Google sign-in provider'?{check:label,ok:response.ok&&data.enabled===true,httpStatus:response.status,enabled:data.enabled===true}:{check:label,ok:response.ok,localhostAuthorized:data.authorizedDomains?.includes('localhost')===true,loopbackAuthorized:data.authorizedDomains?.includes('127.0.0.1')===true});}}catch(e){results.push({check:'Google sign-in configuration',ok:false,code:safeCode(e)});}
console.log(JSON.stringify(results,null,2));await db.terminate();process.exitCode=results.some(r=>!r.ok)?1:0;
