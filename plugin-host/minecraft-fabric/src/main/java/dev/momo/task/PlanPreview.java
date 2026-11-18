package dev.momo.task;
import com.google.gson.*;
import java.util.*;
/** An intended layout sketch. No client, registry, inventory, world or skill factory. */
final class PlanPreview implements TaskRuntime.Work {
 private record Point(int x,int y,int z){}
 private final Map<String,Object> report;
 private boolean closed=true,paused;
 PlanPreview(JsonArray steps){report=describe(steps);}
 public void start(){closed=false;paused=false;}
 public TaskRuntime.Step tick(){return closed?TaskRuntime.Step.failed("activity_ended"):paused?TaskRuntime.Step.running():TaskRuntime.Step.done(report);}
 public void pause(){if(!closed)paused=true;}public void resume(){if(!closed)paused=false;}public void stop(){closed=true;}
 public Map<String,Object> progress(){return Map.of("phase","preview","plannedOnly",true);}
 private static Map<String,Integer> bounds(Collection<Point> points,boolean maximum){
  return Map.of("x",maximum?points.stream().mapToInt(Point::x).max().orElseThrow():points.stream().mapToInt(Point::x).min().orElseThrow(),
   "y",maximum?points.stream().mapToInt(Point::y).max().orElseThrow():points.stream().mapToInt(Point::y).min().orElseThrow(),
   "z",maximum?points.stream().mapToInt(Point::z).max().orElseThrow():points.stream().mapToInt(Point::z).min().orElseThrow());
 }
 private static Map<String,Object> describe(JsonArray steps){
  var targets=new LinkedHashMap<Point,String>();var parts=new ArrayList<Map<String,Object>>();int buildOperations=0,unmodelled=0;
  for(int i=0;i<steps.size();i++){
   var step=steps.get(i).getAsJsonObject();var args=step.getAsJsonObject("args");String skill=step.get("skill").getAsString();
   var part=new LinkedHashMap<String,Object>();part.put("step",i);part.put("skill",skill);part.put("plannedOnly",true);
   if(step.has("when"))part.put("conditional",true);
   var cells=new LinkedHashMap<Point,String>();
   if(skill.equals("build")){
    for(var cell:SparseBuild.from(args).cells())cells.put(new Point(cell.x(),cell.y(),cell.z()),cell.block());
    buildOperations+=cells.size();part.put("targetCells",cells.size());
   }else if(skill.equals("mine"))cells.put(new Point(args.get("x").getAsInt(),args.get("y").getAsInt(),args.get("z").getAsInt()),"minecraft:air");
   else if(Set.of("place","interactBlock","navigate").contains(skill)){
    unmodelled++;for(String axis:new String[]{"x","y","z"})if(args.has(axis))part.put(axis,args.get(axis).getAsInt());
    if(skill.equals("place"))part.put("coordinateIsSupport",true);
   }
   if(!cells.isEmpty()){part.put("min",bounds(cells.keySet(),false));part.put("max",bounds(cells.keySet(),true));targets.putAll(cells);}
   parts.add(Map.copyOf(part));
  }
  var counts=new TreeMap<String,Integer>();targets.values().forEach(block->counts.merge(block,1,Integer::sum));
  var result=new LinkedHashMap<String,Object>();result.put("plannedOnly",true);result.put("worldStateChecked",false);
  result.put("stepCount",steps.size());result.put("plannedBuildOperations",buildOperations);result.put("distinctTerrainTargets",targets.size());
  result.put("unmodelledSpatialSteps",unmodelled);result.put("parts",List.copyOf(parts));result.put("targetCounts",Map.copyOf(counts));
  result.put("layoutPreview",sketch(targets,parts,counts));return Map.copyOf(result);
 }
 private static String sketch(Map<Point,String> targets,List<Map<String,Object>> parts,Map<String,Integer> counts){
  var text=new StringBuilder("INTENT ONLY; world NOT checked. Build/mine targets only; conditions assumed. '?' unspecified, '.' requested air. Rows +Z, columns +X.\n");
  for(var part:parts.subList(0,Math.min(8,parts.size()))){
   text.append("step ").append(part.get("step")).append(' ').append(part.get("skill"));
   if(part.containsKey("min"))text.append(" min=").append(part.get("min")).append(" max=").append(part.get("max"));
   else if(part.containsKey("x"))text.append(" x=").append(part.get("x")).append(" z=").append(part.get("z")).append(" y=").append(part.getOrDefault("y","surface"));
   if(part.containsKey("conditional"))text.append(" (conditional)");text.append('\n');
  }
  if(parts.size()>8)text.append("More parts in full task details.\n");
  if(targets.isEmpty())return text.toString();
  var min=bounds(targets.keySet(),false);var max=bounds(targets.keySet(),true);
  if(List.of("x","y","z").stream().anyMatch(axis->max.get(axis)-min.get(axis)>=16)){text.append("Targets span more than 16 blocks; no slices.\n");return text.toString();}
  var legend=new TreeMap<String,Character>();int index=0;
  for(String id:counts.keySet())if(!id.equals("minecraft:air"))legend.put(id,index<25?(char)('A'+index++):'+');
  int shown=0;
  for(var entry:legend.entrySet()){if(shown++==6){text.append("More block types in targetCounts.\n");break;}String id=entry.getKey();text.append(entry.getValue()).append('=').append(id.length()>48?id.substring(0,48)+"...":id).append(' ');}
  text.append('\n');
  var levels=new TreeSet<Integer>(List.of(min.get("y"),(min.get("y")+max.get("y"))/2,max.get("y")));
  for(int y:levels){
   var layer=new StringBuilder("Y="+y+", X="+min.get("x")+".."+max.get("x")+", Z="+min.get("z")+".."+max.get("z")+"\n");
   for(int z=min.get("z");z<=max.get("z");z++){
    for(int x=min.get("x");x<=max.get("x");x++){
     String block=targets.get(new Point(x,y,z));layer.append(block==null?'?':block.equals("minecraft:air")?'.':legend.get(block));
    }layer.append('\n');
   }
   if(text.length()+layer.length()>1740){text.append("Further slices omitted; see original plan/details.\n");break;}text.append(layer);
  }
  return text.toString();
 }
}
