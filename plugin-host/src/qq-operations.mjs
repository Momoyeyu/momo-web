// Closed QQ action contract. It carries bytes and IDs, never model paths/URLs.
export const QQ_MUTATIONS = new Set(['send_private_msg','private.send','group.send','media.send','friends.respond','groups.manage']);
export const QQ_OPERATIONS = Object.freeze({
 'contacts.list':'contacts','history.list':'history','private.send':'proactive','group.send':'groups','media.send':'media','media.fetch':'media','friends.listRequests':'friendRequests','friends.respond':'friendRequests','groups.list':'groups','groups.members':'groups','groups.manage':'groupManagement',
});
const id=value=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value);
export const qqGroup = value => typeof value==='string'&&/^group:[1-9]\d{0,19}$/.test(value)?value.slice(6):null;
const peer=value=>id(value)||!!qqGroup(value);
const str=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0');
const bad=()=>{throw Object.assign(new Error('Invalid QQ action'),{code:'INPUT',submitted:false});};
export function qqOperationParams(operation,input){
 if(!input||typeof input!=='object'||Array.isArray(input))return bad();
 const accepted={
  get_login_info:[],send_private_msg:['user_id','message'],
  'contacts.list':['limit','cursor','scopePeerIds'],'history.list':['peerId','limit','beforeMessageId'],
  'private.send':['peerId','text'],'group.send':['peerId','text'],
  'media.send':['peerId','name','mime','dataBase64'],'media.fetch':['peerId','messageId','elementId'],
  'friends.listRequests':['limit','cursor','scopePeerIds'],'friends.respond':['peerId','requestId','approve','reason'],
  'groups.list':['limit','cursor','scopePeerIds'],'groups.members':['peerId','limit','cursor'],
  'groups.manage':['peerId','operation','name','memberId','durationSeconds','enabled'],
 }[operation];
 if(!accepted||Object.keys(input).some(key=>!accepted.includes(key)))return bad();
 const p={...input};
 if(p.cursor!==undefined&&(typeof p.cursor!=='string'||!/^(0|[1-9][0-9]{0,4})$/.test(p.cursor)||Number(p.cursor)>10000))return bad();
 if(p.scopePeerIds!==undefined&&(!Array.isArray(p.scopePeerIds)||p.scopePeerIds.length>200||p.scopePeerIds.some(value=>operation==='groups.list'?!qqGroup(value):!id(value))))return bad();
 if(p.limit!==undefined&&(!Number.isSafeInteger(p.limit)||p.limit<1||p.limit>(operation==='history.list'?50:operation==='friends.listRequests'?100:200)))return bad();
 if(['history.list','media.send','media.fetch'].includes(operation)&&!peer(p.peerId))return bad();
 if(['group.send','groups.members','groups.manage'].includes(operation)&&!qqGroup(p.peerId))return bad();
 if(operation==='private.send'&&!id(p.peerId))return bad();
 if(operation==='send_private_msg'&&(!id(p.user_id)||!str(p.message,32000)||!p.message.trim()))return bad();
 if(['private.send','group.send'].includes(operation)&&(!str(p.text,32000)||!p.text.trim()))return bad();
 if(p.beforeMessageId!==undefined&&!str(p.beforeMessageId,200))return bad();
 if(operation==='media.send'&&(!str(p.name,160)||/[\\/\x00-\x1f]/.test(p.name)||!str(p.mime,100)||!str(p.dataBase64,12*1024*1024)||!/^[A-Za-z0-9+/]+={0,2}$/.test(p.dataBase64)))return bad();
 if(operation==='media.fetch'&&(!str(p.messageId,200)||!str(p.elementId,200)))return bad();
 if(operation==='friends.respond'&&(!id(p.peerId)||!str(p.requestId,200)||typeof p.approve!=='boolean'||p.reason!==undefined&&!str(p.reason,256)))return bad();
 if(operation==='groups.manage'){
  if(p.operation==='setName'){if(!str(p.name,60)||!p.name.trim())return bad();}
  else if(p.operation==='muteAll'){if(typeof p.enabled!=='boolean')return bad();}
  else if(p.operation==='muteMember'){if(!id(p.memberId)||!Number.isInteger(p.durationSeconds)||p.durationSeconds<0||p.durationSeconds>2592000)return bad();}
  else if(p.operation==='kickMember'){if(!id(p.memberId))return bad();}
  else return bad();
 }
 return p;
}
