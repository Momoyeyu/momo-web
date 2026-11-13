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
  try{steps.get(index).work.start();}catch(RuntimeException error){failed(TaskRuntime.reason(error,"start_failed"));}
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
  var node=steps.get(index);var partial=node.work.partialEvidence();boolean safe=node.work.retrySafe(reason);
  boolean unknown=Set.of("server_confirmation_missing","execution_failed","stop_unconfirmed","ingredients_station_or_server_ack_missing","trade_stock_or_currency_missing").contains(reason);
  release();
  if(!unknown&&safe&&attempt++<node.retries){begin();return;}
  if(!partial.isEmpty())outcomes.add(Map.of("step",index,"partial",true,"result",partial));
  if(!unknown&&node.skipFailure){outcomes.add(Map.of("step",index,"skipped",reason));index++;attempt=0;begin();}
  else failure=TaskRuntime.Step.failed("step_"+index+":"+reason);
 }
 private void release(){if(running){steps.get(index).work.stop();running=false;}}
 public void pause(){if(running)steps.get(index).work.pause();}
 public void resume(){if(running)steps.get(index).work.resume();}
 public void stop(){release();}
 public Map<String,Object> partialEvidence(){
  var facts=new ArrayList<>(outcomes);
  if(running&&!finished&&failure==null){var partial=steps.get(index).work.partialEvidence();if(!partial.isEmpty())facts.add(Map.of("step",index,"partial",true,"result",partial));}
  return facts.isEmpty()?Map.of():Map.of("steps",List.copyOf(facts));
 }
 public boolean controlsMining(){return running&&!finished&&failure==null&&steps.get(index).work.controlsMining();}
 public Map<String,Object> progress(){return finished?Map.of("completedSteps",index):Map.of("step",index,"completedSteps",outcomes.size(),"action",steps.get(index).work.progress());}
 public boolean acceptsScreen(Object screen){return !finished&&failure==null&&steps.get(index).work.acceptsScreen(screen);}
}
