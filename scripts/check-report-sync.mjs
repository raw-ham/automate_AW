import 'dotenv/config';
const base=process.env.WORKER_URL||'http://127.0.0.1:3001';
const health=await (await fetch(base+'/health',{headers:{Authorization:`Bearer ${process.env.WORKER_API_TOKEN}`},signal:AbortSignal.timeout(10000)})).json();
const response=await fetch(base+'/get-report',{headers:{Authorization:`Bearer ${process.env.REPORT_API_TOKEN}`},signal:AbortSignal.timeout(30000)});
const report=await response.json();
const editor=await fetch(base+'/report-editor',{signal:AbortSignal.timeout(10000)});
const rows=report.data?.reports||[];
console.log(JSON.stringify({health:{ok:health.ok,scansEnabled:health.scansEnabled,mailingEnabled:health.mailingEnabled,reportEditingConfigured:health.reportEditingConfigured,lastScan:health.lastResult},reportStatus:response.status,editorStatus:editor.status,schemaVersion:report.schemaVersion,pageCounts:report.pageCounts,reportsWithMarkings:rows.filter(r=>Array.isArray(r.markings)).length,reportsWithMailHistory:rows.filter(r=>Array.isArray(r.mailHistory)).length,actualSentMailEvents:rows.flatMap(r=>r.mailHistory||[]).filter(m=>m.sent).length},null,2));
const cycle=report.data?.taskCycles?.[0];
if(cycle){const invalid=await fetch(base+'/reports/'+encodeURIComponent(cycle.id),{method:'PATCH',headers:{Authorization:`Bearer ${process.env.REPORT_WRITE_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({requestId:'validation-invalid-edit',expectedRevision:0,changes:{mailTags:['Forged SENT']}}),signal:AbortSignal.timeout(15000)});console.log(JSON.stringify({invalidMailEditRejected:invalid.status===400}));}
const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);
try{const stream=await fetch(base+'/report-events',{headers:{Authorization:`Bearer ${process.env.REPORT_API_TOKEN}`},signal:controller.signal});const reader=stream.body.getReader();let text='';while(!text.includes('event: report-changed')&&!text.includes('event: sync-error')){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value);}console.log(JSON.stringify({liveStreamStatus:stream.status,liveDatabaseNotification:text.includes('event: report-changed'),subscriptionError:text.includes('event: sync-error')}));controller.abort();await reader.cancel().catch(()=>{});}finally{clearTimeout(timeout);controller.abort();}
