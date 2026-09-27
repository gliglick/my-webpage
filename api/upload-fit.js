// Vercel serverless endpoint: POST multipart/form-data with field "fit".
const REPO = "gliglick/my-webpage";
const BRANCH = "main";
const DASHBOARD_PATH = "cycle-performance-dashboard.html";
const FTP = 133;

function readFit(buffer) {
  if (buffer.length < 14 || buffer.toString("ascii", 8, 12) !== ".FIT") throw new Error("유효한 FIT 파일이 아닙니다.");
  const headerSize = buffer[0];
  const dataSize = buffer.readUInt32LE(4);
  let p = headerSize, end = Math.min(headerSize + dataSize, buffer.length);
  const defs = {};
  const sessions = [];
  const records = [];
  const baseInfo = {
    0x00:{size:1,type:"enum"},0x01:{size:1,type:"sint8"},0x02:{size:1,type:"uint8"},
    0x83:{size:2,type:"sint16"},0x84:{size:2,type:"uint16"},0x85:{size:4,type:"sint32"},
    0x86:{size:4,type:"uint32"},0x07:{size:1,type:"string"},0x88:{size:4,type:"float32"},
    0x89:{size:8,type:"float64"},0x0A:{size:1,type:"uint8z"},0x8B:{size:2,type:"uint16z"},
    0x8C:{size:4,type:"uint32z"},0x0D:{size:1,type:"byte"},0x8E:{size:8,type:"sint64"},
    0x8F:{size:8,type:"uint64"},0x90:{size:8,type:"uint64z"}
  };
  function val(b, type, arch) {
    const le = arch === 0;
    if (!b.length) return null;
    if (type === "string") return b.toString("utf8").replace(/\0.*$/s,"").trim() || null;
    if (type === "byte") return b[0];
    const base = baseInfo[type];
    if (!base || b.length < base.size) return null;
    try {
      switch(type) {
        case 0x00: case 0x02: return b[0] === 0xff ? null : b[0];
        case 0x01: return b.readInt8(0);
        case 0x83: return b[le?"readInt16LE":"readInt16BE"](0) === 0x7fff ? null : b[le?"readInt16LE":"readInt16BE"](0);
        case 0x84: return b[le?"readUInt16LE":"readUInt16BE"](0) === 0xffff ? null : b[le?"readUInt16LE":"readUInt16BE"](0);
        case 0x85: return b[le?"readInt32LE":"readInt32BE"](0) === 0x7fffffff ? null : b[le?"readInt32LE":"readInt32BE"](0);
        case 0x86: return b[le?"readUInt32LE":"readUInt32BE"](0) === 0xffffffff ? null : b[le?"readUInt32LE":"readUInt32BE"](0);
        case 0x0A: return b[0] === 0 ? null : b[0];
        case 0x8B: return b[le?"readUInt16LE":"readUInt16BE"](0);
        case 0x8C: return b[le?"readUInt32LE":"readUInt32BE"](0);
        case 0x88: return b[le?"readFloatLE":"readFloatBE"](0);
        case 0x89: return b[le?"readDoubleLE":"readDoubleBE"](0);
        default: return null;
      }
    } catch { return null; }
  }
  while (p < end) {
    const h = buffer[p++];
    if (h & 0x80) { // compressed timestamp header
      const local = (h >> 5) & 0x03;
      const d = defs[local]; if (!d) break;
      const obj = parseData(d, true);
      collect(d.global, obj);
      continue;
    }
    const local = h & 0x0f;
    if (h & 0x40) {
      if (p + 5 > end) break;
      p++; const arch = buffer[p++];
      const global = arch === 0 ? buffer.readUInt16LE(p) : buffer.readUInt16BE(p); p += 2;
      const n = buffer[p++], fields = [];
      for(let i=0;i<n;i++){ if(p+3>end) break; fields.push({num:buffer[p++],size:buffer[p++],type:buffer[p++]}); }
      let dev=[];
      if(h & 0x20) { const nd=buffer[p++]; for(let i=0;i<nd;i++){dev.push({size:buffer[p+1]});p+=3;} }
      defs[local]={global,arch,fields,dev};
    } else {
      const d=defs[local]; if(!d) break;
      const obj=parseData(d); collect(d.global,obj);
    }
  }
  function parseData(d, compressed = false) {
    const o={};
    for(const f of d.fields) {
      const b=buffer.subarray(p,Math.min(p+f.size,end)); p+=f.size;
      const base=f.type & 0xff;
      const info=baseInfo[base];
      if(info && f.size>info.size) {
        const arr=[]; for(let i=0;i+info.size<=b.length;i+=info.size) arr.push(val(b.subarray(i,i+info.size),base,d.arch));
        o[f.num]=arr.length===1?arr[0]:arr;
      } else o[f.num]=val(b,base,d.arch);
    }
    for(const f of (d.dev||[])) p+=f.size;
    return o;
  }
  function collect(global,o) {
    if(global===18) sessions.push(o);
    if(global===20) records.push(o);
  }
  const s=sessions[sessions.length-1];
  if(!s) throw new Error("FIT 파일에서 세션 요약을 찾지 못했습니다.");
  const fitEpoch=Date.UTC(1989,11,31)/1000;
  const ts=s[2] != null ? new Date((s[2]+fitEpoch)*1000) : new Date();
  const date=ts.toISOString().slice(0,10);
  const dur=(s[8] ?? s[7] ?? 0)/1000/3600;
  const dist=(s[9] ?? 0)/100;
  const power=s[20] ?? null, hr=s[16] ?? null;
  let p20=null;
  const pts=records.filter(r=>r[253]!=null && r[7]!=null).map(r=>({t:r[253],p:r[7]})).sort((a,b)=>a.t-b.t);
  if(pts.length>1) {
    let j=0,sum=0,best=0;
    for(let i=0;i<pts.length;i++){
      sum+=pts[i].p;
      while(j<=i && pts[i].t-pts[j].t>1200){sum-=pts[j].p;j++;}
      if(pts[i].t-pts[j].t>=1190) best=Math.max(best,sum/(i-j+1));
    }
    if(best>0) p20=Math.round(best*10)/10;
  }
  const sport=s[5] ?? 2;
  return {
    d:date.slice(5),date,env:(sport===2||sport===1)?"O":"I",
    title:"FIT 업로드 · "+date,hr:hr==null?null:Number(hr),
    p:power==null?null:Number(power),np:s[34]==null?null:Number(s[34]),
    p20,tss:null,dur:Number(dur.toFixed(2)),dist:Number(dist.toFixed(1)),
    eff:null,dec:null,merged:false,partial:false,
    _dedupe: date+"-"+Math.round((s[2]||0))+"-"+Math.round(dist)
  };
}

