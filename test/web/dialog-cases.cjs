// Extract the actual expressions used by every native confirm call. This test
// evaluates text construction only; no UI action or device command is run.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {babelParse,traverse}=require(path.join(path.dirname(require.resolve('playwright/package.json')),'lib/transform/babelBundle.js'));
const base=path.join(__dirname,'../../web');
const files={};
function parse(name){
 if(files[name])return files[name];
 const source=fs.readFileSync(path.join(base,name),'utf8'),ast=babelParse(source,name,true);
 const record={source,confirms:[],calls:[],functions:{}};
 traverse(ast,{
  FunctionDeclaration(p){record.functions[p.node.id.name]=source.slice(p.node.start,p.node.end);},
  CallExpression(p){
   if(p.node.callee.type!=='Identifier')return;
   const item={line:p.node.loc.start.line,args:p.node.arguments.map(n=>source.slice(n.start,n.end))};
   const parent=p.getFunctionParent();item.fn=parent&&parent.node.id&&parent.node.id.name;
   if(p.node.callee.name==='confirm'){
    const arg=p.node.arguments[0];
    if(arg.type==='Identifier'){
     const b=p.scope.getBinding(arg.name);
     if(b&&b.path.node.init)item.resolved=source.slice(b.path.node.init.start,b.path.node.init.end);
    }
    record.confirms.push(item);
   }
   if(['fwAction','confirmClass'].includes(p.node.callee.name))record.calls.push({...item,callee:p.node.callee.name});
  }
 });return files[name]=record;
}
function evaluate(expression,env={}){return new Function(...Object.keys(env),'return ('+expression+');')(...Object.values(env));}
const labels={live:'Live',restart:'Service restart',internet:'Interrupts internet',reboot:'Reboot'};
const ranks={live:1,restart:2,internet:3,reboot:4};
function cases(){
 const result=[];
 const add=(file,item,env,suffix,expression=item.args[0])=>result.push({id:file+':'+item.line+':'+suffix,source:evaluate(expression,env)});
 const app=parse('app.js');
 for(const n of [1,2])add('app.js',app.confirms[0],{SSH_LINES:Array(n).fill('example')},'sshkeys-'+n);
 add('app.js',app.confirms[1],{},'reset');
 const fw=parse('firmware.js');
 for(const part of ['0','1'])add('firmware.js',fw.confirms[0],{part},'write-'+part);
 for(const kind of ['stock','other','unknown'])add('firmware.js',fw.confirms[1],{part:'0',k:{kind},fw:{},describeSlot:()=> 'V1.0-220304'},'overwrite-'+kind);
 for(const call of fw.calls){
  for(const trial of [false,true]){
   const env={p:'0',committed:'1',booted:trial?'0':'1',trial};
   const action=evaluate(call.args[0],env),warning=evaluate(call.args[2],env);
   add('firmware.js',fw.confirms[2],{action,warning,CLASS_RANK:ranks,CLASS_LABEL:labels},action+'-'+trial);
  }
 }
 for(const back of ['0','1',undefined])add('firmware.js',fw.confirms[3],{run:'1',back},'commit-'+back);
 const host=parse('hostlink.js');
 for(const mode of ['off','on'])add('hostlink.js',host.confirms[0],{mode},'autoneg-'+mode,host.confirms[0].resolved);
 for(const mode of ['fiber1g','2500basex','hisgmii']){
  const serdesShort=m=>({fiber1g:'Fiber 1G','2500basex':'2.5G (2500BASE-X)',hisgmii:'HiSGMII'}[m]);
  add('hostlink.js',host.confirms[1],{mode,serdesShort},'serdes-'+mode);
 }
 const restore=parse('restore.js');
 add('restore.js',restore.confirms[0],{PLAN:{identity:[['GPON_SN','ABCD01234567'],['ELAN_MAC_ADDR','020000000001']]}},'identity');
 const save=parse('save.js'),state=parse('state.js');
 const risk=(a,b)=>new Function('before','after','vlanTag',state.functions.vlanRisk+';return vlanRisk(before,after);')({tag:a},{tag:b},v=>v.tag);
 for(const call of save.calls){
  const options=call.args[1].includes('risk')?['untag','tag','retag']:call.args[1].includes('ip ?')?['with-ip','mask-only']:call.args[1].includes('rebootWarning')?['normal','trial']:['default'];
  for(const option of options){
   const env={risk:risk(option==='tag'?null:40,option==='untag'?null:44),ip:option==='mask-only'?undefined:'192.168.3.1',S:{VALUES:{LAN_IP_ADDR:'192.168.3.1'},FW:{env:{sw_active:'1',sw_commit:option==='trial'?'0':'1'}}},cls:call.args[1].includes('rebootWarning')?'reboot':'internet'};
   env.rebootWarning=()=>new Function('S',save.functions.rebootWarning+';return rebootWarning();')(env.S);
   const cls=evaluate(call.args[0],env),text=evaluate(call.args[1],env);
   add('save.js',save.confirms[0],{cls,text,CLASS_RANK:ranks,CLASS_LABEL:labels},'call-'+call.line+'-'+option);
  }
 }
 const sites=Object.entries(files).flatMap(([file,v])=>v.confirms.map(c=>file+':'+c.line));
 assert.equal(sites.length,10);
 const covered=new Set(result.map(c=>c.id.split(':').slice(0,2).join(':')));
 assert(sites.every(x=>covered.has(x)),'a confirm site is not covered');
 return {sites,cases:result};
}
module.exports={cases};
if(require.main===module){const data=cases();fs.writeFileSync(path.join(__dirname,'results/confirm-cases.json'),JSON.stringify(data,null,2));console.log(JSON.stringify({sites:data.sites.length,cases:data.cases.length}));}
