// Synthetic MIB values. No owner capture, credential or device identity.
const catalog=require('../../localization/mib-catalog.json').catalog;
const classes=new Map(catalog.map(([cls,name])=>[cls,name]));
const blocks=[];
function add(cls,id,attrs){
 const lines=[cls+' '+classes.get(cls)+' '+id,...Object.entries(attrs).map(([k,v])=>'    '+k+' '.repeat(Math.max(1,26-k.length))+v)];
 blocks.push({cls,name:classes.get(cls),id,lines});
}
for(const [cls] of catalog){
 if([7,47,84,131,171,262,268,65311].includes(cls))continue;
 add(cls,[241,407].includes(cls)?0:[244,65280,65281,65282,65283].includes(cls)?513:257,{Example:'00'});
}
add(7,0,{Version:Buffer.from('1.0.0\0').toString('hex'),Active:'01',Committed:'01',Valid:'01'});
add(7,1,{Version:Buffer.from('1.0.1\0').toString('hex'),Active:'00',Committed:'00',Valid:'01'});
add(131,0,{OltVendorId:'43414c58',EquipId:Buffer.from('E7\0').toString('hex'),Version:Buffer.from('example\0').toString('hex')});
for(const [id,type,pointer,port] of [[257,1,257,1],[9217,3,9217,5],[170,5,170,1]])add(47,id,{TPType:type.toString(16).padStart(2,'0'),TPPointer:pointer.toString(16).padStart(4,'0'),PortNum:port.toString(16).padStart(2,'0'),BridgeIdPtr:'0001'});
add(84,9217,{FilterTbl:'002800000000000000000000000000000000000000000000',NumOfEntries:'01'});
add(171,257,{AssociationType:'02',AssociatedMePoint:'0101'});
for(let i=0;i<16;i++)add(262,32768+i,{AllocID:(i===0?264:i===3?781:255).toString(16).padStart(4,'0')});
for(const id of [170,175])add(268,id,{PortID:id.toString(16).padStart(4,'0')});
for(const id of [257,258,259,260,263])add(65311,id,{IfHCInOctets:'0000000000000000',IfHCOutOctets:'0000000000000000'});
module.exports={blocks};