module.exports = async (req,res) => {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(204).end();
  if(req.method!=="POST") return res.status(405).json({error:"POST 요청만 허용됩니다."});
  const token=process.env.GITHUB_TOKEN;
  if(!token) return res.status(500).json({error:"Vercel 환경변수 GITHUB_TOKEN이 설정되지 않았습니다."});
  try {
    // Vercel Node.js functions receive IncomingMessage, not the Web Request API.
    const contentType=req.headers["content-type"]||"";
    const boundaryMatch=contentType.match(/multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
    if(!boundaryMatch) return res.status(400).json({error:"multipart/form-data 요청이 아닙니다."});
    const boundary=Buffer.from("--"+(boundaryMatch[1]||boundaryMatch[2]));
    const chunks=[]; let total=0;
    for await (const chunk of req) {
      total+=chunk.length;
      if(total>21*1024*1024) return res.status(413).json({error:"파일은 20MB 이하만 업로드할 수 있습니다."});
      chunks.push(chunk);
    }
    const body=Buffer.concat(chunks);
    let fileBuffer=null;
    let pos=0;
    while((pos=body.indexOf(boundary,pos))!==-1) {
      pos+=boundary.length;
      if(body[pos]===45&&body[pos+1]===45) break;
      if(body[pos]===13&&body[pos+1]===10) pos+=2;
      const headerEnd=body.indexOf(Buffer.from("\r\n\r\n"),pos);
      if(headerEnd<0) break;
      const headers=body.toString("utf8",pos,headerEnd);
      const dataStart=headerEnd+4;
      const next=body.indexOf(boundary,dataStart);
      if(next<0) break;
      let dataEnd=next;
      if(dataEnd>=2&&body[dataEnd-2]===13&&body[dataEnd-1]===10)dataEnd-=2;
      if(/name="fit"/i.test(headers)) { fileBuffer=body.subarray(dataStart,dataEnd); break; }
      pos=next;
    }
    if(!fileBuffer || fileBuffer.length===0) return res.status(400).json({error:"FIT 파일을 선택하세요."});
    if(fileBuffer.length>20*1024*1024) return res.status(413).json({error:"파일은 20MB 이하만 업로드할 수 있습니다."});
    const session=readFit(fileBuffer);
    const api="https://api.github.com/repos/"+REPO+"/contents/"+DASHBOARD_PATH;
    const headers={Authorization:"Bearer "+token,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
    const get=await fetch(api+"?ref="+BRANCH,{headers});
    if(!get.ok) throw new Error("GitHub에서 대시보드를 읽지 못했습니다. 토큰의 저장소 권한을 확인하세요.");
    const current=await get.json();
    const html=Buffer.from(current.content.replace(/\n/g,""),"base64").toString("utf8");
    const match=html.match(/const D=(\{[\s\S]*?\});\s*\nconst S=/);
    if(!match) throw new Error("대시보드 데이터 영역을 찾지 못했습니다.");
    const data=JSON.parse(match[1]);
    const key=session._dedupe;
    const exists=data.sessions.some(x=>x.date===session.date && Math.abs((x.dist||0)-session.dist)<100);
    if(exists) return res.status(200).json({message:"같은 날짜·거리의 세션이 이미 있어 중복 추가하지 않았습니다.",session});
    delete session._dedupe;
    data.sessions.push(session);
    data.sessions.sort((a,b)=>a.date.localeCompare(b.date));
    const next=html.replace(match[1],JSON.stringify(data));
    const put=await fetch(api,{method:"PUT",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({
      message:"Add FIT activity "+session.date,content:Buffer.from(next,"utf8").toString("base64"),sha:current.sha,branch:BRANCH
    })});
    const result=await put.json();
    if(!put.ok) throw new Error(result.message||"GitHub에 저장하지 못했습니다.");
    return res.status(200).json({message:"FIT 세션을 대시보드에 추가했습니다. Vercel 배포가 완료되면 반영됩니다.",session});
  } catch(e) {
    return res.status(400).json({error:e.message||"FIT 업로드 처리 중 오류가 발생했습니다."});
  }
};
