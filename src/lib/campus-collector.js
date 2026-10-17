/** Bookmarklet runs on the school site after the user signs in there. It never contains a mailbox password. */
export function campusCollectorBookmark({ origin, projectId, token }) {
  const program = `async function(){
    const origin=${JSON.stringify(origin)};
    const projectId=${JSON.stringify(projectId)};
    const token=${JSON.stringify(token)};
    const auth={'Authorization':'Bearer '+token,'Content-Type':'application/json'};
    const post=async(path,body)=>fetch(origin+'/api/campus/projects/'+projectId+path,{method:'POST',headers:auth,body:JSON.stringify(body)});
    const host=location.hostname;
    try{
      if(host.endsWith('graduate.shanghaitech.edu.cn')){
        const now=new Date(), month=now.getMonth()+1, year=now.getFullYear();
        const term=month>=8?year+'1':month<=1?(year-1)+'1':(year-1)+'2';
        const res=await fetch('/gsapp/sys/wdkbappshtech/modules/xskcb/xsjxrwcx.do',{method:'POST',credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8','X-Requested-With':'XMLHttpRequest'},body:'&XNXQDM='+term+'&pageNumber=1&pageSize=100'});
        const payload=await res.json();
        const saved=await post('/import',{source:'graduate',payload});
        alert(saved.ok===false? '课表导入失败' : '研究生课表已导入 Daylight');
        return;
      }
      if(host==='piazza.com'){
        const saved=await post('/import',{source:'piazza',html:document.documentElement.outerHTML.slice(0,1500000)});
        const data=await saved.json();
        let uploaded=0;
        for(const item of (data.resources||[]).slice(0,40)){
          const file=await fetch(item.href,{credentials:'include'});
          if(!file.ok) continue;
          const bytes=await file.arrayBuffer();
          const up=await fetch(origin+'/api/campus/projects/'+projectId+'/documents',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(item.name),'X-Campus-Source':'piazza','X-Campus-Course':encodeURIComponent(item.section||'Piazza'),'X-Campus-Kind':item.kind||'lecture'},body:bytes});
          if(up.ok) uploaded++;
        }
        alert('Piazza 已导入，课件 '+uploaded+' 个');
        return;
      }
      if(host.endsWith('elearning.shanghaitech.edu.cn')){
        const menu=location.href.includes('course_id=') ? document.documentElement.outerHTML : await (await fetch('/webapps/blackboard/execute/globalCourseNavMenuSection?cmd=view&serviceLevel=blackboard.data.course.Course$ServiceLevel:FULL',{credentials:'include',headers:{'X-Requested-With':'XMLHttpRequest'}})).text();
        await post('/import',{source:'blackboard',html:menu.slice(0,1500000)});
        const links=[...document.querySelectorAll('a[href*=".pdf"],a[href*="bbcswebdav"]')].slice(0,40);
        let uploaded=0;
        for(const link of links){
          const file=await fetch(link.href,{credentials:'include'});
          if(!file.ok) continue;
          const name=(link.textContent||'course.pdf').trim().slice(0,180)||'course.pdf';
          const up=await fetch(origin+'/api/campus/projects/'+projectId+'/documents',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/octet-stream','X-Filename':encodeURIComponent(name.endsWith('.pdf')?name:name+'.pdf'),'X-Campus-Source':'blackboard','X-Campus-Course':encodeURIComponent(document.title||'Blackboard'),'X-Campus-Kind':'lecture'},body:await file.arrayBuffer()});
          if(up.ok) uploaded++;
        }
        alert('Blackboard 已导入，附件 '+uploaded+' 个');
        return;
      }
      alert('请在研究生课表、Piazza 或 Blackboard 已登录页面使用这个书签');
    }catch(error){alert('导入失败：'+(error&&error.message||'请重新登录官方页面'));}
  }`;
  return `javascript:${encodeURIComponent(`(${program})()`)}`;
}
