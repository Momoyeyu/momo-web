package dev.momo.task;
import java.util.*;
import java.util.function.*;
/** One bounded search, optional owned placement, then a correlated opening. */
final class WorkbenchPreparation implements TaskRuntime.Work {
 private final Supplier<TaskRuntime.Work> place;private final Function<Map<String,Object>,TaskRuntime.Work> open;
 private TaskRuntime.Work work;private int phase;private boolean paused,closed=true;
 private Map<String,Object> placed=Map.of();
 WorkbenchPreparation(TaskRuntime.Work search,Supplier<TaskRuntime.Work> place,Function<Map<String,Object>,TaskRuntime.Work> open){work=search;this.place=place;this.open=open;}
 public void start(){closed=paused=false;work.start();}
 public TaskRuntime.Step tick(){
  if(closed)return TaskRuntime.Step.failed("activity_ended");if(paused)return TaskRuntime.Step.running();
  var result=work.tick();
  if(phase==0&&result.state().equals("failed")&&result.reason().equals("station_required")){
   var replacement=place.get();if(replacement==null)return result;
   work.stop();work=replacement;phase=1;work.start();return TaskRuntime.Step.running();
  }
  if(!result.state().equals("succeeded"))return result;
  if(phase==2){var evidence=new LinkedHashMap<String,Object>(result.evidence());if(!placed.isEmpty())evidence.put("placedWorkbench",placed);return TaskRuntime.Step.done(evidence);}
  Map<?,?> point=result.evidence();
  if(phase==1){placed=Map.copyOf(result.evidence());if(!(placed.get("placement") instanceof Map<?,?> receipt))return TaskRuntime.Step.failed("server_confirmation_missing");point=receipt;}
  if(!point.containsKey("x")||!point.containsKey("y")||!point.containsKey("z"))return TaskRuntime.Step.failed("server_confirmation_missing");
  var target=Map.of("x",point.get("x"),"y",point.get("y"),"z",point.get("z"));
  work.stop();work=open.apply(target);phase=2;work.start();return TaskRuntime.Step.running();
 }
 public void pause(){if(!closed){paused=true;work.pause();}}public void resume(){if(!closed){paused=false;work.resume();}}public void stop(){if(!closed){closed=true;work.stop();}}
 public boolean acceptsScreen(Object screen){return !closed&&work.acceptsScreen(screen);}
 public Map<String,Object> progress(){return Map.of("phase",phase==0?"find_workbench":phase==1?"place_workbench":"open_workbench","action",work.progress());}
 public Map<String,Object> partialEvidence(){var evidence=new LinkedHashMap<String,Object>(work.partialEvidence());if(!placed.isEmpty())evidence.put("placedWorkbench",placed);return Map.copyOf(evidence);}
}
