// Vercel serverless endpoint: POST multipart/form-data with field "fit".
const REPO = "gliglick/my-webpage";
const BRANCH = "main";
const DASHBOARD_PATH = "cycle-performance-dashboard.html";
const FTP = 133;

function readFit(buffer) {
  if (buffer.length < 14 || buffer.toString("ascii", 8, 12) !== ".FIT") {
    throw new Error("유효한 FIT 파일이 아닙니다.");
  }
  const headerSize = buffer[0];
  const dataSize = buffer.readUInt32LE(4);
  const end = Math.min(headerSize + dataSize, buffer.length);
  let p = headerSize;
  const defs = {};
  const sessions = [];
  const records = [];
  let lastTimestamp = null;

  const baseInfo = {
    0x00:{size:1}, 0x01:{size:1}, 0x02:{size:1}, 0x83:{size:2},
    0x84:{size:2}, 0x85:{size:4}, 0x86:{size:4}, 0x07:{size:1},
    0x88:{size:4}, 0x89:{size:8}, 0x0A:{size:1}, 0x8B:{size:2},
    0x8C:{size:4}, 0x0D:{size:1}, 0x8E:{size:8}, 0x8F:{size:8},
    0x90:{size:8}
  };

  function readValue(b, type, arch) {
    const le = arch === 0;
    if (!b.length) return null;
    if (type === 0x07) return b.toString("utf8").replace(/\0.*$/s,"").trim() || null;
    if (type === 0x0D) return b[0];
    try {
      switch(type) {
        case 0x00: case 0x02: return b[0] === 0xff ? null : b[0];
        case 0x01: return b.readInt8(0);
        case 0x83: { const v=b[le?"readInt16LE":"readInt16BE"](0); return v===0x7fff?null:v; }
        case 0x84: { const v=b[le?"readUInt16LE":"readUInt16BE"](0); return v===0xffff?null:v; }
        case 0x85: { const v=b[le?"readInt32LE":"readInt32BE"](0); return v===0x7fffffff?null:v; }
        case 0x86: { const v=b[le?"readUInt32LE":"readUInt32BE"](0); return v===0xffffffff?null:v; }
        case 0x0A: return b[0]===0?null:b[0];
        case 0x8B: return b[le?"readUInt16LE":"readUInt16BE"](0);
        case 0x8C: return b[le?"readUInt32LE":"readUInt32BE"](0);
        case 0x88: return b[le?"readFloatLE":"readFloatBE"](0);
        case 0x89: return b[le?"readDoubleLE":"readDoubleBE"](0);
        case 0x8E: return b[le?"readBigInt64LE":"readBigInt64BE"](0).toString();
        case 0x8F: case 0x90: return b[le?"readBigUInt64LE":"readBigUInt64BE"](0).toString();
        default: return null;
      }
    } catch { return null; }
  }

  function parseData(def, compressedOffset=null) {
    const obj={};
    for(const field of def.fields) {
      const bytes=buffer.subarray(p,Math.min(p+field.size,end)); p+=field.size;
      const type=field.type&0xff, info=baseInfo[type];
      if(info && field.size>info.size) {
        const arr=[];
        for(let i=0;i+info.size<=bytes.length;i+=info.size) arr.push(readValue(bytes.subarray(i,i+info.size),type,def.arch));
        obj[field.num]=arr.length===1?arr[0]:arr;
      } else obj[field.num]=readValue(bytes,type,def.arch);
    }
    for(const field of (def.dev||[])) p+=field.size;
    if(compressedOffset!==null) {
      if(lastTimestamp===null) throw new Error("압축 타임스탬프의 기준 시간이 없습니다.");
      let ts=(lastTimestamp & ~0x1f) | compressedOffset;
      if(ts<lastTimestamp) ts+=0x20;
      obj[253]=ts;
      lastTimestamp=ts;
    } else if(Number.isFinite(obj[253])) {
      lastTimestamp=obj[253];
    }
    return obj;
  }

  function collect(global,obj) {
    if(global===18) sessions.push(obj);
    if(global===20) records.push(obj);
  }

  while(p<end) {
    const h=buffer[p++];
    if(h&0x80) {
      const local=(h>>5)&0x03, offset=h&0x1f, def=defs[local];
      if(!def) throw new Error("FIT 압축 레코드 정의가 없습니다.");
      collect(def.global,parseData(def,offset));
      continue;
    }
    const local=h&0x0f;
    if(h&0x40) {
      if(p+5>end) break;
      p++; const arch=buffer[p++];
      const global=arch===0?buffer.readUInt16LE(p):buffer.readUInt16BE(p); p+=2;
      const n=buffer[p++], fields=[];
      for(let i=0;i<n;i++) {
        if(p+3>end) throw new Error("FIT 필드 정의가 잘렸습니다.");
        fields.push({num:buffer[p++],size:buffer[p++],type:buffer[p++]});
      }
      const dev=[];
      if(h&0x20) {
        const nd=buffer[p++];
        for(let i=0;i<nd;i++){dev.push({size:buffer[p+1]});p+=3;}
      }
      defs[local]={global,arch,fields,dev};
    } else {
      const def=defs[local];
      if(!def) throw new Error("FIT 데이터 정의가 없습니다.");
      collect(def.global,parseData(def));
    }
  }

  const s=sessions[sessions.length-1];
  if(!s) throw new Error("FIT 파일에서 세션 요약을 찾지 못했습니다.");
  const fitEpoch=Date.UTC(1989,11,31)/1000;
  const startTime=s[2] ?? s[253];
  const date=startTime!=null?new Date((startTime+fitEpoch)*1000).toISOString().slice(0,10):new Date().toISOString().slice(0,10);
  const dur=(s[8]??s[7]??0)/1000/3600;
  const dist=(s[9]??0)/100;
  const sport=s[5]??2;

  // Build one-second power samples from timestamped record messages.
  // FIT compressed timestamp headers are reconstructed above; long recording gaps
  // are not interpolated, so they cannot create artificial 20-minute efforts.
  const pts=records
    .filter(r=>Number.isFinite(r[253]) && Number.isFinite(r[7]))
    .map(r=>({t:r[253],p:Number(r[7])}))
    .sort((a,b)=>a.t-b.t);
  const samples=[];
  for(let i=0;i<pts.length-1;i++) {
    const a=pts[i], b=pts[i+1], gap=b.t-a.t;
    if(gap<=0 || gap>3) continue;
    for(let sec=0;sec<gap;sec++) samples.push({t:a.t+sec,p:a.p});
  }
  let p20=null;
  if(samples.length>=1200) {
    let sum=0;
    for(let i=0;i<samples.length;i++) {
      sum+=samples[i].p;
      if(i>=1200) sum-=samples[i-1200].p;
      if(i>=1199) p20=Math.max(p20??0,sum/1200);
    }
    if(p20!==null) p20=Math.round(p20*10)/10;
  }

  return {
    d:date.slice(5),date,env:(sport===2||sport===1)?"O":"I",
    title:"FIT 업로드 · "+date,
    hr:s[16]==null?null:Number(s[16]), p:s[20]==null?null:Number(s[20]),
    np:s[34]==null?null:Number(s[34]), p20,
    tss:null,dur:Number(dur.toFixed(2)),dist:Number(dist.toFixed(1)),
    eff:null,dec:null,merged:false,partial:false,
    _dedupe:date+"-"+Math.round(startTime??0)+"-"+Math.round(dist)
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
    const existingIndex=data.sessions.findIndex(x=>x.date===session.date && Math.abs((x.dist||0)-session.dist)<100);
    delete session._dedupe;
    if(existingIndex>=0) {
      // Re-uploading the same ride refreshes its FIT-derived metrics instead of
      // silently retaining a previously miscalculated 20-minute power.
      const previous=data.sessions[existingIndex];
      data.sessions[existingIndex]={...previous,...session,title:previous.title||session.title};
    } else {
      data.sessions.push(session);
    }
    data.sessions.sort((a,b)=>a.date.localeCompare(b.date));
    const next=html.replace(match[1],JSON.stringify(data));
    const put=await fetch(api,{method:"PUT",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({
      message:"Add FIT activity "+session.date,content:Buffer.from(next,"utf8").toString("base64"),sha:current.sha,branch:BRANCH
    })});
    const result=await put.json();
    if(!put.ok) throw new Error(result.message||"GitHub에 저장하지 못했습니다.");
    return res.status(200).json({message:existingIndex>=0?"기존 라이딩의 FIT 지표를 다시 계산해 갱신했습니다.":"FIT 세션을 대시보드에 추가했습니다. Vercel 배포가 완료되면 반영됩니다.",session});
  } catch(e) {
    return res.status(400).json({error:e.message||"FIT 업로드 처리 중 오류가 발생했습니다."});
  }
};
