package dev.momo.task;
import java.util.*;
/** Clear only explicit air cells, then lend the same body to ordinary placement. */
final class BuildClearance implements TaskRuntime.Work {
 interface Scene {
  /** Establish sight before reading. An occluded target must reject, not guess. */
  String observe(SparseBuild.Cell cell);
  TaskRuntime.Work clear(SparseBuild.Cell cell);
  TaskRuntime.Work place(List<SparseBuild.Cell> cells);
 }
 private final List<SparseBuild.Cell> air,blocks;private final Scene scene;
 private final List<Map<String,Object>> confirmed=new ArrayList<>();
 private TaskRuntime.Work child;private int index;private boolean placing,closed=true,paused;
 BuildClearance(List<SparseBuild.Cell> cells,Scene scene){
  air=cells.stream().filter(SparseBuild.Cell::clearance).toList();blocks=cells.stream().filter(c->!c.clearance()).toList();this.scene=scene;
 }
 public void start(){closed=false;paused=false;index=0;placing=false;confirmed.clear();}
 private boolean coordinate(Object value,int expected){return value instanceof Number n&&n.doubleValue()==expected;}
 private Map<String,Object> proof(SparseBuild.Cell cell,String state,Long seq){
  var row=new LinkedHashMap<String,Object>();row.put("x",cell.x());row.put("y",cell.y());row.put("z",cell.z());row.put("block",state);
  if(seq==null)row.put("observedExisting",true);else row.put("serverBlockSeq",seq);return Map.copyOf(row);
 }
 private void release(){if(child!=null){child.stop();child=null;}}
 private void collectPlacement(Map<String,Object> evidence){
  if(evidence.get("confirmedCells") instanceof List<?> rows)for(var row:rows)if(row instanceof Map<?,?> map){
   var copy=new LinkedHashMap<String,Object>();map.forEach((k,v)->{if(k instanceof String key)copy.put(key,v);});
   if(!confirmed.contains(copy))confirmed.add(Map.copyOf(copy));
  }
 }
 public TaskRuntime.Step tick(){
  if(closed)return TaskRuntime.Step.failed("activity_ended");if(paused)return TaskRuntime.Step.running();
  if(child!=null){
   var result=child.tick();if(result.state().equals("running"))return result;
   if(placing){collectPlacement(child.partialEvidence());if(result.state().equals("succeeded"))collectPlacement(result.evidence());}
   if(!result.state().equals("succeeded"))return result;
   if(!placing){
    var cell=air.get(index);var evidence=result.evidence();var state=scene.observe(cell);
    if(!coordinate(evidence.get("x"),cell.x())||!coordinate(evidence.get("y"),cell.y())||!coordinate(evidence.get("z"),cell.z())||!(evidence.get("serverBlockSeq") instanceof Number seq)||seq.longValue()<=0||!(evidence.get("after") instanceof String after)||!cell.matchesState(after)||!cell.matchesState(state))return TaskRuntime.Step.failed("unverified_result");
    confirmed.add(proof(cell,state,seq.longValue()));index++;
   }
   release();if(placing)return TaskRuntime.Step.done(partialEvidence());
  }
  if(index<air.size()){
   var cell=air.get(index);var state=scene.observe(cell);
   if(cell.matchesState(state)){confirmed.add(proof(cell,state,null));index++;}
   else{child=scene.clear(cell);child.start();}
   return TaskRuntime.Step.running();
  }
  if(blocks.isEmpty())return TaskRuntime.Step.done(partialEvidence());
  placing=true;child=scene.place(blocks);child.start();return TaskRuntime.Step.running();
 }
 public void pause(){paused=true;if(child!=null)child.pause();}
 public void resume(){if(!closed){paused=false;if(child!=null)child.resume();}}
 public void stop(){closed=true;if(child!=null&&placing)collectPlacement(child.partialEvidence());release();}
 public boolean acceptsScreen(Object screen){return child!=null&&child.acceptsScreen(screen);}
 public boolean controlsMining(){return !closed&&!paused&&child!=null&&child.controlsMining();}
 public Map<String,Object> progress(){return Map.of("skill","build","phase",placing?"place":"clear","cleared",index,"clearanceCells",air.size());}
 public Map<String,Object> partialEvidence(){
  if(child!=null&&placing)collectPlacement(child.partialEvidence());var result=new LinkedHashMap<String,Object>();
  if(child!=null)result.putAll(child.partialEvidence());result.put("confirmedCells",List.copyOf(confirmed));return Map.copyOf(result);
 }
}
