package dev.momo.task;
import java.util.*;
/** One body owner composes observed build batches and bounded ordinary approaches. */
final class BuildTask implements TaskRuntime.Work {
 interface Scene {
  void start();void check();
  List<SparseBuild.Cell> visible(List<SparseBuild.Cell> pending);
  boolean matches(SparseBuild.Cell known);
  TaskRuntime.Work build(List<SparseBuild.Cell> visible);
  TaskRuntime.Work approach(int attempt);
  default List<Map<String,Object>> materials(){return List.of();}
 }
 private final List<SparseBuild.Cell> cells;private final Scene scene;
 private final Map<SparseBuild.Cell,Map<String,Object>> confirmed=new LinkedHashMap<>();
 private final Map<String,Object> diagnostics=new LinkedHashMap<>();
 private TaskRuntime.Work child;private List<SparseBuild.Cell> batch=List.of();
 private int ticks,approaches;private boolean moving,paused,closed=true,forceApproach;
 private String recoveryReason="build_cells_not_visible";
 BuildTask(List<SparseBuild.Cell> cells,Scene scene){this.cells=List.copyOf(cells);this.scene=scene;}
 public void start(){scene.start();closed=false;paused=false;}
 private List<SparseBuild.Cell> pending(){return cells.stream().filter(c->!confirmed.containsKey(c)).toList();}
 private boolean coordinate(Object value,int expected){return value instanceof Number n&&n.doubleValue()==expected;}
 private void collect(Map<String,Object> evidence,boolean required){
  for(String field:List.of("blockedCells","observedEmptyCells","missingMaterials"))if(evidence.get(field) instanceof List<?> rows&&!rows.isEmpty())diagnostics.put(field,List.copyOf(rows));
  Object value=evidence.get("confirmedCells");
  if(value instanceof List<?> rows)for(Object entry:rows){
   if(!(entry instanceof Map<?,?> row))continue;
   for(var cell:batch){
    if(!coordinate(row.get("x"),cell.x())||!coordinate(row.get("y"),cell.y())||!coordinate(row.get("z"),cell.z()))continue;
    if(!(row.get("block") instanceof String state)||!cell.matchesState(state))continue;
    if(!Boolean.TRUE.equals(row.get("observedExisting"))&&!(row.get("serverBlockSeq") instanceof Number n&&n.longValue()>0))continue;
    var proof=new LinkedHashMap<String,Object>();row.forEach((k,v)->{if(k instanceof String key)proof.put(key,v);});confirmed.put(cell,Map.copyOf(proof));
   }
  }
  if(required&&batch.stream().anyMatch(c->!confirmed.containsKey(c)))throw new TaskRuntime.Rejected("unverified_result");
 }
 private void releaseChild(){if(child!=null){child.stop();child=null;}batch=List.of();}
 public TaskRuntime.Step tick(){
  if(closed)return TaskRuntime.Step.failed("activity_ended");
  if(paused)return TaskRuntime.Step.running();
  scene.check();if(++ticks>2400)return TaskRuntime.Step.failed("build_timeout");
  if(child!=null){
   TaskRuntime.Step result;
   try{result=child.tick();}catch(TaskRuntime.Rejected error){result=TaskRuntime.Step.failed(error.reason);}
   if(result.state().equals("running"))return result;
   if(!moving){collect(child.partialEvidence(),false);if(result.state().equals("succeeded"))collect(result.evidence(),true);}
   boolean wasMoving=moving;releaseChild();
   if(result.state().equals("failed")){
    if(wasMoving&&!result.reason().equals("unreachable"))return result;
    if(!wasMoving&&!Set.of("build_cells_not_visible","build_blocked").contains(result.reason()))return result;
    if(!wasMoving)recoveryReason=result.reason();
    forceApproach=!wasMoving;
   }else{
    if(wasMoving&&!Boolean.TRUE.equals(result.evidence().get("arrived")))return TaskRuntime.Step.failed("unverified_result");
    forceApproach=false;
   }
  }
  // Recheck only cells already observed/placed by this task. Unknown cells do
  // not acquire their state merely because they are present in the blueprint.
  confirmed.keySet().removeIf(cell->!scene.matches(cell));var pending=pending();
  if(pending.isEmpty())return TaskRuntime.Step.done(Map.of("engine","baritone","confirmedCells",List.copyOf(confirmed.values()),"approaches",approaches,"observedExisting",confirmed.values().stream().filter(v->Boolean.TRUE.equals(v.get("observedExisting"))).count(),"materialInventory",scene.materials()));
  var visible=forceApproach?List.<SparseBuild.Cell>of():scene.visible(pending);
  if(!visible.isEmpty()){
   if(!pending.containsAll(visible))throw new TaskRuntime.Rejected("unverified_result");
   batch=List.copyOf(visible);moving=false;diagnostics.clear();child=scene.build(batch);
   try{child.start();}
   catch(TaskRuntime.Rejected error){
    if(!error.reason.equals("build_cells_not_visible"))throw error;
    collect(child.partialEvidence(),false);releaseChild();forceApproach=true;
   }
   return TaskRuntime.Step.running();
  }
  while(approaches<5){
   child=scene.approach(approaches++);if(child==null)continue;
   moving=true;forceApproach=false;child.start();return TaskRuntime.Step.running();
  }
  return TaskRuntime.Step.failed(recoveryReason);
 }
 public void pause(){paused=true;if(child!=null)child.pause();}
 public void resume(){if(!closed){paused=false;if(child!=null)child.resume();}}
 public void stop(){closed=true;if(child!=null&&!moving)collect(child.partialEvidence(),false);releaseChild();}
 public boolean acceptsScreen(Object screen){return child!=null&&child.acceptsScreen(screen);}
 public boolean controlsMining(){return !closed&&!paused&&child!=null&&child.controlsMining();}
 public Map<String,Object> progress(){return Map.of("skill","build","engine","baritone","phase",child==null?"planning":moving?"approach":"build","confirmed",confirmed.size(),"requested",cells.size(),"approaches",approaches,"ticks",ticks);}
 public Map<String,Object> partialEvidence(){if(child!=null&&!moving)collect(child.partialEvidence(),false);var result=new LinkedHashMap<String,Object>(diagnostics);result.putAll(Map.of("confirmedCells",List.copyOf(confirmed.values()),"remainingCells",pending().stream().map(c->Map.of("x",c.x(),"y",c.y(),"z",c.z(),"block",c.block())).toList(),"approaches",approaches,"materialInventory",scene.materials()));return Map.copyOf(result);}
}
