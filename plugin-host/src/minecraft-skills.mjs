import skills from './minecraft-skills.json' with { type: 'json' };
export {skills};
function validate(schema,value){
 if(schema.type==='object'){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)throw new Error('Invalid skill object');
  if(schema.additionalProperties===false&&Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k)))throw new Error('Invalid skill field');
  if(schema.required?.some(k=>!Object.hasOwn(value,k)))throw new Error('Invalid missing skill field');
  for(const [key,item] of Object.entries(value))if(schema.properties?.[key])validate(schema.properties[key],item);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<schema.minItems||value.length>schema.maxItems)throw new Error('Invalid skill array');
  value.forEach(item=>validate(schema.items,item));
 }else if(schema.type==='integer'){
  if(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum)throw new Error('Invalid skill number');
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length<schema.minLength||value.length>schema.maxLength||/[\x00-\x1f]/u.test(value)||schema.enum&&!schema.enum.includes(value))throw new Error('Invalid skill string');
 }else throw new Error('Unsupported skill schema');
}
export function validateSkill(name,args){
 if(!Object.hasOwn(skills,name))throw new Error('Unsupported Minecraft skill');
 validate(skills[name].parameters,args);
 if(name==='plan')for(const step of args.steps)validateSkill(step.skill,step.args);
 if(Buffer.byteLength(JSON.stringify(args),'utf8')>3500)throw new Error('Invalid skill size');
 return args;
}
