// Bind to a private spreadsheet. Script Properties: API_BASE_URL, SHEETS_SYNC_TOKEN.
function setup() {
 const ss=SpreadsheetApp.getActive();
 ['Task Master','Employee Pending Report','Manager Monitoring','Escalation History','Reports'].forEach(n=>{if(!ss.getSheetByName(n))ss.insertSheet(n);});
 if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='syncReports'))ScriptApp.newTrigger('syncReports').timeBased().everyMinutes(5).create();
 syncReports();
}
function syncReports(){
 const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
 try{
 const props=PropertiesService.getScriptProperties(),base=props.getProperty('API_BASE_URL'),token=props.getProperty('SHEETS_SYNC_TOKEN');if(!base||!token)throw new Error('Configure API_BASE_URL and SHEETS_SYNC_TOKEN');
 const defs=[['tasks','Task Master',['id','title','description','managerUid','employeeUid','intervalDays','scheduleAnchor','proofType','active']],['taskCycles','Employee Pending Report',['id','employeeUid','managerUid','taskId','cycleNumber','dueAt','status','evidenceType','externalTicketId','proofNote','completedAt']],['taskCycles','Manager Monitoring',['id','managerUid','employeeUid','taskId','dueAt','status','firstManagerNotifiedAt','managerAcknowledgedAt','escalationLevel']],['escalationEvents','Escalation History',['id','taskId','cycleId','employeeUid','managerUid','kind','triggeredAt','recipient','deliveryStatus']],['reports','Reports',['id','managerName','employeeName','title','description','cycleNumber','dueAt','status','externalTicketId','proofNote','completionSource','managerAcknowledgedAt']]];
 defs.forEach(([collection,name,columns])=>{
 const response=UrlFetchApp.fetch(base+'/api/sheets?collection='+collection,{headers:{Authorization:'Bearer '+token},muteHttpExceptions:true});if(response.getResponseCode()!==200)throw new Error('Export failed: '+response.getResponseCode());
 const rows=JSON.parse(response.getContentText()).rows,sheet=SpreadsheetApp.getActive().getSheetByName(name);sheet.getRange(1,1,1,columns.length).setValues([columns]).setBackground('#edf3fc').setFontWeight('bold');sheet.setFrozenRows(1);
 const ids=sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues().flat():[],map={};ids.forEach((id,i)=>map[id]=i+2);
 const versions=JSON.parse(props.getProperty('versions_'+name)||'{}');
 rows.forEach(row=>{const version=row.updatedAt||row.triggeredAt||row.createdAt;if(versions[row.id]===version)return;const values=columns.map(k=>{let v=row[k];if(v===null||v===undefined)v='';if(typeof v==='string'&&/^[=+@-]/.test(v))v="'"+v;return v;});const index=map[row.id]||sheet.getLastRow()+1;sheet.getRange(index,1,1,values.length).setValues([values]);map[row.id]=index;versions[row.id]=version;});
 // Checkpoints persist only after successful writes. Stable IDs make retries safe.
 props.setProperty('versions_'+name,JSON.stringify(versions));if(!sheet.getFilter()&&sheet.getLastRow()>1)sheet.getDataRange().createFilter();
 });
 }finally{lock.releaseLock();}
}
