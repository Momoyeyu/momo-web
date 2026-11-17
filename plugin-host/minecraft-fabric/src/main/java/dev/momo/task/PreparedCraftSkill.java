package dev.momo.task;
import java.util.*;
import java.util.function.Supplier;
/** A recipe remains one task while its required visible station is opened. */
final class PreparedCraftSkill implements TaskRuntime.Work {
 private final Supplier<TaskRuntime.Work> prepare,craft;
 private TaskRuntime.Work work;private boolean preparing,paused,closed=true;
 private Map<String,Object> station=Map.of();
 PreparedCraftSkill(Supplier<TaskRuntime.Work> prepare,Supplier<TaskRuntime.Work> craft){this.prepare=prepare;this.craft=craft;}
 public void start(){closed=paused=false;station=Map.of();work=prepare.get();preparing=work!=null;if(preparing)work.start();else beginCraft();}
 private void beginCraft(){preparing=false;work=craft.get();work.start();}
 public TaskRuntime.Step tick(){
  if(closed)return TaskRuntime.Step.failed("activity_ended");if(paused)return TaskRuntime.Step.running();
  var result=work.tick();
  if(!result.state().equals("succeeded"))return result;
  if(preparing){station=Map.copyOf(result.evidence());work.stop();work=null;beginCraft();return TaskRuntime.Step.running();}
  var evidence=new LinkedHashMap<String,Object>(result.evidence());if(!station.isEmpty())evidence.put("stationPreparation",station);
  return TaskRuntime.Step.done(evidence);
 }
 public void pause(){if(!closed){paused=true;if(work!=null)work.pause();}}
 public void resume(){if(!closed){paused=false;if(work!=null)work.resume();}}
 public void stop(){closed=true;if(work!=null)work.stop();}
 public boolean acceptsScreen(Object screen){return !closed&&work!=null&&work.acceptsScreen(screen);}
 public Map<String,Object> progress(){return Map.of("skill","craft","phase",preparing?"open_workbench":"craft","action",work==null?Map.of():work.progress());}
 public Map<String,Object> partialEvidence(){var evidence=new LinkedHashMap<String,Object>();if(work!=null)evidence.putAll(work.partialEvidence());if(!station.isEmpty())evidence.put("stationPreparation",station);return Map.copyOf(evidence);}
}
