import { digest, fail } from './domain.js';
const DAY=86400000;
// Observed ShanghaiTech graduate timetable period grid (not inferred by an LLM).
export const PERIODS=[['08:15','09:00'],['09:10','09:55'],['10:15','11:00'],['11:10','11:55'],['13:00','13:45'],['13:55','14:40'],['15:00','15:45'],['15:55','16:40'],['16:50','17:35'],['18:00','18:45'],['18:55','19:40'],['19:50','20:35'],['20:45','21:30']];
function weeks(text){
 const out=[];for(const term of text.replaceAll('，',',').split(',')){const m=/^(\d{1,2})(?:-(\d{1,2}))?$/.exec(term.trim());if(!m)throw fail('课表周次格式已变化，需要重新核对。');const first=+m[1],last=+(m[2]||m[1]);if(first<1||last>54||last<first)throw fail('课表周次无效');for(let w=first;w<=last;w++)out.push(w);}
 return [...new Set(out)];
}
export function parseGraduateTables(tables,{semesterMonday}={}){
 const table=tables.find(t=>t.length&&t[0].includes('课程代码')&&t[0].includes('上课时间地点'));
 if(!table)return null;
 const head=table[0],col=name=>head.indexOf(name);
 const courses=[];
 for(const cells of table.slice(1)){
  const code=cells[col('课程代码')],title=cells[col('课程名称')],className=cells[col('班级名称')],firstDate=cells[col('首次上课日期')],raw=cells[col('上课时间地点')];
  if(!code||!title||!raw)continue;
  const pattern=/([\d,，\-]+)周\s*星期([一二三四五六日天])\s*\[(\d{1,2})(?:-(\d{1,2}))?节\]\s*([^;；\n]*?)(?=\s*[\d,，\-]+周\s*星期|[;；\n]|$)/g;
  const sessions=[...raw.matchAll(pattern)].map(m=>({weeks:weeks(m[1]),weekday:'一二三四五六日'.indexOf(m[2]==='天'?'日':m[2]),from:+m[3],to:+(m[4]||m[3]),location:m[5].trim()}));
  if(raw.replace(pattern,'').replace(/[;；\s]/g,''))throw fail(`「${title}」含有未识别的课表规则，请查看原课表，不能只导入部分课次。`);
  if(!sessions.length||sessions.some(s=>s.from<1||s.to>13||s.to<s.from))throw fail(`「${title}」时间格式无法确定，请查看原课表。`);
  courses.push({code,title,className,firstDate,sessions});
 }
 if(!courses.length)throw fail('课表没有可读取的课程。');
 let monday=semesterMonday?Date.parse(semesterMonday+'T00:00:00+08:00'):NaN;
 if(!Number.isFinite(monday)){
  const candidates=courses.map(c=>{
   const first=Math.min(...c.sessions.flatMap(s=>s.weeks.map(w=>(w-1)*7+s.weekday)));
   return Date.parse(c.firstDate+'T00:00:00+08:00')-first*DAY;
  });
  if(candidates.some(x=>!Number.isFinite(x))||new Set(candidates).size!==1)throw fail('各课程首次日期无法确定同一学期起点，请手动填写第一周周一。');
  monday=candidates[0];
 }
 if(new Date(monday+8*3600000).getUTCDay()!==1)throw fail('学期第一周起点必须是星期一。');
 const out=new Map();
 for(const c of courses)for(const s of c.sessions)for(const week of s.weeks){
  const date=new Date(monday+((week-1)*7+s.weekday)*DAY+8*3600000).toISOString().slice(0,10);
  const id=digest(`${c.code}:${c.className}:${date}:${s.from}`).slice(0,32);
  out.set(id,{id,title:c.title,start:`${date}T${PERIODS[s.from-1][0]}:00+08:00`,end:`${date}T${PERIODS[s.to-1][1]}:00+08:00`,location:s.location,courseCode:c.code,week,status:'active'});
 }
 return {schedule:[...out.values()].sort((a,b)=>a.start.localeCompare(b.start)),semesterMonday:new Date(monday+8*3600000).toISOString().slice(0,10),courseCount:courses.length};
}
