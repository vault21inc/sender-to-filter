/* Browser-only UI fixture. Excluded from the XPI. No mailbox/native APIs. */
(async () => {
  if (location.hash === '#dark') document.documentElement.style.colorScheme = 'dark';
  const messages = await (await fetch('/_locales/en/messages.json')).json();
  const definition = { name: 'Newsletters', description: 'Reading lists across Work and Personal.', enabled: true, filterType: 17,
    logic: 'or', conditionText: 'OR (from,is,editor@example.com) OR (from,is,updates@example.com)',
    actions: [{ type: 'MarkRead' }, { type: 'MoveToFolder', slotId: 'slot' }] };
  const filters = names => names.map((name,index) => ({index,name,reason:null,fingerprint:'observed',enabled:index!==1,marker:null}));
  const accounts = [{ accountId:'work', name:'Work', type:'imap', reason:null, filters:filters(['Newsletters','Old promotions','Invoices','Team updates','Travel','Archive']) },
    { accountId:'personal', name:'Personal', type:'imap', reason:null, filters:filters(['Family','Old mailing lists','Receipts','Travel confirmations and itinerary changes','Clubs','Project updates','Shopping','Archive']) },
    { accountId:'local',name:'Local Folders',type:'none',reason:'unsupported-account',filters:[]}];
  const folders = [{accountId:'work',path:'/Newsletters',label:'Work — /Newsletters'},{accountId:'personal',path:'/Reading',label:'Personal — /Reading'},{accountId:'local',path:'/Archive',label:'Local Folders — /Archive'}];
  const members = accounts.slice(0,2).map((a,i) => ({id:a.accountId,accountId:a.accountId,folderMappings:{slot:folders[i]},status:'current',positionHint:0}));
  const group = {id:'group',revision:1,definition,members,operation:null};
  const view = { blocked:null,state:{schemaVersion:1,groups:{group}}, observations:{group:members.map(m => ({memberId:m.id,status:'current',reason:null,inspectedAt:'2026-09-16T18:00:00.000Z'}))}};
  window.browser = {i18n:{getMessage(key,args=[]){if(!Array.isArray(args))args=[args];return (messages[key]?.message||'').replace(/\$(\d+)/g,(_,n)=>args[n-1]||'');}},runtime:{async sendMessage({action,payload:p}){
    let data;
    if(action==='load')data=view;
    if(action==='accounts')data={accounts,folders,tags:[]};
    if(action==='source')data={definition, mappings:{slot:folders[0]}};
    if(action==='edit')data={canceled:false,definition:{...p.definition,name:p.definition.name+' edited'},mappingReviewRequired:false};
    if(action==='preview')data={ok:true,token:'preview',group:{...group,definition:p.definition,members:p.members.map((m,i)=>({...m,id:m.memberId||String(i)})),operation:{targets:p.members.map((m,i)=>({memberId:m.memberId||String(i),mode:m.detach?'detach':m.memberId?'replace':m.selector?'adopt':'create',before:null,after:{position:m.position||0}}))}}};
    if(action==='commit'||action==='retry')data=view;
    return {ok:true,data};
  }}};
  const script=document.createElement('script');script.src='/options/shared-filters.js';document.body.append(script);
})();
