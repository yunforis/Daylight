import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import jwt from 'jsonwebtoken';
import os from 'node:os';
import {newProject,mergeSnapshot,renameProject,searchChunks,validateSchedule} from './campus/domain.js';
import {prepareSlideFonts} from './campus/documents.js';
import {parseGraduateTables} from './campus/timetable.js';
import {graduateSnapshot,parsePiazzaResources,piazzaSnapshot,parseBlackboardCourses} from './campus/importers.js';
import {askCampus} from './campus/agent.js';
const table=[['课程代码','课程名称','班级名称','首次上课日期','上课时间地点'],['SYN101','合成测试课程','测试班','2026-09-14','1-2周 星期一[1-2节]测试教室 A;3周 星期一[1-2节]测试教室 B']];
const snapshot={source:'graduate',partial:true,pages:[{url:'https://graduate.shanghaitech.edu.cn/gsapp/sys/wdkbappshtech/index.do',title:'合成课表',text:'合成测试课程',tables:[table]}]};
test('研究生课表 JSON、Piazza 资料和 Blackboard 课程列表可导入',()=>{
 const snap=graduateSnapshot({datas:{xsjxrwcx:{rows:[{KCDM:'CS240',KCMC:'算法设计与分析',BJMC:'算法设计与分析01',SCSKRQ:'2026-09-15',PKSJDD:'1-2周 星期二[3-4节]教学中心201'}]}}});
 const parsed=parseGraduateTables(snap.pages[0].tables);
 assert.equal(parsed.schedule.length,2);
 assert.equal(parsed.schedule[0].start,'2026-09-15T10:15:00+08:00');
 const html='<b class="ml-1">Homework</b><a href="/class_profile/get_resource/mtgoeh6v4cf3xb/mv2k3zu5xbb1v6"><div class="render-html-content">Homework_Rules.pdf</div></a><b class="ml-1">通知</b><a href="/class_profile/get_resource/mtgoeh6v4cf3xb/notice1"><div class="render-html-content">已发邮件的通知</div></a>';
 assert.equal(parsePiazzaResources(html).length,2);
 assert.equal(piazzaSnapshot(html,{skipTitles:['已发邮件的通知']}).resources.length,1);
 assert.equal(parseBlackboardCourses('<a href="/webapps/blackboard/execute/modulepage/view?course_id=_5644_1">矩阵计算</a>')[0].title,'矩阵计算');
});
test('确定性课表展开、换教室稳定 ID、不吞掉未知周次',()=>{
 const result=parseGraduateTables([table]);assert.equal(result.semesterMonday,'2026-09-14');assert.equal(result.schedule.length,3);
 assert.equal(result.schedule[0].start,'2026-09-14T08:15:00+08:00');assert.equal(result.schedule[0].end,'2026-09-14T09:55:00+08:00');
 const moved=structuredClone(table);moved[1][4]=moved[1][4].replace('测试教室 A','测试教室 C');assert.equal(parseGraduateTables([moved]).schedule[0].id,result.schedule[0].id);
 const broken=structuredClone(table);broken[1][4]+=';单周 星期四[3-4节]测试教室';assert.throws(()=>parseGraduateTables([broken]),/未识别/);
 assert.throws(()=>parseGraduateTables([table],{semesterMonday:'2026-09-15'}),/星期一/);
 assert.throws(()=>validateSchedule([{id:'bad',title:'bad',start:'2026-09-14T08:00',end:'2026-09-14T09:00'}]));
});
test('快照去重、资料更新版本、局部采集不推断删除、拒绝外站和登录页',()=>{
 const p=newProject({title:'测试'});assert.equal(mergeSnapshot(p,snapshot).changed,1);assert.equal(mergeSnapshot(p,snapshot).changed,0);
 const changed=structuredClone(snapshot);changed.pages[0].text+='更新';mergeSnapshot(p,changed);assert.equal(p.pages[0].version,2);
 assert.throws(()=>mergeSnapshot(p,{...snapshot,pages:[]}),/没有/);assert.equal(p.pages.length,1);
 assert.throws(()=>mergeSnapshot(p,{...snapshot,pages:[{...snapshot.pages[0],url:'https://example.invalid/'}]}),/不属于/);
 assert.throws(()=>mergeSnapshot(p,{...snapshot,pages:[{...snapshot.pages[0],title:'统一身份认证'}]}),/登录/);
});
test('文件夹改名保留原数据，检索可限定当前文件',()=>{
 const p=newProject({title:'原文件夹'});const id=p.id;
 p.documents=[{id:'a',filename:'a.pdf',chunks:[{page:2,content:'傅里叶变换'}]},{id:'b',filename:'b.pdf',chunks:[{page:9,content:'傅里叶变换与卷积'}]}];
 renameProject(p,'秋季课程');assert.equal(p.id,id);assert.equal(p.title,'秋季课程');
 assert.equal(searchChunks(p,'卷积',8,{documentIds:['a']}).length,0);
 assert.equal(searchChunks(p,'卷积',8,{documentIds:['b']})[0].page,9);
});
test('课件转换字体配置可移植，并尊重管理员显式配置',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'daylight-font-'));
 const made=await prepareSlideFonts(dir,{});
 if(process.platform==='darwin'){assert.equal(made.generated,true);const text=fs.readFileSync(made.FONTCONFIG_FILE,'utf8');assert.match(text,/\/System\/Library\/Fonts/);assert.equal(text.includes(os.homedir()),false);}
 else assert.equal(made.generated,false);
 assert.equal((await prepareSlideFonts(dir,{FONTCONFIG_FILE:'/etc/fonts/local.conf'})).FONTCONFIG_FILE,'/etc/fonts/local.conf');
});
test('RAG 限定项目、页码引用来自检索证据、Agent 有步骤上限',async()=>{
 const p=newProject({title:'测试'});p.documents=[{id:'doc',filename:'synthetic.pdf',chunks:[{page:4,content:'凸函数的局部最优也是全局最优。'}]}];
 assert.equal(searchChunks(p,'凸函数')[0].page,4);assert.equal(searchChunks(newProject({title:'另一个项目'}),'凸函数').length,0);
 const local=await askCampus(p,'凸函数',{},null);assert.equal(local.mode,'retrieval');
 let calls=0;const result=await askCampus(p,'凸函数',{apiKey:'synthetic',baseUrl:'http://invalid',model:'fixture'},[],async()=>++calls<3?{tool:'search',query:'最优'}:{answer:'合成解释',references:[{documentId:'doc',page:4},{documentId:'other',page:99}]});
 assert.equal(calls,3);assert.ok(result.citations.length);assert.ok(result.citations.every(c=>c.documentId==='doc'&&c.page===4));
});
test('HTTP：账号隔离、连接令牌权限/撤销、人工确认、跨端共享日历与附件', {timeout:90000},async()=>{
 fs.mkdirSync('work',{recursive:true});const dir=fs.mkdtempSync(path.resolve('work/campus-api-'));
 const users=[0,1].map(i=>({id:`campus-test-${i}`,email:`synthetic-${i}@example.invalid`,username:`campus-test-${i}`,role:'user',session_version:0}));const secret='campus-local-synthetic-test-secret';
 fs.writeFileSync(path.join(dir,'users.json'),JSON.stringify({users,resets:[]}));
 fs.writeFileSync(path.join(dir,'infra.json'),JSON.stringify({postgres:{enabled:false},redis:{enabled:false},mq:{enabled:false},oss:{enabled:false},auth:{requireAuth:true,jwtSecret:secret}}));
 fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({mailboxes:users.map((u,i)=>({id:`mail-${i}`,ownerUserId:u.id,email:u.email})),userPrefs:Object.fromEntries(users.map((u,i)=>[u.id,{activeMailboxId:`mail-${i}`}]))}));
 const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
 const child=spawn(process.execPath,['server/index.js','--production'],{env:{...process.env,PORT:String(port),DAYLIGHT_DATA_DIR:dir},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',s=>output+=s);child.stderr.on('data',s=>output+=s);
 const tokens=users.map(u=>jwt.sign({sub:u.id,sv:0},secret,{expiresIn:'5m'}));
 const call=async(route,token,method='GET',body,filename)=>{const res=await fetch(`http://127.0.0.1:${port}/api${route}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),'Content-Type':filename?'application/octet-stream':'application/json',...(filename?{'X-Filename':filename}:{})},...(body?{body:filename?body:JSON.stringify(body)}:{})});const text=await res.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:res.status,data};};
 try{
  const deadline=Date.now()+40000;while(Date.now()<deadline&&!output.includes('Daylight is ready')){if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,80));}assert.match(output,/Daylight is ready/);
  assert.equal((await call('/campus')).status,401);
  const made=await call('/campus/projects',tokens[0],'POST',{title:'合成校园项目'});assert.equal(made.status,200,JSON.stringify(made));const base=`/campus/projects/${made.data.id}`;
  assert.equal((await call(base,tokens[1])).status,404);
  const grant=await call(base+'/connectors',tokens[0],'POST',{});assert.equal(grant.status,200,JSON.stringify(grant));const scoped=grant.data.token;
  assert.equal((await call('/state',scoped)).status,401);assert.equal((await call(base,scoped)).status,401);
  assert.equal((await call(base+'/snapshot',scoped,'POST',snapshot)).status,200);
  assert.equal((await call('/campus/projects/other/snapshot',scoped,'POST',snapshot)).status,401);
  assert.equal((await call('/state',tokens[0])).data.events.length,0);
  const proposal=await call(base+'/propose',tokens[0],'POST',{kind:'schedule'});assert.equal(proposal.status,200,JSON.stringify(proposal));assert.equal(proposal.data.schedule.length,3);
  assert.equal((await call(base+'/confirm',scoped,'POST',{proposalId:proposal.data.id})).status,401);
  assert.equal((await call(base+'/confirm',tokens[0],'POST',{proposalId:'stale'})).status,409);
  for(let i=0;i<2;i++)assert.equal((await call(base+'/confirm',tokens[0],'POST',{proposalId:proposal.data.id})).status,200);
  assert.equal((await call('/state',tokens[0])).data.events.length,3);assert.equal((await call('/state',tokens[1])).data.events.length,0);
  const upload=await call(base+'/documents',scoped,'POST',Buffer.from('Synthetic course: convex functions and global minima.'),'synthetic.txt');assert.equal(upload.status,200,JSON.stringify(upload));assert.equal(upload.data.document.status,'ready');assert.equal('originalKey' in upload.data.document,false);
  const docPath=base+'/documents/'+upload.data.document.id+'/original';assert.equal((await call(docPath,tokens[1])).status,404);assert.equal((await call(docPath,scoped)).status,401);assert.match((await call(docPath,tokens[0])).data,/Synthetic/);
  assert.equal((await call(base+'/documents',scoped,'POST',Buffer.from('Synthetic course: convex functions and global minima.'),'synthetic.txt')).data.duplicate,true);
  assert.equal((await call(base+'/connectors/'+grant.data.id,tokens[0],'DELETE')).status,200);assert.equal((await call(base+'/snapshot',scoped,'POST',snapshot)).status,401);
  const files=fs.readdirSync(path.join(dir,'scenarios'));const persisted=JSON.parse(fs.readFileSync(path.join(dir,'scenarios',files[0])));const key=persisted.campus.projects[0].documents[0].originalKey;
  assert.equal((await call('/attachments/'+key)).status,404);
 }finally{child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode===null)child.kill('SIGKILL');}
});
