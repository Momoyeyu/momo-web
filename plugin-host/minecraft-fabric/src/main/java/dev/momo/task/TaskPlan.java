package dev.momo.task;
import java.util.*;
import java.util.function.BooleanSupplier;

/** Finite local composition, no script interpreter or model loop. */
public final class TaskPlan implements TaskRuntime.Work {
 public record Node(TaskRuntime.Work work,BooleanSupplier condition,int retries,boolean skipFailure){
  public Node {if(work==null||condition==null||retries<0||retries>2)throw new IllegalArgumentException("Invalid plan node");}
 }
 private final List<Node> steps;private final List<Map<String,Object>> outcomes=new ArrayList<>();
 private int index,attempt;private boolean running,finished;private TaskRuntime.Step failure;
 public TaskPlan(List<Node> steps){if(steps.isEmpty()||steps.size()>24)throw new IllegalArgumentException("Invalid plan length");this.steps=List.copyOf(steps);}
 public void start(){begin();}
 private void begin(){
  while(index<steps.size()&&!steps.get(index).condition.getAsBoolean()){outcomes.add(Map.of("step",index,"skipped","condition_false"));index++;}
  if(index==steps.size()){finished=true;return;}
  running=true;
  try{steps.get(index).work.start();}catch(RuntimeException error){failed("start_failed");}
 }
 public TaskRuntime.Step tick(){
  if(failure!=null)return failure;
  if(finished)return TaskRuntime.Step.done(Map.of("steps",List.copyOf(outcomes)));
  var result=steps.get(index).work.tick();
  if(result.state().equals("succeeded")){
   if(result.evidence().isEmpty()){failed("unverified_result");}
   else {release();outcomes.add(Map.of("step",index,"result",result.evidence()));index++;attempt=0;begin();}
  }else if(result.state().equals("failed"))failed(result.reason());
  return failure!=null?failure:finished?TaskRuntime.Step.done(Map.of("steps",List.copyOf(outcomes))):TaskRuntime.Step.running();
 }
 private void failed(String reason){
  release();var node=steps.get(index);
  if(attempt++<node.retries){begin();return;}
  if(node.skipFailure){outcomes.add(Map.of("step",index,"skipped",reason));index++;attempt=0;begin();}
  else failure=TaskRuntime.Step.failed("step_"+index+":"+reason);
 }
 private void release(){if(running){steps.get(index).work.stop();running=false;}}
 public void pause(){if(running)steps.get(index).work.pause();}
 public void resume(){if(running)steps.get(index).work.resume();}
 public void stop(){release();}
 public boolean acceptsScreen(Object screen){return !finished&&failure==null&&steps.get(index).work.acceptsScreen(screen);}
}
