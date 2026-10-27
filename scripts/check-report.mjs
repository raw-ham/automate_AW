import 'dotenv/config';
const base=process.env.WORKER_URL||'http://127.0.0.1:3001';
const health=await fetch(base+'/health',{signal:AbortSignal.timeout(10000)});
const healthData=await health.json();
const unauthorized=await fetch(base+'/get-report',{signal:AbortSignal.timeout(10000)});
const response=await fetch(base+'/get-report',{headers:{Authorization:`Bearer ${process.env.REPORT_API_TOKEN||''}`},signal:AbortSignal.timeout(30000)});
const report=await response.json();
console.log(JSON.stringify({healthStatus:health.status,scansEnabled:healthData.scansEnabled,unauthenticatedStatus:unauthorized.status,authenticatedStatus:response.status,schemaVersion:report.schemaVersion||null,pageCounts:report.pageCounts||null,hasMore:report.pagination?.hasMore??null,error:response.ok?null:report.error},null,2));
process.exitCode=response.ok&&unauthorized.status===401?0:1;
