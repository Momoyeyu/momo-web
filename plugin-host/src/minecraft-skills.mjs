import skills from './minecraft-skills.json' with { type: 'json' };
export {skills};
export class SkillInputError extends Error {
 constructor(path,rule,limits={}){super(rule==='supported_skill'?'Unsupported Minecraft skill':'Invalid skill arguments');this.validation={path,rule,...limits};}
}
const invalid=(path,rule,limits)=>{throw new SkillInputError(path,rule,limits);};
function validate(schema,value,path){
 if(schema.type==='object'){
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)invalid(path,'object');
  if(schema.additionalProperties===false&&Object.keys(value).some(k=>!Object.hasOwn(schema.properties,k))){
   const choices=Object.keys(schema.properties??{}).slice(0,32);
   invalid(path,'unknown_field',choices.length?{choices}:{});
  }
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
 for(const rule of ['anyOf','oneOf'])if(schema[rule]){
  const matches=schema[rule].filter(branch=>{try{validate(branch,value,path);return true;}catch{return false;}}).length;
  if(!matches||rule==='oneOf'&&matches!==1)invalid(path,'conditional_fields');
 }
}
/** Geometry only; does not read game state or add targets outside the declared part. */
export function buildCells(args,path='args'){
 validate(skills.build.parameters,args,path);
 if(Object.hasOwn(args,'cells')===Object.hasOwn(args,'box'))invalid(path,'conditional_fields');
 if(Object.hasOwn(args,'cells'))return args.cells;
 const b=args.box,{width:w,height:h,length:l}=b,mode=b.mode??'solid';
 const count=(mode==='walls'?w*l-Math.max(0,w-2)*Math.max(0,l-2):w*l)*h;
 if(count>32)invalid(`${path}.box`,'build_size',{maximum:32});
 const cells=[];
 for(let x=0;x<w;x++)for(let y=0;y<h;y++)for(let z=0;z<l;z++){
  if(mode==='walls'&&x>0&&x<w-1&&z>0&&z<l-1)continue;
  cells.push({x:b.x+x,y:b.y+y,z:b.z+z,block:b.block});
 }
 validate(skills.build.parameters.properties.cells,cells,`${path}.box`);return cells;
}
/** Expand a fixed coordinate frame; never rewrite its original request or inspect a world. */
export function planSteps(args,path='args'){
 const steps=structuredClone(args.steps),origin=args.origin;
 if(!origin)return steps;
 const point=(value,where)=>{
  if(!value||Object.getPrototypeOf(value)!==Object.prototype)return;
  for(const axis of ['x','y','z'])if(Object.hasOwn(value,axis)){
   if(!Number.isSafeInteger(value[axis])||!Number.isSafeInteger(value[axis]+origin[axis]))invalid(`${where}.${axis}`,'integer');
   value[axis]+=origin[axis];
  }
 };
 for(const [index,step] of steps.entries()){
  const a=step.args,where=`${path}.steps[${index}].args`;
  if(['navigate','mine','place','interactBlock'].includes(step.skill))point(a,where);
  if(step.skill==='build'){
   if(Array.isArray(a.cells))a.cells.forEach((cell,i)=>point(cell,`${where}.cells[${i}]`));
   if(Object.hasOwn(a,'box'))point(a.box,`${where}.box`);
  }
 }
 return steps;
}
export function validateSkill(name,args,path='args'){
 if(!Object.hasOwn(skills,name))invalid('skill','supported_skill');
 validate(skills[name].parameters,args,path);
 if(name==='build'){
  const cells=buildCells(args,path);
  if(new Set(cells.map(c=>`${c.x},${c.y},${c.z}`)).size!==cells.length)invalid(`${path}.cells`,'duplicate_cell');
  for(const axis of ['x','y','z'])if(Math.max(...cells.map(c=>c[axis]))-Math.min(...cells.map(c=>c[axis]))>=16)invalid(`${path}.cells`,'build_extent',{maximum:16});
 }
 if(name==='plan')for(const [index,step] of planSteps(args,path).entries())validateSkill(step.skill,step.args,`${path}.steps[${index}].args`);
 if(Buffer.byteLength(JSON.stringify(args),'utf8')>3500)invalid(path,'bytes',{maximum:3500});
 return args;
}
