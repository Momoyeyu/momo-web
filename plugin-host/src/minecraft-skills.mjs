import skills from './minecraft-skills.json' with { type: 'json' };
export {skills};
export class SkillInputError extends Error {
 constructor(path,rule,limits={}){super(rule==='supported_skill'?'Unsupported Minecraft skill':'Invalid skill arguments');this.validation={path,rule,...limits};}
}
const invalid=(path,rule,limits)=>{throw new SkillInputError(path,rule,limits);};
function validate(schema,value,path){
 if(schema.type==='object'){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)invalid(path,'object');
  if(schema.additionalProperties===false&&Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k)))invalid(path,'unknown_field');
  const missing=schema.required?.find(k=>!Object.hasOwn(value,k));if(missing)invalid(`${path}.${missing}`,'required');
  for(const [key,item] of Object.entries(value))if(schema.properties?.[key])validate(schema.properties[key],item,`${path}.${key}`);
 }else if(schema.type==='array'){
  if(!Array.isArray(value)||value.length<schema.minItems||value.length>schema.maxItems)invalid(path,'array',{minimum:schema.minItems,maximum:schema.maxItems});
  value.forEach((item,index)=>validate(schema.items,item,`${path}[${index}]`));
 }else if(schema.type==='integer'){
  if(!Number.isSafeInteger(value)||value<schema.minimum||value>schema.maximum)invalid(path,'integer',{minimum:schema.minimum,maximum:schema.maximum});
 }else if(schema.type==='string'){
  if(typeof value!=='string'||value.length<schema.minLength||value.length>schema.maxLength||/[\x00-\x1f]/u.test(value))invalid(path,'string',{minimum:schema.minLength,maximum:schema.maxLength});
  if(schema.enum&&!schema.enum.includes(value))invalid(path,'enum',{choices:schema.enum});
 }else invalid(path,'schema');
 if(schema.anyOf&&!schema.anyOf.some(branch=>{try{validate(branch,value,path);return true;}catch{return false;}}))invalid(path,'conditional_fields');
}
export function validateSkill(name,args,path='args'){
 if(!Object.hasOwn(skills,name))invalid('skill','supported_skill');
 validate(skills[name].parameters,args,path);
 if(name==='build'){
  if(new Set(args.cells.map(c=>`${c.x},${c.y},${c.z}`)).size!==args.cells.length)invalid(`${path}.cells`,'duplicate_cell');
  for(const axis of ['x','y','z'])if(Math.max(...args.cells.map(c=>c[axis]))-Math.min(...args.cells.map(c=>c[axis]))>=16)invalid(`${path}.cells`,'build_extent',{maximum:16});
 }
 if(name==='plan')for(const [index,step] of args.steps.entries())validateSkill(step.skill,step.args,`${path}.steps[${index}].args`);
 if(Buffer.byteLength(JSON.stringify(args),'utf8')>3500)invalid(path,'bytes',{maximum:3500});
 return args;
}
